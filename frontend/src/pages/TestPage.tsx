import { useEffect, useState } from "react";
import { api, errorText, scopeNames, type Mode, type Settings, type Test, type TestScope, type WithWords } from "../api";
import ModePicker from "../components/ModePicker";
import Quiz from "../components/Quiz";
import { root } from "../components/Nav";
import WordList from "../components/WordList";
import styles from "./pages.module.css";

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
            <h1>开始一次检测</h1>
            <div className={styles.tabs}>
              {(Object.keys(scopeNames) as TestScope[]).map((s) => (
                <button key={s} className={s === scope ? styles.on : ""} onClick={() => setScope(s)}>
                  {scopeNames[s]}
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
            <label className="field">
              <span>题数</span>
              <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              <span className="muted">范围里的词不够时全部出</span>
            </label>
            <ModePicker value={mode} onChange={setMode} />
            <div className="actions">
              <button onClick={start} disabled={busy || count < 1}>
                开始检测
              </button>
              <a href={root + "history/"}>检测记录</a>
            </div>
          </section>
        )}
        {error && <p className="error">{error}</p>}
      </main>
    </>
  );
}

export function TestResult({ result, accent }: { result: WithWords<Test>; accent: string }) {
  const { item, missed } = result;
  return (
    <section className="card stack">
      <h1>检测结果</h1>
      <p className={styles.result}>{item.total ? Math.round((100 * item.correct) / item.total) : 0}%</p>
      <p className="muted">
        {scopeNames[item.scope]}，共 {item.total} 题，答对 {item.correct} 题。
      </p>
      {missed.length > 0 && (
        <>
          <h1>答错的词（已放进错题本，明天复习）</h1>
          <WordList words={missed} accent={accent} />
        </>
      )}
      <div className="actions">
        <a className={styles.button} href={root}>
          回首页
        </a>
      </div>
    </section>
  );
}
