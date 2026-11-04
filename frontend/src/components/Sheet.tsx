import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Sheet.module.css";

// 弹出面板：手机上从底部滑上来，宽屏居中。用原生 <dialog>：Esc 关闭、焦点留在面板里；点面板外面的暗处也关闭。
export default function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(false); // 是 open 变成 false 关掉的，不是用户按 Esc 或点外面关的，不再回调 onClose
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) {
      closing.current = true;
      d.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={styles.sheet}
      onClose={() => {
        if (closing.current) closing.current = false;
        else onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className={styles.body}>
        <h1>{title}</h1>
        {children}
      </div>
    </dialog>
  );
}
