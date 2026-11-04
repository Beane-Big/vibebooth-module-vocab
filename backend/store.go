package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"time"

	fsrs "github.com/open-spaced-repetition/go-fsrs/v3"
	_ "modernc.org/sqlite"
)

// 每个人的数据都按账号 id（令牌里的 sub）分开存，彼此看不到。词库是只读的内置数据，不在数据库里。
type Store struct {
	db        *sql.DB
	scheduler *fsrs.FSRS
	now       func() time.Time
}

// 表结构在启动时创建；以后加字段用 ALTER TABLE，并保证老数据还能读。
const schema = `
CREATE TABLE IF NOT EXISTS settings (
	user_id TEXT PRIMARY KEY,
	data    TEXT NOT NULL
);
-- next_n：下一个学习计划从词库第几个词开始。
CREATE TABLE IF NOT EXISTS progress (
	user_id TEXT PRIMARY KEY,
	next_n  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id     TEXT NOT NULL,
	first_n     INTEGER NOT NULL,
	words       TEXT NOT NULL,
	examples    INTEGER NOT NULL,
	pos         INTEGER NOT NULL DEFAULT 0,
	created_at  TIMESTAMP NOT NULL,
	learned_at  TIMESTAMP,
	finished_at TIMESTAMP,
	correct     INTEGER NOT NULL DEFAULT 0,
	total       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS plans_user ON plans (user_id, id);
-- 复习状态：data 是 FSRS 的卡片状态（JSON），due 单独存一列方便查询到期的词。
CREATE TABLE IF NOT EXISTS cards (
	user_id    TEXT NOT NULL,
	word       TEXT NOT NULL,
	data       TEXT NOT NULL,
	due        TIMESTAMP NOT NULL,
	learned_at TIMESTAMP NOT NULL,
	PRIMARY KEY (user_id, word)
);
CREATE INDEX IF NOT EXISTS cards_due ON cards (user_id, due);
-- 每一次作答。kind：plan（计划测试）、review（复习）、test（检测）；ref_id 是计划或检测的 id。
CREATE TABLE IF NOT EXISTS answers (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	word    TEXT NOT NULL,
	kind    TEXT NOT NULL,
	ref_id  INTEGER NOT NULL DEFAULT 0,
	mode    TEXT NOT NULL,
	ok      INTEGER NOT NULL,
	rating  INTEGER NOT NULL DEFAULT 0,
	answer  TEXT NOT NULL DEFAULT '',
	at      TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_ref ON answers (user_id, kind, ref_id);
CREATE INDEX IF NOT EXISTS answers_at ON answers (user_id, at);
-- 错题本：答错进来，之后连续答对 settings.wrongClear 次移出（cleared_at 不为空）。
CREATE TABLE IF NOT EXISTS wrongs (
	user_id     TEXT NOT NULL,
	word        TEXT NOT NULL,
	count       INTEGER NOT NULL,
	streak      INTEGER NOT NULL DEFAULT 0,
	last_at     TIMESTAMP NOT NULL,
	last_mode   TEXT NOT NULL,
	last_answer TEXT NOT NULL DEFAULT '',
	cleared_at  TIMESTAMP,
	PRIMARY KEY (user_id, word)
);
CREATE TABLE IF NOT EXISTS tests (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id     TEXT NOT NULL,
	scope       TEXT NOT NULL,
	mode        TEXT NOT NULL,
	words       TEXT NOT NULL,
	created_at  TIMESTAMP NOT NULL,
	finished_at TIMESTAMP,
	correct     INTEGER NOT NULL DEFAULT 0,
	total       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tests_user ON tests (user_id, id);
`

var ErrNotFound = errors.New("没有找到")

// OpenStore 打开模块自己的 SQLite 文件；数据库只属于本模块，放在本模块的卷里。
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// SQLite 同一时间只允许一个写入者，单连接可以避免 "database is locked"。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// 按天复习：不用分钟级的短期步骤，答完的词最早明天再出现。
	params := fsrs.DefaultParam()
	params.EnableShortTerm = false
	return &Store{db: db, scheduler: fsrs.NewFSRS(params), now: func() time.Time { return time.Now().UTC() }}, nil
}

