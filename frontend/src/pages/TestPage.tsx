import { useEffect, useState } from "react";
import { api, errorText, modeNames, scopeNames, type Mode, type Settings, type Test, type TestScope, type WithWords } from "../api";
import Icon, { type IconName } from "../components/Icon";
import ModePicker from "../components/ModePicker";
import Quiz from "../components/Quiz";
import { root } from "../components/Nav";
import Ring from "../components/Ring";
import WordList from "../components/WordList";
import styles from "./pages.module.css";

const scopeIcons: Record<TestScope, IconName> = { recent: "clock", range: "hash", all: "layers", wrong: "wrong" };
const counts = [10, 20, 30, 50, 100];

// 检测：自己选范围和题型，做完看正确率和答错的词；答错的进错题本，并提前到明天复习。
export default function TestPage() {
  const params = new URLSearchParams(location.search);
  const [settings, setSettings] = useState<Settings>();
  const [scope, setScope] = useState<TestScope>((params.get("scope") as TestScope) || "recent");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(100);
  const [count, setCount] = useState(20);
  const [mode, setMode] = useState<Mode>("look");
  const [test, setTest] = useState<WithWords<Test>>();
  const [result, setResult] = useState<WithWords<Test>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then((h) => setSettings(h.settings))
      .catch((err) => setError(errorText(err)));
  }, []);

  async function start() {
    setBusy(true);
    setError("");
    try {
      setTest(await api.createTest({ scope, from, to, count, mode }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <main className="content stack">
        {!settings ? null : result ? (
          <TestResult result={result} accent={settings.accent} />
        ) : test ? (
          <Quiz
            words={test.words}
            mode={test.item.mode}
            grading="ok"
            examples={settings.examples}
            settings={settings}
            onAnswer={(r) => api.answer({ word: r.word.w, kind: "test", refId: test.item.id, mode: r.mode, ok: r.ok, rating: 0, answer: r.answer })}
            onDone={async () => {
              try {
                setResult(await api.finishTest(test.item.id));
              } catch (err) {
                setError(errorText(err));
              }
            }}
          />
        ) : (
          <section className="card stack">
            <div>
              <h1>开始一次检测</h1>
              <p className="muted">答错的词会放进错题本，并提前到明天复习。</p>
            </div>
            <div className={styles.group}>
              <h2>范围</h2>
              <div className={styles.tiles} role="radiogroup" aria-label="范围">
                {(Object.keys(scopeNames) as TestScope[]).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={s === scope} className={`${styles.tile} ${s === scope ? styles.on : ""}`} onClick={() => setScope(s)}>
                    <Icon name={scopeIcons[s]} />
                    <strong>{scopeNames[s]}</strong>
                  </button>
                ))}
              </div>
              {scope === "range" && (
                <label className="field">
                  <span>序号</span>
                  <input type="number" min={1} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
                  到
                  <input type="number" min={1} value={to} onChange={(e) => setTo(Number(e.target.value))} />
                </label>
              )}
            </div>
            <div className={styles.group}>
              <h2>题数</h2>
              <div className={`${styles.tabs} ${styles.full}`} role="radiogroup" aria-label="题数">
                {counts.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={n === count} className={n === count ? styles.on : ""} onClick={() => setCount(n)}>
                    {n} 题
                  </button>
                ))}
              </div>
              <p className="muted">范围里的词不够时全部出。</p>
            </div>
            <div className={styles.group}>
              <h2>题型</h2>
              <ModePicker value={mode} onChange={setMode} />
            </div>
            <button className={styles.wide} onClick={start} disabled={busy}>
              开始检测
            </button>
            <a className="muted" href={root + "history/"}>
              查看检测记录
            </a>
          </section>
        )}
        {error && <p className="error">{error}</p>}
      </main>
    </>
  );
}

export function TestResult({ result, accent }: { result: WithWords<Test>; accent: string }) {
  const { item, missed } = result;
  const percent = item.total ? Math.round((100 * item.correct) / item.total) : 0;
  return (
    <section className="card stack">
      <div className={styles.hero}>
        <h1>检测结果</h1>
        <Ring value={item.correct} total={item.total} label={`${percent}%`} sub="正确率" />
        <div className={styles.chips}>
          <span className={styles.chip}>{scopeNames[item.scope]}</span>
          <span className={styles.chip}>{modeNames[item.mode]}</span>
        </div>
        <div className={styles.figures}>
          <div>
            <strong>{item.total}</strong>
            <span className="muted">题</span>
          </div>
          <div>
            <strong className={styles.good}>{item.correct}</strong>
            <span className="muted">答对</span>
          </div>
          <div>
            <strong className={styles.bad}>{item.total - item.correct}</strong>
            <span className="muted">答错</span>
          </div>
        </div>
      </div>
      {missed.length > 0 && (
        <div className={styles.group}>
          <h2>答错的词 · 已放进错题本，明天复习</h2>
          <WordList words={missed} accent={accent} />
        </div>
      )}
      <a className={`${styles.button} ${styles.wide}`} href={root}>
        回首页
      </a>
    </section>
  );
}
