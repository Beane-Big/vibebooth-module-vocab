package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

const maxVideoAssetBytes = 50 << 20

type videoAsset struct {
	File      string    `json:"-"`
	Duration  float64   `json:"duration"`
	Size      int64     `json:"size"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func validVideoAsset(kind string) bool { return kind == "intro" || kind == "outro" }

// 只保留当前片头和片尾。新任务先复制素材，替换素材不会改动已经开始的导出。
func (v *videoExporter) loadAssets() error {
	if err := os.MkdirAll(filepath.Join(v.dir, "assets"), 0700); err != nil {
		return err
	}
	if _, err := v.db.Exec("CREATE TABLE IF NOT EXISTS video_assets(kind TEXT PRIMARY KEY, file TEXT NOT NULL, duration REAL NOT NULL, size INTEGER NOT NULL, updated_at TEXT NOT NULL)"); err != nil {
		return err
	}
	v.assets = map[string]*videoAsset{}
	rows, err := v.db.Query("SELECT kind,file,duration,size,updated_at FROM video_assets")
	if err != nil {
		return err
	}
	defer rows.Close()
	keep := map[string]bool{}
	for rows.Next() {
		var kind, stamp string
		asset := &videoAsset{}
		if err := rows.Scan(&kind, &asset.File, &asset.Duration, &asset.Size, &stamp); err != nil {
			return err
		}
		asset.UpdatedAt, err = time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			return err
		}
		if !validVideoAsset(kind) || filepath.Base(asset.File) != asset.File {
			return errors.New("invalid video asset record")
		}
		if _, err := os.Stat(filepath.Join(v.dir, "assets", asset.File)); err == nil {
			v.assets[kind] = asset
			keep[asset.File] = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	entries, err := os.ReadDir(filepath.Join(v.dir, "assets"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && !keep[entry.Name()] {
			if err := os.Remove(filepath.Join(v.dir, "assets", entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func (v *videoExporter) assetStatus(w http.ResponseWriter, r *http.Request) {
	v.mu.Lock()
	defer v.mu.Unlock()
	writeJSON(w, http.StatusOK, v.assets)
}

func (v *videoExporter) assetFile(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !validVideoAsset(kind) {
		writeError(w, http.StatusNotFound, "没有这类素材")
		return
	}
	v.mu.Lock()
	var f *os.File
	if asset := v.assets[kind]; asset != nil {
		f, _ = os.Open(filepath.Join(v.dir, "assets", asset.File))
	}
	v.mu.Unlock()
	if f == nil {
		writeError(w, http.StatusNotFound, "尚未上传素材")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeContent(w, r, kind+".mp4", time.Time{}, f)
}

func (v *videoExporter) removeAsset(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !validVideoAsset(kind) {
		writeError(w, http.StatusNotFound, "没有这类素材")
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.assetBusy {
		writeError(w, http.StatusConflict, "素材正在处理")
		return
	}
	if _, err := v.db.Exec("DELETE FROM video_assets WHERE kind=?", kind); fail(w, err) {
		return
	}
	if asset := v.assets[kind]; asset != nil {
		if err := os.Remove(filepath.Join(v.dir, "assets", asset.File)); err != nil && !os.IsNotExist(err) {
			slog.Warn("清理旧片头片尾失败", "err", err)
		}
	}
	delete(v.assets, kind)
	w.WriteHeader(http.StatusNoContent)
}

// 先上传到临时文件并转码，完成后才发布新素材。失败时原素材继续可用。
func (v *videoExporter) uploadAsset(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if !validVideoAsset(kind) {
		writeError(w, http.StatusNotFound, "没有这类素材")
		return
	}
	v.mu.Lock()
	if v.assetBusy || v.running {
		v.mu.Unlock()
		writeError(w, http.StatusConflict, "视频或素材正在生成，请完成后再上传")
		return
	}
	v.assetBusy = true
	v.mu.Unlock()
	defer func() { v.mu.Lock(); v.assetBusy = false; v.mu.Unlock() }()
	r.Body = http.MaxBytesReader(w, r.Body, maxVideoAssetBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			r.MultipartForm.RemoveAll()
		}
		writeError(w, http.StatusBadRequest, "请上传不超过 50 MB 的 MP4 或 MOV 视频")
		return
	}
	defer r.MultipartForm.RemoveAll()
	source, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "请选择视频文件")
		return
	}
	defer source.Close()
	input, err := os.CreateTemp(filepath.Join(v.dir, "assets"), "source-*")
	if fail(w, err) {
		return
	}
	inputPath := input.Name()
	defer os.Remove(inputPath)
	size, copyErr := io.Copy(input, io.LimitReader(source, maxVideoAssetBytes+1))
	closeErr := input.Close()
	if fail(w, copyErr) || fail(w, closeErr) {
		return
	}
	if size == 0 || size > maxVideoAssetBytes {
		writeError(w, http.StatusBadRequest, "视频不能为空且不能超过 50 MB")
		return
	}
	output, err := os.CreateTemp(filepath.Join(v.dir, "assets"), "clip-*.mp4")
	if fail(w, err) {
		return
	}
	name := output.Name()
	if err = output.Close(); fail(w, err) {
		return
	}
	published := false
	defer func() {
		if !published {
			os.Remove(name)
		}
	}()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	duration, err := normalizeVideoAsset(ctx, inputPath, name)
	if err != nil {
		slog.Warn("片头片尾处理失败", "err", err)
		writeError(w, http.StatusBadRequest, "无法处理视频，请使用 30 秒以内、4K 以内的 MP4 或 MOV")
		return
	}
	stat, err := os.Stat(name)
	if fail(w, err) {
		return
	}
	asset := &videoAsset{File: filepath.Base(name), Duration: duration, Size: stat.Size(), UpdatedAt: time.Now().UTC()}
	v.mu.Lock()
	defer v.mu.Unlock()
	_, err = v.db.Exec("INSERT INTO video_assets(kind,file,duration,size,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET file=excluded.file,duration=excluded.duration,size=excluded.size,updated_at=excluded.updated_at",
		kind, asset.File, asset.Duration, asset.Size, asset.UpdatedAt.Format(time.RFC3339Nano))
	if fail(w, err) {
		return
	}
	old := v.assets[kind]
	v.assets[kind] = asset
	published = true
	if old != nil {
		if err := os.Remove(filepath.Join(v.dir, "assets", old.File)); err != nil && !os.IsNotExist(err) {
			slog.Warn("清理旧片头片尾失败", "err", err)
		}
	}
	writeJSON(w, http.StatusOK, asset)
}

// 输入仅接受直接的 MOV/MP4 容器，不允许读取上传文件引用的网络地址。
func normalizeVideoAsset(ctx context.Context, input, output string) (float64, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(probeCtx, env("VIDEO_FFPROBE", "ffprobe"), "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", input).Output()
	if err != nil {
		return 0, err
	}
	var info struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Type   string `json:"codec_type"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"streams"`
	}
	if err = json.Unmarshal(raw, &info); err != nil {
		return 0, err
	}
	duration, err := strconv.ParseFloat(info.Format.Duration, 64)
	if err != nil || math.IsNaN(duration) || math.IsInf(duration, 0) || duration <= 0 || duration > 30 {
		return 0, errors.New("invalid video duration")
	}
	video, audio := false, false
	for _, stream := range info.Streams {
		if stream.Type == "video" && !video {
			video = true
			if stream.Width <= 0 || stream.Height <= 0 || stream.Width > 4096 || stream.Height > 4096 {
				return 0, errors.New("video resolution exceeds limit")
			}
		}
		audio = audio || stream.Type == "audio"
	}
	if !video {
		return 0, errors.New("missing video stream")
	}
	audioMap := "1:a:0"
	if audio {
		audioMap = "0:a:0"
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", input,
		"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0", "-map", audioMap,
		"-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xeaf0f8,setsar=1,fps=24",
		"-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "160k", "-af", "apad",
		"-map_metadata", "-1", "-map_chapters", "-1", "-t", strconv.FormatFloat(duration, 'f', 6, 64), "-movflags", "+faststart", output}
	if data, err := exec.CommandContext(ctx, env("VIDEO_FFMPEG", "ffmpeg"), args...).CombinedOutput(); err != nil {
		return 0, fmt.Errorf("normalize clip: %w: %s", err, data)
	}
	if stat, err := os.Stat(output); err != nil || stat.Size() > 100<<20 {
		return 0, errors.New("normalized video exceeds size limit")
	}
	return duration, nil
}

// 在持锁的新任务创建阶段复制两份素材；文件名也是渲染器的拼接顺序约定。
func (v *videoExporter) copyAssetsLocked(dir string) error {
	for _, kind := range []string{"intro", "outro"} {
		asset := v.assets[kind]
		if asset == nil {
			continue
		}
		source, err := os.Open(filepath.Join(v.dir, "assets", asset.File))
		if err != nil {
			return err
		}
		dest, err := os.Create(filepath.Join(dir, kind+"-upload.mp4"))
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(dest, source)
		closeErr := dest.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
