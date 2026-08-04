import Link from 'next/link'
import styles from './Footer.module.scss'

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.col}>
          <div className={styles.label}>可爱依依 · CloudYi</div>
          <p className={styles.tagline}>
            Local-first browser tools with a C/WebAssembly core and a Windows desktop companion.
          </p>
        </div>

        <div className={styles.col}>
          <div className={styles.label}>Product</div>
          <ul className={styles.list}>
            <li>
              <Link href="/">Home</Link>
            </li>
            <li>
              <Link href="/desktop">Desktop</Link>
            </li>
            <li>
              <Link href="/changelog">Changelog</Link>
            </li>
          </ul>
        </div>

        <div className={styles.col}>
          <div className={styles.label}>Developers</div>
          <ul className={styles.list}>
            <li>
              <Link href="/faq">FAQ</Link>
            </li>
            <li>
              <a href="https://github.com/CloudYiC/DesktopPet" target="_blank" rel="noreferrer">
                GitHub
              </a>
            </li>
            <li>
              <Link href="/faq#privacy">Privacy boundary</Link>
            </li>
          </ul>
        </div>

        <div className={styles.col}>
          <div className={styles.label}>Release</div>
          <p className={styles.tagline}>
            Source available on GitHub.
            <br />
            Built with React 18, Next.js, TypeScript, SCSS Modules, and C/WebAssembly.
          </p>
        </div>
      </div>
    </footer>
  )
}
