import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess, spawn } from 'node:child_process'
import { downloadVerifiedLauncherInstaller, installedLauncherRoot, silentLauncherUpdateArgs, spawnLauncherInstaller } from './launcher-update'

const bytes = Buffer.from('signed complete offline installer')
const artifact = {
  url: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/release-v2/040/offline.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length
}
const temporaryRoots: string[] = []
async function cacheDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'launcher-update-test-'))
  temporaryRoots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('launcher kernel update handoff', () => {
  it('resolves an installed versioned shell back to its install root', () => {
    expect(installedLauncherRoot('E:\\apps\\DeepBlueDeepSeekHarness\\shells\\0.10.24\\launcher.exe'))
      .toBe('E:\\apps\\DeepBlueDeepSeekHarness')
  })

  it('does not silently install from a development or unpacked build', () => {
    expect(installedLauncherRoot('E:\\repo\\release\\win-unpacked\\launcher.exe')).toBeUndefined()
  })

  it('keeps the NSIS destination argument last', () => {
    expect(silentLauncherUpdateArgs('E:\\apps\\DeepBlueDeepSeekHarness')).toEqual([
      '/S',
      '/AUTOSTART',
      '/D=E:\\apps\\DeepBlueDeepSeekHarness'
    ])
  })

  it('waits for the old parent process before the final destination argument', () => {
    expect(silentLauncherUpdateArgs('E:\\apps\\DeepBlueDeepSeekHarness', 1234)).toEqual([
      '/S', '/AUTOSTART', '/WAITPID=1234', '/D=E:\\apps\\DeepBlueDeepSeekHarness'
    ])
    expect(() => silentLauncherUpdateArgs('E:\\apps\\DeepBlueDeepSeekHarness', -1)).toThrow(/PID/)
  })

  it('does not complete a handoff until the detached installer has spawned', async () => {
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn()
    const start = vi.fn(() => child) as unknown as typeof spawn
    let handedOff = false
    const pending = spawnLauncherInstaller('E:\\updates\\verified.exe', 'E:\\apps\\DeepBlueDeepSeekHarness', { parentPid: 1234, spawn: start })
      .then(() => { handedOff = true })
    await Promise.resolve()
    expect(handedOff).toBe(false)
    expect(child.unref).not.toHaveBeenCalled()
    child.emit('spawn')
    await pending
    expect(child.unref).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith('E:\\updates\\verified.exe', ['/S', '/AUTOSTART', '/WAITPID=1234', '/D=E:\\apps\\DeepBlueDeepSeekHarness'], {
      detached: true, stdio: 'ignore', windowsHide: true
    })
  })

  it('rejects an installer launch error without reporting a handoff', async () => {
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn()
    const start = (() => child) as unknown as typeof spawn
    const pending = spawnLauncherInstaller('missing.exe', 'E:\\apps\\DeepBlueDeepSeekHarness', { spawn: start })
    const rejected = expect(pending).rejects.toThrow('ENOENT')
    child.emit('error', new Error('ENOENT'))
    await rejected
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('rejects a synchronous installer launch failure', async () => {
    const start = (() => { throw new Error('spawn permission denied') }) as unknown as typeof spawn
    await expect(spawnLauncherInstaller('verified.exe', 'E:\\apps\\DeepBlueDeepSeekHarness', { spawn: start })).rejects.toThrow('spawn permission denied')
  })
})

describe('verified kernel installer download', () => {
  it('stores only complete verified bytes and reports signed byte progress', async () => {
    const root = await cacheDirectory()
    const progress = vi.fn()
    const fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
    const result = await downloadVerifiedLauncherInstaller(artifact, root, progress, { fetch })
    expect(result).toEqual({ path: path.join(root, `${artifact.sha256}.exe`), reused: false })
    expect(await readFile(result.path)).toEqual(bytes)
    expect(progress).toHaveBeenLastCalledWith({ receivedBytes: bytes.length, totalBytes: bytes.length })
    expect(await readdir(root)).toEqual([`${artifact.sha256}.exe`])
  })

  it('rechecks and reuses the complete cache without any network request', async () => {
    const root = await cacheDirectory()
    const first = await downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch: async () => new Response(bytes) })
    const fetch = vi.fn(async () => { throw new Error('network unavailable') })
    expect(await downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch })).toEqual({ ...first, reused: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('redownloads an altered cache instead of reusing it', async () => {
    const root = await cacheDirectory()
    const first = await downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch: async () => new Response(bytes) })
    await writeFile(first.path, Buffer.alloc(bytes.length, 1))
    const fetch = vi.fn(async () => new Response(bytes))
    const result = await downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch })
    expect(result.reused).toBe(false)
    expect(await readFile(result.path)).toEqual(bytes)
  })

  it.each([
    ['truncated', bytes.subarray(0, -1), /大小/],
    ['oversized', Buffer.concat([bytes, Buffer.from('x')]), /大小/],
    ['altered', Buffer.alloc(bytes.length, 1), /SHA-256/]
  ])('rejects a %s response and removes all unverified bytes', async (_label, content, message) => {
    const root = await cacheDirectory()
    await expect(downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch: async () => new Response(content) })).rejects.toThrow(message)
    expect(await readdir(root)).toEqual([])
  })

  it('rejects a content length that differs from the signed size', async () => {
    const root = await cacheDirectory()
    await expect(downloadVerifiedLauncherInstaller(artifact, root, undefined, {
      fetch: async () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } })
    })).rejects.toThrow(/大小/)
    expect(await readdir(root)).toEqual([])
  })

  it('closes and removes the partial download when the response stream is interrupted', async () => {
    const root = await cacheDirectory()
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 5)) },
      pull(controller) { controller.error(new Error('connection interrupted')) }
    })
    await expect(downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch: async () => new Response(interrupted) })).rejects.toThrow('connection interrupted')
    expect(await readdir(root)).toEqual([])
    const retried = await downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch: async () => new Response(bytes) })
    expect(await readFile(retried.path)).toEqual(bytes)
  })

  it.each([
    { url: 'http://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/offline.exe' },
    { url: 'https://evil.example/offline.exe' },
    { url: 'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com.evil.example/offline.exe' },
    { url: 'https://user:password@github.com/pingta-guangpingwang/release.exe' },
    { url: 'https://github.com:8443/offline.exe' },
    { sha256: '../untrusted' },
    { size: 0 },
    { size: Number.NaN },
    { size: 2.5 }
  ])('rejects untrusted artifact metadata before fetching: %j', async (override) => {
    const root = await cacheDirectory()
    const fetch = vi.fn(async () => new Response(bytes))
    await expect(downloadVerifiedLauncherInstaller({ ...artifact, ...override }, root, undefined, { fetch })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('follows only allowed GitHub HTTPS release redirects', async () => {
    const root = await cacheDirectory()
    const fetch = vi.fn(async (url: string) => url.startsWith('https://github.com/')
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset/offline.exe' } })
      : new Response(bytes))
    const result = await downloadVerifiedLauncherInstaller({ ...artifact, url: 'https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/040/offline.exe' }, root, undefined, { fetch })
    expect(await readFile(result.path)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]?.[0]).toContain('https://github.com/')
  })

  it.each(['https://evil.example/offline.exe', 'http://release-assets.githubusercontent.com/offline.exe', 'https://user:password@release-assets.githubusercontent.com/offline.exe'])('rejects an untrusted redirect to %s', async (location) => {
    const root = await cacheDirectory()
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
    await expect(downloadVerifiedLauncherInstaller({ ...artifact, url: 'https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/040/offline.exe' }, root, undefined, { fetch })).rejects.toThrow(/重定向/)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await readdir(root)).toEqual([])
  })

  it('ends a redirect loop without retaining an installer', async () => {
    const root = await cacheDirectory()
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: artifact.url } }))
    await expect(downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch })).rejects.toThrow(/重定向次数/)
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(await readdir(root)).toEqual([])
  })

  it('cancels the response and removes the partial file when cancelled during transfer', async () => {
    const root = await cacheDirectory()
    const controller = new AbortController()
    const cancel = vi.fn()
    const response = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(bytes.subarray(0, 5)) },
      cancel
    })
    const pending = downloadVerifiedLauncherInstaller(artifact, root, () => controller.abort(), { fetch: async () => new Response(response), signal: controller.signal })
    await expect(pending).rejects.toThrow(/abort/i)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })

  it('rejects cancellation without leaving a file eligible for installation', async () => {
    const root = await cacheDirectory()
    const controller = new AbortController()
    const fetch = vi.fn(async () => new Response(bytes))
    controller.abort(new Error('user cancelled'))
    await expect(downloadVerifiedLauncherInstaller(artifact, root, undefined, { fetch, signal: controller.signal })).rejects.toThrow('user cancelled')
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })
})
