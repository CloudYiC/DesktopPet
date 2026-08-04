import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(scriptDir, '..')
const nativeDir = resolve(webRoot, 'native')
const coreDir = resolve(nativeDir, 'core')
const outputDir = resolve(webRoot, 'public', 'wasm')
const outputFile = resolve(outputDir, 'cloudyic-native.wasm')
const clang = resolve(
  webRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'clang.cmd' : 'clang',
)

const sources = [
  resolve(nativeDir, 'cloudyic_wasm.c'),
  resolve(coreDir, 'base64.c'),
  resolve(coreDir, 'hex.c'),
  resolve(coreDir, 'md5.c'),
  resolve(coreDir, 'sha256.c'),
  resolve(coreDir, 'store_tools.c'),
  resolve(coreDir, 'url_encode.c'),
]

mkdirSync(outputDir, { recursive: true })

const args = [
  '--target=wasm32-unknown-unknown',
  '-std=c11',
  '-O3',
  '-flto',
  '-nostdlib',
  '-I',
  resolve(nativeDir, 'include'),
  '-I',
  coreDir,
  '-Wl,--no-entry',
  '-Wl,--export-all',
  '-Wl,--initial-memory=8388608',
  '-o',
  outputFile,
  ...sources,
]

const result = spawnSync(clang, args, {
  cwd: webRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.error) {
  console.error(`Unable to start the WebAssembly compiler: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

console.log(`Built public/wasm/cloudyic-native.wasm (${statSync(outputFile).size} bytes).`)
