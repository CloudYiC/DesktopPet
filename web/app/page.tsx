import type { Metadata } from 'next'
import { ToolIndex } from '../components/ToolIndex/ToolIndex'
import { TOOLS, categoryCounts } from '../lib/catalog'
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME_EN,
  SITE_NAME_ZH,
  absoluteUrl,
} from '../lib/site'

export const metadata: Metadata = {
  title: `${SITE_NAME_ZH} - ${SITE_NAME_EN}`,
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  alternates: {
    canonical: '/',
  },
}

const itemListJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: `${SITE_NAME_ZH} tool index`,
  description: SITE_DESCRIPTION,
  itemListElement: TOOLS.map((tool, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: tool.name,
    url: absoluteUrl(`/tools/${tool.id}/`),
    description: tool.description,
  })),
}

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <ToolIndex tools={TOOLS} categories={categoryCounts()} />
    </>
  )
}
