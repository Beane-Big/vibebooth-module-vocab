// 背单词 的后端。网关已经校验过登录，这里用 SDK 拿到当前用户；每个人的进度存在本模块卷里的 SQLite 文件，词库内置只读。
package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const moduleID = "vocab"

// routes 收集其他文件注册的对内接口：npx github:Beane-Big/create-vibebooth add 加的示例文件用它把接口挂上来。
var routes []func(api *http.ServeMux)

func main() {
	deck, err := LoadDeck(coreDeck)
	if err != nil {
		slog.Error("加载词库失败", "err", err)
		os.Exit(1)
	}
	dict, err := LoadDict(dictData)
	if err != nil {
		slog.Error("加载词典失败", "err", err)
		os.Exit(1)
	}
	dataDir := env("DATA_DIR", "/data")
	store, err := OpenStore(filepath.Join(dataDir, "vocab.db"))
	if err != nil {
		slog.Error("打开数据库失败", "err", err)
		os.Exit(1)
	}
	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), moduleID)

	api := http.NewServeMux()
	newHandlers(deck, dict, store).register(api)
	newSpeaker(env("TTS_URL", "http://vocab-tts:8880"), filepath.Join(dataDir, "tts"), deck, dict).register(api)
	for _, add := range routes {
		add(api)
	}

	// 独立模式（npm run standalone）：离开平台单独运行时不校验令牌，当成一个拥有全部权限的本地用户。平台不会设这个变量。
	guard := verifier.Middleware
	if os.Getenv("STANDALONE") == "1" {
		slog.Warn("独立模式：不校验令牌，所有请求都是拥有全部权限的本地用户")
		guard = auth.Standalone("本地用户")
	}

	mux := http.NewServeMux()
	// 健康检查由平台在内部网络直接调用，不经过网关，也不需要令牌。
	mux.HandleFunc("GET /api/vocab/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/api/vocab/", guard(api))

	srv := &http.Server{Addr: ":8000", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("vocab 模块已启动", "addr", srv.Addr, "words", len(deck.Words))
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("服务退出", "err", err)
		os.Exit(1)
	}
}

type handlers struct {
	deck  *Deck
	dict  Dict
	store *Store
}

func newHandlers(deck *Deck, dict Dict, store *Store) *handlers {
	return &handlers{deck: deck, dict: dict, store: store}
}

