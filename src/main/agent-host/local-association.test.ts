import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalAssociations, validateAssociationLaunch } from './local-association'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'launcher-association-'))); roots.push(root)
  const executable = path.join(root, 'codex.exe'), runtimeHome = path.join(root, 'native-data')
  await writeFile(executable, 'test fixture: never executed'); await mkdir(runtimeHome)
  const probe = vi.fn(async () => {})
  const service = new LocalAssociations(path.join(root, 'associations'), process.execPath, path.join(root, 'launcher.exe'), probe)
  await service.begin('codex')
  const request = service.snapshot()[0]!
  const raw = { schemaVersion: 1, adapter: 'codex', requestId: request.requestId, executablePath: executable, runtimeHome }
  const save = async (value: unknown = raw) => writeFile(request.configPath, JSON.stringify(value))
  return { root, service, probe, request, raw, save }
}
test('offline registration waits for a requested file, validates once and preserves native home after restart', async () => {
  const { root, service, probe, request, save } = await fixture()
  expect(await service.check()).toBe(false); expect(probe).not.toHaveBeenCalled()
  expect(request.prompt).toContain(request.configPath)
  await save(); expect(await service.check()).toBe(true)
  expect(service.snapshot()[0]?.status).toBe('verified')
  expect(service.snapshot()[0]?.message).toContain('尚不代表远程执行就绪')
  expect(service.environment().CODEX_HOME).toBe(path.join(root, 'native-data'))
  await service.check(); expect(probe).toHaveBeenCalledTimes(1)
  const restored = new LocalAssociations(path.join(root, 'associations'), process.execPath, 'launcher.exe', probe)
  await restored.initialize(); expect(await restored.check()).toBe(true)
  expect(restored.launch('codex')?.executable).toBe(path.join(root, 'codex.exe'))
})
test('malformed and stale requests cannot trigger a process; correction triggers the next check', async () => {
  const { service, probe, raw, save, request } = await fixture()
  await writeFile(request.configPath, '{'); await service.check()
  expect(service.snapshot()[0]?.status).toBe('invalid'); expect(probe).not.toHaveBeenCalled()
  await save({ ...raw, requestId: 'stale' }); await service.check(); expect(probe).not.toHaveBeenCalled()
  await save({ ...raw, args: ['--dangerously-skip-permissions'] }); await service.check(); expect(probe).not.toHaveBeenCalled()
  await save(); expect(await service.check()).toBe(true); expect(probe).toHaveBeenCalledTimes(1)
})
test('CLI handshake failure remains an error rather than connected', async () => {
  const { service, probe, save } = await fixture()
  probe.mockRejectedValueOnce(new Error('CLI 未通过版本握手'))
  await save(); expect(await service.check()).toBe(false)
  expect(service.launch('codex')).toBeUndefined(); expect(service.snapshot()[0]?.status).toBe('invalid')
})
test('a changed file during validation is never committed as a verified runtime', async () => {
  const { service, probe, save, raw } = await fixture()
  probe.mockImplementationOnce(async () => { await save({ ...raw, requestId: 'replacement' }) })
  await save(); expect(await service.check()).toBe(false); expect(service.launch('codex')).toBeUndefined()
  await service.check(); expect(service.snapshot()[0]?.status).toBe('invalid')
})
test('new requests expire while already accepted unchanged registration survives restart', async () => {
  const { root, service, probe, save } = await fixture()
  await save(); await service.check()
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
  const restored = new LocalAssociations(path.join(root, 'associations'), process.execPath, 'launcher.exe', probe)
  await restored.initialize(); expect(await restored.check()).toBe(true)
  await restored.begin('claude-code')
  const request = restored.snapshot().find(item => item.adapter === 'claude-code')!
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
  await writeFile(request.configPath, JSON.stringify({ schemaVersion: 1, adapter: 'claude-code', requestId: request.requestId }))
  await restored.check(); expect(restored.snapshot().find(item => item.adapter === 'claude-code')?.status).toBe('expired')
})
test('only an official npm package bin is resolved; script and unrelated program paths are rejected', async () => {
  const { root } = await fixture()
  const pkg = path.join(root, 'package'); await mkdir(pkg)
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'cli.js' } }))
  await writeFile(path.join(pkg, 'cli.js'), '// test fixture')
  expect(await validateAssociationLaunch('codex', { packageRoot: pkg }, process.execPath)).toEqual({ executable: process.execPath, args: [path.join(pkg, 'cli.js')], runtimeHome: undefined })
  await expect(validateAssociationLaunch('claude-code', { packageRoot: pkg }, process.execPath)).rejects.toThrow('官方 npm 包')
  await expect(validateAssociationLaunch('codex', { executablePath: process.execPath }, process.execPath)).rejects.toThrow('实际 CLI')
  await expect(validateAssociationLaunch('codex', { executablePath: 'https://example.com/codex.exe' }, process.execPath)).rejects.toThrow('本机绝对路径')
  expect(JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8')).name).toBe('@openai/codex')
})
test('TRAE and built-in DSH never run a submitted binary', async () => {
  const { service, probe } = await fixture()
  await service.begin('trae'); await service.begin('deepseek-harness'); await service.check()
  const unsupported = service.snapshot().filter(item => item.status === 'unsupported')
  expect(unsupported).toHaveLength(2)
  expect(unsupported.find(item => item.adapter === 'trae')?.message).toContain('暂未打通')
  expect(unsupported.find(item => item.adapter === 'deepseek-harness')?.message).toContain('启动器内置')
  expect(unsupported.every(item => item.prompt === '' && item.configPath === '')).toBe(true)
  expect(probe).not.toHaveBeenCalled()
})
