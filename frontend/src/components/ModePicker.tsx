import { modeNames, modes, type Mode } from "../api";
import styles from "../pages/pages.module.css";
import Icon, { type IconName } from "./Icon";

const hints: Record<Mode, string> = {
  look: "看英文选中文，或看中文选英文，四选一",
  listen: "听读音选中文或拼写，四选一",
  write: "看例句的中文，填出英文句子里挖掉的词",
  dictation: "听例句，写出挖掉的词，自动判对错",
  translate: "看中文写出整句英文，再对照原句自己判",
  speak: "看例句的中文，大声说出英文",
};

export const modeIcons: Record<Mode, IconName> = { look: "eye", listen: "ear", write: "keyboard", dictation: "pen", translate: "translate", speak: "mic" };

// 选题型：计划测试和检测开始前用。每个题型一格（图标和名字），选中的那个的说明写在下面。
export default function ModePicker({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <>
      <div className={`${styles.tiles} ${styles.compact}`} role="radiogroup" aria-label="题型">
        {modes.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={m === value} className={`${styles.tile} ${m === value ? styles.on : ""}`} onClick={() => onChange(m)}>
            <Icon name={modeIcons[m]} />
            <strong>{modeNames[m]}</strong>
          </button>
        ))}
      </div>
      <p className="muted">{hints[value]}</p>
    </>
  );
}