// 所有对内接口。每个人只能读写自己的数据：用户 id 一律取令牌里的 sub，不从请求里读。
func (h *handlers) register(api *http.ServeMux) {
	api.HandleFunc("GET /api/vocab/me", func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserFrom(r.Context())
		writeJSON(w, http.StatusOK, map[string]any{"name": user.Name, "menus": user.Menus, "perms": user.Perms, "all": user.All})
	})

	// 首页：设置、进度、当前计划和统计一次取回。
	api.HandleFunc("GET /api/vocab/home", func(w http.ResponseWriter, r *http.Request) {
		user := userID(r)
		st, err := h.store.Settings(r.Context(), user)
		if fail(w, err) {
			return
		}
		next, err := h.store.NextN(r.Context(), user)
		if fail(w, err) {
			return
		}
		plan, err := h.store.CurrentPlan(r.Context(), user)
		if fail(w, err) {
			return
		}
		stats, err := h.store.Stats(r.Context(), user, tz(r))
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"settings": st, "deck": map[string]any{"name": h.deck.Name, "total": len(h.deck.Words)},
			"nextN": next, "plan": plan, "stats": stats,
		})
	})

	api.HandleFunc("GET /api/vocab/settings", func(w http.ResponseWriter, r *http.Request) {
		st, err := h.store.Settings(r.Context(), userID(r))
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, st)
	})
	api.HandleFunc("PUT /api/vocab/settings", func(w http.ResponseWriter, r *http.Request) {
		var in Settings
		if !decode(w, r, &in) {
			return
		}
		st, err := h.store.SaveSettings(r.Context(), userID(r), in)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, st)
	})

	// 词库：按序号翻页（选起始位置时用），或按单词取。
	api.HandleFunc("GET /api/vocab/words", func(w http.ResponseWriter, r *http.Request) {
		from, _ := strconv.Atoi(r.URL.Query().Get("from"))
		count, _ := strconv.Atoi(r.URL.Query().Get("count"))
		writeJSON(w, http.StatusOK, h.deck.Range(from, max(1, min(100, count))))
	})

	// 点例句里的词时查音标和释义；查不到返回 404，前端显示“词典里没有这个词”。
	api.HandleFunc("GET /api/vocab/lookup", func(w http.ResponseWriter, r *http.Request) {
		e := h.dict.Lookup(h.deck, r.URL.Query().Get("w"))
		if e == nil {
			writeError(w, http.StatusNotFound, "词典里没有这个词")
			return
		}
		writeJSON(w, http.StatusOK, e)
	})

	// ---- 学习计划
	api.HandleFunc("POST /api/vocab/plans", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			From     int `json:"from"` // 从第几个词开始，不填时接着上次
			Count    int `json:"count"`
			Examples int `json:"examples"`
		}
		if !decode(w, r, &in) {
			return
		}
		user := userID(r)
		if in.From <= 0 {
			n, err := h.store.NextN(r.Context(), user)
			if fail(w, err) {
				return
			}
			in.From = n
		}
		if in.Count < 1 || in.Count > 100 {
			writeError(w, http.StatusBadRequest, "每个计划学 1 到 100 个词")
			return
		}
		if in.Examples < 2 || in.Examples > 5 {
			writeError(w, http.StatusBadRequest, "每个词 2 到 5 条例句")
			return
		}
		plan, err := h.store.CreatePlan(r.Context(), user, h.deck.Range(in.From, in.Count), in.Examples)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, h.withWords(plan, plan.Words, nil))
	})
	api.HandleFunc("GET /api/vocab/plans", func(w http.ResponseWriter, r *http.Request) {
		list, err := h.store.Plans(r.Context(), userID(r))
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, list)
	})
	api.HandleFunc("GET /api/vocab/plans/{id}", func(w http.ResponseWriter, r *http.Request) {
		user := userID(r)
		id, _ := strconv.Atoi(r.PathValue("id"))
		plan, err := h.store.Plan(r.Context(), user, id)
		if fail(w, err) {
			return
		}
		missed, err := h.store.Missed(r.Context(), user, "plan", id)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, h.withWords(plan, plan.Words, missed))
	})
	api.HandleFunc("PUT /api/vocab/plans/{id}", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Pos     int  `json:"pos"`
			Learned bool `json:"learned"`
		}
		if !decode(w, r, &in) {
			return
		}
		id, _ := strconv.Atoi(r.PathValue("id"))
		if fail(w, h.store.SavePlanPos(r.Context(), userID(r), id, max(0, in.Pos), in.Learned)) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	api.HandleFunc("POST /api/vocab/plans/{id}/finish", func(w http.ResponseWriter, r *http.Request) {
		user := userID(r)
		id, _ := strconv.Atoi(r.PathValue("id"))
		plan, err := h.store.FinishPlan(r.Context(), user, id)
		if fail(w, err) {
			return
		}
		missed, err := h.store.Missed(r.Context(), user, "plan", id)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, h.withWords(plan, plan.Words, missed))
	})

	// ---- 作答：计划测试、复习、检测都走这里
	api.HandleFunc("POST /api/vocab/answers", func(w http.ResponseWriter, r *http.Request) {
		var in Answer
		if !decode(w, r, &in) {
			return
		}
		if h.deck.Get(in.Word) == nil {
			writeError(w, http.StatusBadRequest, "词库里没有这个词")
			return
		}
		if !validMode(in.Mode) {
			writeError(w, http.StatusBadRequest, "未知的题型")
			return
		}
		user := userID(r)
		st, err := h.store.Settings(r.Context(), user)
		if fail(w, err) {
			return
		}
		err = h.store.Record(r.Context(), user, in, tz(r), st.WrongClear)
		var bad BadInput
		if errors.As(err, &bad) {
			writeError(w, http.StatusBadRequest, bad.Error())
			return
		}
		if fail(w, err) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// ---- 每日复习
	api.HandleFunc("GET /api/vocab/review", func(w http.ResponseWriter, r *http.Request) {
		words, total, err := h.store.Due(r.Context(), userID(r), tz(r), 200)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"total": total, "words": h.deck.Lookup(words)})
	})

	// ---- 错题本
	api.HandleFunc("GET /api/vocab/wrongs", func(w http.ResponseWriter, r *http.Request) {
		list, err := h.store.Wrongs(r.Context(), userID(r), r.URL.Query().Get("cleared") == "1")
		if fail(w, err) {
			return
		}
		type item struct {
			Wrong
			Data *Word `json:"data"`
		}
		out := []item{}
		for _, x := range list {
			if d := h.deck.Get(x.Word); d != nil {
				out = append(out, item{x, d})
			}
		}
		writeJSON(w, http.StatusOK, out)
	})
	api.HandleFunc("DELETE /api/vocab/wrongs/{word}", func(w http.ResponseWriter, r *http.Request) {
		if fail(w, h.store.ClearWrong(r.Context(), userID(r), r.PathValue("word"))) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// ---- 检测
	api.HandleFunc("POST /api/vocab/tests", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Scope string `json:"scope"` // recent（最近 7 天学的）、range（序号范围）、all（全部学过的）、wrong（错题本）
			From  int    `json:"from"`
			To    int    `json:"to"`
			Count int    `json:"count"`
			Mode  string `json:"mode"`
		}
		if !decode(w, r, &in) {
			return
		}
		if !validMode(in.Mode) {
			writeError(w, http.StatusBadRequest, "未知的题型")
			return
		}
		user := userID(r)
		var candidates []string
		var err error
		switch in.Scope {
		case "recent":
			candidates, err = h.store.Learned(r.Context(), user, time.Now().UTC().AddDate(0, 0, -7))
		case "all", "range":
			candidates, err = h.store.Learned(r.Context(), user, time.Time{})
			if in.Scope == "range" {
				kept := candidates[:0]
				for _, w := range candidates {
					if d := h.deck.Get(w); d != nil && d.N >= in.From && d.N <= in.To {
						kept = append(kept, w)
					}
				}
				candidates = kept
			}
		case "wrong":
			var list []Wrong
			list, err = h.store.Wrongs(r.Context(), user, false)
			for _, x := range list {
				candidates = append(candidates, x.Word)
			}
		default:
			writeError(w, http.StatusBadRequest, "未知的检测范围")
			return
		}
		if fail(w, err) {
			return
		}
		test, err := h.store.CreateTest(r.Context(), user, in.Scope, in.Mode, h.known(candidates), in.Count)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, h.withWords(test, test.Words, nil))
	})
	api.HandleFunc("GET /api/vocab/tests", func(w http.ResponseWriter, r *http.Request) {
		list, err := h.store.Tests(r.Context(), userID(r))
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, list)
	})
	api.HandleFunc("GET /api/vocab/tests/{id}", func(w http.ResponseWriter, r *http.Request) {
		user := userID(r)
		id, _ := strconv.Atoi(r.PathValue("id"))
		test, err := h.store.Test(r.Context(), user, id)
		if fail(w, err) {
			return
		}
		missed, err := h.store.Missed(r.Context(), user, "test", id)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, h.withWords(test, test.Words, missed))
	})
	api.HandleFunc("POST /api/vocab/tests/{id}/finish", func(w http.ResponseWriter, r *http.Request) {
		user := userID(r)
		id, _ := strconv.Atoi(r.PathValue("id"))
		test, err := h.store.FinishTest(r.Context(), user, id)
		if fail(w, err) {
			return
		}
		missed, err := h.store.Missed(r.Context(), user, "test", id)
		if fail(w, err) {
			return
		}
		writeJSON(w, http.StatusOK, h.withWords(test, test.Words, missed))
	})
}

