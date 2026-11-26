import { useEffect, useRef, useState } from "react";
import { errorText, request } from "../api";
import { can, getMe } from "../platform";
import Sheet from "../components/Sheet";
import VideoAssets from "./VideoAssets";
import styles from "./pages.module.css";
import videoStyles from "./VideoExport.module.css";

const base = "/api/vocab/video";
const countKey = "vocab.videoCount";
const nameKey = "vocab.videoName";
const appendRangeKey = "vocab.videoAppendRange";
type Tab = "create" | "list";
type Chapter = { start: number; end: number; title: string };
type Job = {
  id: number; state: "running" | "ready" | "expired" | "failed" | "canceled";
  from: number; count: number; name?: string; chapters?: Chapter[]; done: number; total: number;
  createdAt: string; expiresAt?: string; retry: boolean;
};
type State = { next: number; total: number; completed: boolean; jobs: Job[] | null };

function loadCount(): number {
  try {
    const value = Number(localStorage.getItem(countKey));
    if (Number.isInteger(value) && value >= 1) return value;
  } catch { /* ignore */ }
  return 20;
}

function saveCount(value: number) {
  if (!Number.isInteger(value) || value < 1) return;
  try { localStorage.setItem(countKey, String(value)); } catch { /* ignore */ }
}

function loadName(): string {
  try { return localStorage.getItem(nameKey) ?? ""; } catch { return ""; }
}

function saveName(value: string) {
  try { localStorage.setItem(nameKey, value); } catch { /* ignore */ }
}

function loadAppendRange(): boolean {
  try { return localStorage.getItem(appendRangeKey) === "1"; } catch { return false; }
}

function saveAppendRange(value: boolean) {
  try { localStorage.setItem(appendRangeKey, value ? "1" : "0"); } catch { /* ignore */ }
}

