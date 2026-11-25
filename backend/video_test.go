package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// 验证成功才推进、共享进度重启恢复、旧任务重做不推进，以及末尾不越界。
func TestVideoSharedProgress(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "video.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	deck := &Deck{Words: make([]Word, 2598)}
	dir := t.TempDir()
	v := &videoExporter{deck: deck, db: store.db, dir: dir}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}
	if v.next != 1 || v.completed {
		t.Fatal("unexpected initial progress")
	}
	complete := func(from, count int, retry bool, renderErr error) *videoJob {
		t.Helper()
		id := int64(len(v.jobs) + 1)
		job := &videoJob{videoStatus: videoStatus{State: "running"}, ID: id, From: from, Count: count, Retry: retry, Words: []*Word{{W: "snapshot"}}, dir: filepath.Join(dir, strconv.FormatInt(id, 10))}
		if err := os.Mkdir(job.dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(job.dir, "video.mp4"), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		v.jobs = append([]*videoJob{job}, v.jobs...)
		v.finishLocked(job, renderErr)
		return job
	}
	first := complete(1, 20, false, nil)
	if v.next != 21 || first.State != "ready" || first.ExpiresAt == nil {
		t.Fatalf("first export: next=%d job=%+v", v.next, first)
	}
	complete(1, 20, true, nil)
	if v.next != 21 {
		t.Fatal("retry changed cursor")
	}
	complete(21, 20, false, errors.New("render failed"))
	if v.next != 21 {
		t.Fatal("failure advanced cursor")
	}
	complete(21, 20, false, nil)
	if v.next != 41 {
		t.Fatal("next export did not advance cursor")
	}
	complete(2581, 18, false, nil)
	if v.next != 2598 || !v.completed {
		t.Fatal("cursor exceeded deck end")
	}
	restored := &videoExporter{deck: deck, db: store.db, dir: dir}
	if err := restored.initialize(); err != nil {
		t.Fatal(err)
	}
	if restored.next != 2598 || !restored.completed || len(restored.jobs) != 5 || restored.jobs[0].Words[0].W != "snapshot" {
		t.Fatal("shared progress/history lost after restart")
	}
	for i := 1; i < len(restored.jobs); i++ {
		if restored.jobs[i-1].ID <= restored.jobs[i].ID {
			t.Fatal("history not newest first")
		}
	}
}

// 验证到期视频和重启中断任务会清除文件，但历史仍保留供重新生成。
func TestVideoExpiryAndInterruptedRecovery(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "video.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	dir := t.TempDir()
	v := &videoExporter{deck: &Deck{Words: make([]Word, 30)}, db: store.db, dir: dir}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	for id, state := range []string{"ready", "running"} {
		job := &videoJob{videoStatus: videoStatus{State: state}, ID: int64(id + 1), dir: filepath.Join(dir, strconv.FormatInt(int64(id+1), 10))}
		if id == 0 {
			job.ExpiresAt = &past
		}
		if err = os.Mkdir(job.dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(job.dir, "video.mp4"), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		v.jobs = append(v.jobs, job)
	}
	if err = v.saveLocked(); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(dir, "999"), 0700); err != nil {
		t.Fatal(err)
	}
	restored := &videoExporter{deck: v.deck, db: store.db, dir: dir}
	if err = restored.initialize(); err != nil {
		t.Fatal(err)
	}
	if restored.jobs[0].State != "expired" || restored.jobs[1].State != "failed" {
		t.Fatal("unexpected recovered states")
	}
	for _, job := range restored.jobs {
		if _, err = os.Stat(job.dir); !os.IsNotExist(err) {
			t.Fatal("expired/interrupted files remain")
		}
	}
	if _, err = os.Stat(filepath.Join(dir, "999")); !os.IsNotExist(err) {
		t.Fatal("orphan directory remains")
	}
	if restored.next != 1 {
		t.Fatal("restart advanced cursor")
	}
}

