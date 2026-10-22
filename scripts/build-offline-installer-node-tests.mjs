import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const builder = new URL('./build-offline-installer.ps1', import.meta.url)
const windowsOnly = { skip: process.platform !== 'win32' }
const executable = '深蓝DeepSeekHarness启动器.exe'
const packageFiles = [executable, 'resources/app/out/main/index.js', 'resources/app/out/renderer/index.html',
  'resources/app/out/agent-host/module.json', 'resources/app/node_modules/node/bin/node.exe',
  'resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'resources/app/node_modules/pnpm/bin/pnpm.cjs',
  'resources/resources/runtime-modules.generated.json']

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'offline-installer-'))
  async function put(relative, contents = relative) {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents)
    return file
  }
  await put('package.json', JSON.stringify({ version: '0.10.40', build: { productName: executable.slice(0, -4) } }))
  for (const file of packageFiles) await put(`release/win-unpacked/${file}`)
  await put('release/win-unpacked/resources/app/package.json', JSON.stringify({ version: '0.10.40' }))
  await put('release/.icon-ico/icon.ico')
  await put('scripts/bootstrap/installer.nsi', '; Root owns the shared offline-aware installer source')
  await put('scripts/bootstrap/HashVerifier.cs', '// Compile the existing verifier')
  await mkdir(path.join(root, 'tools/plugins/x86-unicode'), { recursive: true })
  await put('tools/run-tool.mjs', `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
    import path from 'node:path';
    const [tool,...args]=process.argv.slice(2);
    appendFileSync(process.env.MOCK_LOG,JSON.stringify({tool,args,nsisDir:process.env.NSISDIR})+'\\n');
    if(process.env.MOCK_FAIL===tool)process.exit(9);
    if(tool==='sevenZip')writeFileSync(args[args.length-2],Buffer.from('complete offline package archive'));
    if(tool==='csc')writeFileSync(args.find(arg=>arg.startsWith('/out:')).slice(5),'verified hash helper');
    if(tool==='makeNsis'){
      const define=name=>args.find(arg=>arg.startsWith('/D'+name+'=')).slice(name.length+3);
      const include=readFileSync(define('RELEASE_INCLUDE'),'utf8');
      const archive=readFileSync(define('OFFLINE_SHELL_ARCHIVE'));
      writeFileSync(define('OUTPUT_FILE'),JSON.stringify({include,archive:archive.toString(),args}));
    }
  `)
  const tools = {}
  for (const name of ['sevenZip', 'makeNsis', 'csc']) {
    tools[name] = await put(`tools/${name}.ps1`, `& '${process.execPath.replaceAll("'", "''")}' (Join-Path $PSScriptRoot 'run-tool.mjs') '${name}' @args\nexit $LASTEXITCODE\n`)
  }
  const script = path.join(root, 'scripts/build-offline-installer.ps1')
  await copyFile(builder, script)
  const output = path.join(root, 'release/deepblue-deepseek-harness-launcher-0.10.40-win-x64-offline.exe')
  const log = path.join(root, 'tool-calls.jsonl')
  function run(options = {}) {
    const env = { ...process.env, MOCK_LOG: log, DSH_CSC_PATH: tools.csc, ...options.env }
    const args = options.environment ? [] : ['-SevenZipPath', tools.sevenZip, '-MakeNsisPath', tools.makeNsis,
      '-NsisPluginsPath', path.join(root, 'tools/plugins/x86-unicode')]
    if (options.environment) Object.assign(env, { ELECTRON_BUILDER_7ZIP_PATH: tools.sevenZip,
      DSH_MAKENSIS_PATH: tools.makeNsis, DSH_NSIS_PLUGINS_PATH: path.join(root, 'tools/plugins/x86-unicode') })
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, env })
  }
  async function calls() { return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
  return { root, output, run, calls, put, cleanup: () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    assert.ok(path.basename(root).startsWith('offline-installer-'))
    return rm(root, { recursive: true, force: true })
  } }
}

test('offline builder exists before any package or native tool runs', async () => {
  assert.ok(await readFile(builder, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), 'Offline builder is missing')
})

test('builds a full internal archive and embeds its exact hash/size into the shared atomic installer', windowsOnly, async () => {
  const f = await fixture()
  try {
    await writeFile(f.output, 'previous complete installer')
    const result = f.run(); assert.equal(result.status, 0, result.stderr || result.stdout)
    const calls = await f.calls(); assert.deepEqual(calls.map(call => call.tool), ['sevenZip', 'csc', 'makeNsis'])
    const archiveCall = calls[0]; assert.equal(archiveCall.args.at(-1), path.join(f.root, 'release/win-unpacked', '*'))
    assert.ok(archiveCall.args.at(-2).startsWith(path.join(f.root, 'release', '.offline-build-')))
    assert.equal(await readFile(path.join(path.dirname(archiveCall.args.at(-2)), 'previous-offline.exe'), 'utf8'), 'previous complete installer')
    const installed = JSON.parse(await readFile(f.output, 'utf8'))
    const bytes = Buffer.from('complete offline package archive')
    assert.ok(installed.include.includes(`!define SHELL_SHA256 "${createHash('sha256').update(bytes).digest('hex')}"`))
    assert.ok(installed.include.includes(`!define SHELL_SIZE "${bytes.length}"`))
    assert.ok(installed.include.includes('!define SHELL_VERSION "0.10.40"'))
    assert.ok(installed.include.includes(`!define SHELL_EXECUTABLE "${executable}"`))
    assert.ok(installed.args.includes('/DOFFLINE_SHELL'))
    assert.ok(installed.args.at(-1).endsWith(path.join('scripts', 'bootstrap', 'installer.nsi')))
    assert.ok(installed.args.find(arg => arg.startsWith('/DOUTPUT_FILE=')).includes('.offline-build-'))
    assert.equal(await readFile(path.join(f.root, 'release/win-unpacked', packageFiles[4]), 'utf8'), `release/win-unpacked/${packageFiles[4]}`)
  } finally { await f.cleanup() }
})

test('accepts fixed native tool paths from the documented environment fallbacks', windowsOnly, async () => {
  const f = await fixture()
  try { const result = f.run({ environment: true }); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal((await f.calls()).length, 3) }
  finally { await f.cleanup() }
})

for (const tool of ['sevenZip', 'csc', 'makeNsis']) {
  test(`${tool} failure preserves the previous complete offline artifact`, windowsOnly, async () => {
    const f = await fixture()
    try {
      await writeFile(f.output, 'previous complete installer')
      const result = f.run({ env: { MOCK_FAIL: tool } }); assert.notEqual(result.status, 0)
      assert.equal(await readFile(f.output, 'utf8'), 'previous complete installer')
      assert.equal((await f.calls()).at(-1).tool, tool)
    } finally { await f.cleanup() }
  })
}

test('refuses to label a pruned online shell or another packaged version as a complete offline update', windowsOnly, async () => {
  const f = await fixture()
  try {
    await rm(path.join(f.root, 'release/win-unpacked/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js'))
    let result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /complete|offline|missing/i)
    await f.put('release/win-unpacked/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js')
    await f.put('release/win-unpacked/resources/app/package.json', JSON.stringify({ version: '0.10.39' }))
    result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /version/i)
    assert.equal(await readFile(f.output, 'utf8').catch(error => error.code === 'ENOENT' ? 'missing' : Promise.reject(error)), 'missing')
  } finally { await f.cleanup() }
})