// ---- 个人设置

// Settings 是每个人自己的设置，前端整份读写。
type Settings struct {
	PlanWords  int     `json:"planWords"`  // 每个学习计划学几个词
	StartN     int     `json:"startN"`     // 下一个计划从第几个词开始，0 表示接着上次；用过一次就回到 0
	Examples   int     `json:"examples"`   // 每个词几条例句，2–5
	SentencePh bool    `json:"sentencePh"` // 例句下面显示整句音标
	Accent     string  `json:"accent"`     // en-US 或 en-GB
	Rate       float64 `json:"rate"`       // 朗读语速，0.5–1.5
	AutoRepeat int     `json:"autoRepeat"` // 自动播放时英文读几遍，1–3
	PauseBy    string  `json:"pauseBy"`    // 自动播放每句后停多久：audio 按这句英文朗读时长的倍数，fixed 按固定秒数
	PauseRatio float64 `json:"pauseRatio"` // pauseBy 为 audio 时，停顿是朗读时长的几倍，0.5–2
	AutoPause  float64 `json:"autoPause"`  // pauseBy 为 fixed 时停几秒，留给跟读
	AutoZh     bool    `json:"autoZh"`     // 自动播放时读不读中文
	ReviewMode string  `json:"reviewMode"` // 复习题型：listen、look 或 mix（轮换）
	WrongClear int     `json:"wrongClear"` // 错题本里连续答对几次移出
}

func defaultSettings() Settings {
	return Settings{PlanWords: 20, Examples: 2, SentencePh: true, Accent: "en-US", Rate: 0.9, AutoRepeat: 2, PauseBy: "audio", PauseRatio: 1, AutoPause: 2, AutoZh: true, ReviewMode: "mix", WrongClear: 3}
}

// Normalize 把越界的值拉回范围内，老版本存的设置缺字段时补默认值。
func (s *Settings) Normalize() {
	d := defaultSettings()
	clamp := func(v *int, lo, hi, def int) {
		if *v == 0 {
			*v = def
		}
		*v = max(lo, min(hi, *v))
	}
	clamp(&s.PlanWords, 1, 100, d.PlanWords)
	clamp(&s.Examples, 2, 5, d.Examples)
	clamp(&s.AutoRepeat, 1, 3, d.AutoRepeat)
	clamp(&s.WrongClear, 1, 10, d.WrongClear)
	if s.Accent != "en-GB" {
		s.Accent = "en-US"
	}
	if s.Rate == 0 {
		s.Rate = d.Rate
	}
	s.Rate = max(0.5, min(1.5, s.Rate))
	s.AutoPause = max(0, min(10, s.AutoPause))
	// 老版本没有这两项：默认按朗读时长停顿。
	if s.PauseBy != "fixed" {
		s.PauseBy = "audio"
	}
	if s.PauseRatio == 0 {
		s.PauseRatio = d.PauseRatio
	}
	s.PauseRatio = max(0.5, min(2, s.PauseRatio))
	s.StartN = max(0, s.StartN)
	if s.ReviewMode != "listen" && s.ReviewMode != "look" {
		s.ReviewMode = "mix"
	}
}

func (s *Store) Settings(ctx context.Context, user string) (Settings, error) {
	st := defaultSettings()
	var data string
	err := s.db.QueryRowContext(ctx, `SELECT data FROM settings WHERE user_id = ?`, user).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal([]byte(data), &st); err != nil {
		return defaultSettings(), nil
	}
	st.Normalize()
	return st, nil
}

func (s *Store) SaveSettings(ctx context.Context, user string, st Settings) (Settings, error) {
	st.Normalize()
	data, _ := json.Marshal(st)
	_, err := s.db.ExecContext(ctx, `INSERT INTO settings (user_id, data) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET data = excluded.data`, user, string(data))
	return st, err
}

// ---- 学习计划

