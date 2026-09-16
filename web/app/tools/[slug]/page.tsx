import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TOOLS, getToolBySlug } from '../../../lib/catalog'
import { isRunnableTool, isWasmNativeTool } from '../../../lib/runnableTools'
import { SITE_NAME_EN, SITE_NAME_ZH, absoluteUrl } from '../../../lib/site'
import { RecentToolTracker } from './RecentToolTracker'
import { ToolRunner } from './ToolRunner'
import styles from './tool.module.scss'

interface Params {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return TOOLS.map((tool) => ({ slug: tool.id }))
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const tool = getToolBySlug(slug)
  if (!tool) return { title: 'Not found' }
  return {
    title: tool.name,
    description: `${tool.description} Run it locally with ${SITE_NAME_ZH} / ${SITE_NAME_EN}.`,
    keywords: [
      SITE_NAME_ZH,
      SITE_NAME_EN,
      tool.name,
      tool.shortName,
      tool.category,
      ...tool.tags,
    ].filter((value): value is string => Boolean(value)),
    alternates: {
      canonical: `/tools/${tool.id}/`,
    },
    openGraph: {
      title: `${tool.name} / ${SITE_NAME_ZH}`,
      description: tool.description,
      url: absoluteUrl(`/tools/${tool.id}/`),
      type: 'website',
    },
  }
}

export default async function ToolPage({ params }: Params) {
  const { slug } = await params
  const tool = getToolBySlug(slug)
  if (!tool) notFound()
  const runnableToolId = isRunnableTool(tool.id) ? tool.id : null
  const runsInBrowser = runnableToolId !== null
  const usesWasm = isWasmNativeTool(tool.id)
  const toolJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: `${tool.name} - ${SITE_NAME_ZH}`,
    alternateName: [tool.shortName, tool.id, `${tool.name} ${SITE_NAME_EN}`].filter(Boolean),
    url: absoluteUrl(`/tools/${tool.id}/`),
    description: tool.longDescription,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: tool.category,
    operatingSystem: 'Any',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    softwareVersion: tool.version,
  }

  return (
    <div className={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(toolJsonLd) }}
      />
      <RecentToolTracker toolId={tool.id} />

      <nav className={styles.crumbs} aria-label="breadcrumb">
        <Link href="/" className={styles.crumbLink}>
          云依助手
        </Link>
        <span className={styles.crumbSep}>/</span>
        <Link href="/" className={styles.crumbLink}>
          home
        </Link>
        <span className={styles.crumbSep}>/</span>
        <span>{tool.id}</span>
      </nav>

      <header className={styles.hero}>
        <div className={`${styles.icon} ${categoryColorClass(tool.category)}`}>{tool.icon}</div>
        <div className={styles.heroBody}>
          <h1 className={styles.title}>{tool.name}</h1>
          <p className={styles.subtitle}>{tool.description}</p>
          <div className={styles.heroMeta}>
            <span>v{tool.version}</span>
            <span>/</span>
            <span>{tool.size}</span>
            <span>/</span>
            <span>{tool.category}</span>
            <span>/</span>
            <span>updated {tool.updatedDays} days ago</span>
            {tool.builtIn && (
              <>
                <span>/</span>
                <span className={styles.builtIn}>built in</span>
              </>
            )}
          </div>
        </div>
      </header>

      <div className={styles.detailLayout}>
        <main className={styles.mainColumn}>
          <section className={styles.previewBox}>
            <div className={styles.previewHead}>
              <span>{runsInBrowser ? 'browser runner' : 'preview'}</span>
              <span>
                {runsInBrowser
                  ? usesWasm
                    ? 'C native core / WebAssembly'
                    : 'TypeScript browser runtime'
                  : 'desktop runner available in app'}
              </span>
            </div>
            {runsInBrowser ? (
              <div className={styles.runnerBody}>
                <div className={styles.runnerNote}>
                  {usesWasm
                    ? 'Runs locally in this browser through the same C native core compiled to WebAssembly.'
                    : 'Runs locally in this browser with a TypeScript runtime where C/WASM is not the best fit.'}{' '}
                  No upload, no account, no desktop client required.
                </div>
                <div className={styles.runnerShell}>
                  <ToolRunner toolId={runnableToolId} />
                </div>
              </div>
            ) : (
              <div className={styles.previewBody}>
                <p>
                  This tool is not wired to the browser runtime yet. Use it inside the desktop
                  client from the signed plugin store while the web runner catches up.
                </p>
                <div className={styles.previewCtaRow}>
                  <Link href="/desktop" className={styles.btnPrimary}>
                    Get desktop
                  </Link>
                  <a
                    href="https://github.com/CloudYiC/DesktopPet"
                    className={styles.btnSecondary}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View source
                  </a>
                </div>
              </div>
            )}
          </section>
        </main>

        <aside className={styles.sideColumn} aria-label={`${tool.name} details`}>
          <section className={styles.sidePanel}>
            <h2 className={styles.h2}>About</h2>
            <p className={styles.aboutPara}>{tool.longDescription}</p>
          </section>

          <section className={styles.sidePanel}>
            <h2 className={styles.h2}>Runtime</h2>
            <div className={styles.metaList}>
              <span>
                <strong>Version</strong>
                <em>v{tool.version}</em>
              </span>
              <span>
                <strong>Size</strong>
                <em>{tool.size}</em>
              </span>
              <span>
                <strong>Mode</strong>
                <em>{runsInBrowser ? (usesWasm ? 'WASM local' : 'Browser local') : 'Desktop app'}</em>
              </span>
              <span>
                <strong>Network</strong>
                <em>No upload</em>
              </span>
            </div>
          </section>

          <section className={styles.sidePanel}>
            <h2 className={styles.h2}>Tags</h2>
            <div className={styles.tagRow}>
              {tool.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </div>
          </section>

          <section className={styles.related}>
            <span className={styles.relatedLabel}>related</span>
            <div className={styles.relatedGrid}>
              {TOOLS.filter(
                (candidate) => candidate.category === tool.category && candidate.id !== tool.id,
              )
                .slice(0, 3)
                .map((candidate) => (
                  <Link
                    key={candidate.id}
                    href={`/tools/${candidate.id}/`}
                    className={styles.relatedCard}
                  >
                    <div
                      className={`${styles.relatedIcon} ${categoryColorClass(candidate.category)}`}
                    >
                      {candidate.icon}
                    </div>
                    <div>
                      <div className={styles.relatedName}>
                        {candidate.shortName ?? candidate.name}
                      </div>
                      <div className={styles.relatedDesc}>{candidate.description}</div>
                    </div>
                  </Link>
                ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
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
