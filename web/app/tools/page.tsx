import type { Metadata } from 'next'
import { ToolIndex } from '../../components/ToolIndex/ToolIndex'
import { TOOLS, categoryCounts } from '../../lib/catalog'
import { SITE_DESCRIPTION, SITE_KEYWORDS } from '../../lib/site'

export const metadata: Metadata = {
  title: 'Home',
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  alternates: {
    canonical: '/',
  },
}

export default function ToolsPage() {
  return <ToolIndex tools={TOOLS} categories={categoryCounts()} />
}
