import { useEffect, useState } from "react";
import { api, errorText, modeNames, type Mode, type Settings, type Wrong } from "../api";
import Icon from "../components/Icon";
import { modeIcons } from "../components/ModePicker";
import Player from "../components/Player";
import { root } from "../components/Nav";
import WordList from "../components/WordList";
import styles from "./pages.module.css";

type Sort = "recent" | "count";

// 错题本：答错的词自动进来，之后连续答对几次（设置里改）自动移出到“已攻克”。可以直接重学，或者拿来做一次检测。
// 每个词一行：错了几次、错在哪种题型、听写写成了什么、离移出还差几次（圆点）。
export default function Wrongs() {
  const [settings, setSettings] = useState<Settings>();
  const [cleared, setCleared] = useState(false);
  const [list, setList] = useState<Wrong[]>();
  const [mode, setMode] = useState<Mode | "">("");
  const [sort, setSort] = useState<Sort>("recent");
  const [learning, setLearning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then((h) => setSettings(h.settings))
      .catch((err) => setError(errorText(err)));
  }, []);
  useEffect(() => {
    setList(undefined);
    api
      .wrongs(cleared)
      .then(setList)
      .catch((err) => setError(errorText(err)));
  }, [cleared]);

  async function remove(word: string) {
    try {
      await api.clearWrong(word);
      setList(list?.filter((x) => x.word !== word));
    } catch (err) {
      setError(errorText(err));
    }
  }

  const shown = (list ?? [])
    .filter((x) => !mode || x.lastMode === mode)
    .sort((a, b) => (sort === "count" ? b.count - a.count : 0) || b.lastAt.localeCompare(a.lastAt));
  const byWord = new Map(shown.map((x) => [x.word, x]));

  if (learning && settings) {
    return (
      <>
        <main className="content stack fill">
          <Player words={shown.map((x) => x.data)} examples={settings.examples} settings={settings} doneLabel="学完了" onDone={() => setLearning(false)} onExit={() => setLearning(false)} />
        </main>
      </>
    );
  }

  return (
    <>
      <main className="content stack">
        <div className={styles.tabs}>
          <button className={!cleared ? styles.on : ""} onClick={() => setCleared(false)}>
            错题本
          </button>
          <button className={cleared ? styles.on : ""} onClick={() => setCleared(true)}>
            已攻克
          </button>
        </div>

        {!cleared && list && list.length > 0 && (
          <section className={`card ${styles.summary}`}>
            <div>
              <strong>{list.length}</strong>
              <span className="muted"> 个词待攻克{settings ? `，连续答对 ${settings.wrongClear} 次自动移出` : ""}</span>
            </div>
            <div className="actions">
              <button onClick={() => setLearning(true)} disabled={!settings || !shown.length}>
                重学{mode ? "这" : ""} {shown.length} 个词
              </button>
              <a className={`${styles.button} secondary`} href={root + "test/?scope=wrong"}>
                用错题本做检测
              </a>
            </div>
          </section>
        )}

        <section className="card stack">
          {list && list.length > 0 && (
            <div className={styles.filters}>
              <div className={styles.chips} role="radiogroup" aria-label="错在哪种题型">
                <button className={`${styles.chip} ${!mode ? styles.on : ""}`} onClick={() => setMode("")}>
                  全部
                </button>
                {(Object.keys(modeNames) as Mode[]).map((m) => (
                  <button key={m} className={`${styles.chip} ${m === mode ? styles.on : ""}`} onClick={() => setMode(m)}>
                    {modeNames[m]}
                  </button>
                ))}
              </div>
              <div className={styles.tabs}>
                <button className={sort === "recent" ? styles.on : ""} onClick={() => setSort("recent")}>
                  最近出错
                </button>
                <button className={sort === "count" ? styles.on : ""} onClick={() => setSort("count")}>
                  错得多
                </button>
              </div>
            </div>
          )}
          {!list ? (
            <p className="muted">加载中…</p>
          ) : shown.length === 0 ? (
            <div className={styles.empty}>
              <Icon name={cleared ? "trophy" : "check"} />
              <h1>{cleared ? "还没有攻克的词" : list.length ? "这种题型没有错题" : "错题本是空的"}</h1>
              <p className="muted">{cleared ? "错题连续答对几次后会移到这里。" : "答错的词会自动放进来。"}</p>
            </div>
          ) : (
            <WordList
              words={shown.map((x) => x.data)}
              accent={settings?.accent ?? "en-US"}
              extra={(w) => {
                const x = byWord.get(w.w)!;
                return (
                  <>
                    <span className={`${styles.chip} ${styles.chipDanger}`}>错 {x.count} 次</span>
                    {!cleared && (
                      <button className={styles.remove} onClick={() => remove(x.word)} aria-label={`把 ${x.word} 移出错题本`} title="移出错题本">
                        <Icon name="cross" size={16} />
                      </button>
                    )}
                  </>
                );
              }}
              below={(w) => {
                const x = byWord.get(w.w)!;
                return (
                  <div className={styles.chips}>
                    {modeNames[x.lastMode] && (
                      <span className={styles.chip}>
                        <Icon name={modeIcons[x.lastMode]} />
                        错在{modeNames[x.lastMode]}
                      </span>
                    )}
                    {x.lastMode === "dictation" && x.lastAnswer && (
                      <span className={`${styles.chip} ${styles.chipDanger}`}>
                        写成 <s>{x.lastAnswer}</s>
                      </span>
                    )}
                    {!cleared && settings && (
                      <span className={styles.chip} title={`已连对 ${x.streak} 次，连对 ${settings.wrongClear} 次移出`}>
                        <span className={styles.dots}>
                          {Array.from({ length: settings.wrongClear }, (_, k) => (
                            <i key={k} className={k < x.streak ? styles.dotOn : ""} />
                          ))}
                        </span>
                        已连对 {x.streak}/{settings.wrongClear}
                      </span>
                    )}
                  </div>
                );
              }}
            />
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    </>
  );
}
