import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, phOf, type Entry } from "../api";
import { speak } from "../speech";
import styles from "./WordPopup.module.css";

// 点例句里的词弹出的气泡：音标、释义、朗读；变形词（ran）同时显示原形（run）。
// 整个页面只挂一个 <WordPopup />（在 App 里），句子里的词调用 showWord 打开它。
type Open = {
  word: string;
  rect: { left: number; top: number; right: number; bottom: number; width: number };
  accent: string;
  surface: HTMLElement | null;
  width: number;
  height: number;
};
let opener: ((o: Open) => void) | null = null;
const cache = new Map<string, Promise<Entry | null>>();

export function showWord(word: string, el: HTMLElement, accent: string) {
  const surface = el.closest<HTMLElement>("[data-word-popup-surface]");
  const rotated = surface && getComputedStyle(surface).transform !== "none";
  const rect = el.getBoundingClientRect();
  if (rotated) {
    // 手动横屏将播放器旋转 90 度，气泡坐标转回播放器内部，和文字一起旋转。
    const bounds = surface.getBoundingClientRect();
    const left = rect.top - bounds.top;
    const top = bounds.right - rect.right;
    opener?.({ word, accent, surface, width: surface.clientWidth, height: surface.clientHeight,
      rect: { left, top, right: left + rect.height, bottom: top + rect.width, width: rect.height } });
  } else {
    opener?.({ word, accent, rect, surface: null, width: window.innerWidth, height: window.innerHeight });
  }
}

function lookup(word: string) {
  const key = word.toLowerCase();
  if (!cache.has(key)) cache.set(key, api.lookup(key).catch(() => null));
  return cache.get(key)!;
}

export default function WordPopup() {
  const [open, setOpen] = useState<Open | null>(null);
  const [entry, setEntry] = useState<Entry | null | undefined>();
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(12);
  const requestID = useRef(0);

  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const height = box.current.offsetHeight;
    const below = open.rect.bottom + 8;
    const wanted = below + height <= open.height - 12 ? below : open.rect.top - height - 8;
    setTop(Math.max(12, Math.min(wanted, open.height - height - 12)));
  }, [open, entry]);

  useEffect(() => {
    opener = (o) => {
      setOpen(o);
      setEntry(undefined);
      speak(o.word, o.accent);
      const id = ++requestID.current;
      lookup(o.word).then((value) => { if (requestID.current === id) setEntry(value); });
    };
    return () => {
      opener = null;
      requestID.current++;
    };
  }, []);

  // 点气泡外面、滚动或按 Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if ((e.type === "pointerdown" || e.type === "scroll") && e.target instanceof Node && box.current?.contains(e.target)) return;
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setOpen(null);
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", close);
    window.addEventListener("resize", close);
    window.addEventListener("orientationchange", close);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("orientationchange", close);
    };
  }, [open]);

  if (!open) return null;
  // 放在词的下方，空间不够时放上方；左右不超出屏幕。
  const width = Math.min(300, open.width - 24);
  const left = Math.max(12, Math.min(open.rect.left + open.rect.width / 2 - width / 2, open.width - width - 12));
  const shown = entry?.lemma ?? entry;

  const popup = (
    <div ref={box} className={styles.popup} style={{ left, width, top, maxHeight: open.height - 24 }} role="dialog" onPointerUp={(e) => e.stopPropagation()}>
      <div className={styles.head}>
        <strong className={styles.word}>{entry?.w ?? open.word.toLowerCase()}</strong>
        {entry && phOf(entry, open.accent) && <span className={styles.ph}>[ {phOf(entry, open.accent)} ]</span>}
        <button className="link" onClick={() => speak(open.word, open.accent)} aria-label="朗读">
          🔊
        </button>
      </div>
      {entry === undefined && <p className="muted">查询中…</p>}
      {entry === null && <p className="muted">词典里没有这个词。</p>}
      {entry?.lemma && (
        <p className="muted">
          是 <strong>{entry.lemma.w}</strong> 的变形{phOf(entry.lemma, open.accent) ? ` [ ${phOf(entry.lemma, open.accent)} ]` : ""}
        </p>
      )}
      {shown && shown.zh.length > 0 && (
        <div className={styles.zh}>
          {shown.zh.map((z) => (
            <p key={z}>{z}</p>
          ))}
        </div>
      )}
    </div>
  );
  return open.surface ? createPortal(popup, open.surface) : popup;
}

