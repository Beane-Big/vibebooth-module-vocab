package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
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
