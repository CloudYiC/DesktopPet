export const WASM_NATIVE_TOOL_IDS = [
  'hash',
  'base64',
  'hex',
  'url-encode',
  'uuid',
  'password',
  'timestamp',
  'numfmt',
] as const

export const TYPESCRIPT_TOOL_IDS = [
  'jwt',
  'json-format',
  'regex',
  'diff',
  'packet-inspector',
] as const

export const RUNNABLE_TOOL_IDS = [...WASM_NATIVE_TOOL_IDS, ...TYPESCRIPT_TOOL_IDS] as const

export type WasmNativeToolId = (typeof WASM_NATIVE_TOOL_IDS)[number]
export type TypeScriptToolId = (typeof TYPESCRIPT_TOOL_IDS)[number]
export type RunnableToolId = (typeof RUNNABLE_TOOL_IDS)[number]

export function isWasmNativeTool(id: string): id is WasmNativeToolId {
  return WASM_NATIVE_TOOL_IDS.includes(id as WasmNativeToolId)
}

export function isRunnableTool(id: string): id is RunnableToolId {
  return RUNNABLE_TOOL_IDS.includes(id as RunnableToolId)
}
