import { useEffect, useState } from "react";
import { api, errorText, type Settings } from "../api";
import { canSpeak, speak } from "../speech";

// 个人设置：每个人自己一份，不影响家里其他人。
export default function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [nextN, setNextN] = useState(1);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .home()
      .then((h) => {
        setS(h.settings);
        setNextN(h.nextN);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  if (!s) {
    return (
      <>
        <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
      </>
    );
  }
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS({ ...s, [k]: v });
    setMessage("");
  };

  async function save() {
    setError("");
    try {
      setS(await api.saveSettings(s!));
      setMessage("已保存。");
    } catch (err) {
      setError(errorText(err));
    }
  }

  const num = (k: "planWords" | "startN" | "autoRepeat" | "wrongClear", min: number, max: number, placeholder?: string) => (
    <input type="number" min={min} max={max} value={s[k] || (placeholder ? "" : s[k])} placeholder={placeholder} onChange={(e) => set(k, Number(e.target.value))} />
  );

  return (
    <>
      <main className="content stack">
        <section className="card stack">
          <h1>学习计划</h1>
          <label className="field">
            <span>每次学几个词</span>
            {num("planWords", 1, 100)}
          </label>
          <label className="field">
            <span>从第几个词开始</span>
            {num("startN", 0, 99999, `第 ${nextN} 个`)}
            <span className="muted">只管下一个计划，已经认识的词可以跳过；不填就接着上次学</span>
          </label>
          <label className="field">
            <span>每个词几条例句</span>
            <select value={s.examples} onChange={(e) => set("examples", Number(e.target.value))}>
              {[2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
            <span className="muted">也用于复习和检测里的例句题</span>
          </label>
          <label className="field">
            <span>例句显示音标</span>
            <input type="checkbox" checked={s.sentencePh} onChange={(e) => set("sentencePh", e.target.checked)} />
            <span className="muted">每个词的词典读音连起来，a、to 这类虚词按弱读显示；没有连读，句子的实际读法以朗读为准</span>
          </label>
        </section>

        <section className="card stack">
          <h1>朗读和自动播放</h1>
          <label className="field">
            <span>口音</span>
            <select value={s.accent} onChange={(e) => set("accent", e.target.value as Settings["accent"])}>
              <option value="en-US">美音</option>
              <option value="en-GB">英音</option>
            </select>
            <button className="link" onClick={() => speak("The course comprises ten lessons.", s.accent, s.rate)} disabled={!canSpeak}>
              🔊 试听
            </button>
          </label>
          <label className="field">
            <span>语速</span>
            <select value={s.rate} onChange={(e) => set("rate", Number(e.target.value))}>
              {[0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
                <option key={r} value={r}>
                  {r === 1 ? "正常" : `${r} 倍`}
                </option>
              ))}
            </select>
            <span className="muted">英文用 Kokoro 语音，一句话第一次读时要等一两秒合成，之后全家共用</span>
          </label>
          <label className="field">
            <span>英文读几遍</span>
            {num("autoRepeat", 1, 3)}
          </label>
          <label className="field">
            <span>每句后停多久</span>
            <select value={s.pauseBy} onChange={(e) => set("pauseBy", e.target.value as Settings["pauseBy"])}>
              <option value="audio">按这句的朗读时长</option>
              <option value="fixed">固定秒数</option>
            </select>
            {s.pauseBy === "audio" ? (
              <select value={s.pauseRatio} onChange={(e) => set("pauseRatio", Number(e.target.value))} aria-label="朗读时长的几倍">
                {[0.5, 1, 1.5, 2].map((r) => (
                  <option key={r} value={r}>
                    {r === 1 ? "一样长" : `${r} 倍`}
                  </option>
                ))}
              </select>
            ) : (
              <select value={s.autoPause} onChange={(e) => set("autoPause", Number(e.target.value))} aria-label="停几秒">
                {[0, 1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} 秒
                  </option>
                ))}
              </select>
            )}
            <span className="muted">{s.pauseBy === "audio" ? "单词停得短、长句停得长，刚好够跟读一遍" : "留时间跟读"}</span>
          </label>
          <label className="field">
            <span>读中文</span>
            <input type="checkbox" checked={s.autoZh} onChange={(e) => set("autoZh", e.target.checked)} />
          </label>
          {!canSpeak && <p className="muted">当前浏览器不支持朗读。</p>}
        </section>

        <section className="card stack">
          <h1>复习和错题本</h1>
          <label className="field">
            <span>复习题型</span>
            <select value={s.reviewMode} onChange={(e) => set("reviewMode", e.target.value as Settings["reviewMode"])}>
              <option value="mix">听音和看词轮换</option>
              <option value="listen">听音想意思</option>
              <option value="look">看词想意思</option>
            </select>
          </label>
          <label className="field">
            <span>连续答对几次移出错题本</span>
            {num("wrongClear", 1, 10)}
          </label>
        </section>

        <div className="actions">
          <button onClick={save}>保存</button>
          {message && <span className="muted">{message}</span>}
          {error && <p className="error">{error}</p>}
        </div>
      </main>
    </>
  );
}
