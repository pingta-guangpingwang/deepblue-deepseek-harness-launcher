import { app } from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DshHostSettings { endpoint: string; expectedVersion: string; expectedCwd: string; nativeClientModule?: string; nativeClientRoot?: string }
const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

/** Read only the owning Launcher's local settings, never an URL from renderer/cloud.
 * Kept inside the signed Host module so the existing protocol-1 shell can use it. */
export async function resolveBuiltinDshHost(storageDir: string, userDataPath = app.getPath('userData')): Promise<DshHostSettings> {
  const configFile = path.join(userDataPath, 'launcher.json')
  if ((await stat(configFile)).size > 2 * 1024 * 1024) throw new Error('启动器配置过大，DSH 未连接')
  const config = JSON.parse(await readFile(configFile, 'utf8')) as { activeVersion?: string; settings?: { port?: number; storageRoot?: string; workspace?: string } }
  const configuredRoot = config.settings?.storageRoot || userDataPath
  if (!path.isAbsolute(configuredRoot)) throw new Error('DSH 存储目录无效')
  const [hostRoot, configured] = await Promise.all([realpath(path.dirname(storageDir)), realpath(configuredRoot)])
  if (pathKey(hostRoot) !== pathKey(configured)) throw new Error('DSH 与智能体托管模块不属于同一启动器数据目录')
  const port = config.settings?.port
  if (!Number.isSafeInteger(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('请先在启动器设置有效的 DSH 端口')
  const workspace = config.settings?.workspace || ''
  if (!path.isAbsolute(workspace) || !(await stat(workspace)).isDirectory()) throw new Error('DSH 默认工作区不可用')
  if (config.activeVersion !== '0.1.1-rc.2') throw new Error('当前 DSH 核心版本尚未通过远程适配验证')
  if (!(await stat(path.join(hostRoot, 'harness-data'))).isDirectory()) throw new Error('请先在启动器首页初始化并启动 DSH')
  const nativeClientRoot = await realpath(path.join(hostRoot, 'runtime/modules/harness-core', config.activeVersion)).catch(() => '')
  const nativeClientModule = nativeClientRoot ? await realpath(path.join(nativeClientRoot, 'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js')).catch(() => '') : ''
  const relative = nativeClientModule ? path.relative(nativeClientRoot, nativeClientModule) : '..'
  const nativeClient = nativeClientModule && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? { nativeClientModule, nativeClientRoot } : {}
  return { endpoint: `http://127.0.0.1:${port}`, expectedVersion: config.activeVersion, expectedCwd: await realpath(workspace), ...nativeClient }
}
