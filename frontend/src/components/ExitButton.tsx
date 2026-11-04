import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import styles from "./ExitButton.module.css";

// 专注模式（学习卡片、做题）左上角的退出按钮：一个圆形的 ×。
// confirm 有值时（比如检测做到一半，退出就不算成绩）点第一下先展开成“再点一次退出”和这句提示，3 秒内再点才退出。
export default function ExitButton({ onExit, confirm, label = "退出" }: { onExit: () => void; confirm?: string; label?: string }) {
  const [asking, setAsking] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = () => {
    if (!confirm || asking) return onExit();
    setAsking(true);
    timer.current = window.setTimeout(() => setAsking(false), 3000);
  };
  return (
    <button type="button" className={`${styles.exit} ${asking ? styles.asking : ""}`} onClick={click} aria-label={label} title={label}>
      <Icon name="cross" size={18} />
      {asking && (
        <span>
          再点一次退出<small>{confirm}</small>
        </span>
      )}
    </button>
  );
}
