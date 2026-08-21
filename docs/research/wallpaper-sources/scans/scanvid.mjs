import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const QUERIES = [
  'live wallpaper in:name,description stars:>30',
  'video wallpaper in:name,description stars:>15',
  'animated wallpaper in:name,description stars:>15',
  'dynamic wallpaper in:name,description stars:>15',
  'motion background in:name,description stars:>15',
  'looping background video in:name,description stars:>5',
  'wallpaper engine in:name,description stars:>40',
  'topic:live-wallpaper',
  'topic:video-wallpaper',
  'topic:animated-wallpaper',
  'topic:dynamic-wallpaper',
  'topic:wallpaper-engine'
]

const SEED = [
  'saint-13/Linux_Dynamic_Wallpapers',
  'manishprivet/dynamic-gnome-wallpapers',
  'adi1090x/dynamic-wallpaper',
  'JaKooLit/Wallpaper-Bank'
]

const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv)$/i
const MP4_RE = /\.(mp4|m4v|mov)$/i
const SKIP_RE = /(^|\/)(\.github|node_modules|thumb|thumbs|thumbnail|thumbnails|icons?|logos?)\//i
const MIN_VIDEO_BYTES = 200_000
const SKIN_STORE_LIMIT = 80 * 1024 * 1024

async function api(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'wp-scan-video' }
    })
    if (res.ok) return res.json()
    if (res.status === 403 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
      continue
    }
    throw new Error(`${res.status} ${path}`)
  }
  throw new Error(`rate limited ${path}`)
}

async function range(url, from, to) {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}`, 'user-agent': 'wp-scan-video' } })
  if (!res.ok && res.status !== 206) return undefined
  const total = Number(res.headers.get('content-range')?.split('/')[1] || res.headers.get('content-length') || 0)
  return { buf: Buffer.from(await res.arrayBuffer()), total }
}

/** Iterates ISO-BMFF boxes in [start, end), handling 64-bit and to-EOF sizes. */
function walkBoxes(buf, start, end, visit) {
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    let header = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = Number(buf.readBigUInt64BE(off + 8))
      header = 16
    } else if (size === 0) {
      size = end - off
    }
    if (size < header) return
    visit(type, off + header, Math.min(off + size, end), off + size <= end)
    off += size
  }
}

function parseMoov(buf, start, end) {
  const info = { tracks: [] }
  walkBoxes(buf, start, end, (type, s, e) => {
    if (type === 'mvhd' && e - s >= 20) {
      const version = buf[s]
      const timescale = version === 1 ? buf.readUInt32BE(s + 20) : buf.readUInt32BE(s + 12)
      const duration = version === 1 ? Number(buf.readBigUInt64BE(s + 24)) : buf.readUInt32BE(s + 16)
      if (timescale > 0) info.durationSec = Number((duration / timescale).toFixed(2))
    } else if (type === 'trak') {
      const track = {}
      walkBoxes(buf, s, e, (t2, s2, e2) => {
        // tkhd always ends with 16.16 fixed-point width and height.
        if (t2 === 'tkhd' && e2 - s2 >= 40) {
          track.width = Math.round(buf.readUInt32BE(e2 - 8) / 65536)
          track.height = Math.round(buf.readUInt32BE(e2 - 4) / 65536)
        } else if (t2 === 'mdia') {
          walkBoxes(buf, s2, e2, (t3, s3, e3) => {
            if (t3 === 'hdlr' && e3 - s3 >= 12) track.kind = buf.toString('latin1', s3 + 8, s3 + 12)
          })
        }
      })
      info.tracks.push(track)
    }
  })
  return info
}

async function probeMp4(url) {
  const head = await range(url, 0, 393_215)
  if (!head) return undefined
  let moov
  let brand
  walkBoxes(head.buf, 0, head.buf.length, (type, s, e, complete) => {
    if (type === 'ftyp' && e - s >= 4) brand = head.buf.toString('latin1', s, s + 4).trim()
    if (type === 'moov' && complete) moov = parseMoov(head.buf, s, e)
  })
  if (!moov && head.total > head.buf.length) {
    const tailFrom = Math.max(0, head.total - 786_432)
    const tail = await range(url, tailFrom, head.total - 1)
    if (tail) {
      const idx = tail.buf.indexOf('moov', 0, 'latin1')
      if (idx > 0) moov = parseMoov(tail.buf, idx + 4, tail.buf.length)
    }
  }
  if (!moov) return { bytes: head.total, brand, parsed: false }
  const video = moov.tracks.find((t) => t.kind === 'vide' && t.width > 0)
  return {
    bytes: head.total,
    brand,
    parsed: true,
    durationSec: moov.durationSec,
    width: video?.width,
    height: video?.height,
    hasAudio: moov.tracks.some((t) => t.kind === 'soun')
  }
}

function spread(list, n) {
  if (list.length <= n) return list
  const step = list.length / n
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)])
}

async function discover() {
  const names = new Set(SEED)
  for (const q of QUERIES) {
    try {
      const page = await api(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100`)
      for (const item of page.items || []) {
        if (!item.fork) names.add(item.full_name)
      }
      process.stderr.write(`query ${String(page.items?.length ?? 0).padStart(3)} hits  ${q}\n`)
    } catch (error) {
      process.stderr.write(`query FAILED ${q} :: ${error}\n`)
    }
    await new Promise((r) => setTimeout(r, 2200))
  }
  return [...names]
}

