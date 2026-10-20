// Node-side release tooling consumes the same typed catalogs as the application.
// Bundling resolves TS imports through the pinned build dependency, not a global loader.
import { build } from 'esbuild'
import path from 'node:path'

export async function loadBundledReleaseMetadata() {
  const root = path.resolve(import.meta.dirname, '..')
  const result = await build({
    stdin: { contents: "export { modelProviderTemplates } from './src/shared/model-provider-catalog.ts'; export { bundledModels, bundledPlugins, bundledVersions } from './src/main/catalog.ts';", resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'
  })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
