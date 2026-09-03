/** Tool categories shared by the catalog, filters, and detail pages. */
export type PluginCategory =
  | 'encoding'
  | 'generators'
  | 'media'
  | 'text-data'
  | 'time-number'
  | 'utility'

export interface ToolEntry {
  id: string
  name: string
  shortName?: string
  description: string
  longDescription: string
  category: PluginCategory
  icon: string
  version: string
  size: string
  publishedAt: string
  updatedDays: number
  tags: string[]
  builtIn: boolean
}

export const TOOLS: ToolEntry[] = [
  {
    id: 'hash',
    name: 'Hash (MD5 / SHA-256)',
    shortName: 'Hash',
    description: 'Compute MD5 and SHA-256 of any text side by side.',
    longDescription:
      'Streaming hash for text and files. MD5 and SHA-256 run locally through the desktop native layer when used inside the app. Nothing is uploaded, logged, or sent to a remote service.',
    category: 'encoding',
    icon: '##',
    version: '0.1.0',
    size: '2 KB',
    publishedAt: '2026-04-23',
    updatedDays: 2,
    tags: ['hash', 'md5', 'sha-256', 'checksum'],
    builtIn: true,
  },
  {
    id: 'base64',
    name: 'Base64',
    description: 'Encode and decode Base64 with optional URL-safe output.',
    longDescription:
      'Encode plain text, decode it back, and switch to URL-safe output for tokens and signed payloads. Handles UTF-8 cleanly and runs locally.',
    category: 'encoding',
    icon: 'B64',
    version: '0.1.0',
    size: '2 KB',
    publishedAt: '2026-04-22',
    updatedDays: 3,
    tags: ['encoding', 'base64', 'utf-8'],
    builtIn: false,
  },
  {
    id: 'url-encode',
    name: 'URL Encode',
    description: 'Percent-encode and decode URL components.',
    longDescription:
      'Switch between component encoding and full URL encoding. Useful for query params, JSON-in-URL payloads, and signed redirects.',
    category: 'encoding',
    icon: '%',
    version: '0.1.0',
    size: '1 KB',
    publishedAt: '2026-04-20',
    updatedDays: 5,
    tags: ['encoding', 'url', 'percent'],
    builtIn: false,
  },
  {
    id: 'hex',
    name: 'Hex',
    description: 'Integer bases and UTF-8 byte views.',
    longDescription:
      'Convert integers between hex, decimal, binary, and octal, or inspect text as UTF-8 bytes for socket and payload debugging.',
    category: 'encoding',
    icon: '0x',
    version: '0.1.0',
    size: '2 KB',
    publishedAt: '2026-04-17',
    updatedDays: 8,
    tags: ['hex', 'binary', 'bytes'],
    builtIn: false,
  },
  {
    id: 'jwt',
    name: 'JWT Inspector',
    shortName: 'JWT',
    description: 'Decode, inspect, and verify JSON Web Tokens locally.',
    longDescription:
      'Paste a JWT to inspect the header, payload, and signature. The current desktop plugin decodes tokens locally and verifies HS256 signatures with your own secret.',
    category: 'text-data',
    icon: 'JWT',
    version: '0.1.0',
    size: '3 KB',
    publishedAt: '2026-04-23',
    updatedDays: 2,
    tags: ['jwt', 'token', 'decode', 'verify'],
    builtIn: false,
  },
  {
    id: 'uuid',
    name: 'UUID Generator',
    shortName: 'UUID',
    description: 'Generate v4 random or v7 time-ordered UUIDs.',
    longDescription:
      'Generate UUIDs locally. Use v4 for random IDs and v7 for sortable time-ordered IDs. The desktop build routes generation through native code.',
    category: 'generators',
    icon: '#ID',
    version: '0.1.0',
    size: '1 KB',
    publishedAt: '2026-04-20',
    updatedDays: 5,
    tags: ['uuid', 'generator', 'v4', 'v7'],
    builtIn: false,
  },
  {
    id: 'json-format',
    name: 'JSON Format',
    description: 'Beautify, minify, and validate JSON.',
    longDescription:
      'Format JSON for reading, minify it for transport, and surface parse errors clearly. Runs inside the plugin sandbox with no network access.',
    category: 'text-data',
    icon: '{ }',
    version: '0.1.0',
    size: '3 KB',
    publishedAt: '2026-04-19',
    updatedDays: 6,
    tags: ['json', 'format', 'beautify'],
    builtIn: false,
  },
  {
    id: 'password',
    name: 'Password',
    description: 'Generate strong random passwords.',
    longDescription:
      'Generate passwords with custom length and character sets. The desktop implementation uses cryptographic random bytes and native charset mapping.',
    category: 'generators',
    icon: 'PW',
    version: '0.1.0',
    size: '1 KB',
    publishedAt: '2026-04-18',
    updatedDays: 7,
    tags: ['password', 'generator', 'random'],
    builtIn: false,
  },
  {
    id: 'timestamp',
    name: 'Timestamp',
    description: 'Convert between Unix timestamps and ISO 8601.',
    longDescription:
      'Switch between Unix seconds, Unix milliseconds, and ISO 8601. The desktop conversion path is backed by native time formatting.',
    category: 'time-number',
    icon: 'TS',
    version: '0.1.0',
    size: '1 KB',
    publishedAt: '2026-04-15',
    updatedDays: 10,
    tags: ['timestamp', 'unix', 'iso'],
    builtIn: false,
  },
  {
    id: 'regex',
    name: 'Regex',
    description: 'Test regular expressions against sample text.',
    longDescription:
      'Test JavaScript regular expressions against sample text, inspect matches, and copy results. This stays in TypeScript so behavior matches the JavaScript runtime.',
    category: 'text-data',
    icon: '/.*',
    version: '0.1.0',
    size: '4 KB',
    publishedAt: '2026-04-14',
    updatedDays: 11,
    tags: ['regex', 'pattern', 'debug'],
    builtIn: false,
  },
  {
    id: 'diff',
    name: 'Diff',
    description: 'Compare two pieces of text line by line.',
    longDescription:
      'Compare two text blocks and produce a compact line diff. Whitespace can be ignored for quick review of copied snippets and prose.',
    category: 'text-data',
    icon: '+-',
    version: '0.1.0',
    size: '5 KB',
    publishedAt: '2026-04-10',
    updatedDays: 15,
    tags: ['diff', 'compare', 'text'],
    builtIn: false,
  },
  {
    id: 'numfmt',
    name: 'Number Format',
    description: 'Pretty-print large numbers with separators.',
    longDescription:
      'Normalize messy numeric strings and add thousands separators. The desktop path uses a small native formatter.',
    category: 'time-number',
    icon: '1k',
    version: '0.1.0',
    size: '2 KB',
    publishedAt: '2026-04-08',
    updatedDays: 17,
    tags: ['number', 'format', 'currency'],
    builtIn: false,
  },
]

