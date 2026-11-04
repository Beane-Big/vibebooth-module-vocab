import { useEffect, useState } from "react";
import { api, errorText, type Settings, type Word } from "../api";
import Icon from "../components/Icon";
import Quiz, { type Result } from "../components/Quiz";
import { root } from "../components/Nav";
import Ring from "../components/Ring";
import styles from "./pages.module.css";

// 每日复习：今天到期的词，按设置里的题型出题，四档自评交给后端的 FSRS 安排下次复习。
export default function Review() {
  const [settings, setSettings] = useState<Settings>();
  const [words, setWords] = useState<Word[]>();
  const [done, setDone] = useState<Result[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.home(), api.review()])
      .then(([home, due]) => {
        setSettings(home.settings);
        setWords(due.words);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  return (
    <>
      <main className="content stack">
        {error && <p className="error">{error}</p>}
        {!words || !settings ? (
          !error && <p className="muted">加载中…</p>
        ) : done ? (
          <section className="card stack">
            <div className={styles.hero}>
              <h1>今天的复习做完了</h1>
              <Ring value={done.filter((r) => r.ok).length} total={done.length} label={String(done.length)} sub="个词" />
              <div className={styles.figures}>
                <div>
                  <strong className={styles.good}>{done.filter((r) => r.ok).length}</strong>
                  <span className="muted">记得</span>
                </div>
                <div>
                  <strong className={styles.bad}>{done.filter((r) => !r.ok).length}</strong>
                  <span className="muted">忘了</span>
                </div>
              </div>
              <p className="muted">忘了的已放进错题本，之后按遗忘规律再出现。</p>
            </div>
            <a className={`${styles.button} ${styles.wide}`} href={root}>
              回首页
            </a>
          </section>
        ) : words.length === 0 ? (
          <section className={`card ${styles.empty}`}>
            <Icon name="check" />
            <h1>今天没有要复习的词</h1>
            <p className="muted">学过的词会按遗忘规律安排复习，到期了会出现在这里。</p>
            <a className={styles.button} href={root}>
              回首页
            </a>
          </section>
        ) : (
          <Quiz
            words={words}
            mode={settings.reviewMode}
            grading="rating"
            examples={settings.examples}
            settings={settings}
            onAnswer={(r) => api.answer({ word: r.word.w, kind: "review", refId: 0, mode: r.mode, ok: r.ok, rating: r.rating, answer: r.answer })}
            onExit={() => (location.href = root)}
            onDone={setDone}
          />
        )}
      </main>
    </>
  );
}
