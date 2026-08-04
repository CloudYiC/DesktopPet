/** Stable category identifiers migrated from the CloudYiCSC desktop client. */
export type ToolCategoryId =
  | 'data'
  | 'network'
  | 'system'
  | 'file-conversion';

export interface ToolCategory {
  id: ToolCategoryId;
  label: string;
  shortLabel: string;
  description: string;
  glyph: string;
}

export type ToolRuntime = 'c-core' | 'react' | 'native-system' | 'planned';

export type ToolPermission =
  | '本地计算'
  | '读取系统信息'
  | '读取端口与进程'
  | '结束端口占用进程'
  | '读取已安装软件'
  | '启动注册卸载程序'
  | '清理已确认的软件残留'
  | '读取所选数据库'
  | '修改所选数据库';

export interface ToolDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  category: ToolCategoryId;
  glyph: string;
  runtime: ToolRuntime;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: 'data', label: '数据处理', shortLabel: '数据处理', description: '格式化、检查、编码并转换代码和结构化数据。', glyph: '01' },
  { id: 'network', label: '网络与协议', shortLabel: '网络协议', description: '分析 URL、协议、载荷和请求数据。', glyph: '◎' },
  { id: 'system', label: '系统工具', shortLabel: '系统工具', description: '查看文件、端口、进程和设备环境。', glyph: '▣' },
  { id: 'file-conversion', label: '文件处理', shortLabel: '文件处理', description: '转换文档、图片、网页和 Markdown 等本地文件。', glyph: '⇄' },
];

/**
 * Complete migration catalog. `planned` entries are visible so the interface
 * keeps CloudYiCSC's information architecture without claiming unavailable
 * native permissions are already implemented.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  { id: 'json-format', name: 'JSON 格式化', shortName: 'JSON', description: '格式化、压缩并校验 JSON 文本。', category: 'data', glyph: '{ }', runtime: 'react' },
  { id: 'regex', name: '正则表达式', shortName: 'Regex', description: '测试表达式并查看所有匹配结果。', category: 'data', glyph: '.*', runtime: 'react' },
  { id: 'diff', name: '文本比较', shortName: 'Diff', description: '按行查看两段文本的差异。', category: 'data', glyph: '±', runtime: 'react' },
  { id: 'base64', name: 'Base64', shortName: 'Base64', description: '使用迁移后的 C 核心编码和解码 UTF-8 文本。', category: 'data', glyph: 'B64', runtime: 'c-core' },
  { id: 'hex', name: 'Hex 编解码', shortName: 'Hex', description: '在 UTF-8 文本与十六进制字节之间转换。', category: 'data', glyph: '0x', runtime: 'c-core' },
  { id: 'hash', name: '哈希计算', shortName: 'Hash', description: '使用 C 实现计算 MD5 或 SHA-256。', category: 'data', glyph: '#', runtime: 'c-core' },
  { id: 'numfmt', name: '数字格式化', shortName: 'Number', description: '使用 C 核心为十进制数字添加分组符。', category: 'data', glyph: '123', runtime: 'c-core' },
  { id: 'timestamp', name: '时间戳', shortName: 'Time', description: '将 Unix 秒或毫秒时间戳转换为 UTC 时间。', category: 'data', glyph: '◷', runtime: 'c-core' },
  { id: 'uuid', name: 'UUID 生成器', shortName: 'UUID', description: '使用系统安全随机源生成 UUID v4 或 v7。', category: 'data', glyph: 'ID', runtime: 'c-core' },
  { id: 'password', name: '密码生成器', shortName: 'Password', description: '使用系统安全随机源按规则生成本地密码。', category: 'data', glyph: '***', runtime: 'c-core' },
  { id: 'data-lab', name: '数据实验室', shortName: 'Data Lab', description: '批量清洗、拆分、筛选、去重和转换文本数据。', category: 'data', glyph: '∑', runtime: 'planned' },
  { id: 'url-encode', name: 'URL 编解码', shortName: 'URL', description: '使用 RFC 3986 C 核心处理 URL 或组件。', category: 'network', glyph: '%', runtime: 'c-core' },
  { id: 'jwt', name: 'JWT 查看器', shortName: 'JWT', description: '离线查看 JWT 头部和载荷。', category: 'network', glyph: 'JWT', runtime: 'planned' },
  { id: 'network-lab', name: '网络实验室', shortName: 'Network', description: '发送请求并检查 TLS 与响应信息。', category: 'network', glyph: '↗', runtime: 'planned' },
  { id: 'system-inspector', name: '系统中心', shortName: 'System', description: '只读查看 Windows、硬件、显示、网络和资源状态。', category: 'system', glyph: 'PC', runtime: 'native-system' },
  { id: 'port-manager', name: '端口管理', shortName: 'Ports', description: '查看 IPv4 TCP/UDP 端口，并经确认结束非关键进程。', category: 'system', glyph: ':80', runtime: 'native-system' },
  { id: 'software-uninstaller', name: '软件卸载', shortName: 'Uninstall', description: '启动注册卸载程序，并审核清理配置、插件、缓存与程序残留。', category: 'system', glyph: 'APP', runtime: 'native-system' },
  { id: 'image-toolbox', name: '图片转换器', shortName: 'Image', description: '本地预览、缩放、旋转、翻转并导出 PNG/JPEG/WebP/ICO。', category: 'file-conversion', glyph: 'IMG', runtime: 'react' },
  { id: 'file-converter', name: '文件转换器', shortName: 'Convert', description: '转换文档、图片和常用导出格式。', category: 'file-conversion', glyph: 'PDF', runtime: 'planned' },
  { id: 'database-studio', name: '数据库工作室', shortName: 'Database', description: '打开或新建 SQLite，查看结构并安全执行 SQL。', category: 'data', glyph: 'DB', runtime: 'native-system' },
];

export const READY_TOOL_COUNT = TOOL_DEFINITIONS.filter(
  (tool) => tool.runtime !== 'planned',
).length;

export function toolsForCategory(category: ToolCategoryId | null) {
  return category
    ? TOOL_DEFINITIONS.filter((tool) => tool.category === category)
    : TOOL_DEFINITIONS;
}

export function categoryById(category: ToolCategoryId | null) {
  return TOOL_CATEGORIES.find((item) => item.id === category) ?? null;
}

/** Permissions are static metadata; runtime enforcement remains native. */
export function permissionsForTool(tool: ToolDefinition): ToolPermission[] {
  if (tool.id === 'system-inspector') return ['读取系统信息'];
  if (tool.id === 'port-manager') {
    return ['读取端口与进程', '结束端口占用进程'];
  }
  if (tool.id === 'software-uninstaller') {
    return ['读取已安装软件', '启动注册卸载程序', '清理已确认的软件残留'];
  }
  if (tool.id === 'database-studio') {
    return ['读取所选数据库', '修改所选数据库'];
  }
  return ['本地计算'];
}
