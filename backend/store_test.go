package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) (*Store, *Deck, *time.Time) {
	t.Helper()
	deck, err := LoadDeck(coreDeck)
	if err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 3, 4, 0, 0, 0, time.UTC) // 北京时间 12 点
	s.now = func() time.Time { return now }
	return s, deck, &now
}

const cn = -480

func TestPlanFlow(t *testing.T) {
	ctx := context.Background()
	s, deck, now := newTestStore(t)
	p, err := s.CreatePlan(ctx, "u1", deck.Range(1, 3), 2)
	if err != nil {
		t.Fatal(err)
	}
	if next, _ := s.NextN(ctx, "u1"); next != 4 {
		t.Fatalf("next = %d, want 4", next)
	}
	if next, _ := s.NextN(ctx, "u2"); next != 1 {
		t.Fatalf("别人的进度不该受影响: %d", next)
	}
	if err := s.SavePlanPos(ctx, "u1", p.ID, 9, true); err != nil {
		t.Fatal(err)
	}
	// 计划测试：第一个词错，后两个对；第一个词重答一次也算错（按最后一次）。
	for i, w := range p.Words {
		if err := s.Record(ctx, "u1", Answer{Word: w, Kind: "plan", RefID: p.ID, Mode: "look", OK: i > 0}, cn, 3); err != nil {
			t.Fatal(err)
		}
	}
	done, err := s.FinishPlan(ctx, "u1", p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if done.Correct != 2 || done.Total != 3 {
		t.Fatalf("score = %d/%d", done.Correct, done.Total)
	}
	if cur, _ := s.CurrentPlan(ctx, "u1"); cur != nil {
		t.Fatal("测试做完后不该还有当前计划")
	}
	wrongs, _ := s.Wrongs(ctx, "u1", false)
	if len(wrongs) != 1 || wrongs[0].Word != p.Words[0] {
		t.Fatalf("wrongs = %+v", wrongs)
	}
	st, _ := s.Stats(ctx, "u1", cn)
	if st.Learned != 3 || st.Wrong != 1 || st.Streak != 1 || st.Due != 0 {
		t.Fatalf("stats = %+v", st)
	}
	// 一天后答错的那个词到期，两天后全部到期（Again 和 Good 的首次间隔按天算）。
	*now = now.AddDate(0, 0, 1)
	due, _, _ := s.Due(ctx, "u1", cn, 100)
	if len(due) == 0 || due[0] != p.Words[0] {
		t.Fatalf("due = %v", due)
	}
	st, _ = s.Stats(ctx, "u1", cn)
	if st.Streak != 1 {
		t.Fatalf("今天还没学，连续天数应算到昨天: %d", st.Streak)
	}
}

func TestWrongBookClears(t *testing.T) {
	ctx := context.Background()
	s, deck, _ := newTestStore(t)
	w := deck.Words[10].W
	s.Record(ctx, "u1", Answer{Word: w, Kind: "plan", Mode: "look", OK: false}, cn, 2)
	s.Record(ctx, "u1", Answer{Word: w, Kind: "review", Mode: "look", Rating: 3}, cn, 2)
	if list, _ := s.Wrongs(ctx, "u1", false); len(list) != 1 || list[0].Streak != 1 {
		t.Fatalf("答对一次还在错题本里: %+v", list)
	}
	s.Record(ctx, "u1", Answer{Word: w, Kind: "test", Mode: "dictation", OK: true}, cn, 2)
	if list, _ := s.Wrongs(ctx, "u1", false); len(list) != 0 {
		t.Fatalf("连续答对两次应移出: %+v", list)
	}
	if list, _ := s.Wrongs(ctx, "u1", true); len(list) != 1 {
		t.Fatal("移出的词应在已攻克里")
	}
	// 再错一次回到错题本，次数累加。
	s.Record(ctx, "u1", Answer{Word: w, Kind: "review", Mode: "listen", Rating: 1}, cn, 2)
	if list, _ := s.Wrongs(ctx, "u1", false); len(list) != 1 || list[0].Count != 2 {
		t.Fatalf("wrongs = %+v", list)
	}
}

func TestTestWrongDueTomorrow(t *testing.T) {
	ctx := context.Background()
	s, deck, now := newTestStore(t)
	w := deck.Words[20].W
	s.Record(ctx, "u1", Answer{Word: w, Kind: "review", Mode: "look", Rating: 4}, cn, 3)
	tt, err := s.CreateTest(ctx, "u1", "all", "look", []string{w}, 10)
	if err != nil {
		t.Fatal(err)
	}
	s.Record(ctx, "u1", Answer{Word: w, Kind: "test", RefID: tt.ID, Mode: "look", OK: false}, cn, 3)
	*now = now.Add(14 * time.Hour) // 北京时间第二天 2 点
	if due, _, _ := s.Due(ctx, "u1", cn, 10); len(due) != 1 {
		t.Fatalf("检测答错的词明天应该复习: %v", due)
	}
	done, _ := s.FinishTest(ctx, "u1", tt.ID)
	if done.Correct != 0 || done.Total != 1 {
		t.Fatalf("score = %+v", done)
	}
	// 没学过的词检测答错不建复习卡片。
	s.Record(ctx, "u1", Answer{Word: deck.Words[30].W, Kind: "test", Mode: "look", OK: false}, cn, 3)
	if st, _ := s.Stats(ctx, "u1", cn); st.Learned != 1 {
		t.Fatalf("learned = %d", st.Learned)
	}
}

func TestDeck(t *testing.T) {
	deck, err := LoadDeck(coreDeck)
	if err != nil {
		t.Fatal(err)
	}
	if len(deck.Words) < 2000 {
		t.Fatalf("词库只有 %d 个词", len(deck.Words))
	}
	for i, w := range deck.Words {
		if w.N != i+1 || w.W == "" || len(w.Zh) == 0 || len(w.Ex) > 5 {
			t.Fatalf("词条不对: %+v", w)
		}
	}
}

func TestDictLookup(t *testing.T) {
	deck, _ := LoadDeck(coreDeck)
	dict, err := LoadDict(dictData)
	if err != nil {
		t.Fatal(err)
	}
	if e := dict.Lookup(deck, "ran"); e == nil || e.Lemma == nil || e.Lemma.W != "run" || e.N == 0 {
		t.Fatalf("ran = %+v", e)
	}
	if e := dict.Lookup(deck, "Tom's"); e == nil || e.W != "tom" {
		t.Fatalf("Tom's = %+v", e)
	}
	if e := dict.Lookup(deck, "Sunday"); e == nil || len(e.Zh) == 0 {
		t.Fatalf("Sunday = %+v", e)
	}
	// 音标来自 CMUdict（美音）和 Britfone（英音），换成学习词典的写法。
	if e := dict.Lookup(deck, "how"); e == nil || e.Us != "haʊ" || e.Uk != "haʊ" {
		t.Fatalf("how = %+v", e)
	}
	if e := dict.Lookup(deck, "ability"); e == nil || e.Us != "əˈbɪləti" || e.Uk != "əˈbɪlɪti" {
		t.Fatalf("ability = %+v", e)
	}
	if w := deck.Get("record"); w == nil || w.Us != "ˈrekərd" || w.Uk != "ˈrekɔːd" {
		t.Fatalf("record（释义第一个是名词，应取名词读音）= %+v", w)
	}
	if dict.Lookup(deck, "zzqx") != nil {
		t.Fatal("不存在的词应返回 nil")
	}
}

func TestRecordBadInput(t *testing.T) {
	s, deck, _ := newTestStore(t)
	w := deck.Words[0].W
	var bad BadInput
	if err := s.Record(context.Background(), "u", Answer{Word: w, Kind: "x", Mode: "look"}, -480, 3); !errors.As(err, &bad) {
		t.Fatalf("未知的作答类型应返回 BadInput，得到 %v", err)
	}
	if err := s.Record(context.Background(), "u", Answer{Word: w, Kind: "review", Mode: "look", Rating: 5}, -480, 3); !errors.As(err, &bad) {
		t.Fatalf("自评越界应返回 BadInput，得到 %v", err)
	}
}
