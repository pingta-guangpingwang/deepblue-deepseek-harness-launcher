import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, lstat, writeFile, rename } from 'node:fs/promises'
import { desktopRelayDirectory } from './desktop-relay'
const knownOlderCode = new Set(['7e329db42f80e418a1c60bce22f81356be0bde7d3dd34fffc7333afcdd6aa338'])
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Update only an already installed, known application-owned helper. This never
 * installs an MCP registration or changes Codex settings, secrets or requests. */
export async function updateExistingDesktopRelay(moduleDir: string, directory = desktopRelayDirectory(), recognized = knownOlderCode): Promise<'absent' | 'current' | 'custom' | 'updated'> {
  const candidate = await readFile(path.join(moduleDir, 'native-companion.mjs')).catch(() => undefined)
  if (!candidate) return 'absent'
  const target = path.join(directory, 'companion.mjs'), info = await lstat(target).catch(() => undefined)
  if (!info) return 'absent'
  if (info.isSymbolicLink() || !info.isFile() || (await lstat(directory)).isSymbolicLink()) return 'custom'
  const previous = await readFile(target), oldHash = hash(previous)
  if (oldHash === hash(candidate)) return 'current'
  if (!recognized.has(oldHash)) return 'custom'
  const settings = await readFile(path.join(directory, 'settings.json'), 'utf8').then(JSON.parse).catch(() => undefined)
  if (!/^[a-f0-9-]{36}$/i.test(settings?.executor || '')) return 'custom'
  const backup = path.join(directory, 'backup-module-' + oldHash.slice(0, 16))
  await mkdir(backup, { recursive: true })
  if ((await lstat(backup)).isSymbolicLink()) return 'custom'
  const copy = path.join(backup, 'companion.mjs')
  try { await writeFile(copy, previous, { flag: 'wx', mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await readFile(copy)) !== oldHash) throw error }
  if (hash(await readFile(target)) !== oldHash) throw new Error('桥接代码已变化，未覆盖')
  const temporary = path.join(directory, 'companion-' + randomUUID() + '.next')
  await writeFile(temporary, candidate, { flag: 'wx', mode: 0o600 }); await rename(temporary, target)
  return 'updated'
}
