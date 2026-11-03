import { root } from "./Topbar";
import styles from "./TabBar.module.css";

// 手机上的底部标签栏：悬浮的毛玻璃胶囊，当前页面的标签带一块玻璃高亮。宽屏不显示，宽屏靠顶栏和首页的入口。
// 学习计划、学习记录这些从首页进的页面，都算在“学习”标签下。
const tabs = [
  { page: "", label: "学习", icon: "M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 1 4 16zM20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 0 1.5-1.5z" },
  { page: "review", label: "复习", icon: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4M12 8.5V12l2.5 1.5" },
  { page: "test", label: "检测", icon: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 15 5a1.5 1.5 0 0 0-1.5-1.5h-3A1.5 1.5 0 0 0 9 5zM8.5 13l2.5 2.5 4.5-5" },
  { page: "wrong", label: "错题本", icon: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9 9l6 6M15 9l-6 6" },
  { page: "settings", label: "设置", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4z" },
];

export default function TabBar({ current }: { current: string }) {
  const active = tabs.some((t) => t.page === current) ? current : "";
  return (
    <nav className={styles.bar} aria-label="页面">
      {tabs.map((t) => (
        <a key={t.page} href={root + (t.page ? t.page + "/" : "")} className={t.page === active ? `${styles.tab} ${styles.on}` : styles.tab} aria-current={t.page === active ? "page" : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={t.icon} />
          </svg>
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}
