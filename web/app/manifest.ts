import type { MetadataRoute } from 'next'
import { SITE_DESCRIPTION, SITE_NAME_EN, SITE_NAME_ZH } from '../lib/site'

export const dynamic = 'force-static'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME_ZH} / ${SITE_NAME_EN}`,
    short_name: SITE_NAME_ZH,
    description: SITE_DESCRIPTION,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#eaf8f1',
    theme_color: '#16b88f',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  }
}
