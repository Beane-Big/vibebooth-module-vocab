import { useEffect, useRef, useState } from "react";
import { errorText, request } from "../api";

type Asset = { duration: number; size: number; updatedAt: string };
type Assets = Partial<Record<"intro" | "outro", Asset>>;
const base = "/api/vocab/video/assets";

// 片头片尾是共享素材，上传成功后替换原素材。上传失败保留原预览。
export default function VideoAssets({ disabled, onBusy }: { disabled: boolean; onBusy: (busy: boolean) => void }) {
  const [assets, setAssets] = useState<Assets>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const intro = useRef<HTMLInputElement>(null);
  const outro = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    request<Assets>(base).then(value => { if (mounted.current) setAssets(value); })
      .catch(err => { if (mounted.current) setError(errorText(err)); });
    return () => { mounted.current = false; };
  }, []);

  async function change(kind: "intro" | "outro", file?: File) {
    if (file && file.size > 50 * 1024 * 1024) { setError("视频不能超过 50 MB"); return; }
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (file) {
        const body = new FormData();
        body.append("file", file);
        const asset = await request<Asset>(base + "/" + kind, { method: "POST", body });
        if (mounted.current) setAssets(previous => ({ ...previous, [kind]: asset }));
      } else {
        await request(base + "/" + kind, { method: "DELETE" });
        if (mounted.current) setAssets(previous => ({ ...previous, [kind]: undefined }));
      }
    } catch (err) {
      if (mounted.current) setError(errorText(err));
    } finally {
      if (mounted.current) setBusy(false);
      onBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>片头片尾</h2>
      {(["intro", "outro"] as const).map(kind => {
        const asset = assets[kind];
        const input = kind === "intro" ? intro : outro;
        const label = kind === "intro" ? "片头" : "片尾";
        return (
          <section className="stack" key={kind}>
            <h3>{label}</h3>
            {asset && <>
              <video aria-label={label + "预览"} key={asset.updatedAt} src={base + "/" + kind + "?v=" + encodeURIComponent(asset.updatedAt)} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "32vh" }} />
              <span className="muted">{asset.duration.toFixed(1)} 秒 · {(asset.size / 1024 / 1024).toFixed(1)} MB</span>
            </>}
            <input aria-label={label + "文件"} ref={input} hidden type="file" accept=".mp4,.mov,video/mp4,video/quicktime" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void change(kind, file); }} />
            <div className="actions">
              <button type="button" className="secondary" disabled={busy || disabled} onClick={() => input.current?.click()}>{asset ? "替换" : "上传"}{label}</button>
              {asset && <button type="button" className="secondary" aria-label={"移除" + label} disabled={busy || disabled} onClick={() => void change(kind)}>移除</button>}
            </div>
          </section>
        );
      })}
      {busy && <p className="muted">正在处理素材…</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
