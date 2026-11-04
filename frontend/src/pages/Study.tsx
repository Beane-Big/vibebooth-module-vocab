import { useEffect, useState } from "react";
import { api, errorText, modeNames, type Mode, type Plan, type Settings, type WithWords, type Word } from "../api";
import ModePicker from "../components/ModePicker";
import Player from "../components/Player";
import Quiz from "../components/Quiz";
import { root } from "../components/Nav";
import WordList from "../components/WordList";
import styles from "./pages.module.css";

// 学习当前计划：先用滑卡或自动播放学完这批词，再做计划测试（只测这批词），最后看结果。答错的词后端放进错题本。
export default function Study() {
  const [settings, setSettings] = useState<Settings>();
  const [plan, setPlan] = useState<WithWords<Plan>>();
  const [phase, setPhase] = useState<"learn" | "pick" | "test" | "result">("learn");
  const [mode, setMode] = useState<Mode>("look");
  const [order, setOrder] = useState<Word[]>([]); // 测试时打乱顺序，开始测试时定下来
  const [start, setStart] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then(async (home) => {
        if (!home.plan) {
          location.href = root;
          return;
        }
        setSettings(home.settings);
        const p = await api.plan(home.plan.id);
        setPlan(p);
        setStart(p.item.pos);
        if (p.item.learnedAt) setPhase("pick");
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  if (!plan || !settings) {
    return (
      <>
        <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
      </>
    );
  }
  const { item, words } = plan;

  return (
    <>
      <main className={phase === "learn" ? "content stack fill" : "content stack"}>
        {phase === "learn" && (
          <Player
            words={words}
            examples={item.examples}
            settings={settings}
            start={start}
            onPos={(pos) => api.savePlanPos(item.id, pos).catch(() => {})}
            doneLabel="学完了，去测试"
            onExit={() => (location.href = root)}
            onDone={() => {
              api.savePlanPos(item.id, 0, true).catch(() => {});
              setPhase("pick");
            }}
          />
        )}

        {phase === "pick" && (
          <section className="card stack">
            <h1>计划测试</h1>
            <p className="muted">只测这次学的 {words.length} 个词，答错的会放进错题本。</p>
            <ModePicker value={mode} onChange={setMode} />
            <div className="actions">
              <button
                onClick={() => {
                  setOrder(shuffle(words));
                  setPhase("test");
                }}
              >
                开始测试
              </button>
              <button
                className="link"
                onClick={() => {
                  setStart(0);
                  setPhase("learn");
                }}
              >
                再学一遍
              </button>
            </div>
          </section>
        )}

        {phase === "test" && (
          <Quiz
            words={order}
            mode={mode}
            grading="ok"
            examples={item.examples}
            settings={settings}
            exitConfirm="计划测试下次要从头做"
            onExit={() => (location.href = root)}
            onAnswer={(r) => api.answer({ word: r.word.w, kind: "plan", refId: item.id, mode: r.mode, ok: r.ok, rating: 0, answer: r.answer })}
            onDone={async () => {
              try {
                setPlan(await api.finishPlan(item.id));
                setPhase("result");
              } catch (err) {
                setError(errorText(err));
              }
            }}
          />
        )}

        {phase === "result" && (
          <section className="card stack">
            <h1>计划完成</h1>
            <p className={styles.result}>
              {item.correct} / {item.total}
            </p>
            <p className="muted">
              {modeNames[mode]}，答对 {item.correct} 个。这批词已经加进每日复习，之后按遗忘规律再出现。
            </p>
            {plan.missed.length > 0 && (
              <>
                <h1>答错的词（已放进错题本）</h1>
                <WordList words={plan.missed} accent={settings.accent} />
              </>
            )}
            <div className="actions">
              <a className={styles.button} href={root}>
                回首页，开始下一个计划
              </a>
            </div>
          </section>
        )}
        {error && <p className="error">{error}</p>}
      </main>
    </>
  );
}

export function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
