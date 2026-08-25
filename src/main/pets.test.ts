import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { nextFavoritePetIds, sortPetCatalogItems, verifyPetCatalog } from './pets'
import type { PetCatalogItem, PetCatalogPayload, SignedPetCatalogManifest } from '../shared/types'

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
    expect(nextFavoritePetIds(['px-0001', 'px-0001'], 'pet-0001')).toEqual(['pet-0001', 'px-0001'])
    expect(nextFavoritePetIds(['pet-0001', 'px-0001'], 'pet-0001')).toEqual(['px-0001'])
  })
})

describe('pet catalog ordering', () => {
  const pet = (id: string, catalogSource: PetCatalogItem['catalogSource'], featured = false): PetCatalogItem => ({
    id,
    name: id,
    description: id,
    mediaKind: 'static',
    species: 'other',
    styles: ['pixel'],
    tags: [],
    featured,
    contentRating: 'everyone',
    thumbnail: { url: 'https://example.test/thumb.webp', sha256: '0'.repeat(64), size: 1, mime: 'image/webp' },
    media: { url: 'https://example.test/pet.webp', sha256: '1'.repeat(64), size: 1, mime: 'image/webp' },
    license: { name: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', author: 'test', sourceUrl: 'https://example.test/source' },
    behavior: { widthPx: 160, idleMotion: 'none', clickMotion: 'heart', speechLines: [] },
    catalogSource
  })

  it('puts pixel sprites before original and local pets by default', () => {
    const sorted = sortPetCatalogItems([
      pet('local', 'custom', true),
      pet('original', 'official', true),
      pet('pixel-normal', 'pixel'),
      pet('pixel-featured', 'pixel', true)
    ])
    expect(sorted.map(item => item.id)).toEqual(['pixel-featured', 'pixel-normal', 'original', 'local'])
  })
})
