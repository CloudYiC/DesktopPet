'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { CategoryEntry, ToolEntry } from '../../lib/catalog'
import styles from './ToolIndex.module.scss'

interface ToolIndexProps {
  tools: ToolEntry[]
  categories: CategoryEntry[]
}

const RECENT_TOOLS_KEY = 'cy.web.recentTools'
const RECENT_LIMIT = 4

export function ToolIndex({ tools, categories }: ToolIndexProps) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<CategoryEntry['id']>('all')
  const [recentIds, setRecentIds] = useState<string[]>([])

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_TOOLS_KEY) ?? '[]')
      if (Array.isArray(parsed)) {
        setRecentIds(parsed.filter((value): value is string => typeof value === 'string'))
      }
    } catch {
      setRecentIds([])
    }
  }, [])

  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return tools.filter((tool) => {
      const categoryMatch = activeCategory === 'all' || tool.category === activeCategory
      if (!categoryMatch) return false
      if (!normalizedQuery) return true

      const haystack = [
        tool.name,
        tool.shortName,
        tool.description,
        tool.longDescription,
        tool.category,
        ...tool.tags,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(normalizedQuery)
    })
  }, [activeCategory, query, tools])

  const recentTools = useMemo(() => {
    const byId = new Map(tools.map((tool) => [tool.id, tool]))
    const stored = recentIds
      .map((id) => byId.get(id))
      .filter((tool): tool is ToolEntry => Boolean(tool))

    if (stored.length >= 2) return stored.slice(0, RECENT_LIMIT)

    const fallback = tools.filter((tool) => !stored.some((recent) => recent.id === tool.id))
    return [...stored, ...fallback].slice(0, 2)
  }, [recentIds, tools])

  const installableCount = tools.filter((tool) => !tool.builtIn).length
  const builtInCount = tools.filter((tool) => tool.builtIn).length

  const recordRecentTool = (toolId: string) => {
    const next = [toolId, ...recentIds.filter((id) => id !== toolId)].slice(0, RECENT_LIMIT)
    setRecentIds(next)
    localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next))
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="tool-index-title">
        <div className={styles.heroCopy}>
          <h1 id="tool-index-title" className={styles.title}>
            云依助手工具箱
          </h1>
          <p className={styles.lead}>
            浏览器直接运行的本地优先工具；无需上传内容，也无需安装桌面客户端。
          </p>
        </div>

        <aside className={styles.recent} aria-label="Recently visited">
          <div className={styles.recentTitle}>Recently visited</div>
          {recentTools.map((tool) => (
            <Link
              key={tool.id}
              href={`/tools/${tool.id}/`}
              className={styles.recentItem}
              onClick={() => recordRecentTool(tool.id)}
            >
              <span className={`${styles.recentIcon} ${categoryColorClass(tool.category)}`}>
                {tool.icon}
              </span>
              <span>
                <strong>{tool.shortName ?? tool.name}</strong>
                <small>{categoryLabel(tool.category, categories)}</small>
              </span>
            </Link>
          ))}
        </aside>

        <label className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true">
            O
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tools / tags / use cases"
            type="search"
          />
          <span className={styles.indexCount}>
            <span>LIVE HOME</span>
            <strong>{filteredTools.length}</strong>
          </span>
        </label>

        <div className={styles.heroStats} aria-label="Tool counts">
          <Stat value={tools.length} label="tools available" />
          <Stat value={installableCount} label="installable plugins" />
          <Stat value={builtInCount} label="built in plugin" />
          <Stat value="0" label="network calls" />
        </div>
      </section>

      <div className={styles.content}>
        <aside className={styles.filters} aria-label="Tool filters">
          <div className={styles.filterBlock}>
            <div className={styles.filterTitle}>Categories</div>
            <div className={styles.categoryList}>
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`${styles.categoryButton} ${
                    activeCategory === category.id ? styles.categoryActive : ''
                  }`}
                  onClick={() => setActiveCategory(category.id)}
                  aria-pressed={activeCategory === category.id}
                >
                  <span>{categoryIcon(category.id)}</span>
                  <strong>{category.label}</strong>
                  <em>{category.count}</em>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <section className={styles.listing}>
          <div className={styles.listHeader}>
            <div>
              <h2>Home</h2>
            </div>
            <span>{filteredTools.length} results</span>
          </div>

          <div className={styles.grid}>
            {filteredTools.map((tool) => (
              <Link
                key={tool.id}
                href={`/tools/${tool.id}/`}
                className={styles.card}
                onClick={() => recordRecentTool(tool.id)}
              >
                <span className={`${styles.cardIcon} ${categoryColorClass(tool.category)}`}>
                  {tool.icon}
                </span>
                <span className={styles.cardCategory}>
                  {tool.builtIn ? 'Built in' : shortCategoryLabel(tool.category)}
                </span>
                <span className={styles.cardTitle}>{tool.shortName ?? tool.name}</span>
                <span className={styles.cardDesc}>{tool.description}</span>
                <span className={styles.cardTags}>
                  {tool.tags.slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </span>
                <span className={styles.cardFooter}>
                  <span className={styles.favorite} aria-hidden="true">
                    *
                  </span>
                  <span className={styles.cardCta}>View details</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <span className={styles.statItem}>
      <strong>{value}</strong>
      <em>{label}</em>
    </span>
  )
}

function categoryLabel(categoryId: CategoryEntry['id'], categories: CategoryEntry[]) {
  return categories.find((category) => category.id === categoryId)?.label ?? 'Tools'
}

function shortCategoryLabel(categoryId: CategoryEntry['id']) {
  const labels: Record<string, string> = {
    all: 'All',
    encoding: 'Encoding',
    network: 'Network',
    'text-data': 'Text',
    generators: 'Generators',
    'time-number': 'Time',
    media: 'Media',
    utility: 'Utility',
  }

  return labels[categoryId] ?? 'Tool'
}

function categoryIcon(categoryId: CategoryEntry['id']) {
  const icons: Record<string, string> = {
    all: '##',
    encoding: '<>',
    network: 'PKT',
    'text-data': '{}',
    generators: '++',
    'time-number': 'TS',
    media: 'IM',
    utility: '**',
  }

  return icons[categoryId] ?? '**'
}

function categoryColorClass(category: string): string {
  const map: Record<string, string | undefined> = {
    encoding: styles.iconCatEncoding,
    network: styles.iconCatNetwork,
    generators: styles.iconCatGenerators,
    media: styles.iconCatMedia,
    'text-data': styles.iconCatTextData,
    'time-number': styles.iconCatTimeNumber,
    utility: styles.iconCatUtility,
  }
  return map[category] ?? styles.iconCatUtility ?? ''
}
