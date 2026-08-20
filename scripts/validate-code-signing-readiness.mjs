import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const requiredFiles = [
  'LICENSE',
  'PRIVACY.md',
  'SECURITY.md',
  'docs/CODE_SIGNING_POLICY.md',
  'docs/signpath-artifact-configuration.xml',
  '.github/workflows/windows-signpath-release.yml',
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Code-signing readiness file is missing: ${file}`);
}

const readme = read('README.md');
const policy = read('docs/CODE_SIGNING_POLICY.md');
const privacy = read('PRIVACY.md');
const workflow = read('.github/workflows/windows-signpath-release.yml');
const artifactConfiguration = read('docs/signpath-artifact-configuration.xml');

for (const token of ['Code signing policy', 'SignPath.io', 'SignPath Foundation', 'PRIVACY.md', 'SECURITY.md']) {
  if (!`${readme}\n${policy}`.includes(token)) throw new Error(`Code-signing policy is missing required text: ${token}`);
}
if (!privacy.includes('不会') || !privacy.includes('模型 API Key')) throw new Error('Privacy policy must state the local-data boundary.');
for (const token of [
  'actions/upload-artifact@v7',
  'signpath/github-action-submit-signing-request@v2',
  'SIGNPATH_API_TOKEN',
  'SIGNPATH_ORGANIZATION_ID',
  'SIGNPATH_PROJECT_SLUG',
  'SIGNPATH_SIGNING_POLICY_SLUG',
  'SIGNPATH_ARTIFACT_CONFIGURATION_SLUG',
  'Get-AuthenticodeSignature',
]) {
  if (!workflow.includes(token)) throw new Error(`Trusted signing workflow is missing: ${token}`);
}
if (!workflow.includes("github.ref == 'refs/heads/main'")) throw new Error('Release signing must be restricted to main.');
if (/pull_request:|\bpush:/.test(workflow)) throw new Error('Formal signing may only run by explicit workflow dispatch.');
for (const token of ['${version}-win-x64-online.exe', '${version}-win-x64-offline.exe', '<authenticode-sign']) {
  if (!artifactConfiguration.includes(token)) throw new Error(`SignPath artifact configuration is missing: ${token}`);
}

console.log('Code-signing readiness checks passed.');
