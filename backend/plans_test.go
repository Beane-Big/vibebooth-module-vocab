package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

// 新建计划不带参数时按个人设置：学几个词、几条例句、从第几个词开始；“从第几个开始”用过一次就回到接着学。
func TestCreatePlanFromSettings(t *testing.T) {
	ctx := context.Background()
	s, deck, _ := newTestStore(t)
	dict, err := LoadDict(dictData)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	newHandlers(deck, dict, s).register(mux)
	h := auth.Standalone("测试")(mux) // 独立模式下的用户 id 是 local

	st := defaultSettings()
	st.PlanWords, st.Examples, st.StartN = 5, 3, 100
	if _, err := s.SaveSettings(ctx, "local", st); err != nil {
		t.Fatal(err)
	}
	create := func() Plan {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/vocab/plans", strings.NewReader("{}")))
		if rec.Code != http.StatusCreated {
			t.Fatalf("新建计划失败：%d %s", rec.Code, rec.Body.String())
		}
		var out struct{ Item Plan }
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out.Item
	}

	p := create()
	if p.FirstN != 100 || len(p.Words) != 5 || p.Examples != 3 {
		t.Fatalf("应按设置从第 100 个学 5 个词、3 条例句，实际 %+v", p)
	}
	if got, _ := s.Settings(ctx, "local"); got.StartN != 0 {
		t.Fatalf("用过之后起始序号应回到 0，实际 %d", got.StartN)
	}
	if p := create(); p.FirstN == 100 {
		t.Fatalf("第二个计划应接着上次，而不是又从第 100 个开始")
	}
}

// 检测可以选几种题型，逗号隔开，不能重复，speak 已经不出了。
func TestValidModes(t *testing.T) {
	for list, want := range map[string]bool{"look": true, "look,write,translate": true, "look,look": false, "": false, "speak": false, "look,": false} {
		if got := validModes(list); got != want {
			t.Errorf("validModes(%q) = %v", list, got)
		}
	}
}

func TestLearnedPlanTestIncludesAllWordsOnEveryAttempt(t *testing.T) {
	ctx := context.Background()
	store, deck, _ := newTestStore(t)
	plan, err := store.CreatePlan(ctx, "local", []*Word{&deck.Words[0], &deck.Words[1]}, 2)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	newHandlers(deck, nil, store).register(mux)
	handler := auth.Standalone("测试")(mux)
	start := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		body := fmt.Sprintf(`{"scope":"learned","plan":%d,"count":1,"mode":"look"}`, plan.ID)
		handler.ServeHTTP(rec, httptest.NewRequest("POST", "/api/vocab/tests", strings.NewReader(body)))
		return rec
	}
	if rec := start(); rec.Code != http.StatusBadRequest {
		t.Fatalf("unfinished plan: got %d %s", rec.Code, rec.Body.String())
	}
	if _, err := store.FinishPlan(ctx, "local", plan.ID); err != nil {
		t.Fatal(err)
	}
	var previousID int
	for range 2 {
		rec := start()
		var out struct{ Item Test }
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if rec.Code != http.StatusCreated || out.Item.ID <= previousID || out.Item.PlanID != plan.ID || len(out.Item.Words) != 2 {
			t.Fatalf("expected a new test with all plan words, got %d %s", rec.Code, rec.Body.String())
		}
		previousID = out.Item.ID
		if _, err := store.FinishTest(ctx, "local", previousID); err != nil {
			t.Fatal(err)
		}
	}
}
