import type { Metadata, Viewport } from 'next'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '../styles/global.scss'
import { Nav } from '../components/Nav/Nav'
import { Footer } from '../components/Footer/Footer'
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME_EN,
  SITE_NAME_ZH,
  SITE_TITLE,
  SITE_URL,
  absoluteUrl,
} from '../lib/site'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: SITE_NAME_EN,
  title: {
    default: SITE_TITLE,
    template: `%s / ${SITE_NAME_ZH}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  authors: [{ name: 'CloudYiC' }],
  creator: 'CloudYiC',
  publisher: 'CloudYiC',
  category: 'DeveloperApplication',
  alternates: {
    canonical: '/',
    languages: {
      'zh-CN': '/',
      en: '/',
    },
  },
  openGraph: {
    title: `${SITE_NAME_ZH} / ${SITE_NAME_EN}`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: SITE_NAME_ZH,
    locale: 'zh_CN',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: `${SITE_NAME_ZH} / ${SITE_NAME_EN}`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    shortcut: ['/icon.svg'],
  },
  manifest: '/manifest.webmanifest',
  verification: {
    other: {
      'baidu-site-verification': 'codeva-u1Kg9wqamV',
    },
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eef8ff' },
    { media: '(prefers-color-scheme: dark)', color: '#050914' },
  ],
}

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': absoluteUrl('/#organization'),
      name: 'CloudYiC',
      url: 'https://github.com/CloudYiC',
      logo: absoluteUrl('/icon.svg'),
    },
    {
      '@type': 'WebSite',
      '@id': absoluteUrl('/#website'),
      name: `${SITE_NAME_ZH} / ${SITE_NAME_EN}`,
      alternateName: [SITE_NAME_ZH, SITE_NAME_EN],
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      inLanguage: ['zh-CN', 'en'],
      publisher: { '@id': absoluteUrl('/#organization') },
    },
    {
      '@type': 'WebApplication',
      '@id': absoluteUrl('/#webapp'),
      name: `${SITE_NAME_ZH} / ${SITE_NAME_EN}`,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any',
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      browserRequirements: 'Requires JavaScript and WebAssembly for native-backed tools.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      isAccessibleForFree: true,
      publisher: { '@id': absoluteUrl('/#organization') },
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  )
}
