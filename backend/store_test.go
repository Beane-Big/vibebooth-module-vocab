package main

import (
	"context"
	"errors"
	"math/rand/v2"
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

// 计划答错过的词：计划测试和做完的错题检查里答错的取并集去重；没做完的错题检查、别的计划的检测不算。
func TestPlanMissed(t *testing.T) {
	ctx := context.Background()
	s, deck, _ := newTestStore(t)
	p, _ := s.CreatePlan(ctx, "u1", deck.Range(1, 3), 2)
	a, b, c := p.Words[0], p.Words[1], p.Words[2]
	rec := func(w, kind string, ref int, ok bool) {
		t.Helper()
		if err := s.Record(ctx, "u1", Answer{Word: w, Kind: kind, RefID: ref, Mode: "look", OK: ok}, cn, 3); err != nil {
			t.Fatal(err)
		}
	}
	for _, w := range p.Words {
		rec(w, "plan", p.ID, w != a)
	}
	s.FinishPlan(ctx, "u1", p.ID)
	check1, _ := s.CreateTest(ctx, "u1", "plan", "look", p.ID, []string{a, b}, 0)
	rec(a, "test", check1.ID, true)
	rec(b, "test", check1.ID, false)
	s.FinishTest(ctx, "u1", check1.ID)
	check2, _ := s.CreateTest(ctx, "u1", "plan", "look", p.ID, []string{c}, 0)
	rec(c, "test", check2.ID, false) // 没做完
	other, _ := s.CreateTest(ctx, "u1", "all", "look", 0, []string{c}, 0)
	rec(c, "test", other.ID, false)
	s.FinishTest(ctx, "u1", other.ID)
	got, err := s.PlanMissed(ctx, "u1", p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("PlanMissed = %v, want [%s %s]", got, a, b)
	}
	if tt, _ := s.Test(ctx, "u1", check1.ID); tt.PlanID != p.ID || tt.Scope != "plan" {
		t.Fatalf("test = %+v", tt)
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
	tt, err := s.CreateTest(ctx, "u1", "all", "look", 0, []string{w}, 10)
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

// 学习顺序：学过的词跳过；从某个位置往后都学过了就从那里重新学；随机顺序每个人固定、是整个词库的一种排列。
func TestLearningOrder(t *testing.T) {
	_, deck, _ := newTestStore(t)
	alpha := deck.Ordered("alpha", "u1")
	if alpha[0].W != "a" || alpha[0].N != 1 {
		t.Fatalf("按字母第一个应是 a，实际 %s", alpha[0].W)
	}
	if frq := deck.Ordered("frq", "u1"); frq[0].F != 1 || frq[1].F != 2 {
		t.Fatalf("按词频应从最常用的开始")
	}
	learned := map[string]bool{alpha[0].W: true, alpha[2].W: true}
	got := Pick(alpha, 1, 3, learned)
	if len(got) != 3 || got[0] != alpha[1] || got[1] != alpha[3] || got[2] != alpha[4] {
		t.Fatalf("应跳过学过的词，实际 %v %v %v", got[0].W, got[1].W, got[2].W)
	}
	if n, w := NextPos(alpha, learned); n != 2 || w != alpha[1] {
		t.Fatalf("下一个应是第 2 个，实际 %d", n)
	}
	last := len(alpha)
	all := map[string]bool{alpha[last-1].W: true}
	if got := Pick(alpha, last, 5, all); len(got) != 1 || got[0] != alpha[last-1] {
		t.Fatalf("往后都学过了应从那里重新学")
	}
	r1, r2, r3 := deck.Ordered("random", "u1"), deck.Ordered("random", "u1"), deck.Ordered("random", "u2")
	seen := map[string]bool{}
	same := true
	for i := range r1 {
		seen[r1[i].W] = true
		if r1[i] != r2[i] {
			t.Fatal("同一个人的随机顺序每次应一样")
		}
		same = same && r1[i] == r3[i]
	}
	if len(seen) != len(deck.Words) || same {
		t.Fatal("随机顺序应是整个词库的一种排列，且不同的人不一样")
	}
}

// 干扰项：每类三个，和正确答案、彼此都不冲突（不同词、意思不重叠），拼写类读音和正确答案不同。
func TestChoices(t *testing.T) {
	_, deck, _ := newTestStore(t)
	rng := rand.New(rand.NewPCG(1, 2))
	short := 0
	initials := map[byte]int{}
	for _, w := range deck.Words {
		initials[w.W[0]]++
	}
	for i := range deck.Words {
		w := &deck.Words[i]
		c := deck.Choices(w, rng)
		if len(c.Meaning) < 3 || len(c.Prefix) < 3 || len(c.Spelling) < 3 {
			short++
			t.Logf("%s（%s）：%v %v %v", w.W, deck.meta[w.W].pos, c.Meaning, c.Prefix, c.Spelling)
		}
		for _, group := range [][]Option{c.Meaning, c.Prefix, c.Spelling} {
			picked := []*Word{w}
			for _, o := range group {
				x := deck.Get(o.W)
				if !deck.usable(x, picked) {
					t.Fatalf("%s 的干扰项 %s 和其他选项冲突", w.W, o.W)
				}
				picked = append(picked, x)
			}
		}
		// 同首字母的词够多时（z 开头的只有一两个），开头类干扰项都要和答案首字母相同。
		if initials[w.W[0]] >= 10 {
			for _, o := range c.Prefix {
				if o.W[0] != w.W[0] {
					t.Fatalf("%s 的开头类干扰项 %s 首字母不同", w.W, o.W)
				}
			}
		}
		for _, o := range c.Spelling {
			if sameSound(w, deck.Get(o.W)) {
				t.Fatalf("%s 的拼写干扰项 %s 读音相同", w.W, o.W)
			}
		}
	}
	if short > 0 {
		t.Fatalf("%d 个词凑不够三个干扰项", short)
	}
	if !deck.clash(deck.Get("big"), deck.Get("large")) {
		t.Fatal("big 和 large 意思重叠，不能互为干扰项")
	}
}

// 还原：设置回到默认值；清空进度只清自己的计划、复习、错题、检测，别人的和自己的设置都不动。
func TestReset(t *testing.T) {
	ctx := context.Background()
	s, deck, _ := newTestStore(t)
	st := defaultSettings()
	st.PlanWords = 7
	for _, u := range []string{"u1", "u2"} {
		if _, err := s.SaveSettings(ctx, u, st); err != nil {
			t.Fatal(err)
		}
		p, err := s.CreatePlan(ctx, u, deck.Range(1, 2), 2)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.Record(ctx, u, Answer{Word: p.Words[0], Kind: "plan", RefID: p.ID, Mode: "look", OK: false}, cn, 3); err != nil {
			t.Fatal(err)
		}
		if _, err := s.CreateTest(ctx, u, "all", "look", 0, p.Words, 2); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.ResetProgress(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	count := func(u string) (n int) {
		for _, table := range []string{"plans", "cards", "answers", "wrongs", "tests"} {
			var c int
			s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE user_id = ?`, u).Scan(&c)
			n += c
		}
		return n
	}
	if n := count("u1"); n != 0 {
		t.Fatalf("u1 还剩 %d 行进度", n)
	}
	if count("u2") == 0 {
		t.Fatal("别人的进度不该被清掉")
	}
	if got, _ := s.Settings(ctx, "u1"); got.PlanWords != 7 {
		t.Fatal("清空进度不该动设置")
	}
	if got, _ := s.ResetSettings(ctx, "u1"); got != defaultSettings() {
		t.Fatal("还原后应是默认设置")
	}
	if got, _ := s.Settings(ctx, "u1"); got != defaultSettings() {
		t.Fatal("还原后再读应是默认设置")
	}
	if got, _ := s.Settings(ctx, "u2"); got.PlanWords != 7 {
		t.Fatal("别人的设置不该被还原")
	}
}
