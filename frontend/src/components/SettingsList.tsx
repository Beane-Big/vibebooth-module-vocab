import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import styles from "./SettingsList.module.css";

// 下拉菜单：每项高度、最高多高、离窗口边缘至少多远（像素）。
const menuRow = 44;
const maxMenu = 360;
const gap = 12;

// 设置页用的 iOS 风格列表：Group 是一组（上面组标题，下面说明），Row 是一行（左边名字和小字说明，右边控件）。
// 控件用下面的 Select、NumberInput、Switch、Stepper，整行是按钮时用 ActionRow。

export function SettingsList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{title}</h1>
      {children}
    </div>
  );
}

export function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.group}>
      {title && <h2 className={styles.header}>{title}</h2>}
      <div className={styles.list}>{children}</div>
      {footer && <p className={styles.footer}>{footer}</p>}
    </section>
  );
}

// 整行是 label：点名字也能操作右边的控件（开关、下拉框、输入框）。右边是步进器时传 plain，
// 不然点名字会按到步进器的第一个按钮。
export function Row({ label, hint, disabled, plain, children }: { label: string; hint?: ReactNode; disabled?: boolean; plain?: boolean; children: ReactNode }) {
  const Tag = plain ? "div" : "label";
  return (
    <Tag className={`${styles.row} ${disabled ? styles.disabled : ""}`}>
      <span className={styles.label}>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className={styles.control}>{children}</span>
    </Tag>
  );
}

// 下拉框：点开是贴着它弹出的菜单（iOS 的下拉菜单那样，当前值前面打勾），不用浏览器自带的下拉列表。
// 菜单挂在 body 上（面板是 overflow: hidden，放在里面会被裁掉），按位置算在框的下方或上方。
// 键盘：↑↓ 换选项、回车或空格选中、Esc 关闭；点菜单外面、滚动、改窗口大小都会关上。
export function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // 键盘高亮的选项
  const [pos, setPos] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = options.findIndex(([v]) => v === value);

  function show() {
    const r = button.current!.getBoundingClientRect();
    const height = Math.min(options.length * menuRow + 12, maxMenu);
    const below = window.innerHeight - r.bottom - gap;
    const top = below >= height || below >= r.top ? r.bottom + 6 : Math.max(gap, r.top - 6 - height);
    setPos({ top, right: Math.max(gap, window.innerWidth - r.right - 8), maxHeight: maxMenu });
    setActive(Math.max(0, current));
    setOpen(true);
  }

  function pick(i: number) {
    setOpen(false);
    button.current?.focus();
    if (options[i][0] !== value) onChange(options[i][0]);
  }

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && (menu.current?.contains(e.target) || button.current?.contains(e.target))) return;
      setOpen(false);
    };
    const shut = () => setOpen(false);
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") setOpen(false);
    else if (e.key === "ArrowDown") setActive((i) => Math.min(options.length - 1, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else return;
    e.preventDefault();
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${styles.select} ${open ? styles.selectOpen : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {options[current]?.[1] ?? String(value)}
      </button>
      {open &&
        createPortal(
          <div ref={menu} className={styles.menu} style={pos} role="listbox" aria-label={label}>
            {options.map(([v, text], i) => (
              <div
                key={v}
                data-i={i}
                role="option"
                aria-selected={i === current}
                className={`${styles.option} ${i === active ? styles.optionActive : ""}`}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span className={styles.tick}>{i === current && <Icon name="check" size={16} />}</span>
                {text}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" inputMode="numeric" className={styles.number} {...props} />;
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" role="switch" className={styles.switch} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

export function Stepper({ value, min, max, onChange, unit = "" }: { value: number; min: number; max: number; onChange: (v: number) => void; unit?: string }) {
  return (
    <>
      <span className={styles.stepperValue}>
        {value}
        {unit}
      </span>
      <span className={styles.stepper}>
        <button type="button" aria-label="减一" onClick={() => onChange(value - 1)} disabled={value <= min}>
          −
        </button>
        <button type="button" aria-label="加一" onClick={() => onChange(value + 1)} disabled={value >= max}>
          +
        </button>
      </span>
    </>
  );
}

export function ActionRow({ children, onClick, disabled, destructive }: { children: ReactNode; onClick: () => void; disabled?: boolean; destructive?: boolean }) {
  return (
    <button type="button" className={`${styles.action} ${destructive ? styles.destructive : ""}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
