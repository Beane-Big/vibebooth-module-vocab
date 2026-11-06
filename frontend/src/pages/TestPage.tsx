import { useEffect, useState } from "react";
import { api, errorText, modes, modesOf, modesText, planSpan, scopeNames, type Mode, type Plan, type Settings, type Test, type TestScope, type WithWords } from "../api";
import BackBar from "../components/BackBar";
import Icon, { type IconName } from "../components/Icon";
import ModePicker from "../components/ModePicker";
import Quiz from "../components/Quiz";
import { root } from "../components/Nav";
import Ring from "../components/Ring";
import WordList from "../components/WordList";
import { RecordRow } from "./History";
import styles from "./pages.module.css";

// 检测页上能选的范围；计划错题（plan）从已学习的计划详情进来，不在这里选。
const scopeIcons: Record<Exclude<TestScope, "plan">, IconName> = { recent: "clock", range: "hash", all: "layers", wrong: "wrong" };
const counts = [10, 20, 30, 50, 100];

// 上次检测选的题型记在这台设备上，下次默认选上。
const modesKey = "vocab.testModes";
function savedModes(): Mode[] {
  try {
    const list = (localStorage.getItem(modesKey) ?? "").split(",").filter((m): m is Mode => (modes as string[]).includes(m));
    if (list.length) return list;
  } catch {
    // 读不到就用默认
  }
  return ["look"];
}
function saveModes(list: Mode[]) {
  try {
    localStorage.setItem(modesKey, list.join(","));
  } catch {
    // 存不了就算了
  }
}

// 检测：自己选范围和题型，做完看正确率和答错的词；答错的进错题本，并提前到明天复习。
// 选题的页面顶部和做完的结果下面有“检测记录”入口：一张卡片，写着做过几次、最近一次的日期和成绩，点进去是全部记录。
// 带 ?plan=<id> 时是这个计划的错题检查：只选题型，计划答错过的词全出。
export default function TestPage() {
  const params = new URLSearchParams(location.search);
  const planId = Number(params.get("plan"));
  const [plan, setPlan] = useState<WithWords<Plan>>();
  const [settings, setSettings] = useState<Settings>();
  const [scope, setScope] = useState<TestScope>((params.get("scope") as TestScope) || "recent");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(100);
  const [count, setCount] = useState(20);
  const [mode, setMode] = useState<Mode[]>(savedModes);
  const [test, setTest] = useState<WithWords<Test>>();
  const [result, setResult] = useState<WithWords<Test>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [past, setPast] = useState<Test[]>();

  useEffect(() => {
    api
      .home()
      .then((h) => setSettings(h.settings))
      .catch((err) => setError(errorText(err)));
    api.tests().then(setPast, () => setPast([]));
    if (planId) api.plan(planId).then(setPlan, (err) => setError(errorText(err)));
  }, [planId]);

  // 检测记录入口。还没做过检测时不显示（点进去也是空的）。
  const latest = past?.[0];
  const records = latest && (
    <RecordRow
      href={root + "history/?tab=tests"}
      icon="history"
      title="检测记录"
      chips={[`共 ${past!.length} 次`, `最近 ${new Date(latest.finishedAt ?? latest.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`]}
      correct={latest.correct}
      total={latest.total}
    />
  );

  async function start() {
    setBusy(true);
    setError("");
    try {
      saveModes(mode);
      const joined = mode.join(",");
      setTest(await api.createTest(planId ? { scope: "plan", plan: planId, count: 0, mode: joined } : { scope, from, to, count, mode: joined }));
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
          <>
            <TestResult result={result} accent={settings.accent} />
            {records}
          </>
        ) : test ? (
          <Quiz
            words={test.words}
            mode={modesOf(test.item.mode)}
            grading="ok"
            examples={settings.examples}
            settings={settings}
            exitConfirm="这次检测不记成绩"
            onExit={() => setTest(undefined)}
            onAnswer={(r) => api.answer({ word: r.word.w, kind: "test", refId: test.item.id, mode: r.mode, ok: r.ok, rating: 0, answer: r.answer })}
            onDone={async () => {
              try {
                setResult(await api.finishTest(test.item.id));
                api.tests().then(setPast, () => {});
              } catch (err) {
                setError(errorText(err));
              }
            }}
          />
        ) : planId ? (
          <>
            <BackBar href={`${root}history/?plan=${planId}`} label="计划详情" />
            {plan && (
              <section className="card stack">
                <h1>错题检查</h1>
                <p className="muted">
                  {planSpan(plan.item)} 这个计划答错过的 {plan.missed.length} 个词（计划测试和之前每次错题检查答错的合在一起），全部出题。
                </p>
                <div className={styles.group}>
                  <h2>题型</h2>
                  <ModePicker value={mode} onChange={setMode} />
                </div>
                <button className={`${styles.wide} ${styles.sticky}`} onClick={start} disabled={busy || plan.missed.length === 0}>
                  开始检查
                </button>
              </section>
            )}
          </>
        ) : (
          <>
            {records}
            <section className="card stack">
              <h1>开始一次检测</h1>
              <div className={styles.group}>
                <h2>范围</h2>
                <div className={`${styles.tiles} ${styles.compact}`} role="radiogroup" aria-label="范围">
                  {(Object.keys(scopeIcons) as (keyof typeof scopeIcons)[]).map((s) => (
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
              </div>
              <div className={styles.group}>
                <h2>题型</h2>
                <ModePicker value={mode} onChange={setMode} />
              </div>
              <button className={`${styles.wide} ${styles.sticky}`} onClick={start} disabled={busy}>
                开始检测
              </button>
            </section>
          </>
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
          <span className={styles.chip}>{modesText(item.mode)}</span>
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
