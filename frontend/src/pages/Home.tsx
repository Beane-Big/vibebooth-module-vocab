import { useEffect, useState } from "react";
import { api, errorText, type Home as HomeData } from "../api";
import Topbar, { root } from "../components/Topbar";
import styles from "./pages.module.css";

// 首页：学习计划（继续或新建）、今天的复习、统计和其他页面的入口。
export default function Home() {
  const [data, setData] = useState<HomeData>();
  const [from, setFrom] = useState(1);
  const [count, setCount] = useState(20);
  const [examples, setExamples] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then((d) => {
        setData(d);
        setFrom(d.nextN);
        setCount(d.settings.planWords);
        setExamples(d.settings.examples);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  async function create() {
    setBusy(true);
    setError("");
    try {
      await api.createPlan(from, count, examples);
      location.href = root + "study/";
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <>
        <Topbar />
        <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
      </>
    );
  }
  const { plan, stats, deck } = data;

  return (
    <>
      <Topbar />
      <main className="content stack">
        <section className={styles.stats}>
          <Stat label="已学" value={stats.learned} />
          <Stat label="今天待复习" value={stats.due} />
          <Stat label="错题本" value={stats.wrong} />
          <Stat label="连续天数" value={stats.streak} />
        </section>

        <section className="card stack">
          <h1>学习计划</h1>
          <div className={styles.progress}>
            <div style={{ width: `${(100 * stats.learned) / deck.total}%` }} />
          </div>
          <p className="muted">
            {deck.name}：共 {deck.total} 个，已学 {stats.learned} 个{!plan && data.nextN <= deck.total ? `，下一个计划从第 ${data.nextN} 个开始` : ""}
          </p>
          {plan ? (
            <>
              <p>
                正在学第 {plan.firstN}–{plan.firstN + plan.words.length - 1} 个词，共 {plan.words.length} 个，每个词 {plan.examples} 条例句
                {plan.learnedAt ? "，已学完，还差计划测试" : ""}。
              </p>
              <div className="actions">
                <a className={styles.button} href={root + "study/"}>
                  {plan.learnedAt ? "去做计划测试" : plan.pos > 0 ? "继续学习" : "开始学习"}
                </a>
                <button className="link" onClick={() => {
                    setFrom(plan.firstN);
                    setData({ ...data, plan: null });
                  }}>
                  放弃这个计划，重新建一个
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>从第几个词开始</span>
                <input type="number" min={1} max={deck.total} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
                <span className="muted">已经认识的词可以跳过</span>
              </label>
              <label className="field">
                <span>这次学几个词</span>
                <input type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>每个词几条例句</span>
                <select value={examples} onChange={(e) => setExamples(Number(e.target.value))}>
                  {[2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} 条
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button onClick={create} disabled={busy || count < 1 || from < 1 || from > deck.total}>
                  开始新计划
                </button>
              </div>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="card stack">
          <h1>每日复习</h1>
          <p className="muted">学过的词按遗忘规律安排复习，每天做完今天到期的就行。</p>
          <div className="actions">
            {stats.due > 0 ? (
              <a className={styles.button} href={root + "review/"}>
                开始复习（{stats.due} 个）
              </a>
            ) : (
              <span className="muted">今天没有要复习的词。</span>
            )}
          </div>
        </section>

        <nav className={styles.links}>
          <a href={root + "test/"} data-tab>
            检测
          </a>
          <a href={root + "wrong/"} data-tab>
            错题本
          </a>
          <a href={root + "history/"}>学习记录</a>
          <a href={root + "settings/"} data-tab>
            设置
          </a>
        </nav>
        <p className="muted">
          单词和释义来自 <a href="https://github.com/skywind3000/ECDICT">ECDICT</a>（MIT），音标来自 <a href="https://github.com/cmusphinx/cmudict">CMUdict</a>（美音）和{" "}
          <a href="https://github.com/JoseLlarena/Britfone">Britfone</a>（英音），例句来自 <a href="https://tatoeba.org">Tatoeba</a>（CC BY 2.0 FR）。
        </p>
      </main>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className="muted">{label}</span>
    </div>
  );
}
