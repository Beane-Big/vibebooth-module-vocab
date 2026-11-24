package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// 升级后旧版中文和英文单字缓存必须重新合成，新音频仍应缓存复用。
func TestTTSCacheUpgrade(t *testing.T) {
	srv, calls := fakeTTS(t)
	dir := t.TempDir()
	speaker := newSpeaker(srv.URL, dir, &Deck{}, nil)

	cases := []struct {
		voice string
		text  string
	}{
		{"zf_001", "您有 Mac 或 PC 吗？"},
		{"af_heart", "large"},
	}
	for idx, tc := range cases {
		sum := sha256.Sum256([]byte(tc.text))
		name := hex.EncodeToString(sum[:])
		legacy := filepath.Join(dir, tc.voice, name[:2], name+".mp3")
		if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(legacy, []byte("legacy broken audio"), 0600); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			data, err := speaker.audio(context.Background(), tc.voice, tc.text)
			if err != nil {
				t.Fatal(err)
			}
			want := "mp3:" + tc.voice + ":" + tc.text
			if string(data) != want {
				t.Fatalf("old cached audio reused: got %q, want %q", data, want)
			}
		}
		if int(calls.Load()) != idx+1 {
			t.Fatalf("expected %d synthesis calls, got %d", idx+1, calls.Load())
		}
	}
}

// 真实播放请求必须优先于排队中的后台预取请求。
func TestTTSActivePriorityOverPrefetch(t *testing.T) {
	startedFirst := make(chan struct{})
	releaseFirst := make(chan struct{})
	var mu sync.Mutex
	var order []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Text, Voice string }
		json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		order = append(order, body.Text)
		first := len(order) == 1
		mu.Unlock()
		if first {
			close(startedFirst)
			<-releaseFirst
		}
		w.Write([]byte("mp3:" + body.Voice + ":" + body.Text))
	}))
	t.Cleanup(srv.Close)

	speaker := newSpeaker(srv.URL, t.TempDir(), &Deck{}, nil)
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		speaker.audioWithPriority(context.Background(), "af_heart", "first", true)
	}()
	<-startedFirst
	go func() {
		defer wg.Done()
		speaker.audioWithPriority(context.Background(), "af_heart", "prefetch-next", true)
	}()
	// 等后台预取进入等待队列后再发真实播放请求。
	for {
		speaker.mu.Lock()
		n := len(speaker.prefetchWaiters)
		speaker.mu.Unlock()
		if n == 1 {
			break
		}
	}
	go func() {
		defer wg.Done()
		speaker.audioWithPriority(context.Background(), "af_heart", "active-now", false)
	}()
	for {
		speaker.mu.Lock()
		n := len(speaker.activeWaiters)
		speaker.mu.Unlock()
		if n == 1 {
			break
		}
	}
	close(releaseFirst)
	wg.Wait()

	if len(order) != 3 || order[0] != "first" || order[1] != "active-now" || order[2] != "prefetch-next" {
		t.Fatalf("expected active request before queued prefetch, got order %v", order)
	}
}
