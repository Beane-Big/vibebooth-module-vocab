import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, errorText, modeNames, phOf, type Choices, type Mode, type Settings, type Word } from "../api";
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
  grading: "ok" | "rating"; // ok：只记对错（计划测试、检测）；rating：复习，按 FSRS 的四档记
  examples: number; // 填词、听写、整句翻译从前几条例句里出题
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

const tokens = (s: string) => s.match(/[A-Za-z']+/g) ?? [];
const shuffle = <T,>(list: T[]) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// 出题和作答。题型：
//   看词选择：看英文选中文，或看中文选英文；听音选择：听读音选中文，或选拼写。都是四选一，另有“不认识”。
//     干扰项由后端挑（同词性、词频相近、意思不重叠；拼写类是拼写相近、读音不同的词）。
//     复习可以在设置里改成老办法：看答案后四档自评（reviewBy = rate）。
//   看中文写英文：显示例句的中文和挖掉目标词（留首字母）的英文，输入这个词；
//   听写：播放例句，句中目标词挖空，输入这个词。这两种程序判对错，接受词形变化。
//   整句翻译：看例句的中文写出整句英文，再对照原句（标出写对的词）自己判对错。
// 选择题答对在复习里算“记得”，答错或不认识算“忘了”。
// 做题时是专注模式：导航收起，左上角 × 退出。
export default function Quiz({ words, mode, grading, examples, settings, onAnswer, onDone, onExit, exitConfirm }: Props) {
  useImmersive(true);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [typed, setTyped] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // 选择题选了哪个，"" 是不认识
  const [choices, setChoices] = useState<Record<string, Choices>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const results = useRef<Result[]>([]);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // 选择题每题的方向：true 是选中文（看英文选中文、听音选中文），false 是选英文。
  const [dirs] = useState(() => words.map(() => Math.random() < 0.5));

  const word = words[i];
  const m: Mode = mode === "mix" ? (i % 2 === 0 ? "listen" : "look") : mode;
  const choice = (m === "look" || m === "listen") && (grading === "ok" || settings.reviewBy === "choice");
  // 例句：从前几条里轮着取，填词类的题优先取含目标词的那条。
  const pool = word ? word.ex.slice(0, examples) : [];
  const hasTarget = (e: (typeof pool)[number]) => tokens(e.en).some((t) => word.forms.includes(t.toLowerCase()));
  const start = pool.length ? i % pool.length : 0;
  const ex = pool.length ? ([...pool.slice(start), ...pool.slice(0, start)].find(hasTarget) ?? pool[start]) : undefined;
  const target = ex ? tokens(ex.en).find((t) => word.forms.includes(t.toLowerCase())) : undefined;
  const typing = m === "write" || m === "dictation";

  useEffect(() => {
    const needs = mode === "look" || mode === "listen" || mode === "mix";
    if (!needs || (grading === "rating" && settings.reviewBy !== "choice")) return;
    api
      .choices(words.map((w) => w.w))
      .then(setChoices)
      .catch((err) => setError(errorText(err)));
  }, [words, mode, grading, settings.reviewBy]);

  // 四个选项：正确答案加三个干扰项，打乱顺序。选中文时显示释义，选英文时显示单词。
  const options = useMemo(() => {
    if (!word || !choice || !choices) return [];
    const c = choices[word.w];
    const distractors = m === "listen" && !dirs[i] ? c?.spelling : c?.meaning;
    return shuffle([{ w: word.w, zh: word.zh[0] ?? "" }, ...(distractors ?? [])]);
  }, [word, choice, choices, m, dirs, i]);
  const toZh = dirs[i];

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
    setPicked(null);
    setError("");
    playPrompt();
    if (typing || m === "translate") input.current?.focus();
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

  // 答完显示答案时读一遍：选择题读单词，填词和整句翻译读原句。
  function reveal() {
    setShown(true);
    stopSpeaking();
    if ((m === "write" || m === "translate") && ex) say(ex.en);
    else if (m === "look" || m === "listen") say(word.w);
  }

  function pick(w: string) {
    setPicked(w);
    reveal();
  }

  function check(e: FormEvent) {
    e.preventDefault();
    setChecked(word.forms.includes(typed.trim().toLowerCase()));
    reveal();
  }

  const correct = results.current.filter((r) => r.ok).length;
  const pickedOk = picked === word.w;
  // 填词的空格：没作答时放首字母（看中文写英文）或一个不换行空格占位（听写），下划线和句子的字底对齐。
  const hint = m === "write" && target ? target[0] : " ";
  const blank = checked === null ? hint : target;
  const typedWords = new Set(tokens(typed).map((t) => t.toLowerCase()));
  const label = choice || (m !== "look" && m !== "listen") ? modeNames[m] : m === "look" ? "看词想意思" : "听音想意思";

  const sentence = ex && (
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
  );

  return (
    <section className={`card ${styles.quiz}`}>
      <span className={styles.bar} style={{ width: `${((i + (shown ? 1 : 0)) / words.length) * 100}%` }} />
      <div className={styles.top}>
        <ExitButton
          label="退出"
          confirm={exitConfirm}
          onExit={() => {
            stopSpeaking();
            onExit();
          }}
        />
        <span className={styles.mode}>
          <Icon name={modeIcons[m]} size={16} />
          {label}
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

      <div className={`${styles.prompt} ${choice ? styles.short : ""}`}>
        {m === "look" && (choice && !toZh ? <p className={styles.mid}>{word.zh.join("；")}</p> : <p className={styles.big}>{word.w}</p>)}
        {m === "listen" && (
          <>
            <button className={styles.play} onClick={playPrompt} disabled={!canSpeak} aria-label="再听一遍" title="再听一遍">
              <Icon name="sound" size={34} />
            </button>
            {choice && <span className={styles.label}>{toZh ? "选出它的意思" : "选出你听到的词"}</span>}
          </>
        )}
        {typing && (
          <>
            {m === "write" && <p className={styles.mid}>{ex && target ? ex.zh : word.zh.join("；")}</p>}
            {ex && target ? sentence : m === "dictation" && <p className={styles.mid}>{word.zh.join("；")}</p>}
            {m === "dictation" && ex && target && <p className="muted">{ex.zh}</p>}
            {m === "dictation" && (
              <button className={styles.replay} onClick={playPrompt} disabled={!canSpeak}>
                <Icon name="sound" size={18} />
                再听一遍
              </button>
            )}
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
                placeholder={m === "write" && !(ex && target) ? "写出这个英文单词" : "写出挖掉的词"}
              />
              {checked === null && (
                <button type="submit" disabled={!typed.trim()}>
                  确定
                </button>
              )}
            </form>
          </>
        )}
        {m === "translate" && ex && (
          <>
            <span className={styles.label}>写出整句英文</span>
            <p className={styles.mid}>{ex.zh}</p>
            <textarea
              ref={input}
              className={`${styles.input} ${styles.sentenceInput}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={shown}
              autoCapitalize="sentences"
              autoCorrect="off"
              spellCheck={false}
              rows={3}
              placeholder="不会的词可以空着"
            />
          </>
        )}
      </div>

      {choice && !choices && !error && <p className="muted">出题中…</p>}
      {choice && options.length > 0 && (
        <div className={styles.options}>
          {options.map((o) => {
            const state = picked === null ? "" : o.w === word.w ? styles.optionRight : o.w === picked ? styles.optionWrong : styles.optionOff;
            return (
              <button key={o.w} className={`${styles.option} ${state}`} onClick={() => pick(o.w)} disabled={picked !== null || busy}>
                {toZh ? o.zh : o.w}
              </button>
            );
          })}
          {picked === null && (
            <button className={`link ${styles.dunno}`} onClick={() => pick("")} disabled={busy}>
              不认识
            </button>
          )}
        </div>
      )}

      {/* 选择题和填词判完后，“下一题”紧跟在作答区下面，答案详情放在它后面。 */}
      {(checked !== null || (choice && picked !== null)) && (
        <button
          className={styles.reveal}
          onClick={() => {
            const ok = typing ? !!checked : pickedOk;
            submit(ok, grading === "rating" ? (ok ? 3 : 1) : 0, typing ? typed.trim() : (picked ?? ""));
          }}
          disabled={busy}
        >
          下一题
        </button>
      )}
      {shown && (
        <div className={styles.answer}>
          {checked !== null && (
            <p className={`${styles.verdict} ${checked ? styles.right : styles.wrong}`}>
              <Icon name={checked ? "check" : "cross"} size={18} />
              {checked ? "答对了" : `正确答案：${target ?? word.w}`}
            </p>
          )}
          {choice && picked !== null && (
            <p className={`${styles.verdict} ${pickedOk ? styles.right : styles.wrong}`}>
              <Icon name={pickedOk ? "check" : "cross"} size={18} />
              {pickedOk ? "答对了" : picked ? "选错了" : "记下了，之后再练"}
            </p>
          )}
          {m === "translate" && ex && (
            <div className={styles.compare}>
              <span className={styles.label}>原句（写对的词标绿）</span>
              <p className={styles.mid}>
                {ex.en.split(/([A-Za-z']+)/).map((part, k) =>
                  /^[A-Za-z']+$/.test(part) ? (
                    <span key={k} className={typedWords.has(part.toLowerCase()) ? styles.matched : ""}>
                      {part}
                    </span>
                  ) : (
                    part
                  ),
                )}
              </p>
              {typed.trim() && <p className="muted">你写的：{typed.trim()}</p>}
            </div>
          )}
          <p className={styles.word}>
            {word.w} {phOf(word, settings.accent) && <span className={styles.wordPh}>[ {phOf(word, settings.accent)} ]</span>}
          </p>
          <p className={styles.meaning}>{word.zh.join("；")}</p>
          {ex && !typing && m !== "translate" && (
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

      {/* 自评：复习的老办法（看答案后四档）和整句翻译（对照原句后判对错）。 */}
      {!shown && !choice && !typing && (
        <button className={styles.reveal} onClick={reveal} disabled={busy}>
          {m === "translate" ? "对照原句" : "看答案"}
        </button>
      )}
      {shown && !choice && !typing && grading === "rating" && (
        <div className={styles.grades}>
          {ratings.map((r) => (
            <button key={r.v} className={`${styles.grade} ${r.cls}`} onClick={() => submit(r.v > 1, r.v, typed.trim())} disabled={busy}>
              <strong>{r.label}</strong>
              <span>{r.hint}</span>
            </button>
          ))}
        </div>
      )}
      {shown && !choice && !typing && grading === "ok" && (
        <div className={styles.grades}>
          <button className={`${styles.grade} ${styles.again}`} onClick={() => submit(false, 0, typed.trim())} disabled={busy}>
            <Icon name="cross" />
            <strong>没译对</strong>
          </button>
          <button className={`${styles.grade} ${styles.easy}`} onClick={() => submit(true, 0, typed.trim())} disabled={busy}>
            <Icon name="check" />
            <strong>译对了</strong>
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
