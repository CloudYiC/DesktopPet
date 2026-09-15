import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './PacketTemplateDialog.module.scss';

interface PacketTemplateDialogProps {
  open: boolean;
  count: number;
  search: string;
  busy: boolean;
  feedback: { text: string; error: boolean } | null;
  returnFocus: RefObject<HTMLElement | null>;
  searchRef: RefObject<HTMLInputElement>;
  children: ReactNode;
  editor?: ReactNode;
  onSearch(value: string): void;
  onNew(): void;
  onImport(): void;
  onExport(): void;
  onClose(): void;
}

/** A separate top-layer library, leaving the network log its full workspace. */
export function PacketTemplateDialog({ open, count, search, busy, feedback, returnFocus, searchRef, children, editor, onSearch, onNew, onImport, onExport, onClose }: PacketTemplateDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      (element.querySelector<HTMLElement>('[data-template-autofocus]') || searchRef.current)?.focus({ preventScroll: true });
    } else if (!open && element.open) {
      element.close();
      const target = returnFocus.current || previousFocus.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
  }, [open, returnFocus, searchRef]);
  return createPortal(<dialog ref={dialog} className={styles.dialog} data-testid="packet-library-panel" tabIndex={-1} aria-labelledby={titleId} aria-modal="true" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const element = dialog.current;
    if (!element) return;
    const focusable = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')).filter((item) => item.getClientRects().length > 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); element.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
  }}>
    <header className={styles.header}>
      <span className={styles.symbol} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" strokeLinecap="round" /></svg></span>
      <h2 id={titleId}>报文模板 <span aria-hidden="true">{count}</span></h2>
      <button className={styles.close} aria-label="关闭报文模板" onClick={onClose}>×</button>
    </header>
    {!editor && <div className={styles.toolbar}>
      <input ref={searchRef} aria-label="搜索模板" placeholder="搜索名称、地址或端口…" value={search} onChange={(event) => onSearch(event.target.value)} />
      <button className={styles.newButton} disabled={busy} onClick={onNew}>新建模板</button><button disabled={busy} onClick={onImport}>导入</button><button onClick={onExport}>导出</button>
    </div>}
    {feedback && <p className={feedback.error ? styles.error : styles.notice} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {editor || <div className={styles.list} data-testid="packet-library">{children}</div>}
    {!editor && <footer className={styles.footer}><span>模板独立保存；应用只填入发送区，不会连接或发送。</span><button onClick={onClose}>完成</button></footer>}
  </dialog>, document.body);
}
