import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const QUERIES = [
  'gif wallpaper in:name,description stars:>5',
  'animated wallpaper gif in:name,description stars:>3',
  'pixel art gif in:name,description stars:>10',
  'living wallpaper gif in:name,description stars:>3',
  'topic:gif-wallpaper',
  'topic:animated-gif',
  'topic:pixel-art-wallpaper',
  'lofi wallpaper in:name,description stars:>5'
]

const MEDIA_RE = /\.(gif|webp)$/i
const SKIP_RE = /(^|\/)(\.github|node_modules|thumb|thumbs|thumbnail|thumbnails|icons?|logos?|badges?)\//i
const MIN_BYTES = 120_000
const MAX_BYTES = 25 * 1024 * 1024
const PROBE_BYTES = 524_288

async function api(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'wp-scan-gif' }
    })
    if (res.ok) return res.json()
    if (res.status === 404 || res.status === 409) return undefined
    if (res.status === 403 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
      continue
    }
    return undefined
  }
  return undefined
}

async function head(url, bytes) {
  try {
    const res = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}`, 'user-agent': 'wp-scan-gif' } })
    if (!res.ok && res.status !== 206) return undefined
    const total = Number(res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') || 0)
    return { buf: Buffer.from(await res.arrayBuffer()), total }
  } catch {
    return undefined
  }
}

/**
 * Walks GIF blocks to count frames. Sub-blocks are length-prefixed so the skip
 * is exact; a partial buffer just stops the walk early and reports truncated.
 */
function gifInfo(buf) {
  if (buf.length < 13) return undefined
  const signature = buf.toString('latin1', 0, 6)
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  const packed = buf[10]
  let off = 13
  if (packed & 0x80) off += 3 * (1 << ((packed & 0x07) + 1))
  let frames = 0
  let loops
  const skipSubBlocks = () => {
    while (off < buf.length) {
      const size = buf[off]
      off += 1
      if (size === 0) return true
      off += size
    }
    return false
  }
  while (off < buf.length) {
    const marker = buf[off]
    if (marker === 0x3b) break
    if (marker === 0x21) {
      const label = buf[off + 1]
      off += 2
      if (label === 0xff && buf.toString('latin1', off + 1, off + 12) === 'NETSCAPE2.0') loops = true
      if (!skipSubBlocks()) return { width, height, frames, loops, truncated: true }
      continue
    }
    if (marker === 0x2c) {
      frames += 1
      if (off + 10 > buf.length) return { width, height, frames, loops, truncated: true }
      const localPacked = buf[off + 9]
      off += 10
      if (localPacked & 0x80) off += 3 * (1 << ((localPacked & 0x07) + 1))
      off += 1
      if (!skipSubBlocks()) return { width, height, frames, loops, truncated: true }
      if (frames >= 2) return { width, height, frames, loops, truncated: false }
      continue
    }
    break
  }
  return { width, height, frames, loops, truncated: false }
}

/** Reads the VP8X canvas size and ANIM flag, plus the ANMF frame marker. */
function webpInfo(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return undefined
  const fourcc = buf.toString('latin1', 12, 16)
  if (fourcc !== 'VP8X') {
    if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false }
    if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false }
    }
    return undefined
  }
  const flags = buf[20]
  const width = (buf.readUIntLE(24, 3) & 0xffffff) + 1
  const height = (buf.readUIntLE(27, 3) & 0xffffff) + 1
  const animated = Boolean(flags & 0x02) || buf.includes('ANMF', 0, 'latin1')
  return { width, height, animated }
}

function spread(list, n) {
  if (list.length <= n) return list
  const step = list.length / n
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)])
}

const seeds = new Set()
try {
  for (const repo of JSON.parse(readFileSync(new URL('./merged.json', import.meta.url), 'utf8'))) {
    if (repo.full) seeds.add(repo.full)
  }
} catch {
  /* merged.json is optional */
}

for (const query of QUERIES) {
  const page = await api(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100`)
  for (const item of page?.items || []) {
    if (!item.fork) seeds.add(item.full_name)
  }
  process.stderr.write(`query ${String(page?.items?.length ?? 0).padStart(3)} hits  ${query}\n`)
  await new Promise((r) => setTimeout(r, 2200))
}

