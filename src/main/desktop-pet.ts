import { BrowserWindow, screen } from 'electron'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PetBehavior, PetMediaKind, PetPackKind, PetStoreState } from '../shared/types'
import { attachToWindowsDesktop } from './dynamic-wallpaper'

interface DesktopPetConfig {
  schemaVersion: 1
  petId: string
  name: string
  mediaKind: PetMediaKind
  packKind: PetPackKind
  mediaPath: string
  behavior: PetBehavior
  appliedAt: string
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

export function desktopPetDocument(config: DesktopPetConfig): string {
  const mediaUrl = safeJson(pathToFileURL(config.mediaPath).href)
  const behavior = safeJson(config.behavior)
  const pixelAtlas = config.packKind === 'pixel-atlas'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:'Microsoft YaHei UI',sans-serif;user-select:none}
.stage{position:relative;width:100%;height:100%;display:grid;place-items:end center;padding:48px 12px 28px;box-sizing:border-box}
.bubble{position:absolute;z-index:3;top:8px;left:50%;max-width:210px;padding:8px 11px;border:1px solid rgba(52,83,123,.16);border-radius:12px;background:rgba(255,255,255,.94);color:#23334a;font-size:12px;line-height:1.45;box-shadow:0 8px 22px rgba(17,45,78,.14);transform:translateX(-50%);opacity:0;transition:opacity .16s ease}.bubble.show{opacity:1}
.pet{position:relative;width:min(var(--pet-width),calc(100vw - 20px));height:min(var(--pet-width),calc(100vh - 76px));display:grid;place-items:center;border:0;background:transparent;padding:0;cursor:pointer;-webkit-app-region:no-drag}
.pet img,.pet canvas{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 10px rgba(20,43,68,.24));pointer-events:none}.pet canvas{display:none;image-rendering:pixelated}.pet.pixel img{position:absolute;width:1px;height:1px;opacity:0}.pet.pixel canvas{display:block}
.pet.float{animation:float 3.4s ease-in-out infinite}.pet.bounce{animation:bounce 2.1s ease-in-out infinite}.pet.hop{animation:hop .56s cubic-bezier(.2,.8,.25,1)}.pet.spin{animation:spin .64s ease}.pet.heart::after{content:'♥';position:absolute;top:4%;right:10%;color:#f04d78;font-size:26px;animation:heart .7s ease both}
.drag{position:absolute;bottom:4px;left:50%;height:20px;min-width:86px;padding:0 10px;border:1px solid rgba(54,84,119,.14);border-radius:8px;background:rgba(255,255,255,.78);color:#52657b;font-size:10px;line-height:20px;text-align:center;transform:translateX(-50%);-webkit-app-region:drag;cursor:move}
@keyframes float{50%{transform:translateY(-9px)}}@keyframes bounce{45%{transform:translateY(-7px) scale(1.02)}}@keyframes hop{45%{transform:translateY(-20px) scale(1.04)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes heart{from{opacity:0;transform:translateY(8px) scale(.6)}50%{opacity:1}to{opacity:0;transform:translateY(-18px) scale(1.2)}}
@media(prefers-reduced-motion:reduce){.pet{animation:none!important}}
</style></head><body><main class="stage"><div id="bubble" class="bubble" role="status"></div><button id="pet" class="pet" type="button" aria-label="电脑桌面宠物，点击互动"><img id="image" alt=""><canvas id="canvas" aria-hidden="true"></canvas></button><div class="drag" title="拖动桌面宠物">拖动位置</div></main><script>
const config=${behavior};const pet=document.getElementById('pet');const image=document.getElementById('image');const canvas=document.getElementById('canvas');const bubble=document.getElementById('bubble');let bubbleTimer=0,reactionTimer=0,frameTimer=0;
pet.classList.add(config.idleMotion==='none'?'':config.idleMotion);${pixelAtlas ? "pet.classList.add('pixel');" : ''}
function speak(){const lines=Array.isArray(config.speechLines)?config.speechLines:[];if(!lines.length)return;bubble.textContent=lines[Math.floor(Math.random()*lines.length)];bubble.classList.add('show');clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>bubble.classList.remove('show'),2600)}
function react(){speak();pet.classList.remove('hop','spin','heart');void pet.offsetWidth;pet.classList.add(config.clickMotion||'heart');clearTimeout(reactionTimer);reactionTimer=setTimeout(()=>pet.classList.remove('hop','spin','heart'),760)}
pet.addEventListener('click',react);image.src=${mediaUrl};
${pixelAtlas ? `image.addEventListener('load',()=>{const columns=8;const rows=image.naturalHeight%11===0?11:image.naturalHeight%9===0?9:1;const fw=image.naturalWidth/columns,fh=image.naturalHeight/rows;canvas.width=fw;canvas.height=fh;const ctx=canvas.getContext('2d');let frame=0;const draw=()=>{ctx.clearRect(0,0,fw,fh);ctx.drawImage(image,(frame%columns)*fw,0,fw,fh,0,0,fw,fh);canvas.dataset.frameIndex=String(frame%columns);frame+=1};draw();frameTimer=setInterval(draw,150)});` : ''}
const seconds=Number(config.autoSpeakIntervalSec);if(Number.isFinite(seconds)&&seconds>=30)setInterval(()=>{if(!document.hidden)speak()},seconds*1000);
window.addEventListener('beforeunload',()=>{clearInterval(frameTimer);clearTimeout(bubbleTimer);clearTimeout(reactionTimer)});
</script></body></html>`
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = `${path.resolve(root)}${path.sep}`.toLowerCase()
  return path.resolve(target).toLowerCase().startsWith(normalizedRoot)
}

export class DesktopPetManager {
  private window?: BrowserWindow
  private active?: DesktopPetConfig

  constructor(
    private readonly statePath: string,
    private readonly hostDirectory: string,
    private readonly allowedPetRoot: string
  ) {}

  state(): PetStoreState['desktopPet'] {
    if (!this.active) return undefined
    return { petId: this.active.petId, running: Boolean(this.window && !this.window.isDestroyed()) }
  }

  isRunning(): boolean {
    return this.state()?.running === true
  }

  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8')) as DesktopPetConfig
      if (saved.schemaVersion !== 1 || !saved.petId || !isInside(this.allowedPetRoot, saved.mediaPath) || saved.packKind === 'live2d') throw new Error('invalid desktop pet state')
      await access(saved.mediaPath)
      this.active = saved
      await this.start(saved)
    } catch {
      await this.clear()
    }
  }

  async apply(config: Omit<DesktopPetConfig, 'schemaVersion' | 'appliedAt'>): Promise<void> {
    if (process.platform !== 'win32') throw new Error('电脑桌面宠物目前支持 Windows 10/11')
    if (!isInside(this.allowedPetRoot, config.mediaPath)) throw new Error('桌面宠物只能读取启动器校验过的本机缓存')
    if (config.packKind === 'live2d') throw new Error('Live2D 桌面宠物需要经过签名校验的完整模型包和运行库，当前不提供桌面应用')
    await access(config.mediaPath)
    const next: DesktopPetConfig = { ...config, schemaVersion: 1, appliedAt: new Date().toISOString() }
    await this.start(next)
    try {
      await this.persist(next)
      this.active = next
    } catch (error) {
      await this.destroyWindow()
      throw error
    }
  }

  async clear(): Promise<void> {
    await this.destroyWindow()
    this.active = undefined
    await unlink(this.statePath).catch(() => undefined)
  }

  async dispose(): Promise<void> {
    await this.destroyWindow()
  }

  private async start(config: DesktopPetConfig): Promise<void> {
    await this.destroyWindow()
    await mkdir(this.hostDirectory, { recursive: true })
    const hostFile = path.join(this.hostDirectory, 'desktop-pet-host.html')
    await writeFile(hostFile, desktopPetDocument(config), 'utf8')
    const display = screen.getPrimaryDisplay()
    const width = Math.max(210, Math.min(360, config.behavior.widthPx + 88))
    const height = Math.max(250, Math.min(420, config.behavior.widthPx + 120))
    const window = new BrowserWindow({
      x: display.workArea.x + display.workArea.width - width - 24,
      y: display.workArea.y + display.workArea.height - height - 18,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      // The pet must accept later click and drag input. showInactive() below
      // avoids stealing focus during launch without disabling interaction.
      focusable: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    try {
      await window.loadFile(hostFile)
      window.showInactive()
      attachToWindowsDesktop(window, 'pet')
      this.window = window
    } catch (error) {
      window.destroy()
      throw new Error(`桌面宠物启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async persist(config: DesktopPetConfig): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.next`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(temporary, this.statePath)
  }

  private async destroyWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }
}
