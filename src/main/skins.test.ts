import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { isSkinResponseTypeCompatible, nextFavoriteSkinIds, verifySkinCatalog } from './skins'
import type { SignedSkinCatalogManifest, SkinCatalogPayload } from '../shared/types'

const payload: SkinCatalogPayload = {
  schemaVersion: 1,
  generatedAt: '2026-08-15T14:30:00.000Z',
  pageSize: 20,
  items: []
}

describe('skin catalog signature verification', () => {
  it('accepts an unchanged Ed25519-signed skin payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const manifest: SignedSkinCatalogManifest = {
      keyId: 'test',
      algorithm: 'ed25519',
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    }
    expect(verifySkinCatalog(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
  })

  it('rejects a changed payload and a non-20 page size', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    expect(verifySkinCatalog({ keyId: 'test', algorithm: 'ed25519', payload: { ...payload, pageSize: 40 as 20 }, signature }, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
    expect(verifySkinCatalog({ keyId: 'test', algorithm: 'ed25519', payload: { ...payload, generatedAt: 'tampered' }, signature }, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
  })
})

describe('skin favorites', () => {
  it('adds a favorite to the front and removes it on the next toggle', () => {
    expect(nextFavoriteSkinIds(['skin-b', 'skin-b'], 'skin-a')).toEqual(['skin-a', 'skin-b'])
    expect(nextFavoriteSkinIds(['skin-a', 'skin-b'], 'skin-a')).toEqual(['skin-b'])
  })
})

describe('skin response media compatibility', () => {
  it('accepts trusted image transcoding while rejecting cross-category content', () => {
    expect(isSkinResponseTypeCompatible('image/jpeg', 'image/webp')).toBe(true)
    expect(isSkinResponseTypeCompatible('video/mp4', 'video/webm')).toBe(true)
    expect(isSkinResponseTypeCompatible('video/mp4', 'text/html')).toBe(false)
    expect(isSkinResponseTypeCompatible('image/png', 'video/mp4')).toBe(false)
  })

  it('accepts exact, absent and generic binary response types', () => {
    expect(isSkinResponseTypeCompatible('image/png', 'image/png')).toBe(true)
    expect(isSkinResponseTypeCompatible('image/png', 'application/octet-stream')).toBe(true)
    expect(isSkinResponseTypeCompatible('image/png')).toBe(true)
  })
})
