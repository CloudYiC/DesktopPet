import type { Metadata } from 'next'
import Link from 'next/link'
import { CHANGELOG } from '../../lib/catalog'
import { SITE_NAME_EN, SITE_NAME_ZH } from '../../lib/site'
import styles from './desktop.module.scss'

export const metadata: Metadata = {
  title: 'Desktop',
  description: `${SITE_NAME_ZH} / ${SITE_NAME_EN} 的 Windows 桌面版，使用 C、C++11、Win32、WebView2 与 React 18。`,
  keywords: [
    SITE_NAME_ZH,
    SITE_NAME_EN,
    '依依工作台',
    'CloudYi desktop toolbox',
    'C++11 Win32 desktop app',
    'local developer toolbox',
  ],
  alternates: {
    canonical: '/desktop/',
  },
}

export default function DesktopPage() {
  const recentLog = CHANGELOG.slice(0, 3)

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle}>依依工作台</h1>
          <p className={styles.heroLead}>
            把粉色依依、事项提醒、系统中心、端口管理和 CloudYi 本地工具放进同一个
            Windows 应用，数据默认保存在本机。
          </p>

          <div className={styles.terminal}>
            <div className={styles.termBar}>
              <span className={styles.termDot} style={{ background: 'var(--cy-mac-red)' }} />
              <span className={styles.termDot} style={{ background: 'var(--cy-mac-yellow)' }} />
              <span className={styles.termDot} style={{ background: 'var(--cy-mac-green)' }} />
              <span className={styles.termTitle}>source build</span>
            </div>
            <pre className={styles.termBody}>
              <span className={styles.termComment}># from the repository root</span>
              {'\n'}
              <span className={styles.termPrompt}>$</span>{' '}
              <span className={styles.termAccent}>.\scripts\build.ps1 -Configuration Release</span>
              {'\n'}
              <span className={styles.termArrow}>==&gt;</span> C/C++11 host and React 18 UI ready
              <span className={styles.termCursor}>_</span>
            </pre>
          </div>

          <div className={styles.heroActions}>
            <a href="#downloads" className={styles.primaryAction}>
              Download desktop
            </a>
            <Link href="/" className={styles.secondaryAction}>
              Browse home
            </Link>
          </div>
        </div>

        <div className={styles.heroVisual} aria-label="依依工作台预览">
          <div className={styles.previewTop}>
            <span />
            <span />
            <span />
            <strong>依依工作台 · CloudYi 工具箱</strong>
          </div>
          <div className={styles.previewBody}>
            <aside className={styles.previewSidebar}>
              <div className={styles.previewSearch}>Filter tools...</div>
              {['Hash', 'Base64', 'Hex', 'URL Encode'].map((tool, index) => (
                <div key={tool} className={index === 0 ? styles.previewActive : ''}>
                  <span>{tool.slice(0, 2).toUpperCase()}</span>
                  <strong>{tool}</strong>
                </div>
              ))}
            </aside>
            <div className={styles.previewMain}>
              <div className={styles.previewHeader}>
                <div>
                  <p>encoding / built in</p>
                  <h2>Hash</h2>
                  <span>MD5 / SHA-256 of any text, fully local.</span>
                </div>
                <strong>verified</strong>
              </div>
              <div className={styles.previewInput}>
                <span>INPUT</span>
                <p>Hello, world!</p>
              </div>
              <div className={styles.previewRows}>
                <div>
                  <span>MD5</span>
                  <code>6cd3556deb0da54b...</code>
                </div>
                <div>
                  <span>SHA-256</span>
                  <code>315f5bdb76d078c4...</code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section} id="downloads">
        <div className={styles.downloadGrid}>
          <DownloadCard
            os="Windows"
            recommended
            icon="WIN"
            arch="x64"
            file=".exe"
            size="release"
            cmdLabel="build"
            cmd=".\scripts\build-installer.ps1"
            requires="Windows 10 / 11 x64"
            downloadUrl="https://github.com/CloudYiC/DesktopPet/releases"
          />
          <DownloadCard
            os="macOS"
            icon="MAC"
            arch="not available"
            file="—"
            size="desktop host is Win32"
            cmdLabel="status"
            cmd="Web tools remain available"
            requires="Use the browser edition"
          />
          <DownloadCard
            os="Linux"
            icon="LNX"
            arch="not available"
            file="—"
            size="desktop host is Win32"
            cmdLabel="status"
            cmd="Web tools remain available"
            requires="Use the browser edition"
          />
        </div>
      </section>

      <section className={styles.whySection}>
        <h2 className={styles.h2Centered}>Why the desktop build</h2>
        <p className={styles.h2Sub}>
          网页适合随开随用；桌面版额外获得 Win32 窗口、提醒调度、系统托盘、本地数据库、
          系统信息和受保护的端口进程操作。
        </p>
        <div className={styles.featureGrid}>
          <Feature
            mark="C"
            title="Native paths where practical"
            body="C is used for compact algorithms such as UUID, password generation, timestamps, and number formatting. TypeScript stays where browser semantics are the feature."
          />
          <Feature
            mark="SIG"
            title="Windows native integration"
            body="C++11 owns Win32, WebView2 and resource lifetime; portable byte algorithms remain in C."
          />
          <Feature
            mark="DEL"
            title="Real uninstall"
            body="Install and uninstall write to the local plugin store instead of only flipping a UI flag."
          />
          <Feature
            mark="DEV"
            title="Checked C++11 boundary"
            body="The build checks project sources and rejects accidental C++14/17 APIs before compilation."
          />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.h2}>What is new</h2>
          <Link className={styles.sectionLink} href="/changelog">
            full changelog
          </Link>
        </div>
        <div className={styles.changelog}>
          {recentLog.map((entry) => (
            <div key={entry.version} className={styles.changeRow}>
              <div className={styles.changeMeta}>
                <span className={styles.changeVersion}>{entry.version}</span>
                <span className={styles.changeDate}>{entry.date}</span>
              </div>
              <ul className={styles.changeList}>
                {entry.items.map((item, index) => (
                  <li key={index}>
                    <span
                      className={`${styles.changeKind} ${
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
            </div>
          ))}
        </div>
      </section>

      <section className={styles.cta}>
        <div className={styles.ctaInner}>
          <h2 className={styles.ctaTitle}>Clone it, build it, run it locally.</h2>
          <p className={styles.ctaSub}>
            Release users can install the Windows package. Source users build the same C/C++11 host
            and React 18 interface from this repository.
          </p>
          <div className={styles.ctaRow}>
            <a href="#downloads" className={styles.ctaPrimary}>
              Download desktop
            </a>
            <Link href="/faq" className={styles.ctaSecondary}>
              Read FAQ
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}

interface DownloadCardProps {
  os: string
  arch: string
  file: string
  size: string
  cmdLabel: string
  cmd: string
  requires: string
  icon: string
  recommended?: boolean
  downloadUrl?: string
}

function DownloadCard(props: DownloadCardProps) {
  return (
    <article className={`${styles.dlCard} ${props.recommended ? styles.dlCardRec : ''}`}>
      <div className={styles.dlHead}>
        <div className={styles.dlIcon}>{props.icon}</div>
        <div className={styles.dlOsBlock}>
          <div className={styles.dlOs}>{props.os}</div>
          <div className={styles.dlArch}>{props.arch}</div>
        </div>
        {props.recommended && <span className={styles.dlBadge}>current</span>}
      </div>

      {props.downloadUrl ? (
        <a className={styles.dlBtn} href={props.downloadUrl}>
          <span className={styles.dlBtnLabel}>
            Download <span className={styles.dlBtnFile}>{props.file}</span>
          </span>
          <span className={styles.dlBtnSize}>{props.size}</span>
        </a>
      ) : (
        <button type="button" className={styles.dlBtn} disabled>
          <span className={styles.dlBtnLabel}>Desktop unavailable</span>
          <span className={styles.dlBtnSize}>{props.size}</span>
        </button>
      )}

      <div className={styles.dlMetaRow}>
        <span className={styles.dlMetaLabel}>{props.cmdLabel}</span>
        <code className={styles.dlMetaValue}>{props.cmd}</code>
      </div>
      <div className={styles.dlMetaRow}>
        <span className={styles.dlMetaLabel}>requires</span>
        <span className={styles.dlMetaValue}>{props.requires}</span>
      </div>
    </article>
  )
}

function Feature({ mark, title, body }: { mark: string; title: string; body: string }) {
  return (
    <article className={styles.feature}>
      <div className={styles.featureMark}>{mark}</div>
      <div className={styles.featureBody}>
        <div className={styles.featureTitle}>{title}</div>
        <p className={styles.featureText}>{body}</p>
      </div>
    </article>
  )
}
