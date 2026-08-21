import { readFileSync, writeFileSync } from 'node:fs'

const merged = JSON.parse(readFileSync(new URL('./merged.json', import.meta.url), 'utf8'))

const ORDER = [
  'dharmx/walls',
  'D3Ext/aesthetic-wallpapers',
  'orangci/walls-catppuccin-mocha',
  'linuxdotexe/nordic-wallpapers',
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
  'makccr/wallpapers',
  'orangci/walls',
  'whoisYoges/lwalpapers',
  'JoydeepMallick/Wallpapers',
  'kitsunebishi/Wallpapers',
  'dxnst/nord-backgrounds',
  'diinki/wallpapers',
  'michaelScopic/Wallpapers',
  'fr0st-xyz/wallz',
  'pop-os/wallpapers',
  'dusklinux/images',
  'pollux78/linuxnext-wallpapers'
]

function tile(rawUrl) {
  const bare = rawUrl.replace(/^https:\/\//, '')
  return `https://wsrv.nl/?url=${encodeURIComponent(bare)}&w=560&h=315&fit=cover&output=webp&q=74`
}

async function check(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'wp-gen' } })
      if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
        return Number(res.headers.get('content-length') || 0)
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return 0
}

const byName = new Map(merged.map((r) => [r.full, r]))
const rows = []
let broken = 0

for (const full of ORDER) {
  const repo = byName.get(full)
  if (!repo || !repo.picks?.length) {
    process.stderr.write(`MISSING ${full}\n`)
    continue
  }
  const shots = []
  for (const p of repo.picks) {
    const t = tile(p.url)
    const bytes = await check(t)
    if (!bytes) {
      broken += 1
      process.stderr.write(`  broken tile ${full} ${p.path}\n`)
      continue
    }
    shots.push({ t, raw: p.url, w: p.width, h: p.height, mb: +(p.bytes / 1048576).toFixed(1) })
    if (shots.length >= 4) break
  }
  if (!shots.length) {
    process.stderr.write(`NO TILES ${full}\n`)
    continue
  }
  rows.push({
    full,
    stars: repo.stars,
    license: repo.license,
    images: repo.imageCount,
    gb: +(repo.repoSizeKb / 1048576).toFixed(2),
    pushed: repo.pushedAt.slice(0, 10),
    branch: repo.branch,
    desc: repo.description || '',
    shots
  })
  process.stderr.write(`ok ${full.padEnd(48)} tiles=${shots.length}\n`)
}

writeFileSync(new URL('./gallery.json', import.meta.url), JSON.stringify(rows))
process.stderr.write(`\n${rows.length} repos, ${rows.reduce((n, r) => n + r.shots.length, 0)} tiles, ${broken} broken\n`)