const candidates = await discover()
process.stderr.write(`\n${candidates.length} candidate repos\n\n`)

const out = []
let index = 0

for (const full of candidates) {
  index += 1
  const tag = `[${String(index).padStart(3)}/${candidates.length}] ${full}`
  try {
    const meta = await api(`/repos/${full}`)
    const tree = await api(`/repos/${full}/git/trees/${meta.default_branch}?recursive=1`)
    const videos = (tree.tree || [])
      .filter((n) => n.type === 'blob' && VIDEO_RE.test(n.path) && !SKIP_RE.test(n.path) && (n.size || 0) > MIN_VIDEO_BYTES)
      .sort((a, b) => a.path.localeCompare(b.path))
    if (!videos.length) {
      process.stderr.write(`${tag} — no video assets\n`)
      continue
    }
    const withinLimit = videos.filter((n) => n.size <= SKIN_STORE_LIMIT)
    const picks = []
    for (const cand of spread(videos.filter((n) => MP4_RE.test(n.path) && n.size <= SKIN_STORE_LIMIT), 10)) {
      if (picks.length >= 4) break
      const url = `https://raw.githubusercontent.com/${full}/${meta.default_branch}/${cand.path.split('/').map(encodeURIComponent).join('/')}`
      let probed
      try {
        probed = await probeMp4(url)
      } catch {
        probed = undefined
      }
      if (!probed?.parsed || !probed.width) continue
      picks.push({
        path: cand.path,
        url,
        width: probed.width,
        height: probed.height,
        durationSec: probed.durationSec,
        hasAudio: probed.hasAudio,
        brand: probed.brand,
        bytes: probed.bytes || cand.size
      })
    }
    out.push({
      full,
      stars: meta.stargazers_count,
      description: meta.description,
      license: meta.license?.spdx_id || meta.license?.name || 'NONE',
      repoSizeKb: meta.size,
      pushedAt: meta.pushed_at,
      branch: meta.default_branch,
      videoCount: videos.length,
      videoBytes: videos.reduce((sum, n) => sum + (n.size || 0), 0),
      withinLimitCount: withinLimit.length,
      mp4Count: videos.filter((n) => MP4_RE.test(n.path)).length,
      webmCount: videos.filter((n) => /\.webm$/i.test(n.path)).length,
      truncated: Boolean(tree.truncated),
      picks
    })
    process.stderr.write(
      `${tag} — videos=${videos.length} within80MiB=${withinLimit.length} probed=${picks.length} lic=${meta.license?.spdx_id || 'NONE'}\n`
    )
  } catch (error) {
    process.stderr.write(`${tag} — ERROR ${error}\n`)
  }
}

out.sort((a, b) => (b.stars || 0) - (a.stars || 0))
writeFileSync(new URL('./video-result.json', import.meta.url), JSON.stringify(out, null, 2))

const usable = out.filter((r) => r.picks.length > 0)
process.stderr.write(`\n${out.length} repos with video assets, ${usable.length} with a probed playable mp4\n\n`)
for (const r of out) {
  const best = r.picks[0]
  const shape = best ? `${best.width}x${best.height} ${best.durationSec}s audio=${best.hasAudio ? 'yes' : 'no'}` : 'no probe'
  process.stderr.write(
    `${String(r.stars).padStart(6)}  ${r.full.padEnd(44)} vid=${String(r.videoCount).padStart(4)} ok=${String(r.withinLimitCount).padStart(4)} ${String(r.license).padEnd(12)} ${shape}\n`
  )
}
