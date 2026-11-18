package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

const videoPermission = "video-export"

type videoStatus struct {
	State string `json:"state"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

type videoJob struct {
	videoStatus
	dir string
}

type videoPage struct {
	Word    *Word    `json:"word"`
	Example int      `json:"example"`
	Index   int      `json:"index"`
	Audio   []string `json:"audio"` // 中文、正常英文、逐词英文，顺序与播放器一致。
}

type videoExporter struct {
	deck    *Deck
	speech  *speaker
	mu      sync.Mutex // 同时只合成一个视频，所有任务状态和文件切换都在锁内。
	running bool
	jobs    map[string]*videoJob
}

func (v *videoExporter) register(api *http.ServeMux) {
	v.jobs = make(map[string]*videoJob)
	guard := func(fn http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			user := auth.UserFrom(r.Context())
			if user.All || !user.Has(videoPermission) {
				writeError(w, http.StatusForbidden, "没有视频导出权限")
				return
			}
			w.Header().Set("Cache-Control", "private, no-store")
			fn(w, r)
		}
	}
	api.HandleFunc("POST /api/vocab/video", guard(v.start))
	api.HandleFunc("GET /api/vocab/video", guard(v.status))
	api.HandleFunc("GET /api/vocab/video/file", guard(v.download))
}

// start 只接受词库范围，在后台生成，不创建学习计划。
func (v *videoExporter) start(w http.ResponseWriter, r *http.Request) {
	var in struct {
		From  int
		Count int
	}
	if !decode(w, r, &in) {
		return
	}
	if in.From < 1 || in.From > len(v.deck.Words) || in.Count < 1 || in.Count > 20 || in.Count > len(v.deck.Words)-in.From+1 {
		writeError(w, http.StatusBadRequest, "请选择词库内的 1 至 20 个单词")
		return
	}
	words := v.deck.Range(in.From, in.Count)
	for _, word := range words {
		if len(word.Ex) < 2 {
			writeError(w, http.StatusBadRequest, "所选单词不足两条例句")
			return
		}
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.running {
		writeError(w, http.StatusConflict, "已有视频正在生成")
		return
	}
	dir, err := os.MkdirTemp("", "vocab-video-")
	if fail(w, err) {
		return
	}
	id := userID(r)
	if old := v.jobs[id]; old != nil {
		os.RemoveAll(old.dir)
	}
	job := &videoJob{videoStatus: videoStatus{State: "running", Total: len(words) * 3}, dir: dir}
	v.jobs[id] = job
	v.running = true
	go v.render(id, job, words)
	writeJSON(w, http.StatusAccepted, job.videoStatus)
}

func (v *videoExporter) status(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	state := videoStatus{State: "idle"}
	if job := v.jobs[userID(r)]; job != nil {
		state = job.videoStatus
	}
	v.mu.Unlock()
	writeJSON(w, http.StatusOK, state)
}

// download 从当前账号的任务打开视频，支持播放器的 HTTP Range 请求。
func (v *videoExporter) download(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	job := v.jobs[userID(r)]
	var f *os.File
	if job != nil && job.State == "ready" {
		f, _ = os.Open(filepath.Join(job.dir, "video.mp4"))
	}
	v.mu.Unlock()
	if f == nil {
		writeError(w, http.StatusNotFound, "没有可下载的视频")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "video/mp4")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", `attachment; filename="vocab.mp4"`)
	}
	http.ServeContent(w, r, "vocab.mp4", time.Time{}, f)
}

func (v *videoExporter) render(id string, job *videoJob, words []*Word) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	err := v.makeVideo(ctx, job, words)
	v.mu.Lock()
	if err != nil {
		slog.Warn("视频导出失败", "err", err)
		job.State = "failed"
		os.RemoveAll(job.dir)
	} else {
		job.State = "ready"
	}
	v.running = false
	v.mu.Unlock()
	// 成片保留一天供预览和下载，重生成时会清除上一份。
	time.AfterFunc(24*time.Hour, func() {
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.jobs[id] == job {
			delete(v.jobs, id)
			os.RemoveAll(job.dir)
		}
	})
}

// makeVideo 复用 Vocab 的语音缓存。每页渲染完成后才更新进度。
func (v *videoExporter) makeVideo(ctx context.Context, job *videoJob, words []*Word) error {
	cache := make(map[string]string)
	audio := func(voice, text string) (string, error) {
		if text == "" {
			return "", nil
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if normalized, ok := v.speech.normalize(text, voice == "zh_chaowen"); ok {
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
			voice := []string{"zh_chaowen", "af_heart"}[i]
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
		return cmd.Run()
	}
	for index, word := range words {
		for example := -1; example < 2; example++ {
			page := videoPage{Word: word, Example: example, Index: index + 1}
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
	if err := run("join"); err != nil {
		return err
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
