package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// 朗读：用模块自带的语音容器 vocab-tts 合成 MP3（英文 Kokoro v1.0，中文与中英混读 Kokoro v1.1-zh），存在卷里的 tts/ 目录。
// 同一个声音读同一段文字只合成一次，所有人共用，重启也还在。
// 只朗读词库里的词、例句和例句里出现的词（弹框能点到的），以及自动播放读的中文（释义、例句翻译），别的文字不合成，缓存不会被随便塞满。

// ttsVoices 要和 tts/voices.py 一致：值为真是中文声音（只读中文），假是英文声音。
var ttsVoices = map[string]bool{"af_heart": false, "bf_emma": false, "zf_001": true}

// sampleText 是设置页“试听”读的句子（frontend/src/pages/SettingsPage.tsx）。
const sampleText = "The course comprises ten lessons."

// errTTSDown 是连不上语音容器（没装、还没启动），前端会有一阵子都改用浏览器朗读；
// errTTSFailed 是语音容器在、只是这一句合成失败，前端只把这一句改用浏览器读。
var (
	errTTSDown   = errors.New("朗读服务不可用")
	errTTSFailed = errors.New("这一句合成失败")
)

type ttsCall struct {
	done chan struct{}
	data []byte
	err  error
}

type speaker struct {
	url    string
	dir    string
	texts  map[string]bool // 英文声音能读的
	zh     map[string]bool // 中文声音能读的
	client *http.Client

	// 语音容器一次只合成一句：用优先级队列让“正在播放的请求”插队到后台预取（X-Vocab-Prefetch）前面，
	// 并对相同 (voice, path) 做并发合并（singleflight），避免连续点击或预取风暴把正常播放堵死。
	mu              sync.Mutex
	busy            bool
	activeWaiters   []chan struct{}
	prefetchWaiters []chan struct{}
	inflight        map[string]*ttsCall
}

// 小写句子里的词：拼读时一个一个地读。
var wordRe = regexp.MustCompile(`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:st|nd|rd|th)?|[a-z]+(?:['’-][a-z]+)*`)

// 释义前面的词性缩写，读中文释义时去掉（和前端 speech.ts 的 plainZh 一样）。
var posRe = regexp.MustCompile(`^[a-z]+\.\s*`)

func newSpeaker(url, dir string, deck *Deck, dict Dict) *speaker {
	texts := map[string]bool{sampleText: true}
	zh := map[string]bool{}
	for _, w := range deck.Words {
		texts[w.W] = true
		if len(w.Zh) > 0 {
			zh[posRe.ReplaceAllString(w.Zh[0], "")] = true
		}
		for _, e := range w.Ex {
			texts[e.En] = true
			zh[e.Zh] = true
			// 拼读时例句里的词一个一个地读，每个词都要能合成（和 normalize 一样用小写）。
			for _, t := range wordRe.FindAllString(strings.ToLower(e.En), -1) {
				texts[strings.Trim(t, "'")] = true
			}
		}
	}
	for w := range dict {
		texts[w] = true
	}
	return &speaker{
		url:      strings.TrimRight(url, "/"),
		dir:      dir,
		texts:    texts,
		zh:       zh,
		client:   &http.Client{Timeout: 60 * time.Second},
		inflight: map[string]*ttsCall{},
	}
}

// normalize 返回缓存用的文字：例句原样，单词统一小写（弹框里点句首的 The 和句中的 the 是同一个音频）。中文只认原样。
func (s *speaker) normalize(text string, zh bool) (string, bool) {
	text = strings.TrimSpace(text)
	if zh {
		return text, s.zh[text]
	}
	if s.texts[text] {
		return text, true
	}
	if w := strings.ToLower(strings.Trim(text, "'")); s.texts[w] {
		return w, true
	}
	return "", false
}

func (s *speaker) cachePath(voice, text string) string {
	cacheText := text
	// 中文新模型（zf_001）使用 v3 缓存键；英文孤立单词（无空格，恢复原生直出与 trim=True，仅定向修复 ʤ/ʧ 与 they）使用 v7 缓存键；
	// 英文整句沿用原有缓存键，升级后可直接命中服务器上已经缓存好的英文例句音频。
	if ttsVoices[voice] {
		cacheText = "tts-v3\n" + text
	} else if !strings.ContainsAny(text, " \t\r\n") {
		cacheText = "tts-v7\n" + text
	}
	sum := sha256.Sum256([]byte(cacheText))
	name := hex.EncodeToString(sum[:])
	return filepath.Join(s.dir, voice, name[:2], name+".mp3")
}