type Plan struct {
	ID         int        `json:"id"`
	FirstN     int        `json:"firstN"`
	Words      []string   `json:"words"`
	Examples   int        `json:"examples"`
	Pos        int        `json:"pos"` // 学到第几页，中途退出再进来从这里接着
	CreatedAt  time.Time  `json:"createdAt"`
	LearnedAt  *time.Time `json:"learnedAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Correct    int        `json:"correct"`
	Total      int        `json:"total"`
}

const planCols = `id, first_n, words, examples, pos, created_at, learned_at, finished_at, correct, total`

func scanPlan(row interface{ Scan(...any) error }) (*Plan, error) {
	var p Plan
	var words string
	if err := row.Scan(&p.ID, &p.FirstN, &words, &p.Examples, &p.Pos, &p.CreatedAt, &p.LearnedAt, &p.FinishedAt, &p.Correct, &p.Total); err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(words), &p.Words)
	return &p, nil
}

// NextN 是下一个计划默认的起始序号。
func (s *Store) NextN(ctx context.Context, user string) (int, error) {
	n := 1
	err := s.db.QueryRowContext(ctx, `SELECT next_n FROM progress WHERE user_id = ?`, user).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 1, nil
	}
	return n, err
}

// CreatePlan 新建学习计划。上一个没做完的计划直接作废（不影响已经记下的作答）。
func (s *Store) CreatePlan(ctx context.Context, user string, words []*Word, examples int) (*Plan, error) {
	if len(words) == 0 {
		return nil, errors.New("词库已经学完了")
	}
	list := make([]string, len(words))
	for i, w := range words {
		list[i] = w.W
	}
	data, _ := json.Marshal(list)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now()
	if _, err := tx.ExecContext(ctx, `DELETE FROM plans WHERE user_id = ? AND finished_at IS NULL`, user); err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO plans (user_id, first_n, words, examples, created_at) VALUES (?, ?, ?, ?, ?)`, user, words[0].N, string(data), examples, now)
	if err != nil {
		return nil, err
	}
	next := words[len(words)-1].N + 1
	if _, err := tx.ExecContext(ctx, `INSERT INTO progress (user_id, next_n) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET next_n = excluded.next_n`, user, next); err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Plan(ctx, user, int(id))
}

