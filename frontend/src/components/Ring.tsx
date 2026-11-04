import styles from "../pages/pages.module.css";

// 结果页顶部的进度环：value / total 画成一圈，中间写 label（比如正确率），下面一行小字 sub。
export default function Ring({ value, total, label, sub }: { value: number; total: number; label: string; sub?: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? value / total : 0;
  return (
    <div className={styles.ring}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className={styles.track} cx="60" cy="60" r={r} />
        <circle className={styles.value} cx="60" cy="60" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - ratio)} />
      </svg>
      <div className={styles.ringText}>
        <strong>{label}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}
