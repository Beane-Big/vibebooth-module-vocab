import { useEffect, useState } from "react";
import { api, errorText, type Home as HomeData } from "../api";
import { root } from "../components/Nav";
import styles from "./pages.module.css";

// 首页：学习计划（继续或新建）、今天的复习、统计和其他页面的入口。
// 新计划学几个词、每个词几条例句、从第几个词开始都在设置里改，这里只显示下一个计划会是什么样。
export default function Home() {
  const [data, setData] = useState<HomeData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then(setData)
      .catch((err) => setError(errorText(err)));
  }, []);

  // from 不传时按设置：设置里指定了从第几个开始就用它，否则接着上次。
  async function create(from?: number) {
    setBusy(true);
    setError("");
    try {
      await api.createPlan({ from });
      location.href = root + "study/";
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <>
        <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
      </>
    );
  }
  const { plan, stats, deck, settings } = data;
  const nextFrom = settings.startN || data.nextN;
  const finished = !plan && nextFrom > deck.total;

  return (
    <>
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
            {deck.name}：共 {deck.total} 个，已学 {stats.learned} 个
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
                {/* 放弃后按现在的设置重建：从这个计划的第一个词重新开始，设置里指定了从第几个开始时用设置的。 */}
                <button className="link" onClick={() => create(settings.startN ? undefined : plan.firstN)} disabled={busy}>
                  放弃这个计划，按现在的设置重新开始
                </button>
              </div>
            </>
          ) : finished ? (
            <p>词库已经学完了。可以在设置里指定从第几个词重新开始。</p>
          ) : (
            <>
              <p>
                下一个计划：从第 {nextFrom} 个词开始，学 {settings.planWords} 个，每个词 {settings.examples} 条例句。{" "}
                <a href={root + "settings/"}>在设置里改</a>
              </p>
              <button className={styles.wide} onClick={() => create()} disabled={busy}>
                开始新计划
              </button>
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
          <a href="https://github.com/JoseLlarena/Britfone">Britfone</a>（英音），例句来自 <a href="https://tatoeba.org">Tatoeba</a>（CC BY 2.0 FR），不够的由 AI 补充；英文朗读用{" "}
          <a href="https://huggingface.co/hexgrad/Kokoro-82M">Kokoro</a>（Apache 2.0）。
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
