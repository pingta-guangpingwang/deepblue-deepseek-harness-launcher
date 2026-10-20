import { vi, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => { throw Error('isolated test must pass root') } } }))
import { ensureHarnessDataHome, dshPersistentDataHash } from './dsh-data-home'
import { harnessHomeDirectoryName } from './config'

it('clones the current alpha home for rc2 while retaining a working alpha rollback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-rc2-home-'))
  try {
    const alpha = path.join(root, 'harness-data-v2')
    await mkdir(path.join(alpha, 'profiles/web'), { recursive: true })
    await writeFile(path.join(alpha, 'profiles/web/cordis.patch.yml'), '- id: agent-default-model\n  config: { provider: deepseek-official, model: deepseek-v4-flash }\n')
    await writeFile(path.join(alpha, '.credentials.yaml'), 'version: 1\nvalues: { DEEPSEEK_API_KEY: SYNTHETIC_ONLY }\n')
    await writeFile(path.join(alpha, 'session.jsonl'), '{"id":"existing-alpha-session"}\n')
    const before = await dshPersistentDataHash(alpha)
    const rc = await ensureHarnessDataHome(root, '0.2.1-rc.2')
    expect(rc).toBe(await realpath(path.join(root, 'harness-data-v2-rc2')))
    expect(await dshPersistentDataHash(rc)).toBe(before)
    await writeFile(path.join(rc, 'profiles/web/cordis.patch.yml'), '- id: web\n  config: { searchProvider: deepseek-search-api, fetchProvider: deepseek-fetch-api }\n')
    await writeFile(path.join(rc, 'new-session.jsonl'), '{"id":"rc2-session"}\n')
    expect(await dshPersistentDataHash(alpha)).toBe(before)
    expect(await ensureHarnessDataHome(root, '0.2.1-alpha.2')).toBe(alpha)
    const receipt = JSON.parse(await readFile(path.join(rc, 'dsh-v2-migration.json'), 'utf8'))
    expect(receipt).toMatchObject({ source: 'harness-data-v2', target: 'harness-data-v2-rc2', sourceHashBefore: before, sourceHashAfter: before })
    const evidence = path.resolve('output/dsh-rc2-data-migration.json')
    await mkdir(path.dirname(evidence), { recursive: true })
    await writeFile(evidence, JSON.stringify({ synthetic: true, passed: true, originalAlphaHash: before, alphaHashAfterRcChanges: await dshPersistentDataHash(alpha), rcSessionRetained: (await readFile(path.join(rc, 'new-session.jsonl'), 'utf8')).includes('rc2-session'), receipt }, null, 2))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('privately clones into a sibling and preserves old bytes after a new session and rollback selection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-versioned-home-'))
  try {
    const old = path.join(root, 'harness-data')
    await mkdir(path.join(old, 'sessions'), { recursive: true })
    await writeFile(path.join(old, 'settings.yaml'), 'agent-default-model: { provider: synthetic, model: test }\n')
    await writeFile(path.join(old, '.credentials.yaml'), 'version: 1\nrefs: { SYNTHETIC: fixture-only }\n')
    await writeFile(path.join(old, 'sessions/old.jsonl'), '{"id":"old-session"}\n')
    const before = await dshPersistentDataHash(old)
    const current = await ensureHarnessDataHome(root, '0.2.1-alpha.2')
    expect(current).toBe(await realpath(path.join(root, 'harness-data-v2')))
    expect(await dshPersistentDataHash(current)).toBe(before)
    expect(await dshPersistentDataHash(old)).toBe(before)
    await writeFile(path.join(current, 'sessions/new.jsonl'), '{"id":"new-v2-session"}\n')
    expect(await dshPersistentDataHash(old)).toBe(before)
    expect(await ensureHarnessDataHome(root, '0.1.1-rc.2')).toBe(old)
    expect(harnessHomeDirectoryName('0.1.1-rc.2')).toBe('harness-data')
    expect(await readFile(path.join(current, 'sessions/new.jsonl'), 'utf8')).toContain('new-v2-session')
    const receipt = JSON.parse(await readFile(path.join(current, 'dsh-v2-migration.json'), 'utf8'))
    expect(receipt.sourceHashBefore).toBe(receipt.sourceHashAfter)
    expect(receipt.clonedHash).toBe(before)
    const evidence = path.resolve('output/dsh-021-candidate/data-migration-proof.json')
    await mkdir(path.dirname(evidence), { recursive: true })
    await writeFile(evidence, JSON.stringify({ input: 'isolated synthetic legacy settings, credential refs, old-session bytes', upgradedVersion: '0.2.1-alpha.2', rollbackVersion: '0.1.1-rc.2', originalHashBefore: before, cloneHash: receipt.clonedHash, originalHashAfterNewSession: await dshPersistentDataHash(old), originalHashAfterRollbackSelection: await dshPersistentDataHash(await ensureHarnessDataHome(root, '0.1.1-rc.2')), newSessionRetained: true, dataHomeSeparate: current !== old }, null, 2) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses live process markers and source symlinks without changing the old home', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-active-home-'))
  try {
    const old = path.join(root, 'harness-data'); await mkdir(path.join(old, 'launcher'), { recursive: true })
    await writeFile(path.join(old, 'settings.yaml'), '{}\n')
    await writeFile(path.join(old, 'launcher/process-auth.json'), JSON.stringify({ pid: process.pid }))
    await expect(ensureHarnessDataHome(root, '0.2.1-alpha.2')).rejects.toThrow('阻止数据迁移')
    expect(await readFile(path.join(old, 'settings.yaml'), 'utf8')).toBe('{}\n')
    await rm(path.join(old, 'launcher/process-auth.json'))
    const { symlink } = await import('node:fs/promises')
    await mkdir(path.join(root, 'outside'))
    await symlink(path.join(root, 'outside'), path.join(old, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ensureHarnessDataHome(root, '0.2.1-alpha.2')).rejects.toThrow('符号链接')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'win32')('refuses a real Windows native session lease even without an auth marker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-session-lease-'))
  const old = path.join(root, 'harness-data')
  await mkdir(old)
  await writeFile(path.join(old, 'settings.yaml'), '{}\n')
  const original = await dshPersistentDataHash(old)
  const { default: koffi } = await import('koffi')
  const kernel = koffi.load('kernel32.dll')
  const create = kernel.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void *', 'int', 'int', 'str16'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['intptr'])
  const name = 'Local\\dsh-session-lock-' + createHash('sha256').update(path.resolve(old, 'session.lock').toLowerCase()).digest('hex')
  const handle = create(null, 1, 1, name)
  try {
    expect(handle).toBeTruthy()
    await expect(ensureHarnessDataHome(root, '0.2.1-alpha.2')).rejects.toThrow('会话仍被运行进程持有')
    expect(await dshPersistentDataHash(old)).toBe(original)
  } finally { if (handle) close(handle); await rm(root, { recursive: true, force: true }) }
})
