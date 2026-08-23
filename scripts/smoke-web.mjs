import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const node = path.join(root, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const dsh = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dshHome = path.join(os.tmpdir(), 'deepseek-harness-launcher-smoke')
const port = 4313
await mkdir(dshHome, { recursive: true })

const env = { ...process.env, DSH_HOME: dshHome }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
env[process.platform === 'win32' ? 'Path' : 'PATH'] = process.env.Path || process.env.PATH || ''

const child = spawn(node, [dsh, 'web', '--port', String(port), '--no-open'], { cwd: root, env, windowsHide: true })
let output = ''
child.stdout.on('data', (chunk) => { output += chunk.toString() })
child.stderr.on('data', (chunk) => { output += chunk.toString() })

async function stop() {
  if (process.platform === 'win32' && child.pid) {
    await Promise.race([new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, env })
      killer.once('error', reject)
      killer.once('exit', resolve)
    }), new Promise((resolve) => setTimeout(resolve, 4_000))])
  } else {
    child.kill('SIGTERM')
  }
}

try {
  let response
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Harness exited early with code ${child.exitCode}\n${output}`)
    try {
      response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(700) })
      if (response.ok) break
    } catch {
      // Startup normally needs several polling attempts.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!response?.ok) throw new Error(`Harness did not become ready\n${output}`)
  console.log(`Harness runtime smoke passed: HTTP ${response.status} on port ${port}`)
  console.log(output.trim().split(/\r?\n/).slice(-8).join('\n'))
} finally {
  await stop()
}
process.exit(0)
