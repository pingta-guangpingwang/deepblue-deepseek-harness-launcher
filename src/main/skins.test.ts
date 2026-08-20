import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifySkinCatalog } from './skins'
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
