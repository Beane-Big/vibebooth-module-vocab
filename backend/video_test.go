package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
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
