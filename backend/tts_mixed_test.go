package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

// 升级后旧中文缓存必须重新合成，新音频仍应缓存复用。
func TestTTSMixedChineseCacheUpgrade(t *testing.T) {
	srv, calls := fakeTTS(t)
	dir := t.TempDir()
	speaker := newSpeaker(srv.URL, dir, &Deck{}, nil)
	text := "您有 Mac 或 PC 吗？"
	sum := sha256.Sum256([]byte(text))
	name := hex.EncodeToString(sum[:])
	legacy := filepath.Join(dir, "zh_chaowen", name[:2], name+".mp3")
	if err := os.MkdirAll(filepath.Dir(legacy), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte("legacy broken audio"), 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		data, err := speaker.audio(context.Background(), "zh_chaowen", text)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "mp3:zh_chaowen:"+text {
			t.Fatalf("old cached audio reused: %q", data)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one synthesis, got %d", calls.Load())
	}
}
