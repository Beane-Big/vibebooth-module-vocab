import { useEffect, useRef, useState } from "react";
import { api, phOf, type Entry } from "../api";
import { speak } from "../speech";
import styles from "./WordPopup.module.css";

// 点例句里的词弹出的气泡：音标、释义、朗读；变形词（ran）同时显示原形（run）。
// 整个页面只挂一个 <WordPopup />（在 App 里），句子里的词调用 showWord 打开它。
type Open = { word: string; rect: DOMRect; accent: string };
let opener: ((o: Open) => void) | null = null;
const cache = new Map<string, Promise<Entry | null>>();

export function showWord(word: string, el: HTMLElement, accent: string) {
  opener?.({ word, rect: el.getBoundingClientRect(), accent });
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

  useEffect(() => {
    opener = (o) => {
      setOpen(o);
      setEntry(undefined);
      speak(o.word, o.accent);
      lookup(o.word).then(setEntry);
    };
    return () => {
      opener = null;
    };
  }, []);

  // 点气泡外面、滚动或按 Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof PointerEvent && box.current?.contains(e.target as Node)) return;
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      setOpen(null);
    };
    const t = setTimeout(() => window.addEventListener("pointerdown", close), 0);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", close);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!open) return null;
  // 放在词的下方，空间不够时放上方；左右不超出屏幕。
  const width = Math.min(300, window.innerWidth - 24);
  const left = Math.max(12, Math.min(open.rect.left + open.rect.width / 2 - width / 2, window.innerWidth - width - 12));
  const below = open.rect.bottom + 220 < window.innerHeight;
  const pos = below ? { top: open.rect.bottom + 8 } : { bottom: window.innerHeight - open.rect.top + 8 };
  const shown = entry?.lemma ?? entry;

  return (
    <div ref={box} className={styles.popup} style={{ left, width, ...pos }} role="dialog" onPointerUp={(e) => e.stopPropagation()}>
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
}