func (s *Store) Plan(ctx context.Context, user string, id int) (*Plan, error) {
	p, err := scanPlan(s.db.QueryRowContext(ctx, `SELECT `+planCols+` FROM plans WHERE user_id = ? AND id = ?`, user, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// CurrentPlan 是还没做完测试的那个计划，没有时返回 nil。
func (s *Store) CurrentPlan(ctx context.Context, user string) (*Plan, error) {
	p, err := scanPlan(s.db.QueryRowContext(ctx, `SELECT `+planCols+` FROM plans WHERE user_id = ? AND finished_at IS NULL ORDER BY id DESC LIMIT 1`, user))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

func (s *Store) Plans(ctx context.Context, user string) ([]*Plan, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+planCols+` FROM plans WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*Plan{}
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

// SavePlanPos 记下学到第几页；learned 表示整批词已经学完，下一步是计划测试。
func (s *Store) SavePlanPos(ctx context.Context, user string, id, pos int, learned bool) error {
	q := `UPDATE plans SET pos = ? WHERE user_id = ? AND id = ? AND finished_at IS NULL`
	args := []any{pos, user, id}
	if learned {
		q = `UPDATE plans SET pos = ?, learned_at = COALESCE(learned_at, ?) WHERE user_id = ? AND id = ? AND finished_at IS NULL`
		args = []any{pos, s.now(), user, id}
	}
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// FinishPlan 结束计划测试：按每个词最后一次作答算对错。
func (s *Store) FinishPlan(ctx context.Context, user string, id int) (*Plan, error) {
	correct, total, err := s.score(ctx, user, "plan", id)
	if err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE plans SET finished_at = ?, learned_at = COALESCE(learned_at, ?), correct = ?, total = ? WHERE user_id = ? AND id = ? AND finished_at IS NULL`,
		s.now(), s.now(), correct, total, user, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.Plan(ctx, user, id)
}

func (s *Store) score(ctx context.Context, user, kind string, ref int) (correct, total int, err error) {
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(ok), 0), COUNT(*) FROM answers a
		WHERE user_id = ? AND kind = ? AND ref_id = ?
		  AND id = (SELECT MAX(id) FROM answers b WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.ref_id = a.ref_id AND b.word = a.word)`,
		user, kind, ref).Scan(&correct, &total)
	return
}

// ---- 作答

// Answer 是一次作答。复习用 Rating（1 忘了、2 模糊、3 记得、4 轻松），计划测试和检测用 OK。
type Answer struct {
	Word   string `json:"word"`
	Kind   string `json:"kind"`
	RefID  int    `json:"refId"`
	Mode   string `json:"mode"` // listen、look、speak、dictation
	OK     bool   `json:"ok"`
	Rating int    `json:"rating"`
	Answer string `json:"answer"`
}

// tomorrow 是明天 0 点（按用户所在时区），tz 是 JavaScript getTimezoneOffset() 的分钟数。
func tomorrow(now time.Time, tz int) time.Time {
	loc := time.FixedZone("", -tz*60)
	l := now.In(loc)
	return time.Date(l.Year(), l.Month(), l.Day()+1, 0, 0, 0, 0, loc).UTC()
}

// Record 记下一次作答，并更新复习计划和错题本：
//   - 计划测试：答对算“记得”、答错算“忘了”，作为这个词的第一次复习，之后进入每日复习。
//   - 复习：按自评的四档交给 FSRS 安排下次复习的时间。
//   - 检测：答错的词提前到明天复习，答对的不改原来的计划。
//   - 答错（或复习时选“忘了”）进错题本；错题本里的词连续答对 clear 次后移出。
//
// BadInput 是请求参数不对的错误，接口返回 400 并把这句话显示给用户；其他错误按服务器出错处理。
type BadInput string

func (e BadInput) Error() string { return string(e) }

func (s *Store) Record(ctx context.Context, user string, a Answer, tz, clear int) error {
	switch a.Kind {
	case "plan", "test":
		a.Rating = 0
	case "review":
		if a.Rating < 1 || a.Rating > 4 {
			return BadInput("自评只能是 1 到 4")
		}
		a.OK = a.Rating > 1
	default:
		return BadInput("未知的作答类型")
	}
	now := s.now()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO answers (user_id, word, kind, ref_id, mode, ok, rating, answer, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		user, a.Word, a.Kind, a.RefID, a.Mode, a.OK, a.Rating, a.Answer, now); err != nil {
		return err
	}

	// 复习计划
	card, exists, err := loadCard(ctx, tx, user, a.Word)
	if err != nil {
		return err
	}
	switch {
	case a.Kind == "test" && !a.OK && exists:
		if due := tomorrow(now, tz); card.Due.After(due) {
			card.Due = due
		}
	case a.Kind == "test":
		// 检测答对，或者检测了还没学过的词：不动复习计划。
	default:
		rating := fsrs.Rating(a.Rating)
		if a.Kind == "plan" {
			rating = fsrs.Again
			if a.OK {
				rating = fsrs.Good
			}
		}
		card = s.scheduler.Next(card, now, rating).Card
	}
	if exists || a.Kind != "test" {
		data, _ := json.Marshal(card)
		if _, err := tx.ExecContext(ctx, `INSERT INTO cards (user_id, word, data, due, learned_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (user_id, word) DO UPDATE SET data = excluded.data, due = excluded.due`, user, a.Word, string(data), card.Due, now); err != nil {
			return err
		}
	}

	// 错题本
	if !a.OK {
		_, err = tx.ExecContext(ctx, `INSERT INTO wrongs (user_id, word, count, streak, last_at, last_mode, last_answer) VALUES (?, ?, 1, 0, ?, ?, ?)
			ON CONFLICT (user_id, word) DO UPDATE SET count = count + 1, streak = 0, last_at = excluded.last_at,
				last_mode = excluded.last_mode, last_answer = excluded.last_answer, cleared_at = NULL`, user, a.Word, now, a.Mode, a.Answer)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE wrongs SET streak = streak + 1, cleared_at = CASE WHEN streak + 1 >= ? THEN ? END
			WHERE user_id = ? AND word = ? AND cleared_at IS NULL`, clear, now, user, a.Word)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func loadCard(ctx context.Context, tx *sql.Tx, user, word string) (fsrs.Card, bool, error) {
	var data string
	err := tx.QueryRowContext(ctx, `SELECT data FROM cards WHERE user_id = ? AND word = ?`, user, word).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return fsrs.NewCard(), false, nil
	}
	if err != nil {
		return fsrs.Card{}, false, err
	}
	var c fsrs.Card
	if err := json.Unmarshal([]byte(data), &c); err != nil {
		return fsrs.NewCard(), true, nil
	}
	return c, true, nil
}

// Due 是到今天结束为止该复习的词，最早到期的在前。
func (s *Store) Due(ctx context.Context, user string, tz, limit int) ([]string, int, error) {
	end := tomorrow(s.now(), tz)
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM cards WHERE user_id = ? AND due < ?`, user, end).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT word FROM cards WHERE user_id = ? AND due < ? ORDER BY due LIMIT ?`, user, end, limit)
	if err != nil {
		return nil, 0, err
	}
	words, err := collect(rows)
	return words, total, err
}

func collect(rows *sql.Rows) ([]string, error) {
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var w string
		if err := rows.Scan(&w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// ---- 错题本

type Wrong struct {
	Word       string     `json:"word"`
	Count      int        `json:"count"`
	Streak     int        `json:"streak"`
	LastAt     time.Time  `json:"lastAt"`
	LastMode   string     `json:"lastMode"`
	LastAnswer string     `json:"lastAnswer"`
	ClearedAt  *time.Time `json:"clearedAt"`
}

// Wrongs 列出错题本；cleared 为 true 时列出已经移出的（“已攻克”）。
func (s *Store) Wrongs(ctx context.Context, user string, cleared bool) ([]Wrong, error) {
	cond := "cleared_at IS NULL"
	if cleared {
		cond = "cleared_at IS NOT NULL"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT word, count, streak, last_at, last_mode, last_answer, cleared_at FROM wrongs WHERE user_id = ? AND `+cond+` ORDER BY last_at DESC`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Wrong{}
	for rows.Next() {
		var w Wrong
		if err := rows.Scan(&w.Word, &w.Count, &w.Streak, &w.LastAt, &w.LastMode, &w.LastAnswer, &w.ClearedAt); err != nil {
			return nil, err
		}
		list = append(list, w)
	}
	return list, rows.Err()
}

// ClearWrong 手动把词移出错题本。
func (s *Store) ClearWrong(ctx context.Context, user, word string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE wrongs SET cleared_at = ? WHERE user_id = ? AND word = ? AND cleared_at IS NULL`, s.now(), user, word)
	return err
}

// ---- 检测

type Test struct {
	ID         int        `json:"id"`
	Scope      string     `json:"scope"`
	Mode       string     `json:"mode"`
	Words      []string   `json:"words"`
	CreatedAt  time.Time  `json:"createdAt"`
	FinishedAt *time.Time `json:"finishedAt"`
	Correct    int        `json:"correct"`
	Total      int        `json:"total"`
}

const testCols = `id, scope, mode, words, created_at, finished_at, correct, total`

func scanTest(row interface{ Scan(...any) error }) (*Test, error) {
	var t Test
	var words string
	if err := row.Scan(&t.ID, &t.Scope, &t.Mode, &words, &t.CreatedAt, &t.FinishedAt, &t.Correct, &t.Total); err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(words), &t.Words)
	return &t, nil
}

// Learned 是学过的词（有复习记录的），since 不为零时只要这之后学的。
func (s *Store) Learned(ctx context.Context, user string, since time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT word FROM cards WHERE user_id = ? AND learned_at >= ? ORDER BY learned_at`, user, since)
	if err != nil {
		return nil, err
	}
	return collect(rows)
}

// CreateTest 从候选词里随机抽 count 个出一次检测。
func (s *Store) CreateTest(ctx context.Context, user, scope, mode string, candidates []string, count int) (*Test, error) {
	if len(candidates) == 0 {
		return nil, errors.New("这个范围里还没有学过的词")
	}
	words := append([]string(nil), candidates...)
	rand.Shuffle(len(words), func(i, j int) { words[i], words[j] = words[j], words[i] })
	if count > 0 && count < len(words) {
		words = words[:count]
	}
	data, _ := json.Marshal(words)
	res, err := s.db.ExecContext(ctx, `INSERT INTO tests (user_id, scope, mode, words, created_at) VALUES (?, ?, ?, ?, ?)`, user, scope, mode, string(data), s.now())
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.Test(ctx, user, int(id))
}

func (s *Store) Test(ctx context.Context, user string, id int) (*Test, error) {
	t, err := scanTest(s.db.QueryRowContext(ctx, `SELECT `+testCols+` FROM tests WHERE user_id = ? AND id = ?`, user, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

func (s *Store) Tests(ctx context.Context, user string) ([]*Test, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+testCols+` FROM tests WHERE user_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 100`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*Test{}
	for rows.Next() {
		t, err := scanTest(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	return list, rows.Err()
}

func (s *Store) FinishTest(ctx context.Context, user string, id int) (*Test, error) {
	correct, total, err := s.score(ctx, user, "test", id)
	if err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, `UPDATE tests SET finished_at = ?, correct = ?, total = ? WHERE user_id = ? AND id = ? AND finished_at IS NULL`, s.now(), correct, total, user, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return s.Test(ctx, user, id)
}

// Missed 是一次计划测试或检测里答错的词（按每个词最后一次作答算）。
func (s *Store) Missed(ctx context.Context, user, kind string, ref int) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT word FROM answers a WHERE user_id = ? AND kind = ? AND ref_id = ? AND ok = 0
		  AND id = (SELECT MAX(id) FROM answers b WHERE b.user_id = a.user_id AND b.kind = a.kind AND b.ref_id = a.ref_id AND b.word = a.word)
		ORDER BY id`, user, kind, ref)
	if err != nil {
		return nil, err
	}
	return collect(rows)
}

// ---- 首页统计

type Stats struct {
	Learned int `json:"learned"` // 学过的词
	Due     int `json:"due"`     // 今天待复习
	Wrong   int `json:"wrong"`   // 错题本里的词
	Streak  int `json:"streak"`  // 连续学习天数（今天还没学时算到昨天）
	Today   int `json:"today"`   // 今天作答次数
}

func (s *Store) Stats(ctx context.Context, user string, tz int) (Stats, error) {
	var st Stats
	end := tomorrow(s.now(), tz)
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM cards WHERE user_id = ?),
		(SELECT COUNT(*) FROM cards WHERE user_id = ? AND due < ?),
		(SELECT COUNT(*) FROM wrongs WHERE user_id = ? AND cleared_at IS NULL),
		(SELECT COUNT(*) FROM answers WHERE user_id = ? AND at >= ?)`,
		user, user, end, user, user, end.AddDate(0, 0, -1)).Scan(&st.Learned, &st.Due, &st.Wrong, &st.Today)
	if err != nil {
		return st, err
	}
	// 连续天数：从今天（或昨天）往前数，每天都有作答才算。最多看一年。
	since := end.AddDate(-1, 0, 0)
	rows, err := s.db.QueryContext(ctx, `SELECT at FROM answers WHERE user_id = ? AND at >= ?`, user, since)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	days := map[int]bool{}
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			return st, err
		}
		days[int(at.Sub(since).Hours()/24)] = true
	}
	d := int(end.Sub(since).Hours()/24) - 1
	if !days[d] {
		d--
	}
	for days[d] {
		st.Streak++
		d--
	}
	return st, rows.Err()
}
