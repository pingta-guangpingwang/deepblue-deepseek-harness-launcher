import { spawn } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const child = spawn(process.execPath, [vitest, 'run', 'src/main/runtime-modules.generated.test.ts'], {
  cwd: root,
  env: { ...process.env, RUNTIME_MODULE_SMOKE: '1' },
  windowsHide: true,
  stdio: 'inherit'
})
child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
