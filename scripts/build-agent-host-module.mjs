import { build } from 'esbuild';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as tar from 'tar';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'out', 'agent-host');
const vendored = path.join(root, 'vendor', 'agent-connector');
const source = path.resolve(process.env.AILISHISHU_CONNECTOR_SOURCE || vendored);
const require = createRequire(import.meta.url);
const rootReal = await realpath(root);
const syncVendor = process.argv.includes('--vendor-from-source');
const upstream = 'https://github.com/pingta-guangpingwang/ailishishu';
const licenseNote = 'Authorization follows the upstream project\'s existing terms. This snapshot adds no license grant and must not be assumed to inherit the launcher\'s license.';

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function managedDirectory(relative) {
  // Fixed generated directories only. Refuse junctions/symlinks in every parent
  // before recursive removal so an out/ or vendor/ redirect cannot escape here.
  if (!['out/agent-host', 'vendor/agent-connector/src'].includes(relative)) throw new Error('Not a managed Agent Host build directory');
  const target = path.resolve(root, relative);
  if (!isWithin(root, target)) throw new Error('Refusing to clean outside this worktree');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const entry = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!entry) break;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Refusing redirected or non-directory build path: ${current}`);
    const resolved = await realpath(current);
    if (!isWithin(rootReal, resolved)) throw new Error('Refusing to clean a directory outside this worktree');
  }
  return target;
}
async function resetManagedDirectory(relative) {
  const target = await managedDirectory(relative);
  console.log(`Refreshing generated directory: ${target}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  return target;
}
async function treeFingerprint(directory, prefix = '', digest = createHash('sha256'), totals = { size: 0 }) {
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const relative = prefix + name;
    if (relative === 'module.json') continue;
    const entry = await lstat(file);
    if (entry.isSymbolicLink()) throw new Error(`Source/build symlinks are not packaged: ${relative}`);
    if (entry.isDirectory()) await treeFingerprint(file, relative + '/', digest, totals);
    else if (entry.isFile()) { const bytes = await readFile(file); totals.size += bytes.length; digest.update(relative).update('\0').update(bytes); }
    else throw new Error(`Unsupported source/build file: ${relative}`);
  }
  return { digest, size: totals.size };
}

// A standalone clone builds exclusively from its committed vendor snapshot;
// no sibling AI历史书 checkout or npm install inside vendor is required.
if (source === vendored) await managedDirectory('vendor/agent-connector/src');
const connector = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
if (connector.name !== '@shenlan/agent-connector' || typeof connector.version !== 'string') throw new Error('Expected the reviewed @shenlan/agent-connector package');
const sourceReal = await realpath(source);
const sourceDirectory = path.join(source, 'src');
const sourceEntry = await lstat(sourceDirectory);
if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) throw new Error('Connector src must be a real directory');
if (!await lstat(path.join(sourceDirectory, 'host-child.mjs')).then(entry => entry.isFile() && !entry.isSymbolicLink())) throw new Error('Connector snapshot is missing the Agent Host child entry');
const expectedOutputReal = path.join(rootReal, 'out', 'agent-host');
if (sourceReal === expectedOutputReal || isWithin(expectedOutputReal, sourceReal)) throw new Error('Connector source cannot be inside the generated output directory');
const sourceTree = await treeFingerprint(sourceDirectory, 'src/');
sourceTree.digest.update('package.json\0').update(await readFile(path.join(source, 'package.json')));
const sourceSha256 = sourceTree.digest.digest('hex');
const wsDirectory = path.dirname(require.resolve('ws/package.json'));

