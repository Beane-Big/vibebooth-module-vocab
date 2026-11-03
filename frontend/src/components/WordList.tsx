import type { ReactNode } from "react";
import type { Word } from "../api";
import { speak } from "../speech";
import styles from "./WordList.module.css";

// 词列表：序号、单词（点一下朗读）、第一条释义，右侧可以放额外信息或按钮。
export default function WordList({ words, accent, extra }: { words: Word[]; accent: string; extra?: (w: Word) => ReactNode }) {
  if (!words.length) return null;
  return (
    <ul className="list">
      {words.map((w) => (
        <li key={w.w} className={styles.row}>
          <span className={styles.n}>{w.n}</span>
          <button className={styles.word} onClick={() => speak(w.w, accent)}>
            {w.w}
          </button>
          <span className={styles.zh}>{w.zh[0]}</span>
          {extra && <span className={styles.extra}>{extra(w)}</span>}
        </li>
      ))}
    </ul>
  );
}
