// Remove only the superseded official cohort from npm's old lock resolution.
// npm then resolves the new cohort while retaining every unrelated locked package.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
await mkdir('.build-cache', { recursive: true })
await writeFile('.build-cache/package-lock-before-dsh-021.json', JSON.stringify(lock, null, 2) + '\n')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
lock.packages[''].dependencies = manifest.dependencies
for (const key of Object.keys(lock.packages)) if (key.includes('node_modules/@deepseek-ai/')) delete lock.packages[key]
await writeFile('package-lock.json', JSON.stringify(lock, null, 2) + '\n')