if (syncVendor) {
  const vendoredReal = await realpath(vendored).catch(error => { if (error.code === 'ENOENT') return vendored; throw error; });
  if (sourceReal === vendoredReal || isWithin(vendoredReal, sourceReal)) throw new Error('Set AILISHISHU_CONNECTOR_SOURCE to the reviewed external connector package before syncing');
  // Copy only reviewed source and package metadata. Resetting this exact source
  // tree ensures upstream-deleted adapters/scripts cannot survive a later sync.
  await resetManagedDirectory('vendor/agent-connector/src');
  await cp(sourceDirectory, path.join(vendored, 'src'), { recursive: true });
  await cp(path.join(source, 'package.json'), path.join(vendored, 'package.json'));
  await writeFile(path.join(vendored, 'README.md'), `# Vendored AI历史书 connector\n\nSource: ${upstream} (packages/agent-connector).\n\n${licenseNote}\nThe upstream package metadata currently declares no license field; maintainers must verify the existing authorization before redistributing it. No additional MIT statement is introduced here.\n\nThis source snapshot is copied mechanically after connector tests; do not maintain a divergent second implementation. Only src and package metadata are synchronized, excluding private configurations, credentials, node_modules and runtime state. Removed upstream source files are removed from this snapshot on synchronization.\n\nStandalone build: run \`npm ci\` at the launcher repository root, then \`npm run agent-host:build\`.\nUpdate: set \`AILISHISHU_CONNECTOR_SOURCE\` to the reviewed upstream package and run \`node scripts/build-agent-host-module.mjs --vendor-from-source\`.\n\nSnapshot package: ${connector.name}@${connector.version}\nSource SHA-256 (src plus package.json): ${sourceSha256}\n`);
}
await resetManagedDirectory('out/agent-host');
await build({ entryPoints: [path.join(root, 'src/main/agent-host/service.ts')], outfile: path.join(output, 'host-service.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: false });
await cp(path.join(source, 'src'), path.join(output, 'connector'), { recursive: true });
await cp(wsDirectory, path.join(output, 'node_modules/ws'), { recursive: true });
await writeFile(path.join(output, 'SOURCE.json'), JSON.stringify({ source: upstream, sourcePath: 'packages/agent-connector', package: connector.name, connectorVersion: connector.version, sourceSha256, authorization: licenseNote, moduleProtocol: 1 }, null, 2));

const { digest, size } = await treeFingerprint(output);
let unpackedSize = size;
const version = '1.0.0+' + digest.digest('hex').slice(0, 12);
const metadata = JSON.stringify({ id: 'agent-host', version, protocol: 1, minimumLauncherVersion: '0.10.34' });
await writeFile(path.join(output, 'module.json'), metadata);
unpackedSize += Buffer.byteLength(metadata);
console.log(`Agent host compiled: ${version}`);
if (process.argv.includes('--compile-only')) process.exit(0);
const modules = path.join(root, 'release/modules');
await mkdir(modules, { recursive: true });
const filename = `agent-host-${version}-win-x64.tar.gz`;
const archive = path.join(modules, filename);
await tar.c({ cwd: output, file: archive, gzip: { level: 9 }, portable: true, mtime: new Date(0), strict: true }, (await readdir(output)).sort());
const bytes = await readFile(archive);
const artifact = { platform: 'win32', arch: 'x64', format: 'tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, unpackedSize,
  mirrors: [
    { id: 'gitee', url: `https://gitee.com/wanggp123/deepseek-harness-launcher/raw/runtime-assets/agent-host-${version}/${filename}` },
    { id: 'oss', url: `https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/modules/${encodeURIComponent(filename)}` },
    { id: 'github', url: `https://github.com/pingta-guangpingwang/deepblue-deepseek-harness-launcher/releases/download/agent-host-${version}/${filename}` }
  ] };
const release = { id: 'agent-host', version, required: false, installWhen: 'launcher', dependencies: [], artifacts: [artifact] };
await writeFile(path.join(root, 'release/agent-host.generated.json'), JSON.stringify(release, null, 2) + '\n');
// Never manufacture/replace a complete online catalog. Publishing combines this
// record with the existing production graph, signs it, then verifies all mirrors.
console.log(JSON.stringify({ archive, version, size: bytes.length, sha256: artifact.sha256, signed: false }));
