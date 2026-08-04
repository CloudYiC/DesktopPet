'use client'

// Browser runtime for tools that share the desktop C implementations. The
// TypeScript side writes input into a fixed WASM memory buffer, calls a thin
// C-exported wrapper, and reads the output buffer back as UTF-8 text.
interface CloudyicWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  cy_web_input_ptr(): number
  cy_web_input_cap(): number
  cy_web_output_ptr(): number
  cy_web_output_cap(): number
  cy_web_base64_encode(inputLength: number, urlSafe: number, pad: number): number
  cy_web_base64_decode(inputLength: number): number
  cy_web_hex_encode(inputLength: number): number
  cy_web_hex_decode(inputLength: number): number
  cy_web_int_convert(inputLength: number, fromBase: number, toBase: number): number
  cy_web_md5_hex(inputLength: number): number
  cy_web_sha256_hex(inputLength: number): number
  cy_web_url_encode(inputLength: number, component: number): number
  cy_web_url_decode(inputLength: number): number
  cy_web_uuid_v4(): number
  cy_web_uuid_v7(unixMsHi: number, unixMsLo: number): number
  cy_web_password_generate(
    randomLength: number,
    length: number,
    lower: number,
    upper: number,
    digits: number,
    symbols: number,
  ): number
  cy_web_timestamp_to_iso(valueHi: number, valueLo: number, unit: number): number
  cy_web_number_group(inputLength: number): number
}

interface LoadedNative {
  exports: CloudyicWasmExports
  memory: Uint8Array
  inputPtr: number
  inputCap: number
  outputPtr: number
  outputCap: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
let nativePromise: Promise<LoadedNative> | null = null

function loadNative(): Promise<LoadedNative> {
  // Cache the instantiated module. WASM startup is relatively expensive, and
  // all browser-native tool calls can safely reuse the same input/output buffers.
  nativePromise ??= (async () => {
    const response = await fetch('/wasm/cloudyic-native.wasm')
    if (!response.ok) {
      throw new Error(`Unable to load WASM native core (${response.status})`)
    }

    const { instance } = await instantiateWasm(response)
    const exports = instance.exports as CloudyicWasmExports

    return {
      exports,
      memory: new Uint8Array(exports.memory.buffer),
      inputPtr: exports.cy_web_input_ptr(),
      inputCap: exports.cy_web_input_cap(),
      outputPtr: exports.cy_web_output_ptr(),
      outputCap: exports.cy_web_output_cap(),
    }
  })()

  return nativePromise
}

async function instantiateWasm(
  response: Response,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  try {
    return await WebAssembly.instantiateStreaming(response, {})
  } catch {
    const bytes = await response.arrayBuffer()
    return WebAssembly.instantiate(bytes, {})
  }
}

async function callNative(
  input: string,
  invoke: (exports: CloudyicWasmExports, inputLength: number) => number,
): Promise<string> {
  return callNativeBytes(textEncoder.encode(input), invoke)
}

async function callNativeBytes(
  inputBytes: Uint8Array,
  invoke: (exports: CloudyicWasmExports, inputLength: number) => number,
): Promise<string> {
  const native = await loadNative()
  if (inputBytes.length > native.inputCap) {
    throw new Error('Input is too large for the browser native core')
  }

  native.memory.fill(0, native.inputPtr, native.inputPtr + inputBytes.length)
  // The C wrapper reads from cy_web_input and writes to cy_web_output.
  native.memory.set(inputBytes, native.inputPtr)

  const outputLength = invoke(native.exports, inputBytes.length)
  if (outputLength < 0 || outputLength > native.outputCap) {
    throw new Error('Native WASM operation failed')
  }

  return textDecoder.decode(
    native.memory.subarray(native.outputPtr, native.outputPtr + outputLength),
  )
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function splitI64(value: number | bigint): { hi: number; lo: number } {
  const raw = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
  const unsigned = BigInt.asUintN(64, raw)
  return {
    hi: Number((unsigned >> 32n) & 0xffffffffn),
    lo: Number(unsigned & 0xffffffffn),
  }
}

export function base64Encode(text: string, opts?: { urlSafe?: boolean; pad?: boolean }) {
  const urlSafe = opts?.urlSafe ?? false
  const pad = opts?.pad ?? !urlSafe
  return callNative(text, (exports, length) =>
    exports.cy_web_base64_encode(length, urlSafe ? 1 : 0, pad ? 1 : 0),
  )
}

export function base64Decode(input: string) {
  return callNative(input, (exports, length) => exports.cy_web_base64_decode(length))
}

export function hexEncode(text: string) {
  return callNative(text, (exports, length) => exports.cy_web_hex_encode(length))
}

export function hexDecode(input: string) {
  return callNative(input, (exports, length) => exports.cy_web_hex_decode(length))
}

export function intConvert(input: string, fromBase: number, toBase: number) {
  return callNative(input, (exports, length) =>
    exports.cy_web_int_convert(length, fromBase, toBase),
  )
}

export function md5(text: string) {
  return callNative(text, (exports, length) => exports.cy_web_md5_hex(length))
}

export function sha256(text: string) {
  return callNative(text, (exports, length) => exports.cy_web_sha256_hex(length))
}

export function urlEncode(text: string, opts?: { component?: boolean }) {
  return callNative(text, (exports, length) =>
    exports.cy_web_url_encode(length, (opts?.component ?? true) ? 1 : 0),
  )
}

export function urlDecode(input: string) {
  return callNative(input, (exports, length) => exports.cy_web_url_decode(length))
}

export function uuidV4() {
  return callNativeBytes(randomBytes(16), (exports) => exports.cy_web_uuid_v4())
}

export function uuidV7(now = Date.now()) {
  const { hi, lo } = splitI64(now)
  return callNativeBytes(randomBytes(10), (exports) => exports.cy_web_uuid_v7(hi, lo))
}

export function passwordGenerate(options: {
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
}) {
  return callNativeBytes(randomBytes(options.length), (exports, randomLength) =>
    exports.cy_web_password_generate(
      randomLength,
      options.length,
      options.lower ? 1 : 0,
      options.upper ? 1 : 0,
      options.digits ? 1 : 0,
      options.symbols ? 1 : 0,
    ),
  )
}

export function timestampToIso(value: number | bigint, unit: 'seconds' | 'milliseconds') {
  const { hi, lo } = splitI64(value)
  return callNativeBytes(new Uint8Array(), (exports) =>
    exports.cy_web_timestamp_to_iso(hi, lo, unit === 'milliseconds' ? 1 : 0),
  )
}

export function numberGroup(input: string) {
  return callNative(input, (exports, length) => exports.cy_web_number_group(length))
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}
