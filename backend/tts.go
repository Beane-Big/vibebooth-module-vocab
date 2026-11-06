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

// 朗读：用模块自带的语音容器 vocab-tts 合成 MP3（英文 Kokoro，中文 Piper），存在卷里的 tts/ 目录。
// 同一个声音读同一段文字只合成一次，所有人共用，重启也还在。
// 只朗读词库里的词、例句和例句里出现的词（弹框能点到的），以及自动播放读的中文（释义、例句翻译），别的文字不合成，缓存不会被随便塞满。

// ttsVoices 要和 tts/voices.py 一致：值为真是中文声音（只读中文），假是英文声音。
var ttsVoices = map[string]bool{"af_heart": false, "bf_emma": false, "zh_chaowen": true}

// sampleText 是设置页“试听”读的句子（frontend/src/pages/SettingsPage.tsx）。
const sampleText = "The course comprises ten lessons."

// errTTSDown 是连不上语音容器（没装、还没启动），前端会有一阵子都改用浏览器朗读；
// errTTSFailed 是语音容器在、只是这一句没合成出来，前端只把这一句改用浏览器读。
var (
	errTTSDown   = errors.New("朗读服务不可用")
	errTTSFailed = errors.New("这一句合成失败")
)

type speaker struct {
	url    string
	dir    string
	texts  map[string]bool // 英文声音能读的
	zh     map[string]bool // 中文声音能读的
	client *http.Client
	gen    sync.Mutex // 语音容器一次只合成一句，这里也一句一句地发，免得请求排队超时
}

// 小写句子里的词：拼读时一个一个地读。
var wordRe = regexp.MustCompile(`[a-z']+`)

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
	return &speaker{url: strings.TrimRight(url, "/"), dir: dir, texts: texts, zh: zh, client: &http.Client{Timeout: 60 * time.Second}}
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

// audio 返回 MP3：有缓存读缓存，没有就请语音容器合成后存起来。
// 浏览器中途取消（翻页了）也合成完存好，下次直接用。
func (s *speaker) audio(ctx context.Context, voice, text string) ([]byte, error) {
	sum := sha256.Sum256([]byte(text))
	name := hex.EncodeToString(sum[:])
	path := filepath.Join(s.dir, voice, name[:2], name+".mp3")
	if b, err := os.ReadFile(path); err == nil {
		return b, nil
	}
	s.gen.Lock()
	defer s.gen.Unlock()
	if b, err := os.ReadFile(path); err == nil { // 排队时别人已经合成好了
		return b, nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"text": text, "voice": voice})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url+"/speak", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errTTSDown, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil || resp.StatusCode != http.StatusOK || len(data) == 0 {
		return nil, fmt.Errorf("%w: %s %v", errTTSFailed, resp.Status, err)
	}
	// 先写临时文件再改名，读的人不会读到写了一半的文件。
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "*.tmp")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	return data, os.Rename(tmp.Name(), path)
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
		data, err := s.audio(r.Context(), voice, text)
		switch {
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
