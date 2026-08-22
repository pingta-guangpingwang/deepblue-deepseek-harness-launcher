import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((entry, index, values) => {
  if (!entry.startsWith('--')) return [entry, true]
  const key = entry.slice(2)
  const next = values[index + 1]
  return [key, next && !next.startsWith('--') ? next : true]
}))

const inputPath = path.resolve(String(args.input || 'skin-store/catalog.payload.json'))
const outputPath = path.resolve(String(args.output || inputPath))
const reportPath = args.report ? path.resolve(String(args.report)) : undefined

const genericNames = new Set([
  'background', 'wallpaper', 'wallpapers', 'live', 'video', 'image', 'images',
  'out', 'output', 'p0', 'pic', 'picture', 'desktop', 'untitled', 'default',
  'new', 'final', 'test', 'sample', 'screenshot', 'download', 'img', 'wall', 'wp'
])

function normalizedName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function isLowQualityName(item) {
  if (!item.sourceKey) return false
  const name = normalizedName(item.name)
  return !name || genericNames.has(name) || /^\d+$/.test(name) || /^p\d{1,3}$/.test(name) || /^\d{1,3}\.?\s*animated$/.test(name)
}

function qualityScore(item) {
  const name = normalizedName(item.name)
  const descriptiveName = name.length >= 7 ? 260 : name.length >= 4 ? 120 : 0
  const chineseName = /[\u3400-\u9fff]/.test(item.name) ? 320 : 0
  const media = item.mediaKind === 'video' ? 2600 : item.mediaKind === 'animated-image' ? 1900 : 700
  const official = String(item.id).startsWith('sd2-') ? 5200 : 0
  const newArrival = item.sourceKey ? 480 : 0
  const originalFeatured = item.featured ? 1500 : 0
  const richMetadata = Math.min(240, String(item.description || '').length * 3) + Math.min(120, (item.tags?.length || 0) * 20)
  return official + media + newArrival + originalFeatured + chineseName + descriptiveName + richMetadata
}

function betterOf(left, right) {
  const scoreDelta = qualityScore(right) - qualityScore(left)
  if (scoreDelta !== 0) return scoreDelta > 0 ? right : left
  return String(right.id).localeCompare(String(left.id), 'zh-CN') < 0 ? right : left
}

const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const removed = { alternateVariants: [], lowQualityNames: [], duplicateMedia: [], duplicateThumbnails: [] }
const candidates = payload.items.filter(item => {
  if (String(item.id).endsWith('-motion-alt')) {
    removed.alternateVariants.push({ id: item.id, name: item.name })
    return false
  }
  if (isLowQualityName(item)) {
    removed.lowQualityNames.push({ id: item.id, name: item.name })
    return false
  }
  return true
})

function dedupe(items, keyOf, reportKey) {
  const selected = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const existing = selected.get(key)
    if (!existing) {
      selected.set(key, item)
      continue
    }
    const winner = betterOf(existing, item)
    const loser = winner === existing ? item : existing
    removed[reportKey].push({ id: loser.id, name: loser.name, kept: winner.id })
    selected.set(key, winner)
  }
  return [...selected.values()]
}

const mediaDeduped = dedupe(candidates, item => item.media.sha256.toLowerCase(), 'duplicateMedia')
const thumbnailDeduped = dedupe(mediaDeduped, item => item.thumbnail.sha256.toLowerCase(), 'duplicateThumbnails')
const ranked = thumbnailDeduped
  .sort((left, right) => qualityScore(right) - qualityScore(left) || String(left.id).localeCompare(String(right.id), 'zh-CN'))
  .map((item, index) => ({ ...item, featured: index < 18 }))

const result = {
  ...payload,
  generatedAt: new Date().toISOString(),
  items: ranked
}
const report = {
  input: payload.items.length,
  output: ranked.length,
  removedCount: payload.items.length - ranked.length,
  recommendedCount: ranked.filter(item => item.featured).length,
  removed,
  topRecommendations: ranked.slice(0, 18).map(item => ({ id: item.id, name: item.name, mediaKind: item.mediaKind }))
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
