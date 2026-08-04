import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

for (const directory of ['.next', 'out']) {
  rmSync(resolve(process.cwd(), directory), { force: true, recursive: true })
}
