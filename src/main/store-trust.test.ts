import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { storeTrustUrl, trustedStoreKey, verifyStoreTrustManifest } from './store-trust'
import type { SignedStoreTrustManifest, StoreTrustPayload } from '../shared/types'

const catalogUrl = 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/catalog.json'

describe('version-independent store trust', () => {
  it('derives one fixed trust URL next to the fixed catalog URL', () => {
    expect(storeTrustUrl(catalogUrl)).toBe('https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/trust.json')
  })

  it('accepts a root-signed key list and resolves the active catalog key', () => {
    const root = generateKeyPairSync('ed25519')
    const store = generateKeyPairSync('ed25519')
    const publicKeyPem = store.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const payload: StoreTrustPayload = {
      schemaVersion: 1,
      generatedAt: '2026-08-17T12:00:00.000Z',
      store: 'skin',
      catalogUrl,
      keys: [{ keyId: 'skin-production-1', algorithm: 'ed25519', publicKeyPem, status: 'active' }]
    }
    const manifest: SignedStoreTrustManifest = {
      keyId: 'production-1',
      algorithm: 'ed25519',
      payload,
      signature: sign(null, Buffer.from(JSON.stringify(payload)), root.privateKey).toString('base64')
    }
    const rootPem = root.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyStoreTrustManifest(manifest, rootPem, 'skin', catalogUrl)).toBe(true)
    expect(trustedStoreKey(manifest, 'skin-production-1')).toBe(publicKeyPem)
  })

  it('rejects a substituted catalog URL, store type, or tampered key list', () => {
    const root = generateKeyPairSync('ed25519')
    const store = generateKeyPairSync('ed25519')
    const payload: StoreTrustPayload = {
      schemaVersion: 1,
      generatedAt: '2026-08-17T12:00:00.000Z',
      store: 'skin',
      catalogUrl,
      keys: [{
        keyId: 'skin-production-1',
        algorithm: 'ed25519',
        publicKeyPem: store.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        status: 'active'
      }]
    }
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), root.privateKey).toString('base64')
    const manifest: SignedStoreTrustManifest = { keyId: 'production-1', algorithm: 'ed25519', payload, signature }
    const rootPem = root.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyStoreTrustManifest(manifest, rootPem, 'pet', catalogUrl)).toBe(false)
    expect(verifyStoreTrustManifest(manifest, rootPem, 'skin', 'https://example.com/catalog.json')).toBe(false)
    expect(verifyStoreTrustManifest({ ...manifest, payload: { ...payload, generatedAt: 'tampered' } }, rootPem, 'skin', catalogUrl)).toBe(false)
  })
})
