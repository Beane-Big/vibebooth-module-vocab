package main

import (
	"math/rand/v2"
	"regexp"
	"sort"
	"strings"
)

// 选择题的干扰项。看词选意思、听音选意思都是四选一：正确答案加三个干扰项。
//   - 意思类干扰项（选中文）：同词性、词频相近，这样不会一眼看出来；
//   - 开头类干扰项（看中文选英文）：开头字母和正确答案一样的词，越多越好。按字母顺序学时一批词开头都差不多，
//     选项开头不一样就能一眼认出哪个是这批里的词；
//   - 拼写类干扰项（听音选拼写）：拼写相近但读音不同的词，读音一样的词（right / write）不能放进来。
// 三类都排除意思重叠的词（big 和 large 都是“大的”），否则会有两个正确答案；也排除互为词形变化的词。
// 意思重叠按释义里的词条判断：词条去掉“很”“的”“地”这类虚字后，有一条相同或者一条包含另一条，就算重叠
// （quick 的“快的”和 quickly 的“很快地”、soon 的“快”都算重叠）。宁可多排除一些，词库够大，换别的词就是。

// Option 是一个选项：单词和它的第一条释义。
type Option struct {
	W  string `json:"w"`
	Zh string `json:"zh"`
}

// Choices 是一个词的三类干扰项，各三个（词库太小凑不够时会少）。
type Choices struct {
	Meaning  []Option `json:"meaning"`
	Prefix   []Option `json:"prefix"`
	Spelling []Option `json:"spelling"`
}

type wordMeta struct {
	pos   string
	terms []string
	forms map[string]bool
}

var (
	bracketRe = regexp.MustCompile(`[（(\[【][^）)\]】]*[）)\]】]`)
	splitRe   = regexp.MustCompile(`[、，,；;\s]+`)
)

// posOf 取第一条释义的词性，及物、不及物都算动词。
func posOf(w *Word) string {
	if len(w.Zh) == 0 {
		return ""
	}
	p, _, _ := strings.Cut(w.Zh[0], " ")
	switch p {
	case "vt.", "vi.", "v.", "aux.":
		return "v"
	}
	return p
}

