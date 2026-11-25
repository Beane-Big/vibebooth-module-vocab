import { useEffect, useRef, useState } from "react";
import { errorText, request } from "../api";
import { can, getMe } from "../platform";
import VideoAssets from "./VideoAssets";
import styles from "./pages.module.css";

const base = "/api/vocab/video";
const countKey = "vocab.videoCount";
type Job = {
  id: number; state: "running" | "ready" | "expired" | "failed" | "canceled";
  from: number; count: number; done: number; total: number;
  createdAt: string; expiresAt?: string; retry: boolean;
};
type State = { next: number; total: number; completed: boolean; jobs: Job[] | null };

function loadCount(): number {
  try {
    const value = Number(localStorage.getItem(countKey));
    if (Number.isInteger(value) && value >= 1 && value <= 20) return value;
  } catch { /* ignore */ }
  return 20;
}

function saveCount(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 20) return;
  try { localStorage.setItem(countKey, String(value)); } catch { /* ignore */ }
}

// 共享列表定时刷新，只有成功的新导出推进默认序号，重做历史记录保持原进度。
export default function VideoExport() {
  const [allowed, setAllowed] = useState<boolean>();
  const [data, setData] = useState<State>();
  const [from, setFrom] = useState(1);
  const [count, setCount] = useState(loadCount);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<number>();
  const previousNext = useRef<number | undefined>(undefined);
  const previousCompleted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    getMe(true).then(me => {
      if (mounted.current) setAllowed(!me.all && can(me, "video-export"));
    }).catch(err => { if (mounted.current) setError(errorText(err)); });
    return () => { mounted.current = false; };
  }, []);

  function apply(value: State) {
    if (previousNext.current !== value.next || previousCompleted.current !== value.completed) {
      setFrom(value.next);
      setCount(Math.min(loadCount(), value.total - value.next + 1));
      previousNext.current = value.next;
      previousCompleted.current = value.completed;
    }
    setData(value);
  }

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await request<State>(base);
        if (live) { apply(value); setError(""); }
      } catch (err) {
        if (live) setError(errorText(err));
      }
      if (live) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [allowed]);

  async function start(retryID?: number) {
    setBusy(true);
    setError("");
    try {
      await request<Job>(base, { method: "POST", body: JSON.stringify(retryID ? { retryID } : { from, count }) });
      const value = await request<State>(base);
      if (mounted.current) { apply(value); setPreview(undefined); }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function stop() {
    setStopping(true);
    setError("");
    try {
      await request(base, { method: "DELETE" });
      const value = await request<State>(base);
      if (mounted.current) apply(value);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setStopping(false);
    }
  }

  if (!allowed || !data) return <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">{allowed === false ? "没有视频导出权限" : "加载中…"}</p>}</main>;
  const jobs = data.jobs ?? [];
  const hasRunning = jobs.some(job => job.state === "running");
  const running = busy || stopping || assetBusy || hasRunning;
  const valid = Number.isInteger(from) && from >= 1 && from <= data.total && Number.isInteger(count) && count >= 1 && count <= 20 && from + count - 1 <= data.total;
  const file = (id: number) => base + "/file?id=" + id;
  return (
    <main className="content stack">
      <section className="card stack">
        <h1>视频导出</h1>
        {data.completed && <p className="muted">已生成至词库末尾，可调整范围重新生成。</p>}
        <form className="stack" onSubmit={event => { event.preventDefault(); if (valid && !running) void start(); }}>
          <label className="field">起始词序号<input type="number" min={1} max={data.total} value={from || ""} onChange={event => { const value = Number(event.target.value); setFrom(value); if (value >= 1 && value <= data.total) setCount(current => Math.min(current, data.total - value + 1)); }} disabled={running} required /></label>
          <label className="field">词数<input type="number" min={1} max={Math.max(1, Math.min(20, data.total - from + 1))} value={count || ""} onChange={event => { const value = Number(event.target.value); setCount(value); saveCount(value); }} disabled={running} required /></label>
          <div className="actions">
            <button type="submit" disabled={!valid || running || (data.completed && from === data.next)}>生成视频</button>
            {hasRunning && <button type="button" className="danger" disabled={stopping} onClick={() => void stop()}>{stopping ? "正在终止…" : "终止生成"}</button>}
          </div>
        </form>
      </section>
      <VideoAssets disabled={busy || stopping || hasRunning} onBusy={setAssetBusy} />
      <section className="stack">
        <h2>生成记录</h2>
        {jobs.length === 0 && <p className="muted">暂无生成记录</p>}
        {jobs.map(job => (
          <article className="card stack" key={job.id}>
            <h3>第 {job.from}–{job.from + job.count - 1} 个词 · {job.count} 个词</h3>
            <time className="muted">{new Date(job.createdAt).toLocaleString()}</time>
            {job.state === "running" && <>
              <label>正在生成 {job.done} / {job.total}<progress value={job.done} max={job.total} /></label>
              <div className="actions"><button type="button" className="danger" disabled={stopping} onClick={() => void stop()}>{stopping ? "正在终止…" : "终止生成"}</button></div>
            </>}
            {job.state === "canceled" && <p className="muted">已终止</p>}
            {job.state === "expired" && <p className="muted">视频已过期</p>}
            {job.state === "failed" && <p className="error">生成失败</p>}
            {job.state === "ready" && <>
              {job.expiresAt && <p className="muted">保留至 {new Date(job.expiresAt).toLocaleString()}</p>}
              <div className="actions">
                <button className="secondary" onClick={() => setPreview(preview === job.id ? undefined : job.id)}>{preview === job.id ? "收起预览" : "预览"}</button>
                <a className={styles.button} href={file(job.id) + "&download=1"}>下载 MP4</a>
              </div>
              {preview === job.id && <video key={job.id} src={file(job.id)} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "65vh" }} />}
            </>}
            {(job.state === "expired" || job.state === "failed" || job.state === "canceled") && <div className="actions"><button className="secondary" disabled={running} onClick={() => void start(job.id)}>重新生成</button></div>}
          </article>
        ))}
      </section>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
