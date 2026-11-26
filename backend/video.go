package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const videoPermission = "video-export"

type videoStatus struct {
	State string `json:"state"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type videoChapter struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Title string  `json:"title"`
}

// 视频历史共享保存。词表快照用于过期重做，避免词库更新改变旧视频内容。
type videoJob struct {
	videoStatus
	ID        int64          `json:"id"`
	From      int            `json:"from"`
	Count     int            `json:"count"`
	Name      string         `json:"name,omitempty"`
	Chapters  []videoChapter `json:"chapters,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
	ExpiresAt *time.Time     `json:"expiresAt,omitempty"`
	Retry     bool           `json:"retry"`
	Words     []*Word        `json:"-"`
	dir       string
}

type savedVideoJob struct {
	Job   videoJob `json:"job"`
	Words []*Word  `json:"words"`
}

type videoState struct {
	Next      int         `json:"next"`
	Completed bool        `json:"completed"`
	Jobs      []*videoJob `json:"jobs"`
	Total     int         `json:"total"`
}

type videoPage struct {
	Word    *Word    `json:"word"`
	Example int      `json:"example"`
	Index   int      `json:"index"`
	From    int      `json:"from"`
	Audio   []string `json:"audio"`
}

type videoExporter struct {
	deck      *Deck
	speech    *speaker
	db        *sql.DB
	dir       string
	mu        sync.Mutex // 状态、文件清理和新任务占位由同一把锁保护。
	running   bool
	cancel    context.CancelFunc
	canceled  bool
	done      chan struct{}
	next      int
	completed bool
	jobs      []*videoJob
	assets    map[string]*videoAsset
	assetBusy bool
}

// initialize 从 SQLite 恢复历史，重启中断的任务标为失败，成片按到期时间清理。
func (v *videoExporter) initialize() error {
	if err := os.MkdirAll(v.dir, 0700); err != nil {
		return err
	}
	if _, err := v.db.Exec("CREATE TABLE IF NOT EXISTS video_exports (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)"); err != nil {
		return err
	}
	var data string
	err := v.db.QueryRow("SELECT data FROM video_exports WHERE id=1").Scan(&data)
	v.next = 1
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		var saved struct {
			Next      int
			Completed bool
			Jobs      []savedVideoJob
		}
		if err = json.Unmarshal([]byte(data), &saved); err != nil {
			return err
		}
		v.next = saved.Next
		v.completed = saved.Completed
		for _, record := range saved.Jobs {
			job := &record.Job
			job.Words = record.Words
			job.dir = filepath.Join(v.dir, strconv.FormatInt(job.ID, 10))
			if job.State == "running" {
				job.State = "failed"
			}
			v.jobs = append(v.jobs, job)
		}
	}
	// 崩溃可能发生在建目录后、写记录前，启动时清理这些没有历史关联的目录。
	known := make(map[string]bool)
	for _, job := range v.jobs {
		known[strconv.FormatInt(job.ID, 10)] = true
	}
	entries, err := os.ReadDir(v.dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if _, parseErr := strconv.ParseInt(entry.Name(), 10, 64); parseErr == nil && !known[entry.Name()] {
			if err := os.RemoveAll(filepath.Join(v.dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	if err := v.loadAssets(); err != nil {
		return err
	}
	v.next = max(1, min(v.next, len(v.deck.Words)))
	v.cleanupLocked(time.Now())
	if err = v.saveLocked(); err != nil {
		return err
	}
	go func() {
		for now := range time.NewTicker(time.Minute).C {
			v.mu.Lock()
			v.cleanupLocked(now)
			if err := v.saveLocked(); err != nil {
				slog.Error("保存视频过期状态失败", "err", err)
			}
			v.mu.Unlock()
		}
	}()
	return nil
}

func (v *videoExporter) saveLocked() error {
	saved := struct {
		Next      int
		Completed bool
		Jobs      []savedVideoJob
	}{Next: v.next, Completed: v.completed}
	for _, job := range v.jobs {
		saved.Jobs = append(saved.Jobs, savedVideoJob{*job, job.Words})
	}
	data, err := json.Marshal(saved)
	if err != nil {
		return err
	}
	_, err = v.db.Exec("INSERT INTO video_exports(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", string(data))
	return err
}

// 先删除过期文件，再更新状态。失败时保留到期时间，下次清理继续重试。
func (v *videoExporter) cleanupLocked(now time.Time) {
	for _, job := range v.jobs {
		if job.State == "running" {
			continue
		}
		expired := job.ExpiresAt != nil && !now.Before(*job.ExpiresAt)
		if expired || job.State == "failed" || job.State == "canceled" || job.State == "expired" {
			if err := os.RemoveAll(job.dir); err != nil {
				slog.Warn("清理视频文件失败", "id", job.ID, "err", err)
				continue
			}
			if expired {
				job.State = "expired"
			}
		} else if job.State == "ready" {
			if _, err := os.Stat(filepath.Join(job.dir, "video.mp4")); os.IsNotExist(err) {
				job.State = "expired"
			}
		}
	}
}

func (v *videoExporter) register(api *http.ServeMux) {
	guard := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			user := auth.UserFrom(r.Context())
			if user == nil || user.All || !user.Has(videoPermission) {
				writeError(w, http.StatusForbidden, "没有视频导出权限")
				return
			}
			w.Header().Set("Cache-Control", "private, no-store")
			fn(w, r)
		}
	}
	api.HandleFunc("POST /api/vocab/video", guard(v.start))
	api.HandleFunc("GET /api/vocab/video", guard(v.status))
	api.HandleFunc("DELETE /api/vocab/video", guard(v.stop))
	api.HandleFunc("DELETE /api/vocab/video/{id}", guard(v.remove))
	api.HandleFunc("GET /api/vocab/video/file", guard(v.download))
	api.HandleFunc("GET /api/vocab/video/assets", guard(v.assetStatus))
	api.HandleFunc("POST /api/vocab/video/assets/cover", guard(v.setCover))
	api.HandleFunc("POST /api/vocab/video/assets/{kind}", guard(v.uploadAsset))
	api.HandleFunc("GET /api/vocab/video/assets/{kind}", guard(v.assetFile))
	api.HandleFunc("DELETE /api/vocab/video/assets/{kind}", guard(v.removeAsset))
}

func sanitizeVideoName(raw string) string {
	name := strings.TrimSpace(raw)
	if len(name) >= 4 && strings.EqualFold(name[len(name)-4:], ".mp4") {
		name = strings.TrimSpace(name[:len(name)-4])
	}
	var b strings.Builder
	count := 0
	for _, r := range name {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`/\\:*?"<>|`, r) {
			continue
		}
		if count >= 100 {
			break
		}
		b.WriteRune(r)
		count++
	}
	return strings.TrimSpace(b.String())
}

