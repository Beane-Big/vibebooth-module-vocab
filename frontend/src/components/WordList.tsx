import type { ReactNode } from "react";
import { phOf, type Word } from "../api";
import { speak } from "../speech";
import styles from "./WordList.module.css";

// 词列表：每个词一行小卡片，序号、单词（点一下朗读）和音标、第一条释义；
// extra 放在右侧（数字、按钮），below 放在释义下面（一行小标签）。
export default function WordList({ words, accent, extra, below }: { words: Word[]; accent: string; extra?: (w: Word) => ReactNode; below?: (w: Word) => ReactNode }) {
  if (!words.length) return null;
  return (
    <ul className={styles.list}>
      {words.map((w) => (
        <li key={w.w} className={styles.row}>
          <span className={styles.n}>{w.n}</span>
          <div className={styles.main}>
            <div className={styles.line}>
              <button className={styles.word} onClick={() => speak(w.w, accent)}>
                {w.w}
              </button>
              {phOf(w, accent) && <span className={styles.ph}>[ {phOf(w, accent)} ]</span>}
            </div>
            <span className={styles.zh}>{w.zh[0]}</span>
            {below && <div className={styles.below}>{below(w)}</div>}
          </div>
          {extra && <div className={styles.extra}>{extra(w)}</div>}
        </li>
      ))}
    </ul>
  );
}
