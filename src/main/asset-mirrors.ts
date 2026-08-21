/**
 * Download-channel fallback for store assets.
 *
 * Measured on 2026-08-21 from a mainland China network: direct
 * raw.githubusercontent.com range requests succeeded 4 of 8 times, while
 * cdn.statically.io, cdn.jsdelivr.net, gh-proxy.com and ghfast.top all
 * succeeded 8 of 8. Accountable CDNs are tried before volunteer proxies; the
 * authoritative host stays in the chain but is not first because of its
 * measured failure rate. Every candidate is still verified against the signed
 * SHA-256, so a hostile mirror cannot substitute content.
 */

const GITHUB_RAW_HOST = 'raw.githubusercontent.com'

/** Both CDNs reject files past roughly 20 MB, so large videos skip them. */
const CDN_SIZE_LIMIT = 20 * 1024 * 1024

export interface MirrorCandidate {
  id: string
  url: string
}

interface GithubRawTarget {
  owner: string
  repo: string
  ref: string
  filePath: string
}

function parseGithubRaw(url: URL): GithubRawTarget | undefined {
  const segments = url.pathname.replace(/^\//, '').split('/')
  if (segments.length < 4) return undefined
  const [owner, repo, ref, ...rest] = segments
  if (!owner || !repo || !ref || !rest.length) return undefined
  return { owner, repo, ref, filePath: rest.join('/') }
}

/**
 * Returns the ordered download channels for one asset URL. Non-GitHub hosts
 * such as the first-party Gitee store are returned untouched.
 */
export function mirrorCandidates(assetUrl: string, sizeBytes?: number): MirrorCandidate[] {
  let url: URL
  try {
    url = new URL(assetUrl)
  } catch {
    return []
  }
  if (url.protocol !== 'https:') return []
  const origin: MirrorCandidate = { id: 'origin', url: assetUrl }
  if (url.hostname !== GITHUB_RAW_HOST) return [origin]
  const target = parseGithubRaw(url)
  if (!target) return [origin]
  const { owner, repo, ref, filePath } = target
  const withinCdnLimit = sizeBytes === undefined || sizeBytes <= CDN_SIZE_LIMIT
  const candidates: MirrorCandidate[] = []
  if (withinCdnLimit) {
    candidates.push({ id: 'statically', url: `https://cdn.statically.io/gh/${owner}/${repo}/${ref}/${filePath}` })
    candidates.push({ id: 'jsdelivr', url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${filePath}` })
  }
  candidates.push({ id: 'gh-proxy', url: `https://gh-proxy.com/${assetUrl}` })
  candidates.push({ id: 'ghfast', url: `https://ghfast.top/${assetUrl}` })
  candidates.push(origin)
  return candidates
}
