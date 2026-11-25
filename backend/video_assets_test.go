package main

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestVideoAssetUploadAndReplacement(t *testing.T) {
	ffmpeg := env("VIDEO_FFMPEG", "ffmpeg")
	ffprobe := env("VIDEO_FFPROBE", "ffprobe")
	if _, err := exec.LookPath(ffmpeg); err != nil {
		t.Skip("ffmpeg not installed")
	}
	if _, err := exec.LookPath(ffprobe); err != nil {
		t.Skip("ffprobe not installed")
	}
	source := filepath.Join(t.TempDir(), "silent.mp4")
	if data, err := exec.Command(ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=24", "-t", "0.25", "-an", "-c:v", "libx264", source).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, data)
	}
	input, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(filepath.Join(t.TempDir(), "assets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	v := &videoExporter{deck: &Deck{Words: make([]Word, 20)}, db: store.db, dir: t.TempDir()}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}
	upload := func(content []byte) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		file, err := form.CreateFormFile("file", "clip.mp4")
		if err != nil {
			t.Fatal(err)
		}
		file.Write(content)
		form.Close()
		request := httptest.NewRequest("POST", "/api/vocab/video/assets/intro", &body)
		request.Header.Set("Content-Type", form.FormDataContentType())
		request.SetPathValue("kind", "intro")
		response := httptest.NewRecorder()
		v.uploadAsset(response, request)
		return response
	}
	if response := upload(input); response.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", response.Code, response.Body)
	}
	first := v.assets["intro"]
	normalized := filepath.Join(v.dir, "assets", first.File)
	raw, err := exec.Command(ffprobe, "-v", "error", "-show_entries", "stream=codec_type,width,height,sample_rate,channels", "-of", "json", normalized).Output()
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		Streams []struct {
			Type     string `json:"codec_type"`
			Width    int    `json:"width"`
			Height   int    `json:"height"`
			Rate     string `json:"sample_rate"`
			Channels int    `json:"channels"`
		}
	}
	if err = json.Unmarshal(raw, &info); err != nil {
		t.Fatal(err)
	}
	video, audio := false, false
	for _, stream := range info.Streams {
		video = video || (stream.Type == "video" && stream.Width == 1080 && stream.Height == 1920)
		audio = audio || (stream.Type == "audio" && stream.Rate == "48000" && stream.Channels == 2)
	}
	if !video || !audio {
		t.Fatalf("not normalized, missing silent audio: %s", raw)
	}
	snapshot := t.TempDir()
	if err = v.copyAssetsLocked(snapshot); err != nil {
		t.Fatal(err)
	}
	if response := upload(input); response.Code != 200 {
		t.Fatal(response.Body)
	}
	current := v.assets["intro"]
	if current.File == first.File {
		t.Fatal("replacement reused filename")
	}
	if _, err = os.Stat(normalized); !os.IsNotExist(err) {
		t.Fatal("old asset retained")
	}
	if _, err = os.Stat(filepath.Join(snapshot, "intro-upload.mp4")); err != nil {
		t.Fatal("running export lost snapshot")
	}
	if response := upload([]byte("not a video")); response.Code != 400 {
		t.Fatalf("invalid upload accepted: %d", response.Code)
	}
	if v.assets["intro"].File != current.File {
		t.Fatal("failed upload changed current asset")
	}
	restored := &videoExporter{deck: v.deck, db: store.db, dir: v.dir}
	if err = restored.initialize(); err != nil {
		t.Fatal(err)
	}
	if restored.assets["intro"].File != current.File {
		t.Fatal("asset lost after restart")
	}
	request := httptest.NewRequest("DELETE", "/api/vocab/video/assets/intro", nil)
	request.SetPathValue("kind", "intro")
	response := httptest.NewRecorder()
	restored.removeAsset(response, request)
	if response.Code != 204 {
		t.Fatal(response.Body)
	}
	if restored.assets["intro"] != nil {
		t.Fatal("asset not removed")
	}
	if _, err = os.Stat(filepath.Join(v.dir, "assets", current.File)); !os.IsNotExist(err) {
		t.Fatal("removed asset remains on disk")
	}
}

// 超时或探测失败应直接失败，不产生可发布的文件。
func TestVideoAssetProbeCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := normalizeVideoAsset(ctx, "missing", "unused"); err == nil {
		t.Fatal("cancelled normalization succeeded")
	}
}

