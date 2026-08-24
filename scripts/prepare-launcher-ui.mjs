import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { launcherUiMetadata } from './launcher-ui-version.mjs'

const root = path.resolve(import.meta.dirname, '..')
const rendererRoot = path.resolve(process.argv[2] || path.join(root, 'out', 'renderer'))
const target = path.join(root, 'build-cache', 'generated', 'launcher-ui-version.json')
const metadata = await launcherUiMetadata(rendererRoot)
await mkdir(path.dirname(target), { recursive: true })
await writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ rendererRoot, target, ...metadata }, null, 2))