function parseIntInput(raw: string): number {
  const digits = raw.replace(/\D+/g, "");
  return digits ? Number(digits) : 0;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

// 共享列表定时刷新，只有成功的新导出推进默认序号，重做历史记录保持原进度。
export default function VideoExport() {
  const [allowed, setAllowed] = useState<boolean>();
  const [data, setData] = useState<State>();
  const [tab, setTab] = useState<Tab>("create");
  const [from, setFrom] = useState(1);
  const [count, setCount] = useState(loadCount);
  const [name, setName] = useState(loadName);
  const [appendRange, setAppendRange] = useState(loadAppendRange);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState<number>();
  const [confirmDelete, setConfirmDelete] = useState<Job>();
  const [copied, setCopied] = useState<number>();
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
      await request<Job>(base, { method: "POST", body: JSON.stringify(retryID ? { retryID } : { from, count, name, appendRange }) });
      const value = await request<State>(base);
      if (mounted.current) {
        apply(value);
        setPreview(undefined);
        setTab("list");
      }
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

  async function remove(id: number) {
    setDeleting(id);
    setError("");
    try {
      await request(base + "/" + id, { method: "DELETE" });
      const value = await request<State>(base);
      if (mounted.current) {
        apply(value);
        setPreview(current => current === id ? undefined : current);
        setConfirmDelete(undefined);
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setDeleting(undefined);
    }
  }

  async function copyChapters(job: Job) {
    if (!job.chapters?.length) return;
    const text = job.chapters.map(c => `${formatTime(c.start)} ${c.title}`).join("\n");
    try {
      await copyText(text);
      if (!mounted.current) return;
      setCopied(job.id);
      setTimeout(() => { if (mounted.current) setCopied(current => current === job.id ? undefined : current); }, 2000);
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    }
  }

  if (!allowed || !data) return <main className="content">{error ? <p className="error">{error}</p> : <p className="muted">{allowed === false ? "没有视频导出权限" : "加载中…"}</p>}</main>;
  const jobs = data.jobs ?? [];
  const hasRunning = jobs.some(job => job.state === "running");
  const running = busy || stopping || assetBusy || hasRunning;
  const valid = Number.isInteger(from) && from >= 1 && from <= data.total && Number.isInteger(count) && count >= 1 && from + count - 1 <= data.total;
  const file = (id: number) => base + "/file?id=" + id;
  const previewJob = preview !== undefined ? jobs.find(job => job.id === preview && job.state === "ready") : undefined;

  return (
    <main className={`content stack ${tab === "list" ? videoStyles.wide : ""}`}>
      <div className={`${styles.tabs} ${styles.full}`} role="tablist">
        <button type="button" role="tab" aria-selected={tab === "create"} className={tab === "create" ? styles.on : ""} onClick={() => setTab("create")}>制作视频</button>
        <button type="button" role="tab" aria-selected={tab === "list"} className={tab === "list" ? styles.on : ""} onClick={() => setTab("list")}>视频列表<span className={styles.count}>{jobs.length}</span></button>
      </div>

      {tab === "create" ? (
        <>
          <section className="card stack">
            <h1>制作视频</h1>
            {data.completed && <p className="muted">已生成至词库末尾，可调整范围重新生成。</p>}
            <form className="stack" onSubmit={event => { event.preventDefault(); if (valid && !running) void start(); }}>
              <label className="field">起始词序号<input type="text" inputMode="numeric" pattern="[0-9]*" value={from || ""} onChange={event => { const value = parseIntInput(event.target.value); setFrom(value); if (value >= 1 && value <= data.total) setCount(current => Math.min(current, data.total - value + 1)); }} disabled={running} required /></label>
              <label className="field">词数<input type="text" inputMode="numeric" pattern="[0-9]*" value={count || ""} onChange={event => { const value = parseIntInput(event.target.value); setCount(value); saveCount(value); }} disabled={running} required /></label>
              <label className="field">视频名称<input type="text" maxLength={100} value={name} onChange={event => { setName(event.target.value); saveName(event.target.value); }} disabled={running} /></label>
              <label className="field"><input type="checkbox" checked={appendRange} onChange={event => { setAppendRange(event.target.checked); saveAppendRange(event.target.checked); }} disabled={running} />名称后拼接词序号范围</label>
              <div className="actions">
                <button type="submit" disabled={!valid || running || (data.completed && from === data.next)}>生成视频</button>
                {hasRunning && <button type="button" className="danger" disabled={stopping} onClick={() => void stop()}>{stopping ? "正在终止…" : "终止生成"}</button>}
              </div>
            </form>
          </section>
          <VideoAssets disabled={busy || stopping || hasRunning} onBusy={setAssetBusy} />
        </>
      ) : (
        <section className="card stack">
          {jobs.length === 0 ? (
            <p className="muted">暂无生成记录</p>
          ) : (
            <div className={videoStyles.tableWrap}>
              <table className={videoStyles.table}>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>词范围</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map(job => {
                    const label = job.name || `vocab-${job.id}`;
                    return (
                      <tr key={job.id}>
                        <td className={videoStyles.nameCell} title={label}>{label}</td>
                        <td>{job.from}–{job.from + job.count - 1}（{job.count}词）</td>
                        <td>
                          {job.state === "running" && (
                            <span className={videoStyles.statusCell}>
                              <span>{job.done}/{job.total}</span>
                              <progress className={videoStyles.progressBar} value={job.done} max={job.total} />
                            </span>
                          )}
                          {job.state === "ready" && <span className={videoStyles.ok}>可下载</span>}
                          {job.state === "expired" && <span className="muted">已过期</span>}
                          {job.state === "canceled" && <span className="muted">已终止</span>}
                          {job.state === "failed" && <span className="error">失败</span>}
                        </td>
                        <td className="muted" title={job.expiresAt ? `保留至 ${new Date(job.expiresAt).toLocaleString()}` : undefined}>{formatStamp(job.createdAt)}</td>
                        <td>
                          <div className={videoStyles.rowActions}>
                            {job.state === "running" && (
                              <button type="button" className={videoStyles.actDanger} disabled={stopping} onClick={() => void stop()}>{stopping ? "终止中…" : "终止"}</button>
                            )}
                            {job.state === "ready" && <>
                              <button type="button" className={videoStyles.act} onClick={() => setPreview(job.id)}>预览</button>
                              <a className={videoStyles.actPrimary} href={file(job.id) + "&download=1"} download={label + ".mp4"}>下载</a>
                              {job.chapters && job.chapters.length > 0 && (
                                <button type="button" className={videoStyles.act} onClick={() => void copyChapters(job)}>{copied === job.id ? "已复制" : "章节"}</button>
                              )}
                              <button type="button" className={videoStyles.act} disabled={running} onClick={() => void start(job.id)}>重做</button>
                              <button type="button" className={videoStyles.act} disabled={deleting === job.id} onClick={() => setConfirmDelete(job)}>删除</button>
                            </>}
                            {(job.state === "expired" || job.state === "failed" || job.state === "canceled") && <>
                              <button type="button" className={videoStyles.act} disabled={running} onClick={() => void start(job.id)}>重做</button>
                              <button type="button" className={videoStyles.act} disabled={deleting === job.id} onClick={() => void remove(job.id)}>删除</button>
                            </>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <Sheet open={!!previewJob} onClose={() => setPreview(undefined)} title={previewJob ? (previewJob.name || `vocab-${previewJob.id}`) : ""}>
        {previewJob && <video key={previewJob.id} src={file(previewJob.id)} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "65vh" }} />}
      </Sheet>

      <Sheet open={!!confirmDelete} onClose={() => { if (deleting === undefined) setConfirmDelete(undefined); }} title="确定删除该视频？">
        {confirmDelete && <p className="muted">{confirmDelete.name || `第 ${confirmDelete.from}–${confirmDelete.from + confirmDelete.count - 1} 个词 · ${confirmDelete.count} 个词`}</p>}
        <div className={styles.sheetActions}>
          <button type="button" className="secondary" onClick={() => setConfirmDelete(undefined)} disabled={deleting !== undefined}>取消</button>
          <button type="button" className="danger" onClick={() => confirmDelete && void remove(confirmDelete.id)} disabled={deleting !== undefined}>删除</button>
        </div>
      </Sheet>
    </main>
  );
}
