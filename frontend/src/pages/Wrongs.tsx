import { useEffect, useState } from "react";
import { api, errorText, modeNames, type Mode, type Settings, type Wrong } from "../api";
import Player from "../components/Player";
import Topbar, { root } from "../components/Topbar";
import WordList from "../components/WordList";
import styles from "./pages.module.css";

type Sort = "recent" | "count";

// 错题本：答错的词自动进来，之后连续答对几次（设置里改）自动移出到“已攻克”。可以直接重学，或者拿来做一次检测。
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
        <Topbar title="错题本 · 重学" />
        <main className="content stack">
          <Player words={shown.map((x) => x.data)} examples={settings.examples} settings={settings} doneLabel="学完了" onDone={() => setLearning(false)} />
        </main>
      </>
    );
  }

  return (
    <>
      <Topbar title="错题本" />
      <main className="content stack">
        <div className={styles.tabs}>
          <button className={!cleared ? styles.on : ""} onClick={() => setCleared(false)}>
            错题本
          </button>
          <button className={cleared ? styles.on : ""} onClick={() => setCleared(true)}>
            已攻克
          </button>
        </div>
        <section className="card stack">
          <div className="actions">
            <select value={mode} onChange={(e) => setMode(e.target.value as Mode | "")}>
              <option value="">全部题型</option>
              {(Object.keys(modeNames) as Mode[]).map((m) => (
                <option key={m} value={m}>
                  错在{modeNames[m]}
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="recent">最近出错的在前</option>
              <option value="count">错得多的在前</option>
            </select>
          </div>
          {!list ? (
            <p className="muted">加载中…</p>
          ) : shown.length === 0 ? (
            <p className="muted">{cleared ? "还没有攻克的词。" : "错题本是空的。"}</p>
          ) : (
            <>
              {!cleared && (
                <div className="actions">
                  <button onClick={() => setLearning(true)} disabled={!settings}>
                    重学这 {shown.length} 个词
                  </button>
                  <a href={root + "test/?scope=wrong"}>用错题本做检测</a>
                </div>
              )}
              <WordList
                words={shown.map((x) => x.data)}
                accent={settings?.accent ?? "en-US"}
                extra={(w) => {
                  const x = byWord.get(w.w)!;
                  return (
                    <>
                      <span>
                        错 {x.count} 次 · {modeNames[x.lastMode] ?? x.lastMode}
                        {x.lastMode === "dictation" && x.lastAnswer ? ` · 写成 ${x.lastAnswer}` : ""}
                        {!cleared && settings ? ` · 已连对 ${x.streak}/${settings.wrongClear}` : ""}
                      </span>
                      {!cleared && (
                        <button className="link" onClick={() => remove(x.word)}>
                          移出
                        </button>
                      )}
                    </>
                  );
                }}
              />
            </>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    </>
  );
}
