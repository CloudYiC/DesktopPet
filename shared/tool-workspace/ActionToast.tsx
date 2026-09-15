'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ActionToast.module.scss';

export interface ActionToastState { id: number; message: string }

/** Transient acknowledgements only. Errors and ongoing state belong beside their operation. */
export function useActionToast() {
  const [toast, setToast] = useState<ActionToastState | null>(null);
  const sequence = useRef(0);
  const notify = useCallback((message: string) => {
    setToast(message ? { id: ++sequence.current, message } : null);
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  return { toast, notify, dismiss };
}

export function ActionToast({ toast, onDismiss }: { toast: ActionToastState | null; onDismiss(): void }) {
  const [mounted, setMounted] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!toast || hovered || focused) return;
    const timer = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [toast, hovered, focused, onDismiss]);
  useEffect(() => { if (!toast) { setHovered(false); setFocused(false); } }, [toast]);
  // Match server output on the first client render before mounting the portal.
  if (!mounted || !toast) return null;
  return createPortal(<div className={styles.anchor}>
    <div className={styles.toast} data-testid="action-toast" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className={styles.icon} aria-hidden="true">✓</span>
      <span role="status" aria-live="polite" aria-atomic="true">{toast.message}</span>
      <button type="button" aria-label="关闭操作提示" onClick={onDismiss}>×</button>
    </div>
  </div>, document.body);
}
