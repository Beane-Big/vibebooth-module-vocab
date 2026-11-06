import { useEffect, useRef, useState } from "react";
import { api, errorText, orderNames, request, type Order, type Settings, type Stats } from "../api";
import Icon from "../components/Icon";
import { ActionRow, Group, NumberInput, Row, Select, SettingsList, Stepper, Switch } from "../components/SettingsList";
import Sheet from "../components/Sheet";
import { canSpeak, speak } from "../speech";
import styles from "./pages.module.css";

// 停止改动这么久之后保存（输入数字时不用每敲一个字保存一次）。
const saveDelay = 500;

// 个人设置：每个人自己一份，不影响家里其他人。改了就自动保存，右下角轻轻提示一下“已保存”，没有保存按钮。
// 保存失败时提示一直留着，点它重试。离开页面时还没来得及保存的改动也会发出去。
// 页面最下面是“还原”：还原设置，或清空全部学习进度，都要再确认一次。
export default function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const [notice, setNotice] = useState("已保存"); // 成功提示的文字
  const [reset, setReset] = useState<"" | "menu" | "settings" | "progress">("");
  const [counts, setCounts] = useState<Stats & { tests: number }>(); // 清空进度前列出会清掉多少
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<Settings | null>(null); // 还没保存的设置
  const timer = useRef(0);
  const version = useRef(0); // 每次改动加 1；保存回来时已经又改过了，就不用服务器的结果覆盖界面
  const hide = useRef(0);

  function done(text: string) {
    setNotice(text);
    setStatus("saved");
    clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setStatus((x) => (x === "saved" ? "" : x)), 1500);
  }

  function openReset(step: "menu" | "settings" | "progress") {
    setResetError("");
    setReset(step);
    if (step === "progress") {
      setCounts(undefined);
      Promise.all([api.home(), api.tests()])
        .then(([h, t]) => setCounts({ ...h.stats, tests: t.length }))
        .catch((err) => setResetError(errorText(err)));
    }
  }

  async function runReset() {
    setResetting(true);
    setResetError("");
    try {
      if (reset === "settings") {
        // 还没发出去的改动作废，免得保存回来又把默认值盖掉。
        clearTimeout(timer.current);
        pending.current = null;
        version.current++;
        setS(await api.resetSettings());
        done("设置已还原");
      } else {
        await api.resetProgress();
        done("学习进度已清空");
      }
      setReset("");
    } catch (err) {
      setResetError(errorText(err));
    } finally {
      setResetting(false);
    }
  }

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
      done("已保存");
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

  // 数字输入：清空时先只改界面（准备重新输入），填了范围内的数才保存；startN 清空就是“不填”（0）。
  const num = (k: "planWords" | "startN", min: number, max: number, placeholder?: string) => (
    <NumberInput
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
  const step = (k: "wordRepeat" | "sentRepeat" | "wrongClear", min: number, max: number, unit: string) => (
    <Stepper value={s[k]} min={min} max={max} unit={unit} onChange={(v) => set(k, v)} />
  );

  return (
    <>
      <main className="content">
        <SettingsList title="设置">
          <Group title="学习计划" footer="学过的词会跳过，学习顺序随时可以换。“从第几个词开始”只管下一个计划，不填就从第一个没学过的词开始。例句条数也用于复习和检测里的例句题。">
            <Row label="每次学几个词">{num("planWords", 1, 100)}</Row>
            <Row label="学习顺序">
              <Select value={s.order} onChange={(v) => set("order", v)} options={(Object.keys(orderNames) as Order[]).map((o) => [o, orderNames[o]])} />
            </Row>
            {/* 随机顺序的“第几个”没有意义，不显示。 */}
            {s.order !== "random" && <Row label="从第几个词开始">{num("startN", 0, 99999, "不填")}</Row>}
            <Row label="每个词几条例句">
              <Select value={s.examples} onChange={(v) => set("examples", v)} options={[2, 3, 4, 5].map((n) => [n, `${n} 条`])} />
            </Row>
          </Group>

          <Group footer="每个词的词典读音连起来，a、to 这类虚词按弱读显示；没有连读，句子的实际读法以朗读为准。">
            <Row label="例句显示音标">
              <Switch checked={s.sentencePh} onChange={(v) => set("sentencePh", v)} />
            </Row>
          </Group>

          <Group title="朗读" footer={canSpeak ? "英文用 Kokoro 语音，中文用 Piper 语音。一句话第一次读时要等一两秒合成，之后全家共用。" : "当前浏览器不支持朗读。"}>
            <Row label="口音">
              <Select value={s.accent} onChange={(v) => set("accent", v)} options={[["en-US", "美音"], ["en-GB", "英音"]]} />
            </Row>
            <Row label="语速">
              <Select value={s.rate} onChange={(v) => set("rate", v)} options={[0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5].map((r) => [r, r === 1 ? "正常" : `${r} 倍`])} />
            </Row>
            <ActionRow onClick={() => speak("The course comprises ten lessons.", s.accent, s.rate)} disabled={!canSpeak}>
              试听
            </ActionRow>
          </Group>

          <Group
            title="自动播放"
            footer={
              <>
                每页先读一遍中文（打开“读中文”时），再读英文。{s.spellOut && s.sentRepeat >= 2 ? "例句第一遍正常读，第二遍一个词一个词地读，之后正常读。" : ""}
                {s.pauseBy === "audio" ? "每遍之间、翻到下一页前都停这么久：单词停得短、长句停得长。" : "每遍之间、翻到下一页前都停这么久。"}
              </>
            }
          >
            <Row label="读中文">
              <Switch checked={s.autoZh} onChange={(v) => set("autoZh", v)} />
            </Row>
            <Row label="单词英文读几遍" plain>
              {step("wordRepeat", 1, 5, " 遍")}
            </Row>
            <Row label="例句英文读几遍" plain>
              {step("sentRepeat", 1, 5, " 遍")}
            </Row>
            <Row label="例句第二遍拼读" hint={s.sentRepeat < 2 ? "例句读两遍以上才有拼读" : undefined} disabled={s.sentRepeat < 2}>
              <Switch checked={s.spellOut} onChange={(v) => set("spellOut", v)} disabled={s.sentRepeat < 2} />
            </Row>
            <Row label="每句后停多久">
              <Select
                value={s.pauseBy}
                onChange={(v) => set("pauseBy", v)}
                options={[
                  ["audio", "按朗读时长"],
                  ["fixed", "固定秒数"],
                ]}
              />
            </Row>
            {s.pauseBy === "audio" ? (
              <Row label="停顿是朗读时长的">
                <Select value={s.pauseRatio} onChange={(v) => set("pauseRatio", v)} options={[0.5, 1, 1.5, 2].map((r) => [r, r === 1 ? "一样长" : `${r} 倍`])} />
              </Row>
            ) : (
              <Row label="停几秒">
                <Select value={s.autoPause} onChange={(v) => set("autoPause", v)} options={[0, 1, 2, 3, 5, 8].map((n) => [n, `${n} 秒`])} />
              </Row>
            )}
          </Group>

          <Group title="复习和错题本" footer={s.reviewBy === "choice" ? "四选一：答对算记得，答错或不认识算忘了。" : "看答案后按忘了、模糊、记得、轻松安排下次复习。"}>
            <Row label="复习题型">
              <Select
                value={s.reviewMode}
                onChange={(v) => set("reviewMode", v)}
                options={[
                  ["mix", "听音和看词轮换"],
                  ["listen", "只听音"],
                  ["look", "只看词"],
                ]}
              />
            </Row>
            <Row label="复习怎么作答">
              <Select
                value={s.reviewBy}
                onChange={(v) => set("reviewBy", v)}
                options={[
                  ["choice", "四选一"],
                  ["rate", "看答案后自评"],
                ]}
              />
            </Row>
            <Row label="连续答对几次移出错题本" plain>
              {step("wrongClear", 1, 10, " 次")}
            </Row>
          </Group>

          <Group footer="还原设置，或清空全部学习进度，都要再确认一次。">
            <ActionRow onClick={() => openReset("menu")} destructive>
              还原
            </ActionRow>
          </Group>
        </SettingsList>
      </main>

      <Sheet open={reset === "menu"} onClose={() => setReset("")} title="还原">
        <button className={styles.sheetOption} onClick={() => openReset("settings")}>
          <span className={styles.recordIcon}>
            <Icon name="replay" />
          </span>
          <span>
            <strong>还原设置</strong>
            <small>所有设置恢复成默认值，学习进度不变</small>
          </span>
        </button>
        <button className={`${styles.sheetOption} ${styles.risky}`} onClick={() => openReset("progress")}>
          <span className={styles.recordIcon}>
            <Icon name="trash" />
          </span>
          <span>
            <strong>重置学习进度</strong>
            <small>清空学过的词、复习安排、错题本、检测记录和学习计划，设置不变</small>
          </span>
        </button>
        <button className="link" onClick={() => setReset("")}>
          取消
        </button>
      </Sheet>

      <Sheet open={reset === "settings" || reset === "progress"} onClose={() => setReset("")} title={reset === "settings" ? "确定还原设置？" : "确定清空学习进度？"}>
        {reset === "settings" ? (
          <p className="muted">每次学几个词、学习顺序、口音、语速、自动播放、复习方式等都会恢复成默认值。学习进度不受影响。</p>
        ) : (
          <>
            <p>下面这些会全部清空，不能恢复：</p>
            <ul className={styles.sheetList}>
              <li>学过的 {counts?.learned ?? "…"} 个词和它们的复习安排</li>
              <li>错题本里的 {counts?.wrong ?? "…"} 个词</li>
              <li>{counts?.tests ?? "…"} 次检测记录、全部学习计划和作答记录</li>
            </ul>
            <p className="muted">设置不受影响。清空后从第一个词重新开始学。</p>
          </>
        )}
        {resetError && <p className="error">{resetError}</p>}
        <div className={styles.sheetActions}>
          <button className="secondary" onClick={() => setReset("")} disabled={resetting}>
            取消
          </button>
          <button className={reset === "progress" ? "danger" : ""} onClick={runReset} disabled={resetting || (reset === "progress" && !counts)}>
            {reset === "settings" ? "还原设置" : "清空学习进度"}
          </button>
        </div>
      </Sheet>
      <div className={`${styles.toast} ${status ? styles.toastOn : ""} ${status === "failed" ? styles.toastError : ""}`} role="status" aria-live="polite">
        {status === "failed" ? (
          <button className="link" onClick={flush} title={error}>
            保存失败，点这里重试
          </button>
        ) : (
          <>
            <Icon name="check" size={16} />
            {notice}
          </>
        )}
      </div>
    </>
  );
}
