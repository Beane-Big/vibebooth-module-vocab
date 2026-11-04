import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorText, modeNames, phOf, type Mode, type Settings, type Word } from "../api";
import { canSpeak, speak, stopSpeaking } from "../speech";
import ExitButton from "./ExitButton";
import Icon from "./Icon";
import { useImmersive } from "./Nav";
import { modeIcons } from "./ModePicker";
import { Highlight } from "./WordCard";
import styles from "./Quiz.module.css";

export type Result = { word: Word; mode: Mode; ok: boolean; rating: number; answer: string };

type Props = {
  words: Word[];
  mode: Mode | "mix"; // mix：听音和看词轮换
  grading: "ok" | "rating"; // ok：认识 / 不认识（计划测试、检测）；rating：四档自评（复习）
  examples: number; // 开口说和听写从前几条例句里出题
  settings: Settings;
  onAnswer: (r: Result) => Promise<void>;
  onDone: (results: Result[]) => void;
  onExit: () => void; // 左上角的 × ：不做了
  exitConfirm?: string; // 退出前要再确认时的提示（比如“这次检测不算成绩”）
};

// 复习的四档自评，每档一句说明它对下次复习的影响（FSRS 按这个安排间隔）。
const ratings = [
  { v: 1, label: "忘了", hint: "很快再复习", cls: styles.again },
  { v: 2, label: "模糊", hint: "间隔短一些", cls: styles.hard },
  { v: 3, label: "记得", hint: "正常间隔", cls: styles.good },
  { v: 4, label: "轻松", hint: "间隔长一些", cls: styles.easy },
];

