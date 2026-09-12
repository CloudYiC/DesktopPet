import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './ConfirmDialog.module.scss';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  size?: 'normal' | 'wide';
  error?: string;
  tone?: 'danger' | 'primary';
  children: ReactNode;
  onCancel(): void;
  onConfirm(): void;
}

/** Top-layer modal centered in the whole client, with native focus containment. */
export function ConfirmDialog({ open, title, confirmLabel, cancelLabel = '取消', busy = false, confirmDisabled = false, size = 'normal', error, tone = 'danger', children, onCancel, onConfirm }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      // Enter must not accidentally confirm a destructive action on opening.
      cancel.current?.focus({ preventScroll: true });
    } else if (!open && element.open) {
      element.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    }
  }, [open]);
  return createPortal(<dialog ref={dialog} className={styles.dialog} data-tone={tone} data-size={size} tabIndex={-1} aria-labelledby={titleId} aria-describedby={bodyId} aria-modal="true" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }} onKeyDown={(event) => {
    if (event.key !== 'Tab') return;
    const element = dialog.current;
    if (!element) return;
    const focusable = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter((item) => item.getClientRects().length > 0);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!first) { event.preventDefault(); element.focus(); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
  }}>
    <header className={styles.header}>
      <span className={styles.symbol} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 10 17H2Z" strokeLinejoin="round" /><path d="M12 8v5m0 3v1" strokeLinecap="round" /></svg></span>
      <h2 id={titleId}>{title}</h2>
      <button type="button" className={styles.close} aria-label="关闭确认弹窗" disabled={busy} onClick={onCancel}>×</button>
    </header>
    <div id={bodyId} className={styles.body}>{children}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}>
      <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
      <button type="button" className={styles.confirm} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? '处理中…' : confirmLabel}</button>
    </footer>
  </dialog>, document.body);
}
