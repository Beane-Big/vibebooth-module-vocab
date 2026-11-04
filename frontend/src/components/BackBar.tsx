import Icon from "./Icon";
import styles from "../pages/pages.module.css";

// 页面顶部的返回行：左边“‹ 上一级”，右边可以放标题。列表页回到进来的地方，详情页回到列表。
export default function BackBar({ href, label, title }: { href: string; label: string; title?: string }) {
  return (
    <div className={styles.backBar}>
      <a className={styles.back} href={href}>
        <Icon name="prev" size={20} />
        {label}
      </a>
      {title && <h1>{title}</h1>}
    </div>
  );
}
