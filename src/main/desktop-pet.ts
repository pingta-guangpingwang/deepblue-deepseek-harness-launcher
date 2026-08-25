import { BrowserWindow, screen } from 'electron'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DeepSeekBalanceSummary, PetBehavior, PetMediaKind, PetPackKind, PetStoreState } from '../shared/types'

interface DesktopPetPosition {
  x: number
  y: number
}

interface DesktopPetConfig {
  schemaVersion: 1
  petId: string
  name: string
  mediaKind: PetMediaKind
  packKind: PetPackKind
  mediaPath: string
  behavior: PetBehavior
  position?: DesktopPetPosition
  appliedAt: string
}

interface DragSession {
  startPointer: DesktopPetPosition
  startWindow: DesktopPetPosition
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
.bubble{position:absolute;z-index:3;top:8px;left:50%;width:max-content;max-width:230px;padding:8px 11px;border:1px solid rgba(52,83,123,.16);border-radius:12px;background:rgba(255,255,255,.94);color:#23334a;font-size:12px;line-height:1.45;text-align:center;box-shadow:0 8px 22px rgba(17,45,78,.14);transform:translateX(-50%);opacity:0;transition:opacity .16s ease}.bubble.show{opacity:1}
.pet{position:relative;width:min(var(--pet-width),calc(100vw - 20px));height:min(var(--pet-width),calc(100vh - 76px));display:grid;place-items:center;border:0;background:transparent;padding:0;cursor:grab;touch-action:none;-webkit-app-region:no-drag}.pet[data-dragging='true']{cursor:grabbing}
.pet img,.pet canvas{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 10px rgba(20,43,68,.24));pointer-events:none;-webkit-user-drag:none}.pet canvas{display:none;image-rendering:pixelated}.pet.pixel img{position:absolute;width:1px;height:1px;opacity:0}.pet.pixel canvas{display:block}
.pet.float{animation:float 3.4s ease-in-out infinite}.pet.bounce{animation:bounce 2.1s ease-in-out infinite}.pet.hop{animation:hop .56s cubic-bezier(.2,.8,.25,1)}.pet.spin{animation:spin .64s ease}.pet.heart::after{content:'♥';position:absolute;top:4%;right:10%;color:#f04d78;font-size:26px;animation:heart .7s ease both}
.hint{position:absolute;bottom:4px;left:50%;height:20px;min-width:112px;padding:0 10px;border:1px solid rgba(54,84,119,.14);border-radius:8px;background:rgba(255,255,255,.78);color:#52657b;font-size:10px;line-height:20px;text-align:center;transform:translateX(-50%);pointer-events:none}
@keyframes float{50%{transform:translateY(-9px)}}@keyframes bounce{45%{transform:translateY(-7px) scale(1.02)}}@keyframes hop{45%{transform:translateY(-20px) scale(1.04)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes heart{from{opacity:0;transform:translateY(8px) scale(.6)}50%{opacity:1}to{opacity:0;transform:translateY(-18px) scale(1.2)}}
@media(prefers-reduced-motion:reduce){.pet{animation:none!important}}
</style></head><body><main class="stage"><div id="bubble" class="bubble" role="status"></div><button id="pet" class="pet" type="button" aria-label="电脑桌面宠物，可拖动位置，单击随机互动，每三次点击查看 DeepSeek 余额"><img id="image" alt=""><canvas id="canvas" aria-hidden="true"></canvas></button><div class="hint">拖动位置 · 三击看余额</div></main><script>
const config=${behavior};const pet=document.getElementById('pet');const image=document.getElementById('image');const canvas=document.getElementById('canvas');const bubble=document.getElementById('bubble');let bubbleTimer=0,reactionTimer=0,frameTimer=0,presenceTimer=0,atlasRow=0,atlasReady=false,interactionActive=false,lastInteractionRow=-1,lastCssReaction='',drag=null,clickCount=0,speechGeneration=0;
pet.classList.add(config.idleMotion==='none'?'':config.idleMotion);${pixelAtlas ? "pet.classList.add('pixel');pet.classList.remove('float','bounce');" : ''}
function showBubble(text,duration=3000){bubble.textContent=text;bubble.classList.add('show');clearTimeout(bubbleTimer);bubbleTimer=setTimeout(()=>bubble.classList.remove('show'),duration)}
async function speak(source){const generation=++speechGeneration;const direct=source==='click'||source==='keyboard';if(direct){clickCount=clickCount%3+1;if(clickCount===3){showBubble('正在查询 DeepSeek 余额…',8000);let result;try{result=await window.desktopPetHost?.getDeepSeekBalance()}catch{}if(generation!==speechGeneration)return;showBubble(result?.message||'DeepSeek 余额暂时查询失败，请稍后再点我',4200);return}}const lines=Array.isArray(config.speechLines)?config.speechLines:[];if(lines.length)showBubble(lines[Math.floor(Math.random()*lines.length)])}
let validFrames=()=>[];
function pickDifferent(values,last){const available=values.filter(value=>value!==last);const pool=available.length?available:values;return pool.length?pool[Math.floor(Math.random()*pool.length)]:undefined}
function finishInteraction(){interactionActive=false;atlasRow=0;pet.dataset.interactionRow='0';pet.dataset.interactionSource='idle';pet.classList.remove('hop','spin','heart')}
function playInteraction(source='click'){if(drag?.moved)return;interactionActive=true;void speak(source);clearTimeout(reactionTimer);if(${pixelAtlas ? 'true' : 'false'}&&atlasReady){const rows=[];for(let row=1;row<12;row+=1)if(validFrames(row).length)rows.push(row);const next=pickDifferent(rows,lastInteractionRow);if(next!==undefined){lastInteractionRow=next;atlasRow=next;pet.dataset.interactionRow=String(next)}}else{const next=pickDifferent(['hop','spin','heart'],lastCssReaction)||'heart';lastCssReaction=next;pet.classList.remove('hop','spin','heart');void pet.offsetWidth;pet.classList.add(next)}pet.dataset.interactionSource=source;reactionTimer=setTimeout(finishInteraction,1100)}
function schedulePresence(){clearTimeout(presenceTimer);const base=Number(config.autoSpeakIntervalSec);const seconds=Number.isFinite(base)&&base>=30?base:38;const delay=Math.round(seconds*(.78+Math.random()*.44)*1000);presenceTimer=setTimeout(()=>{if(!document.hidden&&!drag&&!interactionActive)playInteraction('presence');schedulePresence()},delay)}
function pointerPoint(event){return {x:Number(event.screenX),y:Number(event.screenY)}}
pet.addEventListener('pointerdown',event=>{if(event.button!==0)return;try{pet.setPointerCapture(event.pointerId)}catch{}drag={pointerId:event.pointerId,start:pointerPoint(event),moved:false};pet.dataset.dragging='false'})
pet.addEventListener('pointermove',event=>{if(!drag||drag.pointerId!==event.pointerId)return;const point=pointerPoint(event);if(!drag.moved&&Math.hypot(point.x-drag.start.x,point.y-drag.start.y)>=5){drag.moved=true;pet.dataset.dragging='true';window.desktopPetHost?.beginDrag(drag.start)}if(drag.moved)window.desktopPetHost?.moveDrag(point)})
async function endPointer(event,cancelled=false){if(!drag||drag.pointerId!==event.pointerId)return;const moved=drag.moved;const point=pointerPoint(event);drag=null;pet.dataset.dragging='false';if(moved)await window.desktopPetHost?.endDrag(point);else if(!cancelled)playInteraction('click')}
pet.addEventListener('pointerup',event=>void endPointer(event));pet.addEventListener('pointercancel',event=>void endPointer(event,true));pet.addEventListener('click',event=>{if(event.detail===0)playInteraction('keyboard')});
pet.addEventListener('mouseenter',()=>{if(!interactionActive&&!drag&&validFrames(6).length)atlasRow=6});pet.addEventListener('mouseleave',()=>{if(!interactionActive&&!drag)atlasRow=0});image.src=${mediaUrl};
${pixelAtlas ? `image.addEventListener('load',()=>{const columns=8;const rows=image.naturalHeight%11===0?11:image.naturalHeight%9===0?9:1;const fw=image.naturalWidth/columns,fh=image.naturalHeight/rows;canvas.width=fw;canvas.height=fh;const ctx=canvas.getContext('2d',{willReadFrequently:true});const scratch=document.createElement('canvas');scratch.width=fw;scratch.height=fh;const scan=scratch.getContext('2d',{willReadFrequently:true});const cache=new Map();validFrames=row=>{if(row<0||row>=rows)return[];if(cache.has(row))return cache.get(row);const frames=[];const minimum=Math.max(12,Math.floor(fw*fh*.002));for(let frame=0;frame<columns;frame+=1){scan.clearRect(0,0,fw,fh);scan.drawImage(image,frame*fw,row*fh,fw,fh,0,0,fw,fh);const pixels=scan.getImageData(0,0,fw,fh).data;let visible=0;for(let pixel=3;pixel<pixels.length&&visible<minimum;pixel+=4)if(pixels[pixel]>8)visible+=1;if(visible>=minimum)frames.push(frame)}cache.set(row,frames);return frames};for(let row=0;row<rows;row+=1)validFrames(row);atlasReady=true;let index=0,lastRow=-1;const draw=()=>{const requested=Math.min(rows-1,Math.max(0,atlasRow));const row=validFrames(requested).length?requested:0;if(row!==lastRow){index=0;lastRow=row}const frames=validFrames(row);if(!frames.length)return;const frame=frames[index%frames.length];ctx.clearRect(0,0,fw,fh);ctx.drawImage(image,frame*fw,row*fh,fw,fh,0,0,fw,fh);canvas.dataset.frameIndex=String(frame);canvas.dataset.animationRow=String(row);index+=1};draw();frameTimer=setInterval(draw,150)});` : ''}
window.__deepbluePetDebug={triggerPresence:()=>playInteraction('presence'),triggerClick:()=>playInteraction('click'),clickCount:()=>clickCount};schedulePresence();
window.addEventListener('beforeunload',()=>{clearInterval(frameTimer);clearTimeout(bubbleTimer);clearTimeout(reactionTimer);clearTimeout(presenceTimer)});
</script></body></html>`
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = `${path.resolve(root)}${path.sep}`.toLowerCase()
  return path.resolve(target).toLowerCase().startsWith(normalizedRoot)
}

function finitePoint(value: unknown): value is DesktopPetPosition {
  const point = value as Partial<DesktopPetPosition> | undefined
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

export class DesktopPetManager {
  private window?: BrowserWindow
  private active?: DesktopPetConfig
  private drag?: DragSession

  constructor(
    private readonly statePath: string,
    private readonly hostDirectory: string,
    private readonly allowedPetRoot: string,
    private readonly readDeepSeekBalance: () => Promise<DeepSeekBalanceSummary>
  ) {}

  state(): PetStoreState['desktopPet'] {
    if (!this.active) return undefined
    return { petId: this.active.petId, running: Boolean(this.window && !this.window.isDestroyed()) }
  }

  isRunning(): boolean {
    return this.state()?.running === true
  }

  ownsWebContents(senderId: number): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.webContents.id === senderId)
  }

  async deepSeekBalance(senderId: number): Promise<DeepSeekBalanceSummary> {
    if (!this.ownsWebContents(senderId)) {
      return { status: 'error', message: '只有正在运行的桌面宠物可以查询余额', checkedAt: new Date().toISOString() }
    }
    try {
      return await this.readDeepSeekBalance()
    } catch {
      return { status: 'error', message: 'DeepSeek 余额暂时查询失败，请稍后再点我', checkedAt: new Date().toISOString() }
    }
  }

  beginDrag(senderId: number, pointer: unknown): void {
    if (!this.ownsWebContents(senderId) || !this.window || !finitePoint(pointer)) return
    const current = this.window.getPosition()
    const x = current[0] ?? 0
    const y = current[1] ?? 0
    this.drag = { startPointer: pointer, startWindow: { x, y } }
  }

  moveDrag(senderId: number, pointer: unknown): void {
    if (!this.ownsWebContents(senderId) || !this.window || !this.drag || !finitePoint(pointer)) return
    const next = this.clampPosition({
      x: Math.round(this.drag.startWindow.x + pointer.x - this.drag.startPointer.x),
      y: Math.round(this.drag.startWindow.y + pointer.y - this.drag.startPointer.y)
    }, this.window.getBounds())
    this.window.setPosition(next.x, next.y, false)
  }

  async endDrag(senderId: number, pointer: unknown): Promise<void> {
    if (!this.ownsWebContents(senderId) || !this.window || !this.drag) return
    if (finitePoint(pointer)) this.moveDrag(senderId, pointer)
    this.drag = undefined
    const current = this.window.getPosition()
    const x = current[0] ?? 0
    const y = current[1] ?? 0
    if (!this.active) return
    const next = { ...this.active, position: { x, y } }
    this.active = next
    await this.persist(next)
  }

  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8')) as DesktopPetConfig
      const legacyKind = (saved as unknown as { packKind?: string }).packKind
      if (saved.schemaVersion !== 1 || !saved.petId || !isInside(this.allowedPetRoot, saved.mediaPath) || legacyKind === 'live2d') throw new Error('invalid desktop pet state')
      await access(saved.mediaPath)
      this.active = saved
      await this.start(saved)
    } catch {
      await this.clear()
    }
  }

  async apply(config: Omit<DesktopPetConfig, 'schemaVersion' | 'appliedAt' | 'position'>): Promise<void> {
    if (process.platform !== 'win32') throw new Error('电脑桌面宠物目前支持 Windows 10/11')
    if (!isInside(this.allowedPetRoot, config.mediaPath)) throw new Error('桌面宠物只能读取启动器校验过的本机缓存')
    await access(config.mediaPath)
    const next: DesktopPetConfig = { ...config, schemaVersion: 1, appliedAt: new Date().toISOString(), ...(this.active?.position ? { position: this.active.position } : {}) }
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

  private clampPosition(position: DesktopPetPosition, bounds: { width: number; height: number }): DesktopPetPosition {
    const display = screen.getDisplayNearestPoint(position)
    const area = display.workArea
    return {
      x: Math.max(area.x, Math.min(area.x + area.width - bounds.width, Math.round(position.x))),
      y: Math.max(area.y, Math.min(area.y + area.height - bounds.height, Math.round(position.y)))
    }
  }

  private async start(config: DesktopPetConfig): Promise<void> {
    await this.destroyWindow()
    await mkdir(this.hostDirectory, { recursive: true })
    const hostFile = path.join(this.hostDirectory, 'desktop-pet-host.html')
    await writeFile(hostFile, desktopPetDocument(config), 'utf8')
    const display = screen.getPrimaryDisplay()
    const width = Math.max(210, Math.min(360, config.behavior.widthPx + 88))
    const height = Math.max(250, Math.min(420, config.behavior.widthPx + 120))
    const fallback = { x: display.workArea.x + display.workArea.width - width - 24, y: display.workArea.y + display.workArea.height - height - 18 }
    const position = this.clampPosition(config.position || fallback, { width, height })
    config.position = position
    const window = new BrowserWindow({
      ...position,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      focusable: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '../preload/desktop-pet.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    try {
      this.window = window
      await window.loadFile(hostFile)
      window.setAlwaysOnTop(true, 'screen-saver')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      window.showInactive()
      window.on('blur', () => {
        if (!window.isDestroyed()) window.setAlwaysOnTop(true, 'screen-saver')
      })
    } catch (error) {
      this.window = undefined
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
    this.drag = undefined
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }
}
