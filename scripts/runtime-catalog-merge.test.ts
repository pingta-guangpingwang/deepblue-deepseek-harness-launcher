import { describe, expect, it } from 'vitest';
// @ts-expect-error Build scripts are plain JavaScript.
import { mergeRuntimeModules } from './runtime-catalog-merge.mjs';
import { readFileSync } from 'node:fs';
const module = (id: string, version = '1') => ({ id, version, artifacts: [{ sha256: 'fixture' }] });
describe('independent Agent Host publishing', () => {
  it('updates only its own record without dropping UI, runtime or other modules', () => {
    const existing = ['node-runtime', 'harness-core', 'package-manager', 'launcher-ui', 'agent-host', 'future-module'].map(id => module(id));
    const merged = mergeRuntimeModules(existing, [module('agent-host', '2')], ['launcher-ui']);
    expect(merged).toHaveLength(6);
    expect(merged.find((entry: { id: string }) => entry.id === 'agent-host').version).toBe('2');
    expect(merged.find((entry: { id: string }) => entry.id === 'launcher-ui')).toBe(existing[3]);
    expect(existing[4].version).toBe('1');
  });
  it('preserves the host during a full core rebuild', () => {
    expect(mergeRuntimeModules([module('agent-host'), module('launcher-ui'), module('node-runtime')], [module('node-runtime', '2')]).map((entry: { id: string }) => entry.id)).toEqual(['agent-host', 'launcher-ui', 'node-runtime']);
  });
  it('fails closed for missing prerequisites and duplicate records', () => {
    expect(() => mergeRuntimeModules([], [module('agent-host')], ['node-runtime'])).toThrow('missing node-runtime');
    expect(() => mergeRuntimeModules([module('agent-host'), module('agent-host')], [])).toThrow('duplicate');
    expect(() => mergeRuntimeModules([], [module('agent-host'), module('agent-host')])).toThrow('duplicate');
  });
  it('the full build and signing-payload gate include agent-host', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['modules:build']).toContain('npm run hot-update:agent-host');
    expect(readFileSync(new URL('./update-release-payload.mjs', import.meta.url), 'utf8')).toContain("'launcher-ui', 'agent-host'");
  });
});
