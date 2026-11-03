import Icon, { type IconName } from "./Icon";
import styles from "./Nav.module.css";

export const root = "/apps/vocab/";

// 模块的导航，一份数据两种样子：宽屏是顶部居中的毛玻璃胶囊（左边模块名），手机是底部悬浮的毛玻璃标签栏。
// 当前页面的标签带一块玻璃高亮；学习计划这类从首页进的页面算在“学习”下。学习记录只在宽屏的导航里，手机上从首页进。
const tabs: { page: string; label: string; icon: IconName; wide?: boolean }[] = [
  { page: "", label: "学习", icon: "book" },
  { page: "review", label: "复习", icon: "review" },
  { page: "test", label: "检测", icon: "test" },
  { page: "wrong", label: "错题本", icon: "wrong" },
  { page: "history", label: "记录", icon: "history", wide: true },
  { page: "settings", label: "设置", icon: "settings" },
];

export default function Nav({ current }: { current: string }) {
  const active = tabs.some((t) => t.page === current) ? current : "";
  return (
    <header className={styles.header}>
      <a className={styles.brand} href={root}>
        一词两句
      </a>
      <nav className={styles.bar} aria-label="页面">
        {tabs.map((t) => (
          <a
            key={t.page}
            href={root + (t.page ? t.page + "/" : "")}
            className={[styles.tab, t.page === active && styles.on, t.wide && styles.wide].filter(Boolean).join(" ")}
            aria-current={t.page === active ? "page" : undefined}
          >
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </a>
        ))}
      </nav>
    </header>
  );
}