// acquire 占住语音容器的合成名额：非预取请求（真实播放）总是排在后台预取请求之前；
// 排队期间调用方取消（翻页、暂停、中止预取）会立刻撤出队列，不浪费语音容器算力。
func (s *speaker) acquire(ctx context.Context, prefetch bool) error {
	s.mu.Lock()
	if !s.busy {
		s.busy = true
		s.mu.Unlock()
		return nil
	}
	ch := make(chan struct{})
	if prefetch {
		s.prefetchWaiters = append(s.prefetchWaiters, ch)
	} else {
		s.activeWaiters = append(s.activeWaiters, ch)
	}
	s.mu.Unlock()

	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		s.mu.Lock()
		removed := false
		if prefetch {
			s.prefetchWaiters, removed = removeWaiter(s.prefetchWaiters, ch)
		} else {
			s.activeWaiters, removed = removeWaiter(s.activeWaiters, ch)
		}
		s.mu.Unlock()
		if !removed {
			// 刚被 release 唤醒并交出了名额，归还名额给下一个等待者。
			select {
			case <-ch:
				s.release()
			default:
			}
		}
		return ctx.Err()
	}
}

func removeWaiter(list []chan struct{}, target chan struct{}) ([]chan struct{}, bool) {
	for i, ch := range list {
		if ch == target {
			return append(list[:i], list[i+1:]...), true
		}
	}
	return list, false
}

func (s *speaker) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.activeWaiters) > 0 {
		next := s.activeWaiters[0]
		s.activeWaiters = s.activeWaiters[1:]
		close(next)
		return
	}
	if len(s.prefetchWaiters) > 0 {
		next := s.prefetchWaiters[0]
		s.prefetchWaiters = s.prefetchWaiters[1:]
		close(next)
		return
	}
	s.busy = false
}

// audio 返回 MP3：有缓存读缓存，没有就请语音容器合成后存起来。
func (s *speaker) audio(ctx context.Context, voice, text string) ([]byte, error) {
	return s.audioWithPriority(ctx, voice, text, false)
}

func (s *speaker) audioWithPriority(ctx context.Context, voice, text string, prefetch bool) ([]byte, error) {
	path := s.cachePath(voice, text)
	if b, err := os.ReadFile(path); err == nil {
		return b, nil
	}

	// 同一个音频正在合成时合并等待，避免重复请求排队。
	s.mu.Lock()
	if call, ok := s.inflight[path]; ok {
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.data, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &ttsCall{done: make(chan struct{})}
	s.inflight[path] = call
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.inflight, path)
		s.mu.Unlock()
		close(call.done)
	}()

	if err := s.acquire(ctx, prefetch); err != nil {
		call.err = err
		return nil, err
	}
	defer s.release()

	if b, err := os.ReadFile(path); err == nil { // 排队时别人已经合成好了
		call.data = b
		return b, nil
	}

	// 已经拿到合成名额开始请求语音容器后，本次合成保留到结束并落盘，下次直接命中缓存。
	reqCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"text": text, "voice": voice})
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, s.url+"/speak", bytes.NewReader(body))
	if err != nil {
		call.err = err
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		call.err = fmt.Errorf("%w: %v", errTTSDown, err)
		return nil, call.err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil || resp.StatusCode != http.StatusOK || len(data) == 0 {
		call.err = fmt.Errorf("%w: %s %v", errTTSFailed, resp.Status, err)
		return nil, call.err
	}
	// 先写临时文件再改名，读的人不会读到写了一半的文件。
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		call.err = err
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "*.tmp")
	if err != nil {
		call.err = err
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		call.err = err
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		call.err = err
		return nil, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		call.err = err
		return nil, err
	}
	call.data = data
	return data, nil
}

func (s *speaker) register(api *http.ServeMux) {
	// GET /api/vocab/tts?voice=af_heart&text=... → audio/mpeg。连不上语音容器时返回 503，只是这一句合成失败时返回 502，前端都改用浏览器朗读。
	api.HandleFunc("GET /api/vocab/tts", func(w http.ResponseWriter, r *http.Request) {
		voice := r.URL.Query().Get("voice")
		zh, known := ttsVoices[voice]
		text, ok := s.normalize(r.URL.Query().Get("text"), zh)
		if !known || !ok {
			writeError(w, http.StatusBadRequest, "没有这个声音，或者这段文字不在词库里")
			return
		}
		prefetch := r.Header.Get("X-Vocab-Prefetch") == "1"
		data, err := s.audioWithPriority(r.Context(), voice, text, prefetch)
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			return
		case errors.Is(err, errTTSDown):
			slog.Warn("连不上语音容器", "err", err)
			writeError(w, http.StatusServiceUnavailable, "朗读服务不可用")
			return
		case errors.Is(err, errTTSFailed):
			slog.Warn("合成语音失败", "text", text, "err", err)
			writeError(w, http.StatusBadGateway, "这一句合成失败")
			return
		}
		if fail(w, err) {
			return
		}
		// 网址里有声音和文字，内容不会变，浏览器可以一直缓存。
		w.Header().Set("Content-Type", "audio/mpeg")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Write(data)
	})
}
