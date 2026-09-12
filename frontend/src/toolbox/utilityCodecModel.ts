export const CODEC_INPUT_LIMIT = 1024 * 1024;
export function textMetrics(text: string) {
  let characters = 0;
  let lines = text ? 1 : 0;
  let previous = '';
  for (const character of text) {
    characters += 1;
    if (character === '\r' || (character === '\n' && previous !== '\r')) lines += 1;
    previous = character;
  }
  return { characters, lines, bytes: new TextEncoder().encode(text).length };
}
export function codecModes(toolId: string) {
  if (toolId === 'hash') return [{ id: 'sha256', label: 'SHA-256' }, { id: 'md5', label: 'MD5' }];
  if (toolId === 'json-format') return [{ id: 'format', label: '格式化' }, { id: 'minify', label: '压缩' }];
  if (toolId === 'url-encode') return [{ id: 'encode-component', label: '组件编码' }, { id: 'encode-url', label: '完整 URL 编码' }, { id: 'decode', label: '解码' }];
  return [{ id: 'encode', label: '编码' }, { id: 'decode', label: '解码' }];
}
export function codecSample(toolId: string, operation: string) {
  if (toolId === 'json-format') return '{"name":"云依助手","enabled":true,"tools":["Base64","Hex","JSON"]}';
  if (toolId === 'url-encode') return operation === 'decode' ? '%E4%BA%91%E4%BE%9D%E5%8A%A9%E6%89%8B' : 'https://example.com/search?q=云依助手';
  if (operation === 'decode') return toolId === 'hex' ? 'e4 ba 91 e4 be 9d e5 8a a9 e6 89 8b' : '5LqR5L6d5Yqp5omL';
  return '云依助手 可爱依依';
}
/** Display options do not alter the byte sequence. The C decoder accepts whitespace. */
export function formatHexOutput(raw: string, uppercase: boolean, spaced: boolean) {
  const text = uppercase ? raw.toUpperCase() : raw.toLowerCase();
  return spaced ? text.replace(/(..)(?=.)/g, '$1 ') : text;
}
