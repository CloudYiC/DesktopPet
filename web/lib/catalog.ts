/** Tool categories shared by the catalog, filters, and detail pages. */
export type PluginCategory =
  | 'encoding'
  | 'network'
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
    id: 'packet-inspector',
    name: '十六进制报文分析器',
    shortName: '报文分析',
    description: '粘贴 Hex 或 Wireshark 转储，看清协议层、字段与字节位置。',
    longDescription:
      '在浏览器本地解析 Ethernet、IPv4、IPv6、TCP、UDP 和 ICMP 基本头部，并用颜色将字段映射到原始字节。未知载荷不会被猜测成某种协议；可以为自定义协议保存字段模板。',
    category: 'network',
    icon: 'PKT',
    version: '0.1.0',
    size: '12 KB',
    publishedAt: '2026-09-03',
    updatedDays: 0,
    tags: ['hex', 'packet', 'wireshark', 'tcp', 'udp', '自定义协议'],
    builtIn: true,
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
    { id: 'network', label: 'Network & Protocols', count: counts.network ?? 0 },
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
    version: 'v0.13.13-desktop',
    date: '2026-09-15',
    items: [
      { kind: '~', text: 'Fixed redundant whole-page MQTT scrolling at default and scaled desktop sizes by fitting the workspace and message list to available height' },
      { kind: '~', text: 'Kept left-side settings independently scrollable and right-side message controls stationary, preserving internal history and payload scrolling without changing broker behavior' },
    ],
  },
  {
    version: 'v0.13.12-desktop',
    date: '2026-09-15',
    items: [
      { kind: '~', text: 'Kept packet protocol navigation and current selection beside byte and field views at default and scaled desktop widths, with automatic byte-row sizing' },
      { kind: '~', text: 'Attached payload-field actions to their corresponding protocol nodes and brought custom-field editing into view on activation' },
      { kind: '~', text: 'Clarified standard protocol fields versus raw selected-byte integer interpretation while preserving parser, selection and saved-field behavior' },
    ],
  },
  {
    version: 'v0.13.11-desktop',
    date: '2026-09-15',
    items: [
      { kind: '~', text: 'Renamed saved packets to Packet Templates and moved management to an on-demand dialog beside the send editor, preserving existing templates and JSON compatibility' },
      { kind: '~', text: 'Moved line endings, interval, repeat count and send/stop controls into the same left scrolling pane, leaving the right side dedicated to traffic history' },
      { kind: '~', text: 'Strengthened TCP client, TCP server and UDP mode tabs with clear selected styling and keyboard navigation without changing connection or sending behavior' },
    ],
  },
  {
    version: 'v0.13.10-desktop',
    date: '2026-09-15',
    items: [
      { kind: '~', text: 'Rebuilt MQTT as a message-first workspace with left-side operations, full-height message browsing, payload previews, topic/content and direction filters, and collapsible selection details' },
      { kind: '+', text: 'Added stable history reading and new-message follow controls without interrupting MQTT reception or replacing the selected message' },
      { kind: '~', text: 'Prioritized Modbus register and coil data with filtering, same-request value-change highlights, preserved results during refresh and a collapsible raw-traffic panel' },
      { kind: '~', text: 'Protected newer device state from late polling responses and isolated MQTT event history when starting a new session while retaining final messages after disconnect' },
      { kind: '~', text: 'Preserved native communication, MQTT TLS/credential handling and per-operation Modbus write confirmation; verified responsive layouts and synthetic message/device regressions' },
    ],
  },
  {
    version: 'v0.13.9-desktop',
    date: '2026-09-15',
    items: [
      { kind: '~', text: 'Merged packet authoring, saved libraries, file loading, escaped bytes and multicast controls into one Network Debugger workspace with TCP client/server and UDP modes' },
      { kind: '+', text: 'Preserved multi-client server sending and continuous sends; added bounded repeat batches, separate stop-sending/disconnect actions and line endings without changing saved payload bytes' },
      { kind: '~', text: 'Kept a large readable traffic console beside connection and send controls, with collapsible packet library and user-controlled follow-to-latest behavior' },
      { kind: '-', text: 'Removed the redundant Packet Sender entry and UI; all 20 built-in tools open directly and existing local packet libraries remain intact' },
    ],
  },
  {
    version: 'v0.13.8-desktop',
    date: '2026-09-14',
    items: [
      { kind: '~', text: 'Gave packet traffic logs a 320px content-height floor and the remaining workspace space; short windows and wrapped session details may scroll vertically instead of squeezing logs' },
      { kind: '+', text: 'Added collapsible saved packets and compact empty-library spacing without changing packet data or active network sessions' },
      { kind: '~', text: 'Documented the distinction between packet-template workflows and connection/server debugging; send and reply functionality remain intact' },
    ],
  },
  {
    version: 'v0.13.7-desktop',
    date: '2026-09-14',
    items: [
      { kind: '~', text: 'Replaced hidden loopback-only packet binding with a visible Windows IPv4 adapter selector and reviewed automatic routing for legacy multicast drafts' },
      { kind: '+', text: 'Added explicit UDP multicast send-interface and TTL options, separate join/listen and leave actions, and native-confirmed membership with local/remote port display' },
      { kind: '~', text: 'Pinned packet send controls, preserved editable targets and bytes, and clarified that TX completion is not remote delivery or multicast membership' },
      { kind: '+', text: 'Added adapter, multicast confirmation, cancellation, port separation and legacy-library regression checks; physical multicast networks remain user-tested' },
    ],
  },
  {
    version: 'v0.13.6-desktop',
    date: '2026-09-14',
    items: [
      { kind: '+', text: 'Added a desktop Packet Sender with TCP/UDP, lossless text/HEX/escaped-byte editing, binary payload loading and a local packet library with JSON import/export' },
      { kind: '+', text: 'Added bounded repeat sends, cancellation and live TX/RX logs in a fixed left-editor/right-results workspace; editing and importing never transmit automatically' },
      { kind: '+', text: 'Supports IPv4 UDP multicast sending through the system default route with explicit local binding consent; no multicast reception, raw packets or HTTP/TLS support' },
      { kind: '+', text: 'Added pure-model, isolated mocked-bridge and local-loopback native regressions; the Windows installer now includes all 21 tools' },
    ],
  },
  {
    version: 'v0.13.5-desktop',
    date: '2026-09-13',
    items: [
      { kind: '~', text: 'Unified the remaining 17 tool workspaces with slate-blue text, warm neutral panels and distinct input/output surfaces inspired by the system tools' },
      { kind: '~', text: 'Preserved protocol, diff and regex highlights; refreshed dark communication logs with consistent TX, RX, status and error colors' },
      { kind: '~', text: 'Improved solid action contrast across all three themes without changing fonts, layout, scrolling, communication or confirmation behavior' },
      { kind: '+', text: 'Added paint-only CSS comparison and a 20-tool, three-theme visual regression that checks title colors, action contrast and sidebar isolation' },
    ],
  },
  {
    version: 'v0.13.4-desktop',
    date: '2026-09-13',
    items: [
      { kind: '~', text: 'Reorganized Network, Serial and Modbus debuggers into left-hand controls and right-hand receive or result panes at default and maximized window sizes' },
      { kind: '~', text: 'Kept send controls and received data visible together; only viewports of 900px or narrower stack the panes' },
      { kind: '~', text: 'Constrained growing logs and results to internal scrolling, with independent left-panel scrolling for short windows and expanded settings' },
      { kind: '+', text: 'Added default, maximized, scaled-effective and narrow-window layout regressions without changing communication protocols or confirmation safeguards' },
    ],
  },
  {
    version: 'v0.13.3-desktop',
    date: '2026-09-13',
    items: [
      { kind: '~', text: 'Unified all desktop confirmations, including database write approval, Modbus writes, character deletion and residual cleanup, under one client-centered dialog component' },
      { kind: '~', text: 'Preserved cancel-first keyboard focus, reviewed action targets, full-name cleanup checks and native safety boundaries' },
      { kind: '~', text: 'Database writes now freeze SQL and database identity during review; repeated activation cannot reuse an approval and failed writes require a fresh confirmation' },
      { kind: '+', text: 'Added a source inventory guard against browser-native prompts and isolated confirmation tests across themes, font sizes and window sizes' },
    ],
  },
  {
    version: 'v0.13.2-desktop',
    date: '2026-09-13',
    items: [
      { kind: '~', text: 'Refreshed System Center, Port Manager and Software Uninstaller with coordinated slate-blue surfaces and distinct category and status colors' },
      { kind: '~', text: 'Organized all System Center fields into four detail tabs with compact colored overview cards' },
      { kind: '~', text: 'Kept port operations fully visible with a vertically scrolling table, wrapping long values and responsive narrow-window cards' },
      { kind: '~', text: 'Centered custom process and uninstall confirmation dialogs in the whole client, with cancel-first focus, retry feedback and duplicate-submit protection' },
      { kind: '-', text: 'Removed the permanent Port Manager safety footer while retaining explicit confirmation and native process protections' },
    ],
  },
  {
    version: 'v0.13.1-desktop',
    date: '2026-09-13',
    items: [
      { kind: '~', text: 'Redesigned Software Uninstaller with a scrolling app list, fixed detail pane, five-row pagination and an explicit cleanup confirmation dialog' },
      { kind: '+', text: 'Added bounded background discovery of nested Start Menu and desktop shortcuts using their actual local targets, with cancellation and post-uninstall revalidation' },
      { kind: '~', text: 'Replaced desktop sidebar character glyphs with consistent outline SVG icons without adding icon fonts or changing window size' },
      { kind: '-', text: 'Removed permanent safety banners and long scan notices; verification and confirmation remain enforced for cleanup' },
    ],
  },
  {
    version: 'v0.13.0-desktop',
    date: '2026-09-12',
    items: [
      { kind: '+', text: 'Added desktop Serial, MQTT and Modbus debugging clients with native communication workers' },
      { kind: '+', text: 'Added serial text/HEX transfers, MQTT topic subscription and publishing, and Modbus RTU/TCP register operations' },
      { kind: '~', text: 'All 20 built-in desktop tools open directly; the three device clients use compact controls and internally scrolling results' },
      { kind: '~', text: 'Device sessions stop when leaving the workbench; Modbus writes require explicit confirmation and MQTT credentials are not persisted' },
    ],
  },
  {
    version: 'v0.12.14-desktop',
    date: '2026-09-12',
    items: [
      { kind: '-', text: 'Removed the redundant built-in module enable and disable registry from the desktop UI' },
      { kind: '~', text: 'All 17 packaged desktop tools now open directly, without Local, Available, Popular or status-filter labels' },
      { kind: '~', text: 'Simplified Assistant Settings to General, Local Data and About while preserving native confirmation boundaries' },
    ],
  },
  {
    version: 'v0.12.13-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Reorganized Network Debugger into full-width connection, scrolling log and send sections' },
      { kind: '~', text: 'Aligned send options, server targets and sending in one row; server targets wrap below at window widths of 900px or less' },
      { kind: '~', text: 'Kept readable controls, responsive wrapping and risk/error feedback without a persistent local-processing notice' },
    ],
  },
  {
    version: 'v0.12.12-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Compacted Assistant Settings into horizontal tabs, a three-theme row and concise preference controls' },
      { kind: '-', text: 'Removed repeated settings introductions and decorative small-print labels while retaining useful values' },
      { kind: '~', text: 'Aligned all desktop content insets, including Yiyi settings, with the tool pages' },
    ],
  },
  {
    version: 'v0.12.11-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Aligned line-ending and repeat-send controls in Network Debugger, with server targets on a separate row' },
      { kind: '-', text: 'Removed redundant connection headings and the default local-processing notice' },
      { kind: '~', text: 'Used available window height to reduce nested scrolling while preserving readable controls and safety feedback' },
    ],
  },
  {
    version: 'v0.12.10-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Redesigned nine desktop utilities with compact purpose-built workspaces and independent scrolling' },
      { kind: '+', text: 'Added codec reverse conversion and byte counts, hash verification, timestamp result cards and UUID/password controls' },
      { kind: '+', text: 'Added regex match highlighting, bounded worker execution and stale-result and clipboard-error protection' },
    ],
  },
  {
    version: 'v0.12.9-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Renamed and redesigned Database Workbench with a schema tree, SQL/structure/DDL tabs and fixed result grid' },
      { kind: '+', text: 'Added resizable editor/results panes, SQL highlighting, result copying and duplicate-execution protection' },
      { kind: '-', text: 'Removed Number Format from desktop and web catalogs, runners and dedicated C/WASM APIs' },
    ],
  },
  {
    version: 'v0.12.8-desktop',
    date: '2026-09-12',
    items: [
      { kind: '+', text: 'Added local solid-background replacement with white, blue, red, custom and transparent targets' },
      { kind: '+', text: 'Added background sampling, tolerance and edge feathering in a cancellable image worker' },
      { kind: '~', text: 'Pinned image previews and save controls while image settings scroll independently' },
    ],
  },
  {
    version: 'v0.12.7-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Redesigned desktop text comparison with aligned red/green rows and inline change highlights' },
      { kind: '+', text: 'Added change counts, difference navigation, changes-only filtering and collapsible inputs' },
      { kind: '~', text: 'Replaced index-based text comparison with bounded line alignment and Unicode-aware inline matching' },
    ],
  },
  {
    version: 'v0.12.6-desktop',
    date: '2026-09-12',
    items: [
      { kind: '~', text: 'Unified all desktop tool headers into compact back navigation and title rows' },
      { kind: '~', text: 'Reduced sidebar width and tool-page insets without changing the initial window size' },
      { kind: '~', text: 'Kept tool descriptions in the catalog and preserved assistant pages and safety prompts' },
    ],
  },
  {
    version: 'v0.12.5-desktop',
    date: '2026-09-11',
    items: [
      { kind: '~', text: 'Redesigned packet inspection with linked protocol, byte, ASCII and field panes' },
      { kind: '+', text: 'Added offset navigation, 8/16/32-byte rows, range selection and precise endian interpretation' },
      { kind: '~', text: 'Preserved editable local custom fields and virtualized full 64 KiB packet scrolling' },
    ],
  },
  {
    version: 'v0.12.4-desktop',
    date: '2026-09-11',
    items: [
      { kind: '~', text: 'Reorganized connection and send controls into one balanced operation column' },
      { kind: '~', text: 'Expanded the receive log into a full-height fixed reading area' },
      { kind: '~', text: 'Kept growing traffic inside the log\'s own scrollbar and prioritized it on narrow windows' },
    ],
  },
  {
    version: 'v0.11.9-desktop',
    date: '2026-09-06',
    items: [
      { kind: '~', text: 'Removed repeated introductory headings from CloudYi toolbox list pages' },
      { kind: '~', text: 'Rebalanced typography, controls, spacing, and narrow-window layouts across desktop tools' },
      { kind: '~', text: 'Fixed clipping in the assistant interaction cloud at narrow and high-DPI window sizes' },
    ],
  },
  {
    version: 'v0.11.8-desktop',
    date: '2026-09-05',
    items: [
      { kind: '~', text: 'Improved text, controls, spacing, and responsive layouts across every desktop workspace' },
      { kind: '~', text: 'Added Per-Monitor V2 DPI awareness and removed fractional whole-page UI scaling' },
      { kind: '~', text: 'Improved desktop and web packet-inspector readability at narrow window sizes' },
    ],
  },
  {
    version: 'v0.11.7-desktop',
    date: '2026-09-05',
    items: [
      { kind: '+', text: 'Desktop Hex and Wireshark packet inspector with protocol and byte maps' },
      { kind: '~', text: 'Packet inspector is enabled as a local desktop tool by default' },
      { kind: '~', text: 'Windows executable and installer use the packaged pink Yiyi brand icon' },
    ],
  },
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
