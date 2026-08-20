import { app } from 'electron'
import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SignedStoreTrustManifest, StoreTrustKind } from '../shared/types'

const MAX_TRUST_MANIFEST_BYTES = 64 * 1024
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

function canonicalUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('商店地址必须使用 HTTPS')
  url.hash = ''
  return url.toString()
}

export function storeTrustUrl(catalogUrl: string): string {
  const url = new URL(canonicalUrl(catalogUrl))
  if (!url.pathname.endsWith('/catalog.json')) throw new Error('固定商店目录必须以 /catalog.json 结尾')
  url.pathname = `${url.pathname.slice(0, -'catalog.json'.length)}trust.json`
  url.search = ''
  return url.toString()
}

export function verifyStoreTrustManifest(
  manifest: SignedStoreTrustManifest,
  rootPublicKey: string,
  store: StoreTrustKind,
  catalogUrl: string
): boolean {
  if (manifest.algorithm !== 'ed25519' || manifest.payload?.schemaVersion !== 1) return false
  if (manifest.payload.store !== store || manifest.payload.catalogUrl !== canonicalUrl(catalogUrl)) return false
  if (!Array.isArray(manifest.payload.keys) || manifest.payload.keys.length < 1 || manifest.payload.keys.length > 8) return false
  const ids = new Set<string>()
  for (const key of manifest.payload.keys) {
    if (!KEY_ID_PATTERN.test(key.keyId) || ids.has(key.keyId) || key.algorithm !== 'ed25519') return false
    if (!['active', 'retired'].includes(key.status) || typeof key.publicKeyPem !== 'string' || key.publicKeyPem.length > 1024) return false
    try {
      if (createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') return false
    } catch {
      return false
    }
    ids.add(key.keyId)
  }
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(manifest.payload), 'utf8'),
      rootPublicKey,
      Buffer.from(manifest.signature, 'base64')
    )
  } catch {
    return false
  }
}

export function trustedStoreKey(manifest: SignedStoreTrustManifest, catalogKeyId: string): string | undefined {
  return manifest.payload.keys.find(key => key.keyId === catalogKeyId && key.status === 'active')?.publicKeyPem
}

async function readRootPublicKey(): Promise<string | undefined> {
  const candidates = [
    path.join(process.resourcesPath, 'resources', 'update-public-key.pem'),
    path.join(app.getAppPath(), 'resources', 'update-public-key.pem'),
    path.resolve('resources', 'update-public-key.pem')
  ]
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch {
      // Try the next packaged or development path.
    }
  }
  return undefined
}

export async function fetchTrustedStoreKey(
  store: StoreTrustKind,
  catalogUrl: string,
  catalogKeyId: string
): Promise<string | undefined> {
  const rootPublicKey = await readRootPublicKey()
  if (!rootPublicKey) return undefined
  const response = await fetch(storeTrustUrl(catalogUrl), {
    signal: AbortSignal.timeout(8_000),
    headers: { 'User-Agent': 'DeepSeek-Harness-Launcher' }
  })
  if (!response.ok) throw new Error(`在线信任清单 HTTP ${response.status}`)
  const declaredBytes = Number(response.headers.get('content-length') || 0)
  if (declaredBytes > MAX_TRUST_MANIFEST_BYTES) throw new Error('在线信任清单过大')
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_TRUST_MANIFEST_BYTES) throw new Error('在线信任清单过大')
  const manifest = JSON.parse(body) as SignedStoreTrustManifest
  if (!verifyStoreTrustManifest(manifest, rootPublicKey, store, catalogUrl)) throw new Error('在线信任清单签名校验失败')
  return trustedStoreKey(manifest, catalogKeyId)
}