// 验证生成视频期间可以主动终止：杀死渲染进程组、清理中间目录、不推进进度，且终止后可继续新建任务。
func TestVideoCancelRunningExport(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	store, err := OpenStore(filepath.Join(t.TempDir(), "video.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()

	tts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("fake-mp3"))
	}))
	defer tts.Close()

	deck := &Deck{Words: []Word{{
		N:  1,
		W:  "apple",
		Zh: []string{"n. 苹果"},
		Ex: []Example{
			{En: "Eat an apple.", Zh: "吃一个苹果。"},
			{En: "The apple is red.", Zh: "这个苹果是红的。"},
		},
	}}}
	speech := newSpeaker(tts.URL, filepath.Join(t.TempDir(), "tts"), deck, Dict{})
	dir := t.TempDir()
	v := &videoExporter{deck: deck, speech: speech, db: store.db, dir: dir}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}

	// 没有正在运行的任务时，终止返回 409。
	idleResp := httptest.NewRecorder()
	v.stop(idleResp, httptest.NewRequest(http.MethodDelete, "/api/vocab/video", nil))
	if idleResp.Code != http.StatusConflict {
		t.Fatalf("expected 409 when idle, got %d", idleResp.Code)
	}

	// 模拟长时间渲染的 python 脚本，并拉起子进程以验证进程组一起被清理。
	childPIDFile := filepath.Join(t.TempDir(), "child.pid")
	renderer := filepath.Join(t.TempDir(), "fake-renderer.py")
	script := "import subprocess, sys, time\n" +
		"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n" +
		"open(" + strconv.Quote(childPIDFile) + ", 'w').write(str(p.pid))\n" +
		"time.sleep(60)\n"
	if err = os.WriteFile(renderer, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIDEO_RENDERER", renderer)

	startResp := httptest.NewRecorder()
	v.start(startResp, httptest.NewRequest(http.MethodPost, "/api/vocab/video", strings.NewReader(`{"from":1,"count":1}`)))
	if startResp.Code != http.StatusAccepted {
		t.Fatalf("start: %d %s", startResp.Code, startResp.Body)
	}

	// 等待渲染脚本启动并写入子进程 PID。
	deadline := time.Now().Add(5 * time.Second)
	var childPID int
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(childPIDFile); err == nil && len(raw) > 0 {
			if pid, parseErr := strconv.Atoi(strings.TrimSpace(string(raw))); parseErr == nil {
				childPID = pid
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("renderer did not start in time")
	}

	stopResp := httptest.NewRecorder()
	v.stop(stopResp, httptest.NewRequest(http.MethodDelete, "/api/vocab/video", nil))
	if stopResp.Code != http.StatusNoContent {
		t.Fatalf("stop: %d %s", stopResp.Code, stopResp.Body)
	}

	v.mu.Lock()
	running := v.running
	next := v.next
	job := v.jobs[0]
	v.mu.Unlock()
	if running {
		t.Fatal("exporter still marked running after stop")
	}
	if next != 1 {
		t.Fatalf("cancel advanced cursor to %d", next)
	}
	if job.State != "canceled" {
		t.Fatalf("expected canceled state, got %s", job.State)
	}
	if _, err = os.Stat(job.dir); !os.IsNotExist(err) {
		t.Fatal("canceled job directory was not removed")
	}

	// 验证子进程也已退出（等待内核回收极短时间）。
	killDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(killDeadline) {
		if err := syscall.Kill(childPID, 0); errors.Is(err, syscall.ESRCH) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(childPID, 0); !errors.Is(err, syscall.ESRCH) {
		_ = syscall.Kill(childPID, syscall.SIGKILL)
		t.Fatalf("child process %d still alive after cancel: %v", childPID, err)
	}

	// 重启恢复后仍保留 canceled 状态。
	restored := &videoExporter{deck: deck, speech: speech, db: store.db, dir: dir}
	if err = restored.initialize(); err != nil {
		t.Fatal(err)
	}
	if len(restored.jobs) != 1 || restored.jobs[0].State != "canceled" || restored.next != 1 {
		t.Fatalf("unexpected restored state after cancel: next=%d jobs=%+v", restored.next, restored.jobs)
	}
}

// 验证自定义视频名称、可选拼接词序号范围、下载头编码以及重试复用名称。
func TestVideoCustomNameAndDownloadHeader(t *testing.T) {
	if got := sanitizeVideoName("  每日背单词.MP4  "); got != "每日背单词" {
		t.Fatalf("sanitize .mp4: got %q", got)
	}
	if got := sanitizeVideoName(`a/b\c:d*e?f"g<h>i|j`); got != "abcdefghij" {
		t.Fatalf("sanitize invalid chars: got %q", got)
	}
	if got := videoDownloadDisposition(7, ""); got != `attachment; filename="vocab-7.mp4"` {
		t.Fatalf("default disposition: got %q", got)
	}
	if got := videoDownloadDisposition(7, "daily-1-5"); got != `attachment; filename="daily-1-5.mp4"; filename*=UTF-8''daily-1-5.mp4` {
		t.Fatalf("ascii disposition: got %q", got)
	}
	if got := videoDownloadDisposition(7, "高频词-1-20"); !strings.Contains(got, `filename="vocab-7.mp4"`) || !strings.Contains(got, `filename*=UTF-8''%E9%AB%98%E9%A2%91%E8%AF%8D-1-20.mp4`) {
		t.Fatalf("unicode disposition: got %q", got)
	}

	store, err := OpenStore(filepath.Join(t.TempDir(), "video.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	words := make([]Word, 25)
	for i := range words {
		words[i] = Word{
			N:  i + 1,
			W:  "apple",
			Zh: []string{"n. 苹果"},
			Ex: []Example{
				{En: "Eat an apple.", Zh: "吃一个苹果。"},
				{En: "The apple is red.", Zh: "这个苹果是红的。"},
			},
		}
	}
	deck := &Deck{Words: words}
	tts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("fake-mp3"))
	}))
	defer tts.Close()
	speech := newSpeaker(tts.URL, filepath.Join(t.TempDir(), "tts"), deck, Dict{})
	dir := t.TempDir()
	v := &videoExporter{deck: deck, speech: speech, db: store.db, dir: dir}
	if err = v.initialize(); err != nil {
		t.Fatal(err)
	}

	// 验证不拼接范围时保持原名称，拼接范围时追加 -from-to，并在下载头中生效。
	cases := []struct {
		body     string
		wantName string
	}{
		{`{"from":1,"count":10,"name":"高频词","appendRange":false}`, "高频词"},
		{`{"from":11,"count":10,"name":"高频词","appendRange":true}`, "高频词-11-20"},
		{`{"from":21,"count":5,"name":"","appendRange":true}`, ""},
	}
	t.Setenv("VIDEO_RENDERER", filepath.Join(t.TempDir(), "missing.py"))
	for i, tc := range cases {
		rec := httptest.NewRecorder()
		v.start(rec, httptest.NewRequest(http.MethodPost, "/api/vocab/video", strings.NewReader(tc.body)))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("case %d start: %d %s", i, rec.Code, rec.Body)
		}
		v.mu.Lock()
		done := v.done
		job := v.jobs[0]
		v.mu.Unlock()
		if done != nil {
			<-done
		}
		if job.Name != tc.wantName {
			t.Fatalf("case %d: want name %q, got %q", i, tc.wantName, job.Name)
		}
	}

	// 准备就绪后验证下载接口返回正确的 Content-Disposition。
	v.mu.Lock()
	job := v.jobs[1] // 高频词-11-20
	job.State = "ready"
	if err = os.MkdirAll(job.dir, 0700); err != nil {
		v.mu.Unlock()
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(job.dir, "video.mp4"), []byte("mp4"), 0600); err != nil {
		v.mu.Unlock()
		t.Fatal(err)
	}
	v.mu.Unlock()

	dl := httptest.NewRecorder()
	v.download(dl, httptest.NewRequest(http.MethodGet, "/api/vocab/video/file?id="+strconv.FormatInt(job.ID, 10)+"&download=1", nil))
	if dl.Code != http.StatusOK {
		t.Fatalf("download: %d %s", dl.Code, dl.Body)
	}
	if got := dl.Header().Get("Content-Disposition"); !strings.Contains(got, "%E9%AB%98%E9%A2%91%E8%AF%8D-11-20.mp4") {
		t.Fatalf("unexpected download header: %q", got)
	}
}