// 验证从片头视频截取指定时间点作为封面：入参校验、文件输出与读取、任务复制、重启恢复及移除。
func TestVideoCoverFromIntroFrame(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "assets.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	dir := t.TempDir()
	v := &videoExporter{deck: &Deck{Words: make([]Word, 10)}, db: store.db, dir: dir}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}

	// 未上传片头时不能设置封面。
	rec := httptest.NewRecorder()
	v.setCover(rec, httptest.NewRequest(http.MethodPost, "/api/vocab/video/assets/cover", bytes.NewBufferString(`{"time":2}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 without intro, got %d", rec.Code)
	}

	// 准备模拟片头与模拟 ffmpeg（记录参数并写出非空 JPEG 字节）。
	introFile := "clip-intro.mp4"
	if err = os.WriteFile(filepath.Join(dir, "assets", introFile), []byte("mp4"), 0600); err != nil {
		t.Fatal(err)
	}
	v.assets["intro"] = &videoAsset{File: introFile, Duration: 5.0, Size: 3}
	argsLog := filepath.Join(t.TempDir(), "ffmpeg-args.txt")
	fakeFFmpeg := filepath.Join(t.TempDir(), "fake-ffmpeg.sh")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + argsLog + "\nfor last; do :; done\nprintf 'JPEGDATA' > \"$last\"\n"
	if err = os.WriteFile(fakeFFmpeg, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_FFMPEG", fakeFFmpeg)

	// 负数时间点被拒绝。
	bad := httptest.NewRecorder()
	v.setCover(bad, httptest.NewRequest(http.MethodPost, "/api/vocab/video/assets/cover", bytes.NewBufferString(`{"time":-1}`)))
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative time, got %d", bad.Code)
	}

	// 截取 2.0 秒处的帧作为封面。
	ok := httptest.NewRecorder()
	v.setCover(ok, httptest.NewRequest(http.MethodPost, "/api/vocab/video/assets/cover", bytes.NewBufferString(`{"time":2}`)))
	if ok.Code != http.StatusOK {
		t.Fatalf("setCover: %d %s", ok.Code, ok.Body)
	}
	cover := v.assets["cover"]
	if cover == nil || cover.Duration != 2 || cover.Size != 8 {
		t.Fatalf("unexpected cover asset: %+v", cover)
	}
	loggedArgs, err := os.ReadFile(argsLog)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(loggedArgs, []byte("2.000")) {
		t.Fatalf("expected 2.000 timestamp in ffmpeg args, got %s", loggedArgs)
	}

	// 读取封面接口返回 image/jpeg。
	getReq := httptest.NewRequest(http.MethodGet, "/api/vocab/video/assets/cover", nil)
	getReq.SetPathValue("kind", "cover")
	getRec := httptest.NewRecorder()
	v.assetFile(getRec, getReq)
	if getRec.Code != http.StatusOK || getRec.Header().Get("Content-Type") != "image/jpeg" || getRec.Body.String() != "JPEGDATA" {
		t.Fatalf("assetFile cover: code=%d ct=%q body=%q", getRec.Code, getRec.Header().Get("Content-Type"), getRec.Body.String())
	}

	// 任务目录复制包含 cover-upload.jpg。
	jobDir := t.TempDir()
	if err = v.copyAssetsLocked(jobDir); err != nil {
		t.Fatal(err)
	}
	if copied, err := os.ReadFile(filepath.Join(jobDir, "cover-upload.jpg")); err != nil || string(copied) != "JPEGDATA" {
		t.Fatalf("copied cover mismatch: %v %q", err, copied)
	}

	// 重启后可从 SQLite 恢复封面，并可移除。
	restored := &videoExporter{deck: v.deck, db: store.db, dir: dir}
	if err = restored.initialize(); err != nil {
		t.Fatal(err)
	}
	if restored.assets["cover"] == nil || restored.assets["cover"].File != cover.File {
		t.Fatalf("cover lost after restart: %+v", restored.assets["cover"])
	}
	delReq := httptest.NewRequest(http.MethodDelete, "/api/vocab/video/assets/cover", nil)
	delReq.SetPathValue("kind", "cover")
	delRec := httptest.NewRecorder()
	restored.removeAsset(delRec, delReq)
	if delRec.Code != http.StatusNoContent || restored.assets["cover"] != nil {
		t.Fatalf("remove cover failed: %d", delRec.Code)
	}
}

