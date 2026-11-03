import { modeNames, type Mode } from "../api";
import styles from "../pages/pages.module.css";

const hints: Record<Mode, string> = {
  look: "只显示单词，想出意思后看答案",
  listen: "只播放读音，练听力",
  speak: "看例句的中文，大声说出英文",
  dictation: "听例句，写出挖掉的词，自动判对错",
};

// 选题型：计划测试和检测开始前用。
export default function ModePicker({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="stack">
      <div className={styles.tabs}>
        {(Object.keys(modeNames) as Mode[]).map((m) => (
          <button key={m} className={m === value ? styles.on : ""} onClick={() => onChange(m)} type="button">
            {modeNames[m]}
          </button>
        ))}
      </div>
      <p className="muted">{hints[value]}</p>
    </div>
  );
}
