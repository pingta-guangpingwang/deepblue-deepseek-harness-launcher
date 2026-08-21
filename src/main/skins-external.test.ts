import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mirrorCandidates } from './asset-mirrors'
import type { ExternalSkinCatalogPayload } from '../shared/types'

const PAYLOAD_PATH = path.resolve('skin-store', 'external-catalog.payload.json')

async function readPayload(): Promise<ExternalSkinCatalogPayload> {
  return JSON.parse(await readFile(PAYLOAD_PATH, 'utf8')) as ExternalSkinCatalogPayload
}

describe('mirrorCandidates', () => {
  it('leaves the first-party Gitee store on its own channel', () => {
    const candidates = mirrorCandidates('https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/assets/a.png', 1024)
    expect(candidates.map((candidate) => candidate.id)).toEqual(['origin'])
  })

  it('prefers accountable CDNs and keeps the authoritative host last for GitHub assets', () => {
    const candidates = mirrorCandidates('https://raw.githubusercontent.com/rose-pine/wallpapers/main/anime/eating-cake.jpg', 204_800)
    expect(candidates.map((candidate) => candidate.id)).toEqual(['statically', 'jsdelivr', 'gh-proxy', 'ghfast', 'origin'])
    expect(candidates[0]?.url).toBe('https://cdn.statically.io/gh/rose-pine/wallpapers/main/anime/eating-cake.jpg')
    expect(candidates[1]?.url).toBe('https://cdn.jsdelivr.net/gh/rose-pine/wallpapers@main/anime/eating-cake.jpg')
  })

  it('skips the size-limited CDNs for assets past their ceiling', () => {
    const candidates = mirrorCandidates('https://raw.githubusercontent.com/owner/repo/main/big.mp4', 40 * 1024 * 1024)
    expect(candidates.map((candidate) => candidate.id)).toEqual(['gh-proxy', 'ghfast', 'origin'])
  })

  it('rejects non-HTTPS and malformed addresses', () => {
    expect(mirrorCandidates('http://raw.githubusercontent.com/a/b/main/c.png')).toEqual([])
    expect(mirrorCandidates('not a url')).toEqual([])
  })
})

describe('external skin catalog payload', () => {
  it('pins a digest and byte count for every asset', async () => {
    const payload = await readPayload()
    expect(payload.items.length).toBeGreaterThan(0)
    for (const item of payload.items) {
      expect(item.media.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(item.media.size).toBeGreaterThan(0)
    }
  })

  it('serves every asset from the upstream repository it declares', async () => {
    const payload = await readPayload()
    for (const item of payload.items) {
      const url = new URL(item.media.url)
      expect(url.hostname).toBe('raw.githubusercontent.com')
      expect(url.pathname.startsWith(`/${item.origin.repo}/`)).toBe(true)
    }
  })

  it('never points an asset at the first-party store, which would make it redistribution', async () => {
    const payload = await readPayload()
    for (const item of payload.items) {
      expect(item.media.url).not.toContain('gitee.com')
      expect(item.thumbnailUrl).not.toContain('gitee.com')
    }
  })

  it('carries a rights notice for every source and item', async () => {
    const payload = await readPayload()
    for (const source of payload.sources) {
      expect(source.licenseStatus).toMatch(/^(redistributable|copyleft|undeclared)$/)
      expect(source.itemCount).toBeGreaterThan(0)
    }
    for (const item of payload.items) {
      expect(item.origin.notice.trim().length).toBeGreaterThan(0)
      expect(payload.sources.some((source) => source.repo === item.origin.repo)).toBe(true)
    }
  })

  it('states plainly when an upstream declares no license', async () => {
    const payload = await readPayload()
    for (const item of payload.items) {
      if (item.origin.licenseStatus !== 'undeclared') continue
      expect(item.origin.notice).toContain('没有 LICENSE')
    }
  })

  it('stays inside the store size limits', async () => {
    const payload = await readPayload()
    for (const item of payload.items) {
      const limit = item.media.mime.startsWith('video/') ? 80 * 1024 * 1024 : 25 * 1024 * 1024
      expect(item.media.size).toBeLessThanOrEqual(limit)
    }
  })

  it('keeps ids unique and slug-safe', async () => {
    const payload = await readPayload()
    const ids = payload.items.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,79}$/)
  })
})
