import type { Metadata } from 'next'
import { CHANGELOG } from '../../lib/catalog'
import { SITE_NAME_EN, SITE_NAME_ZH } from '../../lib/site'
import styles from './changelog.module.scss'

export const metadata: Metadata = {
  title: 'Changelog',
  description: `${SITE_NAME_ZH} / ${SITE_NAME_EN} release notes.`,
  keywords: [SITE_NAME_ZH, SITE_NAME_EN, 'CloudYi Assistant changelog', '云依助手更新日志'],
  alternates: {
    canonical: '/changelog/',
  },
}

export default function ChangelogPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Changelog</h1>
      </header>

      {CHANGELOG.length === 0 ? (
        <p className={styles.empty}>暂无更新日志。</p>
      ) : (
        <ol className={styles.list}>
          {CHANGELOG.map((entry) => (
            <li key={entry.version} className={styles.entry}>
              <div className={styles.meta}>
                <span className={styles.version}>{entry.version}</span>
                <span className={styles.date}>{entry.date}</span>
              </div>
              <ul className={styles.items}>
                {entry.items.map((item, index) => (
                  <li key={index} className={styles.item}>
                    <span
                      className={`${styles.kind} ${
                        item.kind === '+'
                          ? styles.kindAdd
                          : item.kind === '~'
                            ? styles.kindFix
                            : styles.kindRemove
                      }`}
                    >
                      {item.kind}
                    </span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
