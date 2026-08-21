import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const images = JSON.parse(readFileSync(new URL('./merged.json', import.meta.url), 'utf8'))
const videos = JSON.parse(readFileSync(new URL('./video-result.json', import.meta.url), 'utf8'))

const REDISTRIBUTABLE = new Set(['MIT', 'CC0-1.0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Unlicense', 'CC-BY-4.0'])
const COPYLEFT = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-3.0', 'CC-BY-SA-4.0', 'MPL-2.0'])

/** Filename patterns that betray reposted third-party art rather than original work. */
const THIRD_PARTY_PATH = [
  { re: /wallhaven[-_]/i, label: 'wallhaven 转载' },
  { re: /unsplash/i, label: 'Unsplash 图源' },
  { re: /pexels/i, label: 'Pexels 图源' },
  { re: /aenami|artstation|deviantart/i, label: '商业画师作品' },
  { re: /^\d{6,9}_p\d+\./i, label: 'Pixiv 作品编号命名' },
  { re: /drawn_by_/i, label: '同人图站命名' },
  { re: /genshin|honkai|zenless|arknights|hoyo/i, label: '第三方游戏 IP' }
]

/** README phrases that signal the author does not hold rights to the assets. */
const README_FLAGS = [
  { re: /i do not own|i don'?t own|not mine|do not claim/i, label: '作者声明不拥有版权' },
  { re: /credit(s)? (to|go)|all credit/i, label: 'README 要求署名他人' },
  { re: /found (on|from) (the )?(internet|web|reddit)/i, label: '来源为网络收集' },
  { re: /dmca|takedown|remove your/i, label: '提到侵权下架流程' },
  { re: /wallhaven|pixiv|unsplash|pexels|artstation/i, label: 'README 提到第三方图源' },
  { re: /scrap(e|ed|er)|download(ed)? from/i, label: '抓取或下载自他处' }
]

async function api(path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'wp-curate' }
    })
    if (res.ok) return res.json()
    if (res.status === 404) return undefined
    if (res.status === 403 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
      continue
    }
    return undefined
  }
  return undefined
}

async function readme(full) {
  const data = await api(`/repos/${full}/readme`)
  if (!data?.content) return ''
  try {
    return Buffer.from(data.content, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function licenseClass(license) {
  if (REDISTRIBUTABLE.has(license)) return 'redistributable'
  if (COPYLEFT.has(license)) return 'copyleft'
  if (license === 'NONE') return 'none'
  return 'unclear'
}

const imageCandidates = images
  .filter((r) => r.picks?.length)
  .map((r) => ({
    kind: 'image',
    full: r.full,
    stars: r.stars,
    license: r.license,
    assetCount: r.imageCount,
    branch: r.branch,
    pushedAt: r.pushedAt?.slice(0, 10),
    paths: r.picks.map((p) => p.path)
  }))

const videoCandidates = videos
  .filter((r) => r.picks?.length)
  .map((r) => {
    const usable = r.picks.filter(
      (p) => p.width >= 1280 && p.width / p.height >= 1.5 && !p.hasAudio && (p.durationSec ?? 999) <= 60
    )
    return {
      kind: 'video',
      full: r.full,
      stars: r.stars,
      license: r.license,
      assetCount: r.videoCount,
      branch: r.branch,
      pushedAt: r.pushedAt?.slice(0, 10),
      usablePicks: usable.length,
      probedPicks: r.picks.length,
      bestShape: r.picks[0] ? `${r.picks[0].width}x${r.picks[0].height} ${r.picks[0].durationSec}s audio=${r.picks[0].hasAudio ? 'yes' : 'no'}` : '',
      paths: r.picks.map((p) => p.path)
    }
  })
  .filter((r) => r.usablePicks > 0)

const all = [...imageCandidates, ...videoCandidates]
const out = []

for (const cand of all) {
  const pathFlags = []
  for (const rule of THIRD_PARTY_PATH) {
    if (cand.paths.some((p) => rule.re.test(p))) pathFlags.push(rule.label)
  }
  const text = await readme(cand.full)
  const readmeFlags = []
  for (const rule of README_FLAGS) {
    if (rule.re.test(text)) readmeFlags.push(rule.label)
  }
  const cls = licenseClass(cand.license)
  const flags = [...new Set([...pathFlags, ...readmeFlags])]
  let verdict
  if (cls === 'redistributable' && !flags.length) verdict = 'default-source'
  else if (cls === 'redistributable') verdict = 'needs-review'
  else if (cls === 'copyleft' && !flags.length) verdict = 'copyleft-optin'
  else if (cls === 'none' && !flags.length) verdict = 'link-only'
  else verdict = 'exclude'
  out.push({ ...cand, licenseClass: cls, flags, verdict, readmeBytes: text.length })
  process.stderr.write(
    `${cand.kind.padEnd(6)} ${cand.full.padEnd(46)} ${String(cand.license).padEnd(13)} ${verdict.padEnd(15)} ${flags.join(' / ') || '-'}\n`
  )
  await new Promise((r) => setTimeout(r, 250))
}

writeFileSync(new URL('./curate-result.json', import.meta.url), JSON.stringify(out, null, 2))

const groups = ['default-source', 'copyleft-optin', 'link-only', 'needs-review', 'exclude']
process.stderr.write('\n')
for (const g of groups) {
  const rows = out.filter((r) => r.verdict === g)
  const assets = rows.reduce((sum, r) => sum + (r.kind === 'image' ? r.assetCount : r.usablePicks), 0)
  process.stderr.write(`${g.padEnd(16)} ${String(rows.length).padStart(3)} 仓库   ${String(assets).padStart(6)} 个素材(图片按全量计,视频按合格抽样计)\n`)
}
process.stderr.write('\n')
for (const g of groups) {
  const rows = out.filter((r) => r.verdict === g)
  if (!rows.length) continue
  process.stderr.write(`\n== ${g} ==\n`)
  for (const r of rows.sort((a, b) => b.stars - a.stars)) {
    const size = r.kind === 'image' ? `${r.assetCount} 图` : `${r.usablePicks}/${r.probedPicks} 合格视频  ${r.bestShape}`
    process.stderr.write(`  ${String(r.stars).padStart(5)}  ${r.full.padEnd(46)} ${String(r.license).padEnd(13)} ${size}${r.flags.length ? `  [${r.flags.join(' / ')}]` : ''}\n`)
  }
}