// 出题和作答。四种题型：
//   听音想意思：只播放读音，想好后看答案自评；看词想意思：只显示单词，想好后看答案自评；
//   看中文说英文：显示一条例句的中文，大声说出英文，再播放原句对照自评；
//   听写：播放例句，句中目标词挖空，输入这个词，程序判对错（接受词形变化）。
// 做题时是专注模式：导航收起，左上角 × 退出。
export default function Quiz({ words, mode, grading, examples, settings, onAnswer, onDone, onExit, exitConfirm }: Props) {
  useImmersive(true);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [typed, setTyped] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const results = useRef<Result[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const word = words[i];
  const m: Mode = mode === "mix" ? (i % 2 === 0 ? "listen" : "look") : mode;
  const pool = word ? word.ex.slice(0, examples) : [];
  const ex = pool.length ? pool[i % pool.length] : undefined;
  const target = ex ? (ex.en.match(/[A-Za-z']+/g) ?? []).find((t) => word.forms.includes(t.toLowerCase())) : undefined;

  const say = (text: string) => speak(text, settings.accent, settings.rate);
  const playPrompt = () => {
    stopSpeaking();
    if (m === "listen") say(word.w);
    if (m === "dictation") say(ex && target ? ex.en : word.w);
  };

  useEffect(() => {
    if (!word) return;
    setShown(false);
    setTyped("");
    setChecked(null);
    setError("");
    playPrompt();
    if (m === "dictation") input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);
  useEffect(() => () => stopSpeaking(), []);

  if (!word) return null;

  async function submit(ok: boolean, rating = 0, answer = "") {
    setBusy(true);
    setError("");
    const r: Result = { word, mode: m, ok, rating, answer };
    try {
      await onAnswer(r);
      results.current.push(r);
      if (i + 1 >= words.length) onDone(results.current);
      else setI(i + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function reveal() {
    setShown(true);
    stopSpeaking();
    if (m === "speak" && ex) say(ex.en);
    else if (m === "look") say(word.w);
  }

  function check(e: FormEvent) {
    e.preventDefault();
    const ok = word.forms.includes(typed.trim().toLowerCase());
    setChecked(ok);
    setShown(true);
  }

  const correct = results.current.filter((r) => r.ok).length;

  // 听写的空格：没作答时放一个不换行空格占位，下划线和句子的字底对齐（空字符串会让 inline-block 按基线顶上去）。
  const blank = checked === null ? "\u00a0" : target;

  return (
    <section className={`card ${styles.quiz}`}>
      <span className={styles.bar} style={{ width: `${((i + (shown ? 1 : 0)) / words.length) * 100}%` }} />
      <div className={styles.top}>
        <ExitButton label="退出" confirm={exitConfirm} onExit={() => { stopSpeaking(); onExit(); }} />
        <span className={styles.mode}>
          <Icon name={modeIcons[m]} size={16} />
          {modeNames[m]}
        </span>
        <span className={styles.count}>
          {grading === "ok" && i > 0 && (
            <span className={styles.score}>
              <Icon name="check" size={14} />
              {correct}
            </span>
          )}
          {i + 1} / {words.length}
        </span>
      </div>

      <div className={styles.prompt}>
        {m === "look" && <p className={styles.big}>{word.w}</p>}
        {m === "listen" && (
          <button className={styles.play} onClick={playPrompt} disabled={!canSpeak} aria-label="再听一遍" title="再听一遍">
            <Icon name="sound" size={34} />
          </button>
        )}
        {m === "speak" && (
          <>
            <span className={styles.label}>大声说出英文</span>
            <p className={styles.mid}>{ex ? ex.zh : word.zh.join("；")}</p>
          </>
        )}
        {m === "dictation" && (
          <>
            {ex && target ? (
              <p className={styles.mid}>
                {ex.en.split(/([A-Za-z']+)/).map((part, k) =>
                  part === target ? (
                    <span key={k} className={`${styles.blank} ${checked === null ? "" : checked ? styles.blankRight : styles.blankWrong}`}>
                      {blank}
                    </span>
                  ) : (
                    part
                  ),
                )}
              </p>
            ) : (
              <p className={styles.mid}>{word.zh.join("；")}</p>
            )}
            {ex && target && <p className="muted">{ex.zh}</p>}
            <button className={styles.replay} onClick={playPrompt} disabled={!canSpeak}>
              <Icon name="sound" size={18} />
              再听一遍
            </button>
            <form className={styles.write} onSubmit={check}>
              <input
                ref={input}
                className={styles.input}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={checked !== null}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="写出挖掉的词"
              />
              {checked === null && (
                <button type="submit" disabled={!typed.trim()}>
                  确定
                </button>
              )}
            </form>
          </>
        )}
      </div>

      {shown && (
        <div className={styles.answer}>
          {checked !== null && (
            <p className={`${styles.verdict} ${checked ? styles.right : styles.wrong}`}>
              <Icon name={checked ? "check" : "cross"} size={18} />
              {checked ? "答对了" : `正确答案：${target ?? word.w}`}
            </p>
          )}
          <p className={styles.word}>
            {word.w} {phOf(word, settings.accent) && <span className={styles.wordPh}>[ {phOf(word, settings.accent)} ]</span>}
          </p>
          <p className={styles.meaning}>{word.zh.join("；")}</p>
          {ex && m !== "dictation" && (
            <div className={styles.example}>
              <p>
                <Highlight text={ex.en} forms={word.forms} accent={settings.accent} />
              </p>
              {settings.sentencePh && phOf(ex, settings.accent) && <p className={styles.ph}>[ {phOf(ex, settings.accent)} ]</p>}
              <p className="muted">{ex.zh}</p>
            </div>
          )}
        </div>
      )}

      {!shown && m !== "dictation" && (
        <button className={styles.reveal} onClick={reveal} disabled={busy}>
          {m === "speak" ? "说好了，播放原句" : "看答案"}
        </button>
      )}
      {shown && m !== "dictation" && grading === "rating" && (
        <div className={styles.grades}>
          {ratings.map((r) => (
            <button key={r.v} className={`${styles.grade} ${r.cls}`} onClick={() => submit(r.v > 1, r.v)} disabled={busy}>
              <strong>{r.label}</strong>
              <span>{r.hint}</span>
            </button>
          ))}
        </div>
      )}
      {shown && m !== "dictation" && grading === "ok" && (
        <div className={styles.grades}>
          <button className={`${styles.grade} ${styles.again}`} onClick={() => submit(false)} disabled={busy}>
            <Icon name="cross" />
            <strong>不认识</strong>
          </button>
          <button className={`${styles.grade} ${styles.easy}`} onClick={() => submit(true)} disabled={busy}>
            <Icon name="check" />
            <strong>认识</strong>
          </button>
        </div>
      )}
      {checked !== null && (
        <button className={styles.reveal} onClick={() => submit(checked, grading === "rating" ? (checked ? 3 : 1) : 0, typed.trim())} disabled={busy}>
          下一题
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