const candidates = [...seeds]
process.stderr.write(`\n${candidates.length} candidate repos\n\n`)

const out = []
let index = 0

for (const full of candidates) {
  index += 1
  const tag = `[${String(index).padStart(3)}/${candidates.length}] ${full}`
  const meta = await api(`/repos/${full}`)
  if (!meta) {
    process.stderr.write(`${tag} — unavailable\n`)
    continue
  }
  const tree = await api(`/repos/${full}/git/trees/${meta.default_branch}?recursive=1`)
  if (!tree) {
    process.stderr.write(`${tag} — no tree\n`)
    continue
  }
  const files = (tree.tree || [])
    .filter((n) => n.type === 'blob' && MEDIA_RE.test(n.path) && !SKIP_RE.test(n.path))
    .filter((n) => (n.size || 0) > MIN_BYTES && (n.size || 0) <= MAX_BYTES)
    .sort((a, b) => a.path.localeCompare(b.path))
  if (!files.length) {
    process.stderr.write(`${tag} — no gif/webp candidates\n`)
    continue
  }
  const picks = []
  let checked = 0
  for (const cand of spread(files, 24)) {
    if (picks.length >= 6) break
    checked += 1
    const url = `https://raw.githubusercontent.com/${full}/${meta.default_branch}/${cand.path.split('/').map(encodeURIComponent).join('/')}`
    const probe = await head(url, PROBE_BYTES)
    if (!probe) continue
    const isGif = /\.gif$/i.test(cand.path)
    const info = isGif ? gifInfo(probe.buf) : webpInfo(probe.buf)
    if (!info || !info.width || !info.height) continue
    const animated = isGif ? (info.frames >= 2 || Boolean(info.loops)) : info.animated
    if (!animated) continue
    picks.push({
      path: cand.path,
      url,
      format: isGif ? 'gif' : 'webp',
      width: info.width,
      height: info.height,
      bytes: probe.total || cand.size,
      ...(isGif ? { frames: info.frames, looping: Boolean(info.loops), frameCountTruncated: Boolean(info.truncated) } : {})
    })
  }
  if (!picks.length) {
    process.stderr.write(`${tag} — ${files.length} files, ${checked} probed, none animated\n`)
    continue
  }
  const landscape = picks.filter((p) => p.width / p.height >= 1.4 && p.width >= 1024)
  out.push({
    full,
    stars: meta.stargazers_count,
    description: meta.description,
    license: meta.license?.spdx_id || meta.license?.name || 'NONE',
    branch: meta.default_branch,
    pushedAt: meta.pushed_at,
    candidateFiles: files.length,
    animatedFound: picks.length,
    landscapeCount: landscape.length,
    picks
  })
  const best = landscape[0] || picks[0]
  process.stderr.write(
    `${tag} — animated=${picks.length} landscape=${landscape.length} lic=${meta.license?.spdx_id || 'NONE'} best=${best.format} ${best.width}x${best.height} ${(best.bytes / 1024 / 1024).toFixed(1)}MB\n`
  )
}

out.sort((a, b) => (b.landscapeCount - a.landscapeCount) || (b.stars - a.stars))
writeFileSync(new URL('./gif-result.json', import.meta.url), JSON.stringify(out, null, 2))

const withLandscape = out.filter((r) => r.landscapeCount > 0)
process.stderr.write(`\n${out.length} repos with animated media, ${withLandscape.length} with landscape-usable frames\n\n`)
for (const r of out) {
  const best = r.picks.find((p) => p.width / p.height >= 1.4 && p.width >= 1024) || r.picks[0]
  process.stderr.write(
    `${String(r.stars).padStart(6)}  ${r.full.padEnd(44)} anim=${String(r.animatedFound).padStart(2)} land=${String(r.landscapeCount).padStart(2)} ${String(r.license).padEnd(12)} ${best.format} ${best.width}x${best.height} ${(best.bytes / 1024 / 1024).toFixed(1)}MB\n`
  )
}
