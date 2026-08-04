'use client'

import { useEffect, useState } from 'react'
import styles from './faq.module.scss'

interface FaqSection {
  id: string
  label: string
}

export function FaqToc({ sections }: { sections: FaqSection[] }) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '')

  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => Boolean(element))

    if (!elements.length) return

    let frame = 0

    const updateActiveSection = () => {
      const activationLine = Math.min(340, window.innerHeight * 0.42)
      const firstElement = elements[0]
      if (!firstElement) return

      let nextActive = firstElement.id

      for (const element of elements) {
        if (element.getBoundingClientRect().top <= activationLine) {
          nextActive = element.id
        }
      }

      setActiveId(nextActive)
    }

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateActiveSection)
    }

    updateActiveSection()
    const syncTimers = [
      window.setTimeout(updateActiveSection, 120),
      window.setTimeout(updateActiveSection, 420),
      window.setTimeout(updateActiveSection, 900),
    ]
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('hashchange', scheduleUpdate)

    return () => {
      window.cancelAnimationFrame(frame)
      syncTimers.forEach((timer) => window.clearTimeout(timer))
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('hashchange', scheduleUpdate)
    }
  }, [sections])

  return (
    <aside className={styles.toc} aria-label="FAQ outline">
      <div className={styles.tocLabel}>FAQ</div>
      <ul className={styles.tocList}>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={`${styles.tocLink} ${activeId === section.id ? styles.tocLinkActive : ''}`}
              aria-current={activeId === section.id ? 'true' : undefined}
              onClick={() => setActiveId(section.id)}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}
