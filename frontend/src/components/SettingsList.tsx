import type { ReactNode } from "react";
import styles from "./SettingsList.module.css";

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

export function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label?: string }) {
  return (
    <select
      className={styles.select}
      value={value}
      aria-label={label}
      onChange={(e) => onChange((typeof value === "number" ? Number(e.target.value) : e.target.value) as T)}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
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
