// 顶栏：模块名和当前页面名；不在首页时右侧有回首页的链接。手机上不显示顶栏，用底部标签栏切换页面。
export const root = "/apps/vocab/";

export default function Topbar({ title }: { title?: string }) {
  return (
    <header className="topbar">
      <span className="title">一词两句{title ? ` · ${title}` : ""}</span>
      {title && (
        <a className="nav" href={root}>
          首页
        </a>
      )}
    </header>
  );
}
