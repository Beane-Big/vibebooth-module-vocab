import { useEffect, useState } from "react";
import { api, errorText, planSpan, type Plan, type Settings, type WithWords } from "../api";
import Player from "../components/Player";
import { useStudyTimer } from "../components/useStudyTimer";
import { root } from "../components/Nav";
import styles from "./pages.module.css";

// 把做完的计划再学一遍：?plan=<id> 学整批词（再次学习），再带 &wrong 只学答错过的词（错题学习）。
// 只是翻卡片，不改计划、不记作答（学习时长照样记在这个计划上）；学完可以接着做这个计划的错题检查。从首页进来时（&home）退出回首页，否则回计划详情。
export default function Relearn() {
  const params = new URLSearchParams(location.search);
  const planId = Number(params.get("plan"));
  const wrongOnly = params.has("wrong");
  const [settings, setSettings] = useState<Settings>();
  const [plan, setPlan] = useState<WithWords<Plan>>();
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  // 再学的时间也记在这个计划上；没有要学的词时不计。
  useStudyTimer(planId, !!plan && !done && (wrongOnly ? plan.missed : plan.words).length > 0);

  useEffect(() => {
    const fail = (err: unknown) => setError(errorText(err));
    api.home().then((h) => setSettings(h.settings), fail);
    api.plan(planId).then(setPlan, fail);
  }, [planId]);

  if (!plan || !settings) {
    return (
      <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
    );
  }
  const words = wrongOnly ? plan.missed : plan.words;
  const detail = `${root}history/?plan=${planId}`;
  const back = params.has("home") ? root : detail;

  if (done || words.length === 0) {
    return (
      <main className="content stack">
        <section className="card stack">
          <h1>{words.length === 0 ? "这个计划没有答错的词" : wrongOnly ? "错题学完了" : "又学完一遍"}</h1>
          <p className="muted">
            {planSpan(plan.item)}
            {words.length > 0 && `，${words.length} 个词`}
            {plan.missed.length > 0 ? `。可以检查一下答错过的 ${plan.missed.length} 个词记住了没有。` : "。"}
          </p>
          <div className="actions">
            {plan.missed.length > 0 && (
              <a className={styles.button} href={`${root}test/?plan=${planId}`}>
                错题检查
              </a>
            )}
            <a className={`${styles.button} secondary`} href={back}>
              {back === root ? "回首页" : "返回计划详情"}
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="content stack fill">
      <Player words={words} examples={plan.item.examples} settings={settings} doneLabel="学完了" onExit={() => (location.href = back)} onDone={() => setDone(true)} />
    </main>
  );
}
