import styles from './ToolWorkspaceHeader.module.scss';

interface ToolWorkspaceHeaderProps {
  title: string;
  onBack?: () => void;
  backHref?: string;
}

/** One compact navigation row shared by every tool; descriptions stay in the catalog. */
export function ToolWorkspaceHeader({ title, onBack, backHref = '/tools/' }: ToolWorkspaceHeaderProps) {
  return (
    <header className={styles.header} aria-label="工具详情导航">
      {onBack
        ? <button className={styles.backLink} type="button" onClick={onBack}>← 返回工具列表</button>
        : <a className={styles.backLink} href={backHref}>← 返回工具列表</a>}
      <span className={styles.separator} aria-hidden="true">/</span>
      <h2 className={styles.title}>{title}</h2>
    </header>
  );
}