func videoDownloadDisposition(id int64, name string) string {
	fallback := fmt.Sprintf("vocab-%d.mp4", id)
	if name == "" {
		return fmt.Sprintf("attachment; filename=%q", fallback)
	}
	filename := name + ".mp4"
	ascii := filename
	for _, r := range filename {
		if r < 0x20 || r > 0x7e || r == '"' || r == '\\' || r == ';' {
			ascii = fallback
			break
		}
	}
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, url.PathEscape(filename))
}

// 新生成成功才推进序号。重做旧记录时复用快照，另建一条历史且不推进。
func (v *videoExporter) start(w http.ResponseWriter, r *http.Request) {
	var in struct {
		From        int
		Count       int
		RetryID     int64
		Name        string
		AppendRange bool
	}
	if !decode(w, r, &in) {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.running || v.assetBusy {
		writeError(w, http.StatusConflict, "已有视频正在生成")
		return
	}
	var words []*Word
	var name string
	if in.RetryID != 0 {
		for _, job := range v.jobs {
			if job.ID == in.RetryID {
				words = job.Words
				// 重生成使用当前上传的素材，词表和名称仍复用历史快照。
				in.From = job.From
				in.Count = job.Count
				name = job.Name
				break
			}
		}
		if len(words) == 0 {
			writeError(w, http.StatusNotFound, "没有这条生成记录")
			return
		}
	} else {
		if in.From < 1 || in.From > len(v.deck.Words) || in.Count < 1 || in.Count > len(v.deck.Words)-in.From+1 {
			writeError(w, http.StatusBadRequest, "请选择词库范围内的有效词数")
			return
		}
		words = v.deck.Range(in.From, in.Count)
		name = sanitizeVideoName(in.Name)
		if name != "" && in.AppendRange {
			name = fmt.Sprintf("%s-%d-%d", name, in.From, in.From+in.Count-1)
		}
	}
	for _, word := range words {
		if len(word.Ex) < 2 {
			writeError(w, http.StatusBadRequest, "所选单词不足两条例句")
			return
		}
	}
	id := int64(1)
	if len(v.jobs) > 0 {
		id = v.jobs[0].ID + 1
	}
	dir := filepath.Join(v.dir, strconv.FormatInt(id, 10))
	if fail(w, os.Mkdir(dir, 0700)) {
		return
	}
	if err := v.copyAssetsLocked(dir); err != nil {
		os.RemoveAll(dir)
		fail(w, err)
		return
	}
	job := &videoJob{videoStatus: videoStatus{State: "running", Total: len(words) * 3}, ID: id, From: in.From, Count: in.Count, Name: name, CreatedAt: time.Now().UTC(), Retry: in.RetryID != 0, Words: words, dir: dir}
	v.jobs = append([]*videoJob{job}, v.jobs...)
	if err := v.saveLocked(); err != nil {
		v.jobs = v.jobs[1:]
		os.RemoveAll(dir)
		fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	done := make(chan struct{})
	v.running = true
	v.cancel = cancel
	v.canceled = false
	v.done = done
	go v.render(ctx, cancel, done, job)
	writeJSON(w, http.StatusAccepted, job)
}

func (v *videoExporter) stop(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	if !v.running || v.cancel == nil {
		v.mu.Unlock()
		writeError(w, http.StatusConflict, "当前没有正在生成的视频")
		return
	}
	v.canceled = true
	cancel := v.cancel
	done := v.done
	v.mu.Unlock()
	cancel()
	if done != nil {
		select {
		case <-done:
		case <-r.Context().Done():
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (v *videoExporter) remove(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "请选择生成记录")
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	index := -1
	for i, job := range v.jobs {
		if job.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		writeError(w, http.StatusNotFound, "没有这条生成记录")
		return
	}
	job := v.jobs[index]
	if job.State == "running" {
		writeError(w, http.StatusConflict, "正在生成的视频请先终止后再删除")
		return
	}
	oldJobs := v.jobs
	nextJobs := make([]*videoJob, 0, len(v.jobs)-1)
	nextJobs = append(nextJobs, v.jobs[:index]...)
	nextJobs = append(nextJobs, v.jobs[index+1:]...)
	v.jobs = nextJobs
	if err := v.saveLocked(); err != nil {
		v.jobs = oldJobs
		fail(w, err)
		return
	}
	if err := os.RemoveAll(job.dir); err != nil {
		slog.Warn("删除视频文件失败", "id", job.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (v *videoExporter) status(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.cleanupLocked(time.Now())
	// 在锁内编码，避免后台渲染进度更新时读取到不一致的数据。
	writeJSON(w, http.StatusOK, videoState{v.next, v.completed, v.jobs, len(v.deck.Words)})
}

func (v *videoExporter) download(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "请选择生成记录")
		return
	}
	v.mu.Lock()
	v.cleanupLocked(time.Now())
	var file *os.File
	var name string
	for _, job := range v.jobs {
		if job.ID == id && job.State == "ready" {
			file, _ = os.Open(filepath.Join(job.dir, "video.mp4"))
			name = job.Name
			break
		}
	}
	v.mu.Unlock()
	if file == nil {
		writeError(w, http.StatusGone, "视频已过期或尚未生成")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", "video/mp4")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", videoDownloadDisposition(id, name))
	}
	http.ServeContent(w, r, "video.mp4", time.Time{}, file)
}

func (v *videoExporter) render(ctx context.Context, cancel context.CancelFunc, done chan struct{}, job *videoJob) {
	defer close(done)
	defer cancel()
	err := v.makeVideo(ctx, job, job.Words)
	v.mu.Lock()
	defer v.mu.Unlock()
	v.finishLocked(job, err)
}

// finishLocked 原子保存完成状态和共享进度，调用方持有 mu。
func (v *videoExporter) finishLocked(job *videoJob, err error) {
	oldNext, oldCompleted := v.next, v.completed
	canceled := v.canceled
	v.cancel = nil
	v.canceled = false
	v.done = nil
	job.State = "ready"
	if canceled {
		slog.Info("视频导出已终止", "id", job.ID)
		job.State = "canceled"
		os.RemoveAll(job.dir)
	} else if err != nil {
		slog.Warn("视频导出失败", "err", err)
		job.State = "failed"
		os.RemoveAll(job.dir)
	} else {
		expiry := time.Now().UTC().Add(24 * time.Hour)
		job.ExpiresAt = &expiry
		if !job.Retry {
			end := job.From + job.Count
			v.next = min(len(v.deck.Words), max(v.next, end))
			v.completed = v.completed || end > len(v.deck.Words)
		}
	}
	if err := v.saveLocked(); err != nil {
		slog.Error("保存视频生成结果失败", "err", err)
		v.next, v.completed = oldNext, oldCompleted
		if !canceled {
			job.State = "failed"
		}
		os.RemoveAll(job.dir)
	}
	v.running = false
}

func (v *videoExporter) makeVideo(ctx context.Context, job *videoJob, words []*Word) error {
	cache := make(map[string]string)
	audio := func(voice, text string) (string, error) {
		if text == "" {
			return "", nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if normalized, ok := v.speech.normalize(text, ttsVoices[voice]); ok {
			text = normalized
		}
		key := voice + "\n" + text
		if name, ok := cache[key]; ok {
			return name, nil
		}
		data, err := v.speech.audio(ctx, voice, text)
		if err != nil {
			return "", err
		}
		file, err := os.CreateTemp(job.dir, "speech-*.mp3")
		if err != nil {
			return "", err
		}
		_, err = file.Write(data)
		closeErr := file.Close()
		if err != nil {
			return "", err
		}
		if closeErr != nil {
			return "", closeErr
		}
		name := filepath.Base(file.Name())
		cache[key] = name
		return name, nil
	}
	normal := func(page *videoPage, zh, en string) error {
		for i, text := range []string{zh, en} {
			voice := []string{"zf_001", "af_heart"}[i]
			name, err := audio(voice, text)
			if err != nil {
				return err
			}
			page.Audio = append(page.Audio, name)
		}
		return nil
	}
	run := func(args ...string) error {
		cmd := exec.CommandContext(ctx, "python3", append([]string{env("VIDEO_RENDERER", "/usr/local/lib/vocab-video.py")}, args...)...)
		cmd.Dir = job.dir
		cmd.Stdout = os.Stderr
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Cancel = func() error {
			err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			if errors.Is(err, syscall.ESRCH) {
				return os.ErrProcessDone
			}
			return err
		}
		return cmd.Run()
	}
	for index, word := range words {
		for example := -1; example < 2; example++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			page := videoPage{Word: word, Example: example, Index: index + 1, From: job.From}
			if example < 0 {
				zh := ""
				if len(word.Zh) > 0 {
					zh = posRe.ReplaceAllString(word.Zh[0], "")
				}
				if err := normal(&page, zh, word.W); err != nil {
					return err
				}
			} else {
				e := word.Ex[example]
				if err := normal(&page, e.Zh, e.En); err != nil {
					return err
				}
				for _, token := range wordRe.FindAllString(strings.ToLower(e.En), -1) {
					name, err := audio("af_heart", token)
					if err != nil {
						return err
					}
					page.Audio = append(page.Audio, name)
				}
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			data, err := json.Marshal(page)
			if err != nil {
				return err
			}
			if err = os.WriteFile(filepath.Join(job.dir, "page.json"), data, 0600); err != nil {
				return err
			}
			if err = run("page", strconv.Itoa(len(words))); err != nil {
				return err
			}
			v.mu.Lock()
			job.Done++
			v.mu.Unlock()
		}
	}
	wordTitles := make([]string, len(words))
	for i, word := range words {
		wordTitles[i] = word.W
	}
	meta := struct {
		From  int      `json:"from"`
		Words []string `json:"words"`
	}{From: job.From, Words: wordTitles}
	if data, err := json.Marshal(meta); err != nil {
		return err
	} else if err = os.WriteFile(filepath.Join(job.dir, "words.json"), data, 0600); err != nil {
		return err
	}
	if err := run("join"); err != nil {
		return err
	}
	if raw, err := os.ReadFile(filepath.Join(job.dir, "chapters.json")); err == nil {
		var chapters []videoChapter
		if err = json.Unmarshal(raw, &chapters); err == nil {
			v.mu.Lock()
			job.Chapters = chapters
			v.mu.Unlock()
		}
	}
	// 下载只需要成片，其余中间文件合成成功后清除。
	files, err := os.ReadDir(job.dir)
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.Name() != "video.mp4" {
			os.Remove(filepath.Join(job.dir, file.Name()))
		}
	}
	return nil
}
