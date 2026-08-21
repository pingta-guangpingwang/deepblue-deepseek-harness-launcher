import { writeFileSync } from 'node:fs'

const RANGE_BYTES = 524_288
const ATTEMPTS = 2
const TIMEOUT_MS = 20_000

/** Real assets from permissively licensed repos in the image scan, spread across sizes. */
const SAMPLES = [
  { full: 'D3Ext/aesthetic-wallpapers', branch: 'main', path: 'images/anime-chick.jpg', mb: 0.2 },
  { full: 'linuxdotexe/nordic-wallpapers', branch: 'master', path: 'dynamic-wallpapers/cyberpunk-01/ign_cyberpunk-01-4.jpg', mb: 0.9 },
  { full: 'SleepyCatHey/CozyPixels', branch: 'main', path: 'Catppuccin/Animals%20%26%20Creatures/kaiju.png', mb: 4.2 },
  { full: 'rose-pine/wallpapers', branch: 'main', path: 'anime/bocchi-studio.jpg', mb: 2.1 }
]

const TARGETS = [
  { id: 'raw.githubusercontent', build: (s) => `https://raw.githubusercontent.com/${s.full}/${s.branch}/${s.path}` },
  { id: 'jsdelivr', build: (s) => `https://cdn.jsdelivr.net/gh/${s.full}@${s.branch}/${s.path}` },
  { id: 'statically', build: (s) => `https://cdn.statically.io/gh/${s.full}/${s.branch}/${s.path}` },
  { id: 'gitmirror', build: (s) => `https://raw.gitmirror.com/${s.full}/${s.branch}/${s.path}` },
  { id: 'ghfast', build: (s) => `https://ghfast.top/https://raw.githubusercontent.com/${s.full}/${s.branch}/${s.path}` },
  { id: 'gh-proxy', build: (s) => `https://gh-proxy.com/https://raw.githubusercontent.com/${s.full}/${s.branch}/${s.path}` }
]

/** Baseline: the store the launcher already ships with, so results have a reference point. */
const GITEE_BASELINE = {
  id: 'gitee (现有皮肤商店)',
  url: 'https://gitee.com/wanggp123/deepseek-harness-skins/raw/master/thumbnails/sd2-aurora-library-motion.webp'
}

async function timedGet(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = performance.now()
  let firstByteAt
  try {
    const res = await fetch(url, {
      headers: { range: `bytes=0-${RANGE_BYTES - 1}`, 'user-agent': 'mirror-probe' },
      signal: controller.signal,
      redirect: 'follow'
    })
    firstByteAt = performance.now()
    if (!res.ok && res.status !== 206) {
      return { ok: false, status: res.status, ttfbMs: Math.round(firstByteAt - started) }
    }
    const contentType = res.headers.get('content-type') || ''
    let bytes = 0
    for await (const chunk of res.body) bytes += chunk.length
    const totalMs = performance.now() - started
    return {
      ok: bytes > 0,
      status: res.status,
      ttfbMs: Math.round(firstByteAt - started),
      totalMs: Math.round(totalMs),
      bytes,
      kbps: Math.round(bytes / 1024 / (totalMs / 1000)),
      contentType,
      ranged: res.status === 206
    }
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : String(error.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

function median(values) {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

const results = []

for (const target of TARGETS) {
  const runs = []
  for (const sample of SAMPLES) {
    const url = target.build(sample)
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const run = await timedGet(url)
      runs.push({ sample: `${sample.full}/${sample.path}`, attempt, ...run })
      const verdict = run.ok
        ? `ok ${String(run.totalMs).padStart(6)}ms ttfb=${String(run.ttfbMs).padStart(5)}ms ${String(run.kbps).padStart(6)} KB/s ${run.ranged ? 'range' : 'full '} ${Math.round(run.bytes / 1024)}KB`
        : `FAIL ${run.error || `status ${run.status}`}`
      process.stderr.write(`${target.id.padEnd(24)} ${sample.full.padEnd(32)} #${attempt}  ${verdict}\n`)
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  const okRuns = runs.filter((r) => r.ok)
  results.push({
    id: target.id,
    attempts: runs.length,
    successes: okRuns.length,
    successRate: Math.round((okRuns.length / runs.length) * 100),
    medianTtfbMs: median(okRuns.map((r) => r.ttfbMs)),
    medianKbps: median(okRuns.map((r) => r.kbps)),
    honorsRange: okRuns.some((r) => r.ranged),
    runs
  })
  process.stderr.write('\n')
}

process.stderr.write(`${GITEE_BASELINE.id} baseline\n`)
const baselineRuns = []
for (let attempt = 1; attempt <= ATTEMPTS + 1; attempt += 1) {
  const run = await timedGet(GITEE_BASELINE.url)
  baselineRuns.push(run)
  process.stderr.write(
    `  #${attempt}  ${run.ok ? `ok ${run.totalMs}ms ttfb=${run.ttfbMs}ms ${run.kbps} KB/s` : `FAIL ${run.error || run.status}`}\n`
  )
  await new Promise((r) => setTimeout(r, 400))
}
const baselineOk = baselineRuns.filter((r) => r.ok)
results.push({
  id: GITEE_BASELINE.id,
  attempts: baselineRuns.length,
  successes: baselineOk.length,
  successRate: Math.round((baselineOk.length / baselineRuns.length) * 100),
  medianTtfbMs: median(baselineOk.map((r) => r.ttfbMs)),
  medianKbps: median(baselineOk.map((r) => r.kbps)),
  honorsRange: baselineOk.some((r) => r.ranged),
  runs: baselineRuns
})

writeFileSync(new URL('./mirror-result.json', import.meta.url), JSON.stringify(results, null, 2))

process.stderr.write('\n渠道                       成功率   中位首字节   中位速度   支持断点\n')
for (const r of results) {
  process.stderr.write(
    `${r.id.padEnd(26)} ${String(r.successRate + '%').padStart(5)}   ${String(r.medianTtfbMs ?? '-').padStart(7)}ms   ${String(r.medianKbps ?? '-').padStart(6)} KB/s   ${r.honorsRange ? 'yes' : 'no'}\n`
  )
}
