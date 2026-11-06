package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

// 假的语音容器：返回 "mp3:<voice>:<text>"，并数一共合成了几次。
func fakeTTS(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Text, Voice string }
		json.NewDecoder(r.Body).Decode(&body)
		calls.Add(1)
		w.Write([]byte("mp3:" + body.Voice + ":" + body.Text))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func ttsMux(t *testing.T, ttsURL string) *http.ServeMux {
	t.Helper()
	deck, err := LoadDeck(coreDeck)
	if err != nil {
		t.Fatal(err)
	}
	dict, err := LoadDict(dictData)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	newSpeaker(ttsURL, t.TempDir(), deck, dict).register(mux)
	return mux
}

func getTTS(mux *http.ServeMux, voice, text string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/vocab/tts?voice="+voice+"&text="+url.QueryEscape(text), nil))
	return rec
}

func TestTTSCache(t *testing.T) {
	srv, calls := fakeTTS(t)
	mux := ttsMux(t, srv.URL)
	deck, _ := LoadDeck(coreDeck)
	sentence := deck.Words[0].Ex[0].En

	for range 2 {
		rec := getTTS(mux, "af_heart", sentence)
		if rec.Code != 200 || rec.Body.String() != "mp3:af_heart:"+sentence {
			t.Fatalf("got %d %q", rec.Code, rec.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("同一句应该只合成一次，合成了 %d 次", calls.Load())
	}
	// 单词不分大小写，共用一份。
	getTTS(mux, "bf_emma", "The")
	if rec := getTTS(mux, "bf_emma", "the"); rec.Body.String() != "mp3:bf_emma:the" || calls.Load() != 2 {
		t.Fatalf("The 和 the 应该共用: %q, calls %d", rec.Body.String(), calls.Load())
	}
	// 不同声音分开存。
	if getTTS(mux, "af_heart", "the"); calls.Load() != 3 {
		t.Fatalf("换声音要重新合成, calls %d", calls.Load())
	}
}

func TestTTSRejects(t *testing.T) {
	srv, calls := fakeTTS(t)
	mux := ttsMux(t, srv.URL)
	for _, c := range [][2]string{{"af_heart", "please read this random text aloud"}, {"xx_nobody", "the"}, {"af_heart", ""}} {
		if rec := getTTS(mux, c[0], c[1]); rec.Code != 400 {
			t.Fatalf("%v: got %d, want 400", c, rec.Code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("不该请求语音容器")
	}
}

func TestTTSDown(t *testing.T) {
	srv, _ := fakeTTS(t)
	srv.Close()
	if rec := getTTS(ttsMux(t, srv.URL), "af_heart", sampleText); rec.Code != 503 {
		t.Fatalf("语音容器不可用时应该返回 503，got %d", rec.Code)
	}
}

func TestTTSFailedSentence(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "synthesis failed", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	if rec := getTTS(ttsMux(t, srv.URL), "af_heart", sampleText); rec.Code != 502 {
		t.Fatalf("语音容器只是这一句失败时应该返回 502，got %d", rec.Code)
	}
}

// 中文声音只读释义（去掉词性）和例句翻译；英文声音不读中文，中文声音也不读英文。
func TestTTSChinese(t *testing.T) {
	srv, _ := fakeTTS(t)
	mux := ttsMux(t, srv.URL)
	deck, _ := LoadDeck(coreDeck)
	w := deck.Words[0]
	meaning := posRe.ReplaceAllString(w.Zh[0], "")
	for _, text := range []string{meaning, w.Ex[0].Zh} {
		if rec := getTTS(mux, "zh_chaowen", text); rec.Code != 200 {
			t.Fatalf("%q: %d", text, rec.Code)
		}
	}
	for _, c := range []struct{ voice, text string }{
		{"zh_chaowen", w.Zh[0]},  // 带词性的原文不读
		{"zh_chaowen", w.W},      // 中文声音不读英文
		{"af_heart", w.Ex[0].Zh}, // 英文声音不读中文
		{"zh_chaowen", "随便一句话"},
	} {
		if rec := getTTS(mux, c.voice, c.text); rec.Code != 400 {
			t.Fatalf("%s %q 应该被拒绝，得到 %d", c.voice, c.text, rec.Code)
		}
	}
}
