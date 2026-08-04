'use client'

import { useEffect } from 'react'

const RECENT_TOOLS_KEY = 'cy.web.recentTools'
const RECENT_LIMIT = 4

export function RecentToolTracker({ toolId }: { toolId: string }) {
  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_TOOLS_KEY) ?? '[]')
      const current = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []
      const next = [toolId, ...current.filter((id) => id !== toolId)].slice(0, RECENT_LIMIT)
      localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next))
    } catch {
      localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify([toolId]))
    }
  }, [toolId])

  return null
}
