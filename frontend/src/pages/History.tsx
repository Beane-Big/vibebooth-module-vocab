import { useEffect, useState } from "react";
import { api, durationText, errorText, modesText, planSpan, scopeNames, type Plan, type Settings, type Test, type WithWords } from "../api";
import BackBar from "../components/BackBar";
import Icon, { type IconName } from "../components/Icon";
import { root } from "../components/Nav";
import Ring from "../components/Ring";
import WordList from "../components/WordList";
import { TestResult } from "./TestPage";
import styles from "./pages.module.css";

type Tab = "plans" | "tests";

// 已学习：两栏，“已学习”是做完的学习计划，“检测记录”是做完的检测，新的在前；点一行看详情（答错的词、这次学的词）。
// 列表页左上角返回进来的地方（首页或检测页），详情页返回列表。
export default function History() {
  const params = new URLSearchParams(location.search);
  const planId = Number(params.get("plan"));
  const testId = Number(params.get("test"));
  const tab: Tab = params.get("tab") === "tests" || testId ? "tests" : "plans";
  const [settings, setSettings] = useState<Settings>();
  const [plans, setPlans] = useState<Plan[]>();
  const [tests, setTests] = useState<Test[]>();
  const [plan, setPlan] = useState<WithWords<Plan>>();
  const [test, setTest] = useState<WithWords<Test>>();
  const [error, setError] = useState("");

  useEffect(() => {
    const fail = (err: unknown) => setError(errorText(err));
    api.home().then((h) => setSettings(h.settings), fail);
    if (planId) api.plan(planId).then(setPlan, fail);
    else if (testId) api.test(testId).then(setTest, fail);
    else if (tab === "plans") api.plans().then(setPlans, fail);
    else api.tests().then(setTests, fail);
  }, [planId, testId, tab]);

  const accent = settings?.accent ?? "en-US";
  const list = root + "history/" + (tab === "tests" ? "?tab=tests" : "");
  const date = (s: string) => new Date(s).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const range = (p: Plan) => `${planSpan(p)}，${p.words.length} 个词`;

  // 详情页
  if (planId || testId) {
    return (
      <main className="content stack">
        <BackBar href={list} label={tab === "tests" ? "检测记录" : "已学习"} />
        {error && <p className="error">{error}</p>}
        {test && <TestResult result={test} accent={accent} />}
        {plan && (
          <section className="card stack">
            <div className={styles.hero}>
              <h1>{range(plan.item)}</h1>
              <Ring value={plan.item.correct} total={plan.item.total} label={`${plan.item.correct}/${plan.item.total}`} sub="计划测试答对" />
              <div className={styles.chips}>
                <span className={styles.chip}>{plan.item.words.length} 个词</span>
                <span className={styles.chip}>每个词 {plan.item.examples} 条例句</span>
                {plan.item.finishedAt && <span className={styles.chip}>{date(plan.item.finishedAt)}</span>}
                {plan.item.studySecs > 0 && <span className={styles.chip}>学习 {durationText(plan.item.studySecs)}</span>}
              </div>
            </div>
            {/* 错题学习、错题检查只看这个计划答错过的词（计划测试和每次错题检查答错的合在一起）；再次学习是整批词从头学。 */}
            <div className={styles.buttonRow}>
              {plan.missed.length > 0 && (
                <>
                  <a className={styles.button} href={`${root}relearn/?plan=${plan.item.id}&wrong`}>
                    错题学习
                  </a>
                  <a className={`${styles.button} secondary`} href={`${root}test/?plan=${plan.item.id}`}>
                    错题检查
                  </a>
                </>
              )}
              <a className={`${styles.button} secondary`} href={`${root}relearn/?plan=${plan.item.id}`}>
                再次学习
              </a>
              <a className={`${styles.button} secondary`} href={`${root}test/?scope=learned&plan=${plan.item.id}`}>
                检测全部
              </a>
            </div>
            {plan.missed.length > 0 && (
              <div className={styles.group}>
                <h2>答错过的词 · {plan.missed.length} 个</h2>
                <WordList words={plan.missed} accent={accent} />
              </div>
            )}
            <div className={styles.group}>
              <h2>这次学的词</h2>
              <WordList words={plan.words} accent={accent} />
            </div>
          </section>
        )}
      </main>
    );
  }

  // 列表页
  const rows = tab === "plans" ? plans : tests;
  return (
    <main className="content stack">
      <BackBar href={tab === "tests" ? root + "test/" : root} label={tab === "tests" ? "检测" : "学习"} />
      <div className={styles.tabs}>
        <a className={tab === "plans" ? styles.on : ""} href={root + "history/"}>
          已学习
        </a>
        <a className={tab === "tests" ? styles.on : ""} href={root + "history/?tab=tests"}>
          检测记录
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {!rows ? (
        !error && <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <section className={`card ${styles.empty}`}>
          <Icon name={tab === "plans" ? "book" : "test"} />
          <h1>{tab === "plans" ? "还没有学完的计划" : "还没有做完的检测"}</h1>
          <p className="muted">{tab === "plans" ? "学完一个计划并做完计划测试后，会出现在这里。" : "做完一次检测后，结果会出现在这里。"}</p>
          <a className={styles.button} href={tab === "plans" ? root : root + "test/"}>
            {tab === "plans" ? "去学习" : "去检测"}
          </a>
        </section>
      ) : (
        <ul className={styles.records}>
          {tab === "plans"
            ? plans!.map((p) => (
                <li key={p.id}>
                  <RecordRow href={`${root}history/?plan=${p.id}`} icon="book" title={range(p)} chips={[`${p.words.length} 个词`, date(p.finishedAt ?? p.createdAt), ...(p.studySecs > 0 ? [`学习 ${durationText(p.studySecs)}`] : [])]} correct={p.correct} total={p.total} />
                </li>
              ))
            : tests!.map((t) => (
                <li key={t.id}>
                  <RecordRow
                    href={`${root}history/?test=${t.id}`}
                    icon="test"
                    title={`${scopeNames[t.scope]} · ${modesText(t.mode)}`}
                    chips={[`${t.total} 题`, date(t.finishedAt ?? t.createdAt)]}
                    correct={t.correct}
                    total={t.total}
                  />
                </li>
              ))}
        </ul>
      )}
    </main>
  );
}

// 记录的一行（一张整行可点的卡片）：图标、标题和小标签，右边是答对比例（全对绿色，过半蓝色，不到一半红色），最右一个箭头。
// 检测页顶部的“检测记录”入口也用它。
export function RecordRow({ href, icon, title, chips, correct, total }: { href: string; icon: IconName; title: string; chips: string[]; correct: number; total: number }) {
  const ratio = total ? correct / total : 0;
  const tone = ratio === 1 ? styles.good : ratio >= 0.5 ? styles.chipAccent : styles.bad;
  return (
    <a className={styles.record} href={href}>
      <span className={styles.recordIcon}>
        <Icon name={icon} />
      </span>
      <span className={styles.recordMain}>
        <strong>{title}</strong>
        <span className={styles.chips}>
          {chips.map((c) => (
            <span key={c} className={styles.chip}>
              {c}
            </span>
          ))}
        </span>
      </span>
      <span className={`${styles.score} ${tone}`}>
        {correct}/{total}
      </span>
      <Icon name="next" size={18} />
    </a>
  );
}
