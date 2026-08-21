import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const REPOS = [
  'dharmx/walls',
  'D3Ext/aesthetic-wallpapers',
  'orangci/walls-catppuccin-mocha',
  'linuxdotexe/nordic-wallpapers',
  'SniperGER/iOS-Wallpapers',
  'SleepyCatHey/CozyPixels',
  'saint-13/Linux_Dynamic_Wallpapers',
  'AngelJumbo/gruvbox-wallpapers',
  'JaKooLit/Wallpaper-Bank',
  'mylinuxforwork/wallpaper',
  'FrenzyExists/wallpapers',
  'vyrx-dev/Wallpapers',
  'DenverCoder1/minimalistic-wallpaper-collection',
  'elementary/wallpapers',
  'rose-pine/wallpapers',
  'manishprivet/dynamic-gnome-wallpapers',
  'roigoatzzz/Wallsync',
  'makccr/wallpapers',
  'orangci/walls',
  'whoisYoges/lwalpapers',
  'HyDE-Project/hyde-gallery',
  'dxnst/nord-backgrounds',
  'diinki/wallpapers',
  'pop-os/wallpapers',
  'fr0st-xyz/wallz'
]

const IMG_RE = /\.(png|jpe?g|webp)$/i
const SKIP_RE = /(^|\/)(\.github|preview|previews|thumb|thumbs|thumbnail|thumbnails|icons?|logos?|screenshots?)\//i

async function api(path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'wp-scan' }
    })
    if (res.ok) return res.json()
    if (res.status === 403 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
      continue
    }
    throw new Error(`${res.status} ${path}`)
  }
  throw new Error(`rate limited ${path}`)
}

function pngSize(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = b[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = b.readUInt16BE(i + 2)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return undefined
}

function webpSize(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const fourcc = b.toString('ascii', 12, 16)
  if (fourcc === 'VP8X') return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 }
  if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-131071', 'user-agent': 'wp-scan' } })
    if (!res.ok && res.status !== 206) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    const size = pngSize(buf) || jpegSize(buf) || webpSize(buf)
    if (!size || !size.width || !size.height) return undefined
    const total = Number(res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') || 0)
    return { ...size, bytes: total }
  } catch {
    return undefined
  }
}

function spread(list, n) {
  if (list.length <= n) return list
  const step = list.length / n
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)])
}

const out = []

for (const full of REPOS) {
  process.stderr.write(`scan ${full}\n`)
  try {
    const meta = await api(`/repos/${full}`)
    const tree = await api(`/repos/${full}/git/trees/${meta.default_branch}?recursive=1`)
    const files = (tree.tree || [])
      .filter((n) => n.type === 'blob' && IMG_RE.test(n.path) && !SKIP_RE.test(n.path) && (n.size || 0) > 40000)
      .sort((a, b) => a.path.localeCompare(b.path))
    const picks = []
    for (const cand of spread(files, 26)) {
      if (picks.length >= 5) break
      const url = `https://raw.githubusercontent.com/${full}/${meta.default_branch}/${cand.path.split('/').map(encodeURIComponent).join('/')}`
      const dim = await probe(url)
      if (!dim) continue
      if (dim.width / dim.height < 1.4) continue
      picks.push({ path: cand.path, url, width: dim.width, height: dim.height, bytes: dim.bytes || cand.size })
    }
    out.push({
      full,
      stars: meta.stargazers_count,
      description: meta.description,
      license: meta.license?.spdx_id || meta.license?.name || 'NONE',
      repoSizeKb: meta.size,
      pushedAt: meta.pushed_at,
      branch: meta.default_branch,
      imageCount: files.length,
      truncated: Boolean(tree.truncated),
      picks
    })
  } catch (error) {
    out.push({ full, error: String(error) })
  }
}

out.sort((a, b) => (b.stars || 0) - (a.stars || 0))
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 2))
process.stderr.write(`\nwrote ${out.length} repos\n`)
for (const r of out) process.stderr.write(`${String(r.stars).padStart(6)}  ${r.full.padEnd(48)} imgs=${r.imageCount ?? '-'} landscape=${r.picks?.length ?? 0} lic=${r.license ?? '-'}\n`)