// withWords 把计划或检测连同词条一起返回，前端不用再查；missed 是答错的词。
func (h *handlers) withWords(v any, words, missed []string) map[string]any {
	return map[string]any{"item": v, "words": h.deck.Lookup(words), "missed": h.deck.Lookup(missed)}
}

// known 去掉词库更新后已经不存在的词。
func (h *handlers) known(words []string) []string {
	out := []string{}
	for _, w := range words {
		if h.deck.Get(w) != nil {
			out = append(out, w)
		}
	}
	return out
}

func validMode(m string) bool {
	return m == "listen" || m == "look" || m == "speak" || m == "dictation"
}

func userID(r *http.Request) string { return auth.UserFrom(r.Context()).ID }

// tz 是前端传来的时区（JavaScript getTimezoneOffset() 的分钟数），“今天”按它算。
func tz(r *http.Request) int {
	v, err := strconv.Atoi(r.URL.Query().Get("tz"))
	if err != nil || v < -840 || v > 720 {
		return -480 // 默认北京时间
	}
	return v
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式不对")
		return false
	}
	return true
}

// fail 处理读写数据库的错误，有错误时写好响应并返回 true。
func fail(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, ErrNotFound):
		writeError(w, http.StatusNotFound, "没有找到")
	default:
		slog.Error("处理请求失败", "err", err)
		writeError(w, http.StatusInternalServerError, "服务器出错了")
	}
	return true
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
