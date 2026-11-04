import { useEffect, useRef, useState } from "react";
import { api, errorText, orderNames, request, type Order, type Settings } from "../api";
import Icon from "../components/Icon";
import { canSpeak, speak } from "../speech";
import styles from "./pages.module.css";

// 停止改动这么久之后保存（输入数字时不用每敲一个字保存一次）。
const saveDelay = 500;

// 个人设置：每个人自己一份，不影响家里其他人。改了就自动保存，右下角轻轻提示一下“已保存”，没有保存按钮。
// 保存失败时提示一直留着，点它重试。离开页面时还没来得及保存的改动也会发出去。
export default function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const [error, setError] = useState("");
  const pending = useRef<Settings | null>(null); // 还没保存的设置
  const timer = useRef(0);
  const version = useRef(0); // 每次改动加 1；保存回来时已经又改过了，就不用服务器的结果覆盖界面
  const hide = useRef(0);

  async function flush() {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    const v = version.current;
    try {
      const saved = await api.saveSettings(next);
      // 服务器会把越界的值拉回范围内，没有新改动时用它的结果。
      if (v === version.current) setS(saved);
      setStatus("saved");
      clearTimeout(hide.current);
      hide.current = window.setTimeout(() => setStatus((x) => (x === "saved" ? "" : x)), 1500);
    } catch (err) {
      pending.current ??= next;
      setStatus("failed");
      setError(errorText(err));
    }
  }

  useEffect(() => {
    // 离开页面（换页、关掉）时把没保存的改动发出去；keepalive 让请求在页面关掉后也能发完。
    const onHide = () => {
      if (!pending.current) return;
      request("/api/vocab/settings", { method: "PUT", body: JSON.stringify(pending.current), keepalive: true }).catch(() => {});
      pending.current = null;
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      clearTimeout(timer.current);
      clearTimeout(hide.current);
    };
  }, []);

  useEffect(() => {
    api
      .home()
      .then((h) => setS(h.settings))
      .catch((err) => setError(errorText(err)));
  }, []);

  if (!s) {
    return (
      <>
        <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>}</main>
      </>
    );
  }
  // 改一项：界面立刻变，停下 saveDelay 后保存。save 为假时只改界面（数字框还没填完，比如清空了准备重新输入）。
  const set = <K extends keyof Settings>(k: K, v: Settings[K], save = true) => {
    const next = { ...s, [k]: v };
    setS(next);
    version.current++;
    if (!save) return;
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, saveDelay);
  };

  const num = (k: "planWords" | "startN" | "autoRepeat" | "wrongClear", min: number, max: number, placeholder?: string) => (
    <input
      type="number"
      min={min}
      max={max}
      value={s[k] || (placeholder ? "" : s[k])}
      placeholder={placeholder}
      onChange={(e) => {
        const n = Number(e.target.value);
        set(k, n, e.target.value === "" ? min === 0 : n >= min && n <= max);
      }}
    />
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
            <span>学习顺序</span>
            <select value={s.order} onChange={(e) => set("order", e.target.value as Order)}>
              {(Object.keys(orderNames) as Order[]).map((o) => (
                <option key={o} value={o}>
                  {orderNames[o]}
                </option>
              ))}
            </select>
            <span className="muted">学过的词会跳过，随时可以换</span>
          </label>
          {/* 随机顺序的“第几个”没有意义，不显示。 */}
          {s.order !== "random" && (
            <label className="field">
              <span>从第几个词开始</span>
              {num("startN", 0, 99999, "不填")}
              <span className="muted">只管下一个计划；不填就从第一个没学过的词开始</span>
            </label>
          )}
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
              <option value="listen">只听音</option>
              <option value="look">只看词</option>
            </select>
          </label>
          <label className="field">
            <span>复习怎么作答</span>
            <select value={s.reviewBy} onChange={(e) => set("reviewBy", e.target.value as Settings["reviewBy"])}>
              <option value="choice">四选一</option>
              <option value="rate">看答案后自己评（四档）</option>
            </select>
            <span className="muted">{s.reviewBy === "choice" ? "答对算记得，答错或不认识算忘了" : "按忘了、模糊、记得、轻松安排下次复习"}</span>
          </label>
          <label className="field">
            <span>连续答对几次移出错题本</span>
            {num("wrongClear", 1, 10)}
          </label>
        </section>

      </main>
      <div className={`${styles.toast} ${status ? styles.toastOn : ""} ${status === "failed" ? styles.toastError : ""}`} role="status" aria-live="polite">
        {status === "failed" ? (
          <button className="link" onClick={flush} title={error}>
            保存失败，点这里重试
          </button>
        ) : (
          <>
            <Icon name="check" size={16} />
            已保存
          </>
        )}
      </div>
    </>
  );
}
