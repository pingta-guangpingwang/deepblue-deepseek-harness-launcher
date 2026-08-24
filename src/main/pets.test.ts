import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { nextFavoritePetIds, verifyPetCatalog } from './pets'
import type { PetCatalogPayload, SignedPetCatalogManifest } from '../shared/types'

const payload: PetCatalogPayload = {
  schemaVersion: 1,
  generatedAt: '2026-08-15T16:00:00.000Z',
  pageSize: 20,
  items: []
}

describe('pet catalog signature verification', () => {
  it('accepts an unchanged Ed25519-signed payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const manifest: SignedPetCatalogManifest = {
      keyId: 'test',
      algorithm: 'ed25519',
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    }
    expect(verifyPetCatalog(manifest, publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
  })

  it('rejects changed content and incompatible pagination', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyPetCatalog({ keyId: 'test', algorithm: 'ed25519', payload: { ...payload, generatedAt: 'tampered' }, signature }, publicPem)).toBe(false)
    expect(verifyPetCatalog({ keyId: 'test', algorithm: 'ed25519', payload: { ...payload, pageSize: 40 as 20 }, signature }, publicPem)).toBe(false)
  })
})

describe('pet favorites', () => {
  it('adds newest first, removes on a second click and eliminates duplicates', () => {
    expect(nextFavoritePetIds(['px-0001', 'px-0001'], 'l2d-0001')).toEqual(['l2d-0001', 'px-0001'])
    expect(nextFavoritePetIds(['l2d-0001', 'px-0001'], 'l2d-0001')).toEqual(['px-0001'])
  })
})
