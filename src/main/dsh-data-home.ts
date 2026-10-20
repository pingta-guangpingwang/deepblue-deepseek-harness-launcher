import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { harnessHomeDirectoryName } from './config'
import { restrictDshPrivateDirectory } from './dsh-process-auth'
const preparations = new Map<string, Promise<string>>()
const caches = new Set(['node_modules', '.pnpm-store', '.cache', 'tmp', 'logs'])
const ephemeral = (name: string) => name === 'process-auth.json' || name.endsWith('.lock') || name.endsWith('.next') || name.endsWith('.tmp') || name === 'dsh-v2-migration.json'
let windowsLeaseProbe: Promise<(directory: string) => void> | undefined
async function assertNoWindowsSessionLease(directory: string): Promise<void> {
  windowsLeaseProbe ||= import('koffi').then(({ default: koffi }) => {
    const kernel = koffi.load('kernel32.dll')
    const open = kernel.func('__stdcall', 'OpenSemaphoreW', 'intptr', ['uint', 'int', 'str16'])
    const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
    const lastError = kernel.func('__stdcall', 'GetLastError', 'uint', [])
    return (home: string) => {
      const name = 'Local\\dsh-session-lock-' + createHash('sha256').update(path.resolve(home, 'session.lock').toLowerCase()).digest('hex')
      const handle = open(0x100000, 0, name)
      if (handle) { close(handle); throw new Error('旧 DSH 会话仍被运行进程持有，请先结束任务') }
      if (lastError() !== 2) throw new Error('无法确认旧 DSH 会话锁状态，未迁移数据')
    }
  })
  const probe = await windowsLeaseProbe
  for (const candidate of new Set([path.resolve(directory), await realpath(directory)])) probe(candidate)
}

async function existing(file: string): Promise<boolean> { try { await lstat(file); return true } catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function scan(root: string, checkActive = false): Promise<{ hash: string; files: Array<{ relative: string; sha256: string }> }> {
  const files: Array<{ relative: string; sha256: string }> = []
  const visit = async (directory: string, relative = ''): Promise<void> => {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('DSH 数据目录含符号链接，未修改旧数据')
    if (checkActive && process.platform === 'win32') await assertNoWindowsSessionLease(directory)
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), key = relative ? relative + '/' + entry.name : entry.name
      if (caches.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue
      const metadata = await lstat(file)
      if (metadata.isSymbolicLink()) throw new Error('DSH 数据含符号链接，未修改旧数据')
      if (metadata.isDirectory()) { await visit(file, key); continue }
      if (!metadata.isFile()) throw new Error('DSH 数据含不支持的节点，未修改旧数据')
      if (ephemeral(entry.name)) {
        if (checkActive && metadata.size < 8192 && (entry.name === 'process-auth.json' || entry.name.endsWith('.lock'))) {
          try { const value = JSON.parse(await readFile(file, 'utf8')); if (Number.isSafeInteger(value.pid) && value.pid > 0) { let alive = false; try { process.kill(value.pid, 0); alive = true } catch(error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') alive = true } if (alive) throw new Error('DSH 活跃进程阻止数据迁移') } } catch(error) { if ((error as Error).message.includes('阻止数据迁移')) throw error }
        }
        continue
      }
      const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk)
      files.push({ relative: key, sha256: hash.digest('hex') })
    }
  }
  if (await existing(root)) await visit(root)
  const digest = createHash('sha256'); for (const file of files) digest.update(file.relative).update('\0').update(file.sha256).update('\n')
  return { hash: digest.digest('hex'), files }
}

export async function dshPersistentDataHash(home: string): Promise<string> { return (await scan(home)).hash }
export async function ensureHarnessDataHome(storageRoot: string, version: string, assertQuiescent: () => Promise<void> = async () => {}): Promise<string> {
  const targetName = harnessHomeDirectoryName(version)
  const wanted = path.join(storageRoot, targetName)
  if (!['harness-data-v2', 'harness-data-v2-rc2'].includes(targetName)) return wanted
  if (await existing(wanted)) { if ((await lstat(wanted)).isSymbolicLink()) throw new Error('DSH v2 目录不能是符号链接'); return wanted }
  if (preparations.has(wanted)) return preparations.get(wanted)!
  const pending = (async () => {
    await assertQuiescent()
    await mkdir(storageRoot, { recursive: true }); const root = await realpath(storageRoot)
    const sourceName = targetName === 'harness-data-v2-rc2' && await existing(path.join(root, 'harness-data-v2')) ? 'harness-data-v2' : 'harness-data'
    const old = path.join(path.resolve(storageRoot), sourceName), target = path.join(root, targetName)
    if (await existing(target)) return target
    if (await existing(old) && (await lstat(old)).isSymbolicLink()) throw new Error('旧 DSH 目录不能是符号链接')
    const before = await scan(old, true)
    const staging = path.join(root, '.' + targetName + '-next-' + randomUUID())
    await mkdir(staging, { mode: 0o700 }); await restrictDshPrivateDirectory(staging)
    for (const file of before.files) { const destination = path.join(staging, ...file.relative.split('/')); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await copyFile(path.join(old, ...file.relative.split('/')), destination) }
    const [after, copied] = await Promise.all([scan(old, true), scan(staging)])
    if (before.hash !== after.hash || before.hash !== copied.hash) throw new Error('旧 DSH 数据在克隆期间变化，未切换或覆盖旧数据')
    await assertQuiescent()
    await writeFile(path.join(staging, 'dsh-v2-migration.json'), JSON.stringify({ schemaVersion: 1, source: sourceName, target: targetName, sourceHashBefore: before.hash, sourceHashAfter: after.hash, clonedHash: copied.hash, fileCount: before.files.length, excluded: [...caches, 'temporary process/lock markers'], createdAt: new Date().toISOString() }), { mode: 0o600 })
    await rename(staging, target)
    return target
  })()
  preparations.set(wanted, pending)
  try { return await pending } finally { if (preparations.get(wanted) === pending) preparations.delete(wanted) }
}
