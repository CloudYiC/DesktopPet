'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import styles from './Nav.module.scss'

const LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/desktop', label: 'Desktop' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/faq', label: 'FAQ' },
]

const GITHUB_URL = 'https://github.com/CloudYiC/DesktopPet'

type Theme = 'light' | 'dark' | 'system'

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  return ((localStorage.getItem('cy.web.theme') as Theme | null) ?? 'light') as Theme
}

function applyTheme(theme: Theme) {
  const html = document.documentElement
  if (theme === 'system') {
    html.removeAttribute('data-theme')
  } else {
    html.setAttribute('data-theme', theme)
  }
}

export function Nav() {
  const [theme, setTheme] = useState<Theme>('light')
  const [confirmExternal, setConfirmExternal] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    const stored = readTheme()
    setTheme(stored)
    applyTheme(stored)
  }, [])

  useEffect(() => {
    if (!confirmExternal) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmExternal(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmExternal])

  const cycleTheme = () => {
    const next: Theme = theme === 'light' ? 'system' : theme === 'system' ? 'dark' : 'light'
    setTheme(next)
    applyTheme(next)
    localStorage.setItem('cy.web.theme', next)
  }

  const openGitHub = () => {
    const opened = window.open(GITHUB_URL, '_blank', 'noopener,noreferrer')
    if (opened) opened.opener = null
    setConfirmExternal(false)
  }

  return (
    <>
      <header className={styles.nav}>
        <div className={styles.inner}>
          <Link href="/" className={styles.brand} aria-label="可爱依依 CloudYi 首页">
            <span className={styles.brandMark}>
              <img src="/icon.svg" alt="" className={styles.brandIcon} />
            </span>
            <span className={styles.brandText}>
              <strong>可爱依依 · CloudYi</strong>
              <small>Web Toolbox</small>
            </span>
          </Link>

          <nav className={styles.links} aria-label="Primary">
            {LINKS.map((link) => {
              const active =
                link.href === '/'
                  ? pathname === '/' || pathname?.startsWith('/tools')
                  : pathname === link.href || pathname?.startsWith(`${link.href}/`)
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`${styles.link} ${active ? styles.linkActive : ''}`}
                >
                  {link.label}
                </Link>
              )
            })}
          </nav>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={cycleTheme}
              aria-label="Change theme"
              title={`Theme: ${theme}`}
            >
              <ThemeIcon theme={theme} />
            </button>
            <button
              type="button"
              className={styles.githubBtn}
              aria-label="GitHub"
              onClick={() => setConfirmExternal(true)}
            >
              <GitHubIcon />
            </button>
          </div>
        </div>
      </header>

      {confirmExternal && (
        <div
          className={styles.dialogBackdrop}
          role="presentation"
          onMouseDown={() => setConfirmExternal(false)}
        >
          <section
            className={styles.externalDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="external-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={styles.guideScene} aria-hidden="true">
              <div className={styles.guidePerson}>
                <span className={styles.guideHead} />
                <span className={styles.guideBody} />
                <span className={`${styles.guideArm} ${styles.left}`} />
                <span className={`${styles.guideArm} ${styles.right}`} />
                <span className={`${styles.guideLeg} ${styles.left}`} />
                <span className={`${styles.guideLeg} ${styles.right}`} />
              </div>
              <div className={styles.guideSign}>
                <strong>Open an external site?</strong>
                <span>Confirm the destination before leaving.</span>
              </div>
            </div>

            <div className={styles.dialogContent}>
              <div>
                <p className={styles.dialogEyebrow}>EXTERNAL LINK</p>
                <h2 id="external-title">Open GitHub?</h2>
              </div>
              <div className={styles.destinationCard}>
                <span className={styles.destinationIcon}>Git</span>
                <span>
                  <strong>github.com</strong>
                  <small>{GITHUB_URL}</small>
                </span>
              </div>
              <p className={styles.dialogText}>
                This external site will open in a new browser tab.
              </p>
              <div className={styles.dialogActions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => setConfirmExternal(false)}
                >
                  Stay here
                </button>
                <button type="button" className={styles.confirmBtn} onClick={openGitHub}>
                  Open GitHub
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') return <SunIcon />
  if (theme === 'system') return <MoonIcon />
  return <MonitorIcon />
}

function SunIcon() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 14.4A8 8 0 0 1 9.6 3 8.5 8.5 0 1 0 21 14.4Z" />
    </svg>
  )
}

function MonitorIcon() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="11" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg className={styles.iconSvg} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.5-1.1-4.5-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.3 4.6-4.5 4.9.4.3.7 1 .7 2v2.5c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  )
}