func termsOf(w *Word) []string {
	var out []string
	for _, line := range w.Zh {
		if _, rest, ok := strings.Cut(line, ". "); ok {
			line = rest
		}
		for _, t := range splitRe.Split(bracketRe.ReplaceAllString(line, ""), -1) {
			t = strings.TrimSpace(t)
			t = strings.TrimLeft(t, "很使")
			t = strings.TrimRight(t, "的地得")
			if t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func (d *Deck) prepareChoices() {
	d.meta = make(map[string]*wordMeta, len(d.Words))
	d.byPos = map[string][]*Word{}
	for _, w := range d.byF {
		m := &wordMeta{pos: posOf(w), terms: termsOf(w), forms: map[string]bool{w.W: true}}
		for _, f := range w.Forms {
			m.forms[f] = true
		}
		d.meta[w.W] = m
		d.byPos[m.pos] = append(d.byPos[m.pos], w)
	}
}

// clash 为真时 b 不能当 a 的干扰项：同一个词、互为词形变化，或者意思重叠。
func (d *Deck) clash(a, b *Word) bool {
	ma, mb := d.meta[a.W], d.meta[b.W]
	if a.W == b.W || ma.forms[b.W] || mb.forms[a.W] {
		return true
	}
	for _, x := range ma.terms {
		for _, y := range mb.terms {
			if strings.Contains(x, y) || strings.Contains(y, x) {
				return true
			}
		}
	}
	return false
}

// usable 为真时 c 能和已经选中的干扰项、正确答案放在一起。
func (d *Deck) usable(c *Word, picked []*Word) bool {
	for _, p := range picked {
		if d.clash(p, c) {
			return false
		}
	}
	return true
}

func option(w *Word) Option {
	zh := ""
	if len(w.Zh) > 0 {
		zh = w.Zh[0]
	}
	return Option{W: w.W, Zh: zh}
}

func (d *Deck) Choices(w *Word, r *rand.Rand) Choices {
	meaning := d.meaningDistractors(w, r)
	return Choices{
		Meaning:  options(meaning),
		Prefix:   options(d.prefixDistractors(w, meaning, r)),
		Spelling: options(d.spellingDistractors(w, meaning, r)),
	}
}

func options(list []*Word) []Option {
	out := []Option{}
	for _, x := range list {
		out = append(out, option(x))
	}
	return out
}

// 和正确答案开头相同的字母越多越优先，一样多的随机挑；至少要首字母相同，凑不够三个时用意思类干扰项补上。
func (d *Deck) prefixDistractors(w *Word, fallback []*Word, r *rand.Rand) []*Word {
	type cand struct {
		w   *Word
		lcp int
	}
	var pool []cand
	for i := range d.Words {
		c := &d.Words[i]
		if n := commonPrefix(w.W, c.W); n > 0 && !d.clash(w, c) {
			pool = append(pool, cand{c, n})
		}
	}
	r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	sort.SliceStable(pool, func(i, j int) bool { return pool[i].lcp > pool[j].lcp })
	picked := []*Word{w}
	for _, c := range pool {
		if len(picked) == 4 {
			break
		}
		if d.usable(c.w, picked) {
			picked = append(picked, c.w)
		}
	}
	for _, c := range fallback {
		if len(picked) == 4 {
			break
		}
		if d.usable(c, picked) {
			picked = append(picked, c)
		}
	}
	return picked[1:]
}

func commonPrefix(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}

// 同词性里按词频由近到远放宽，凑够一批候选后随机挑三个；
// 冠词、感叹词这类同词性的词太少，就不限词性。
func (d *Deck) meaningDistractors(w *Word, r *rand.Rand) []*Word {
	same := d.byPos[d.meta[w.W].pos]
	if len(same) < 20 {
		same = d.byF
	}
	var pool []*Word
	for _, win := range []int{150, 400, 1000, 1 << 30} {
		pool = pool[:0]
		for _, c := range same {
			if c.F-w.F <= win && w.F-c.F <= win && !d.clash(w, c) {
				pool = append(pool, c)
			}
		}
		if len(pool) >= 12 {
			break
		}
	}
	r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	picked := []*Word{w}
	for _, c := range pool {
		if len(picked) == 4 {
			break
		}
		if d.usable(c, picked) {
			picked = append(picked, c)
		}
	}
	return picked[1:]
}

// 拼写最接近的一批里随机挑；凑不够三个时用意思类干扰项补上。
func (d *Deck) spellingDistractors(w *Word, fallback []*Word, r *rand.Rand) []*Word {
	type cand struct {
		w    *Word
		dist int
	}
	var pool []cand
	limit := max(2, len(w.W)/3)
	for i := range d.Words {
		c := &d.Words[i]
		if diff := len(c.W) - len(w.W); diff > limit || -diff > limit {
			continue
		}
		if dist := editDistance(w.W, c.W); dist <= limit && !sameSound(w, c) && !d.clash(w, c) {
			pool = append(pool, cand{c, dist})
		}
	}
	r.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	sort.SliceStable(pool, func(i, j int) bool { return pool[i].dist < pool[j].dist })
	picked := []*Word{w}
	for _, c := range pool {
		if len(picked) == 4 {
			break
		}
		if d.usable(c.w, picked) && !soundsLikeAny(c.w, picked) {
			picked = append(picked, c.w)
		}
	}
	for _, c := range fallback {
		if len(picked) == 4 {
			break
		}
		if d.usable(c, picked) && !soundsLikeAny(c, picked) {
			picked = append(picked, c)
		}
	}
	return picked[1:]
}

func sameSound(a, b *Word) bool {
	return (a.Us != "" && a.Us == b.Us) || (a.Uk != "" && a.Uk == b.Uk)
}

func soundsLikeAny(c *Word, list []*Word) bool {
	for _, x := range list {
		if sameSound(c, x) {
			return true
		}
	}
	return false
}

func editDistance(a, b string) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}
