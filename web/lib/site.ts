export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://assistant.cloudyic.com').replace(
  /\/$/,
  '',
)
export const SITE_NAME_ZH = '云依助手'
export const SITE_NAME_EN = 'CloudYi Assistant'
export const SITE_TITLE = `${SITE_NAME_ZH} - ${SITE_NAME_EN}`

export const SITE_DESCRIPTION =
  '云依助手是本地优先的开发工具箱。Hash、Base64、Hex、URL、JSON、JWT、UUID、密码、时间戳、正则和文本比较均可直接在浏览器中运行。'

export const SITE_KEYWORDS = [
  '云依助手',
  'CloudYi Assistant',
  '可爱依依',
  'CloudYi',
  '云依助手工具箱',
  'developer tools',
  'local-first tools',
  'browser tools',
  'desktop toolbox',
  'WebAssembly',
  'C native tools',
  'Hash tool',
  'MD5',
  'SHA-256',
  'Base64',
  'Hex converter',
  'URL encode',
  'JSON formatter',
  'JWT inspector',
  'UUID generator',
  'password generator',
]

export function absoluteUrl(path = '/'): string {
  if (/^https?:\/\//.test(path)) return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${SITE_URL}${normalized}`
}
