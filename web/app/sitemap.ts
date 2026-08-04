import type { MetadataRoute } from 'next'
import { CHANGELOG, TOOLS } from '../lib/catalog'
import { absoluteUrl } from '../lib/site'

export const dynamic = 'force-static'

const releaseDates = CHANGELOG.map((entry) => new Date(entry.date).getTime()).filter(
  Number.isFinite,
)
const latestReleaseDate =
  releaseDates.length > 0 ? new Date(Math.max(...releaseDates)) : new Date('2026-06-15')

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: absoluteUrl('/'),
      lastModified: latestReleaseDate,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: absoluteUrl('/desktop/'),
      lastModified: latestReleaseDate,
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: absoluteUrl('/faq/'),
      lastModified: latestReleaseDate,
      changeFrequency: 'monthly',
      priority: 0.7,
    },
    {
      url: absoluteUrl('/changelog/'),
      lastModified: latestReleaseDate,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
  ]

  const toolRoutes: MetadataRoute.Sitemap = TOOLS.map((tool) => ({
    url: absoluteUrl(`/tools/${tool.id}/`),
    lastModified: new Date(tool.publishedAt),
    changeFrequency: 'monthly',
    priority: tool.builtIn ? 0.9 : 0.75,
  }))

  return [...staticRoutes, ...toolRoutes]
}