export interface CategoryEntry {
  id: PluginCategory | 'all'
  label: string
  count: number
}

export function categoryCounts(): CategoryEntry[] {
  const counts: Partial<Record<PluginCategory, number>> = {}
  for (const tool of TOOLS) {
    counts[tool.category] = (counts[tool.category] ?? 0) + 1
  }
  const all: CategoryEntry[] = [
    { id: 'all', label: 'All', count: TOOLS.length },
    { id: 'encoding', label: 'Encoding', count: counts.encoding ?? 0 },
    { id: 'text-data', label: 'Text & Data', count: counts['text-data'] ?? 0 },
    { id: 'generators', label: 'Generators', count: counts.generators ?? 0 },
    { id: 'time-number', label: 'Time & Number', count: counts['time-number'] ?? 0 },
    { id: 'media', label: 'Media', count: counts.media ?? 0 },
    { id: 'utility', label: 'Utility', count: counts.utility ?? 0 },
  ]
  return all.filter((category) => category.count > 0 || category.id === 'all')
}

export function getToolBySlug(slug: string): ToolEntry | undefined {
  return TOOLS.find((tool) => tool.id === slug)
}

export interface ChangelogEntry {
  version: string
  date: string
  items: { kind: '+' | '~' | '-'; text: string }[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: 'v0.12.0-web',
    date: '2026-08-01',
    items: [
      { kind: '+', text: 'CloudYiCSC web catalog migrated into the CloudYi Assistant repository' },
      { kind: '+', text: 'Eight C utilities compile to WebAssembly during every production build' },
      { kind: '+', text: 'Four browser-native tools remain implemented with TypeScript' },
      { kind: '~', text: 'Removed the old Wails/Go workspace dependency from the deployable site' },
    ],
  },
  {
    version: 'v0.1.0',
    date: '2026-04-29',
    items: [
      { kind: '+', text: 'Web site goes live with the full tool catalog' },
      { kind: '+', text: 'Desktop client ships signed plugin loading and verification UI' },
      {
        kind: '+',
        text: 'Marketplace install, uninstall, disable, and sort now persist locally',
      },
      { kind: '~', text: 'Only Hash remains built in; other bundled tools are installable' },
    ],
  },
  {
    version: 'v0.0.5',
    date: '2026-04-22',
    items: [
      { kind: '+', text: 'Plugin Manager pane added to Settings' },
      { kind: '+', text: 'Marketplace mock data and plugin detail page added' },
      { kind: '~', text: 'Sidebar filter input replaces the category dropdown' },
    ],
  },
  {
    version: 'v0.0.3',
    date: '2026-04-12',
    items: [
      { kind: '+', text: 'Initial built-in tools: Hash, Base64, URL Encode, and Hex' },
      { kind: '+', text: 'Native desktop shell with Welcome and Workbench routing' },
      { kind: '~', text: 'Design tokens split into SCSS partials with light and dark themes' },
    ],
  },
]
