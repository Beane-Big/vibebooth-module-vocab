package main

import (
	"context"
	"encoding/json"
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
