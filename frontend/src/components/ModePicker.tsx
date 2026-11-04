import { modeNames, type Mode } from "../api";
import styles from "../pages/pages.module.css";
import Icon, { type IconName } from "./Icon";

const hints: Record<Mode, string> = {
  look: "只显示单词，想出意思后看答案",
  listen: "只播放读音，练听力",
  speak: "看例句的中文，大声说出英文",
  dictation: "听例句，写出挖掉的词，自动判对错",
};

export const modeIcons: Record<Mode, IconName> = { look: "eye", listen: "ear", speak: "mic", dictation: "pen" };

// 选题型：计划测试和检测开始前用。每个题型一格：图标、名字、一句说明。
export default function ModePicker({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className={styles.tiles} role="radiogroup" aria-label="题型">
      {(Object.keys(modeNames) as Mode[]).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={m === value} className={`${styles.tile} ${m === value ? styles.on : ""}`} onClick={() => onChange(m)}>
          <Icon name={modeIcons[m]} />
          <strong>{modeNames[m]}</strong>
          <span>{hints[m]}</span>
        </button>
      ))}
    </div>
  );
}
