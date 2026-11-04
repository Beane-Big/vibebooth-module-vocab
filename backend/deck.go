package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"sort"
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

// Word 是词库里的一个词。N 是序号（按字母顺序从 1 开始），F 是词频名次（1 最常用）；
// 每个人的复习记录按 W（单词本身）保存，词库更新、序号变了也接得上。
type Word struct {
	N     int       `json:"n"`
	F     int       `json:"f"`
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
	byF   []*Word              // 按词频排
	meta  map[string]*wordMeta // 出选择题用：词性、释义词条、词形，见 choices.go
	byPos map[string][]*Word   // 同词性的词，按词频排
}

func LoadDeck(data []byte) (*Deck, error) {
	var d Deck
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("解析词库失败: %w", err)
	}
	d.byW = make(map[string]*Word, len(d.Words))
	d.byF = make([]*Word, len(d.Words))
	for i := range d.Words {
		d.byW[d.Words[i].W] = &d.Words[i]
		d.byF[i] = &d.Words[i]
	}
	sort.Slice(d.byF, func(i, j int) bool { return d.byF[i].F < d.byF[j].F })
	d.prepareChoices()
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

// Ordered 是按学习顺序排好的整个词库：alpha 按字母（词库本身的顺序）、frq 按词频、
// random 是每个人各自的一种打乱顺序（按账号 id 生成，每次都一样，所以计划能接着往下学）。
func (d *Deck) Ordered(order, user string) []*Word {
	switch order {
	case "frq":
		return d.byF
	case "random":
		h := fnv.New64a()
		h.Write([]byte(user))
		out := make([]*Word, len(d.Words))
		for i, k := range rand.New(rand.NewPCG(h.Sum64(), 0)).Perm(len(d.Words)) {
			out[i] = &d.Words[k]
		}
		return out
	}
	out := make([]*Word, len(d.Words))
	for i := range d.Words {
		out[i] = &d.Words[i]
	}
	return out
}

// Pick 从学习顺序的第 from 个（从 1 数）起，挑 count 个还没学过的词。
// 从 from 往后都学过了就不再跳过，从 from 起重新学（词库学完后在设置里指定从第几个重新开始）。
func Pick(list []*Word, from, count int, learned map[string]bool) []*Word {
	from = max(1, from)
	out := []*Word{}
	for i := from - 1; i < len(list) && len(out) < count; i++ {
		if !learned[list[i].W] {
			out = append(out, list[i])
		}
	}
	if len(out) == 0 {
		for i := from - 1; i < len(list) && len(out) < count; i++ {
			out = append(out, list[i])
		}
	}
	return out
}

// NextPos 是学习顺序里第一个没学过的词的位置（从 1 数）和这个词；全学过了返回 len+1 和 nil。
func NextPos(list []*Word, learned map[string]bool) (int, *Word) {
	for i, w := range list {
		if !learned[w.W] {
			return i + 1, w
		}
	}
	return len(list) + 1, nil
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
