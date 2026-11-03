package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

// 内置词库：由 scripts/build-deck.mjs 生成，只读，打进镜像。数据来源和许可证见 deck/NOTICE.md。
//
//go:embed deck/core.json
var coreDeck []byte

// Example 是一条例句。Us、Uk 是整句的美音、英音音标（每个词的词典读音连起来）；
// Src 是来源：tatoeba:<句子 id> 或 extra（deck/extra.json 里补的）。
type Example struct {
	En  string `json:"en"`
	Zh  string `json:"zh"`
	Us  string `json:"us"`
	Uk  string `json:"uk"`
	Src string `json:"src"`
}

// Word 是词库里的一个词。N 是序号（按词频从 1 开始），学习进度按 N 往前走；
// 每个人的复习记录按 W（单词本身）保存，词库更新、序号变了也接得上。
type Word struct {
	N     int       `json:"n"`
	W     string    `json:"w"`
	Us    string    `json:"us"` // 美音音标（CMUdict）
	Uk    string    `json:"uk"` // 英音音标（Britfone）
	Zh    []string  `json:"zh"`
	Forms []string  `json:"forms"`
	Ex    []Example `json:"ex"`
}

type Deck struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Words []Word `json:"words"`
	byW   map[string]*Word
}

func LoadDeck(data []byte) (*Deck, error) {
	var d Deck
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("解析词库失败: %w", err)
	}
	d.byW = make(map[string]*Word, len(d.Words))
	for i := range d.Words {
		d.byW[d.Words[i].W] = &d.Words[i]
	}
	return &d, nil
}

// Get 按单词取词条；词库更新后删掉的词返回 nil。
func (d *Deck) Get(w string) *Word { return d.byW[w] }

// Lookup 按顺序取一组词，跳过词库里已经没有的。
func (d *Deck) Lookup(ws []string) []*Word {
	out := make([]*Word, 0, len(ws))
	for _, w := range ws {
		if x := d.Get(w); x != nil {
			out = append(out, x)
		}
	}
	return out
}

// Range 取序号 from 起（含）的 count 个词。
func (d *Deck) Range(from, count int) []*Word {
	if from < 1 {
		from = 1
	}
	out := []*Word{}
	for i := from - 1; i < len(d.Words) && len(out) < count; i++ {
		out = append(out, &d.Words[i])
	}
	return out
}

// 例句里点词时查的小词典：例句里出现的词在 ECDICT 里的音标和释义，同样由 scripts/build-deck.mjs 生成。
// 每一项是 [美音, 英音, 释义列表] 或 [美音, 英音, 释义列表, 原形]（变形词，比如 ran → run）。
//
//go:embed deck/dict.json
var dictData []byte

type Dict map[string][]json.RawMessage

func LoadDict(data []byte) (Dict, error) {
	var d Dict
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("解析词典失败: %w", err)
	}
	return d, nil
}

// Entry 是弹框里显示的内容。Lemma 是原形的词条（变形词才有）；N 是这个词（或原形）在词库里的序号，不在词库里为 0。
type Entry struct {
	W     string   `json:"w"`
	Us    string   `json:"us"`
	Uk    string   `json:"uk"`
	Zh    []string `json:"zh"`
	Lemma *Entry   `json:"lemma,omitempty"`
	N     int      `json:"n"`
}

// Lookup 查一个词。查不到时去掉缩写和所有格再查（I'm → i，Tom's → tom，don't 词典里有就直接用）。
func (d Dict) Lookup(deck *Deck, w string) *Entry {
	w = strings.ToLower(strings.Trim(w, "'"))
	if e := d.entry(deck, w, true); e != nil {
		return e
	}
	for _, suffix := range []string{"'s", "'ll", "'re", "'ve", "'m", "'d", "n't"} {
		if base, ok := strings.CutSuffix(w, suffix); ok && base != "" {
			if e := d.entry(deck, base, true); e != nil {
				return e
			}
		}
	}
	return nil
}

func (d Dict) entry(deck *Deck, w string, follow bool) *Entry {
	raw, ok := d[w]
	if !ok {
		return nil
	}
	e := &Entry{W: w}
	if len(raw) >= 3 {
		json.Unmarshal(raw[0], &e.Us)
		json.Unmarshal(raw[1], &e.Uk)
		json.Unmarshal(raw[2], &e.Zh)
	}
	if x := deck.Get(w); x != nil {
		e.N = x.N
	}
	if len(raw) >= 4 && follow {
		var lemma string
		json.Unmarshal(raw[3], &lemma)
		e.Lemma = d.entry(deck, lemma, false)
		if e.Lemma != nil && e.N == 0 {
			e.N = e.Lemma.N
		}
	}
	return e
}
