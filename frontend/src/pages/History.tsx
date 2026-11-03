import { useEffect, useState } from "react";
import { api, errorText, modeNames, scopeNames, type Plan, type Settings, type Test, type WithWords } from "../api";
import { root } from "../components/Nav";
import WordList from "../components/WordList";
import { TestResult } from "./TestPage";
import styles from "./pages.module.css";

type Row = { kind: "plan"; at: string; item: Plan } | { kind: "test"; at: string; item: Test };

// 学习记录：做完的学习计划和检测，新的在前；点开看答错的词。
export default function History() {
  const params = new URLSearchParams(location.search);
  const [settings, setSettings] = useState<Settings>();
  const [rows, setRows] = useState<Row[]>();
  const [plan, setPlan] = useState<WithWords<Plan>>();
  const [test, setTest] = useState<WithWords<Test>>();
  const [error, setError] = useState("");
  const planId = Number(params.get("plan"));
  const testId = Number(params.get("test"));

  useEffect(() => {
    const fail = (err: unknown) => setError(errorText(err));
    api.home().then((h) => setSettings(h.settings), fail);
    if (planId) api.plan(planId).then(setPlan, fail);
    else if (testId) api.test(testId).then(setTest, fail);
    else
      Promise.all([api.plans(), api.tests()]).then(([plans, tests]) => {
        const all: Row[] = [
          ...plans.map((p): Row => ({ kind: "plan", at: p.finishedAt ?? p.createdAt, item: p })),
          ...tests.map((t): Row => ({ kind: "test", at: t.finishedAt ?? t.createdAt, item: t })),
        ];
        setRows(all.sort((a, b) => b.at.localeCompare(a.at)));
      }, fail);
  }, [planId, testId]);

  const accent = settings?.accent ?? "en-US";
  const date = (s: string) => new Date(s).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <main className="content stack">
        {error && <p className="error">{error}</p>}
        {test && <TestResult result={test} accent={accent} />}
        {plan && (
          <section className="card stack">
            <h1>
              学习计划：第 {plan.item.firstN}–{plan.item.firstN + plan.item.words.length - 1} 个词
            </h1>
            <p className={styles.result}>
              {plan.item.correct} / {plan.item.total}
            </p>
            {plan.missed.length > 0 && (
              <>
                <h1>答错的词</h1>
                <WordList words={plan.missed} accent={accent} />
              </>
            )}
            <h1>这次学的词</h1>
            <WordList words={plan.words} accent={accent} />
          </section>
        )}
        {(plan || test) && <a href={root + "history/"}>返回学习记录</a>}
        {rows && (
          <section className="card stack">
            {rows.length === 0 ? (
              <p className="muted">还没有做完的计划或检测。</p>
            ) : (
              <ul className="list">
                {rows.map((r) => (
                  <li key={r.kind + r.item.id}>
                    <a href={`${root}history/?${r.kind}=${r.item.id}`}>
                      {r.kind === "plan"
                        ? `学习计划 · 第 ${r.item.firstN}–${r.item.firstN + r.item.words.length - 1} 个词`
                        : `检测 · ${scopeNames[r.item.scope]} · ${modeNames[r.item.mode]}`}
                    </a>
                    <span className="muted">
                      {" "}
                      · {r.item.correct}/{r.item.total} · {date(r.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </>
  );
}
