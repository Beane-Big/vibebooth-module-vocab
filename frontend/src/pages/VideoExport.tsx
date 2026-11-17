import { useEffect, useState } from "react";
import { errorText, request } from "../api";
import { can, getMe } from "../platform";

const base = "/api/vocab/video";
type Job = { state: "idle" | "running" | "ready" | "failed"; done: number; total: number };

// Poll the current account's export while it runs. Visiting the page again resumes monitoring.
export default function VideoExport({ total }: { total: number }) {
  const [allowed, setAllowed] = useState(false);
  const [job, setJob] = useState<Job>();
  const [from, setFrom] = useState(1);
  const [count, setCount] = useState(1);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    getMe(true).then((me) => {
      if (live) setAllowed(!me.all && can(me, "video-export"));
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  const state = job?.state;
  useEffect(() => {
    if (!allowed || state === "ready" || state === "failed" || state === "idle") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<Job>(base);
        if (!live) return;
        setJob(data);
        if (data.state === "running") timer = setTimeout(poll, 2000);
      } catch (err) {
        if (live) {
          setError(errorText(err));
          if (state === "running") timer = setTimeout(poll, 4000);
        }
      }
    }
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [allowed, state]);

  async function start() {
    setStarting(true);
    setError("");
    try {
      setJob(await request<Job>(base, { method: "POST", body: JSON.stringify({ from, count }) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  }

  if (!allowed) return null;
  const running = starting || state === "running";
  const valid = Number.isInteger(from) && Number.isInteger(count) && from >= 1 && count >= 1 && count <= 20 && from + count - 1 <= total;
  return (
    <section className="card stack">
      <h1>视频导出</h1>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void start(); }}>
        <label className="field">起始词序号 <input type="number" min={1} max={total} value={from || ""} onChange={(event) => setFrom(Number(event.target.value))} disabled={running} required /></label>
        <label className="field">词数 <input type="number" min={1} max={Math.max(1, Math.min(20, total - from + 1))} value={count || ""} onChange={(event) => setCount(Number(event.target.value))} disabled={running} required /></label>
        <div className="actions"><button type="submit" disabled={!valid || running}>生成视频</button></div>
      </form>
      {state === "running" && job && (
        <label>正在生成 {job.done} / {job.total} <progress value={job.done} max={job.total} /></label>
      )}
      {state === "failed" && <p className="error">生成失败，请重试。</p>}
      {state === "ready" && (
        <>
          <video src={base + "/file"} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "60vh" }} />
          <div className="actions"><a className="button" href={base + "/file?download=1"}>下载 MP4</a></div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
