window.__ModuleLoader__.load({ id: '@deepblue/dsh-skin-runtime', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  const ReactDOM = require('react-dom')
  const STYLE_ID = '@deepblue/dsh-skin-runtime/appearance.css'
  const CLARITY_STORAGE_KEY = 'deepblue-skin-clarity'
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@deepblue/dsh-skin-runtime'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = `
      *:has(> [data-shell-overlay]) { isolation: isolate; }
      [data-shell-overlay] { z-index: -1 !important; overflow: hidden; }
      .deepblue-skin-wallpaper { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; background: #07111f; }
      .deepblue-skin-wallpaper > img, .deepblue-skin-wallpaper > video, .deepblue-skin-wallpaper > canvas { width: 100%; height: 100%; display: block; object-fit: cover; transform: scale(1.01); }
      .deepblue-skin-wallpaper[data-media-kind='animated-image'] > img { animation: deepblue-skin-drift 18s ease-in-out infinite alternate; }
      .deepblue-skin-wallpaper > canvas { position: absolute; inset: 0; display: none; }
      .deepblue-skin-wallpaper[data-held='true'] > canvas { display: block; }
      .deepblue-skin-wallpaper[data-held='true'] > img { display: none; }
      .deepblue-skin-wallpaper::after { content: ''; position: absolute; inset: 0; background: var(--deepblue-skin-overlay-current, var(--deepblue-skin-overlay, rgba(2, 9, 20, .32))); transition: background .18s ease; }
      .deepblue-skin-clarity-toggle { height: 32px; min-width: 88px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--dsw-alias-border-normal, rgba(122,139,164,.3)); border-radius: 8px; color: var(--dsw-alias-fg-secondary, #526071); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.72)); box-shadow: 0 1px 2px rgba(10,25,48,.06); font: 600 12px/1 system-ui, sans-serif; white-space: nowrap; cursor: pointer; transition: color .15s ease, border-color .15s ease, background .15s ease; }
      .deepblue-skin-clarity-toggle:hover { color: var(--dsw-alias-fg-primary, #182438); border-color: #7897dd; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.86)); }
      .deepblue-skin-clarity-toggle[aria-pressed='true'] { color: #155f8e; border-color: rgba(53,145,197,.64); background: rgba(218,242,255,.86); }
      .deepblue-skin-clarity-icon { width: 16px; height: 13px; position: relative; flex: 0 0 auto; overflow: hidden; border: 1.5px solid currentColor; border-radius: 3px; }
      .deepblue-skin-clarity-icon::before { content: ''; width: 4px; height: 4px; position: absolute; top: 2px; right: 2px; border-radius: 50%; background: currentColor; }
      .deepblue-skin-clarity-icon::after { content: ''; width: 10px; height: 10px; position: absolute; left: 1px; bottom: -6px; border: 1.5px solid currentColor; transform: rotate(45deg); }
      .deepblue-skin-clarity-toggle[aria-pressed='false'] .deepblue-skin-clarity-icon { opacity: .68; box-shadow: inset 0 0 0 4px rgba(255,255,255,.3); }
      .deepblue-pet-host { position: fixed; inset: 0; z-index: 30; pointer-events: none; overflow: hidden; }
      .deepblue-pet { position: absolute; width: min(var(--deepblue-pet-width), 22vw); min-width: 96px; max-width: 280px; padding: 0; border: 0; background: transparent; cursor: grab; pointer-events: auto; touch-action: none; filter: drop-shadow(0 12px 13px rgba(7, 17, 31, .2)); }
      .deepblue-pet:active { cursor: grabbing; }
      .deepblue-pet-visual { position: relative; display: block; width: 100%; transform-origin: 50% 85%; }
      .deepblue-pet-visual > img, .deepblue-pet-visual > canvas { display: block; width: 100%; height: auto; max-height: 36vh; object-fit: contain; pointer-events: none; user-select: none; }
      .deepblue-pet-visual > canvas { display: none; }
      .deepblue-pet[data-held='true'] .deepblue-pet-visual > canvas { display: block; }
      .deepblue-pet[data-held='true'] .deepblue-pet-visual > img { display: none; }
      .deepblue-pet[data-pack-kind='pixel-atlas'] .deepblue-pet-visual > canvas { display: block; image-rendering: pixelated; }
      .deepblue-pet[data-pack-kind='pixel-atlas'] .deepblue-pet-visual > img { position: absolute; width: 1px; height: 1px; opacity: 0; }
      .deepblue-pet[data-idle='float'] .deepblue-pet-visual { animation: deepblue-pet-float 4.8s ease-in-out infinite; }
      .deepblue-pet[data-idle='bounce'] .deepblue-pet-visual { animation: deepblue-pet-bounce 3.6s ease-in-out infinite; }
      .deepblue-pet[data-reaction='hop'] .deepblue-pet-visual { animation: deepblue-pet-hop .55s cubic-bezier(.2,.8,.2,1); }
      .deepblue-pet[data-reaction='spin'] .deepblue-pet-visual { animation: deepblue-pet-spin .65s cubic-bezier(.2,.8,.2,1); }
      .deepblue-pet[data-reaction='heart'] .deepblue-pet-visual { animation: deepblue-pet-pop .55s cubic-bezier(.2,.8,.2,1); }
      .deepblue-pet[data-hover='perk']:hover .deepblue-pet-visual { animation: deepblue-pet-perk .42s ease-out both; }
      .deepblue-pet-bubble { position: absolute; left: 50%; bottom: calc(100% - 4px); max-width: 190px; padding: 9px 12px; border-radius: 13px 13px 13px 4px; background: rgba(255,255,255,.96); color: #202124; box-shadow: 0 8px 24px rgba(10,20,38,.18); font: 600 13px/1.45 system-ui, sans-serif; white-space: nowrap; transform: translateX(-50%); pointer-events: none; }
      .deepblue-pet-sparks { position: absolute; inset: -10px; pointer-events: none; opacity: 0; }
      .deepblue-pet[data-reaction='heart'] .deepblue-pet-sparks { opacity: 1; }
      .deepblue-pet-sparks::before, .deepblue-pet-sparks::after { content: ''; position: absolute; width: 8px; height: 8px; border-radius: 50%; background: #4d6bfe; box-shadow: 28px -10px 0 #7bdff2, 54px 8px 0 #8d7cff; animation: deepblue-pet-sparks .6s ease-out both; }
      .deepblue-pet-sparks::before { left: 12%; top: 12%; }
      .deepblue-pet-sparks::after { right: 18%; top: 4%; transform: scale(.75) rotate(25deg); }
      @keyframes deepblue-skin-drift { from { transform: scale(1.02) translate3d(-.4%, 0, 0); } to { transform: scale(1.07) translate3d(.4%, -.3%, 0); } }
      @keyframes deepblue-pet-float { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-9px) rotate(1deg); } }
      @keyframes deepblue-pet-bounce { 0%,78%,100% { transform: translateY(0) scaleY(1); } 86% { transform: translateY(-8px) scaleY(1.02); } 94% { transform: translateY(1px) scaleY(.98); } }
      @keyframes deepblue-pet-hop { 45% { transform: translateY(-22px) rotate(-4deg); } 70% { transform: translateY(0) rotate(3deg); } }
      @keyframes deepblue-pet-spin { to { transform: rotate(360deg); } }
      @keyframes deepblue-pet-pop { 45% { transform: scale(1.12); } }
      @keyframes deepblue-pet-perk { 45% { transform: translateY(-6px) scale(1.035) rotate(1deg); } }
      @keyframes deepblue-pet-sparks { from { opacity: 1; transform: translateY(8px) scale(.6); } to { opacity: 0; transform: translateY(-28px) scale(1.1); } }
      @media (max-width: 640px) { .deepblue-pet { width: min(var(--deepblue-pet-width), 31vw); max-width: 148px; } .deepblue-pet-bubble { max-width: 150px; font-size: 12px; } }
      @media (prefers-reduced-motion: reduce) { .deepblue-skin-wallpaper > video { display: none; } .deepblue-skin-wallpaper > img, .deepblue-pet-visual, .deepblue-pet-sparks::before, .deepblue-pet-sparks::after { animation: none !important; } .deepblue-skin-wallpaper[data-has-poster='false'] { background: #07111f; } }
      /* Decoder-driven GIF and WebP frames ignore the rule above, so the held canvas replaces them. */
    `
    document.head.appendChild(tag)
  }

  async function loadConfig(url) {
    try {
      const response = await fetch(url, { cache: 'no-store' })
      return response.ok ? await response.json() : undefined
    } catch {
      return undefined
    }
  }

  const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

  function readSkinClarity() {
    try { return localStorage.getItem(CLARITY_STORAGE_KEY) === 'clear' }
    catch { return false }
  }

  function applySkinClarity(config, clear) {
    const root = document.documentElement
    const opacity = Math.min(.98, Math.max(.2, Number(config.presentation?.surfaceOpacity) || .72))
    const baseOpacity = Math.max(.18, opacity - .42)
    root.dataset.deepblueSkinClarity = clear ? 'clear' : 'overlay'
    root.style.setProperty('--deepblue-skin-overlay-current', clear ? 'transparent' : (config.presentation?.overlay || 'rgba(2, 9, 20, .32)'))
    root.style.setProperty('--deepblue-skin-bg-base-light', `rgba(248, 251, 255, ${clear ? .035 : baseOpacity})`)
    root.style.setProperty('--deepblue-skin-bg-base-dark', `rgba(4, 12, 23, ${clear ? .06 : baseOpacity})`)
    root.style.setProperty('--deepblue-skin-bg-layer-1-light', `rgba(252, 253, 255, ${clear ? .07 : opacity})`)
    root.style.setProperty('--deepblue-skin-bg-layer-1-dark', `rgba(10, 22, 38, ${clear ? .1 : opacity})`)
    root.style.setProperty('--deepblue-skin-bg-layer-2-light', `rgba(248, 251, 255, ${clear ? .12 : Math.min(.98, opacity + .08)})`)
    root.style.setProperty('--deepblue-skin-bg-layer-2-dark', `rgba(13, 27, 46, ${clear ? .15 : Math.min(.98, opacity + .08)})`)
    root.style.setProperty('--deepblue-skin-sidebar-light', `rgba(244, 248, 255, ${clear ? .09 : Math.min(.96, opacity + .04)})`)
    root.style.setProperty('--deepblue-skin-sidebar-dark', `rgba(7, 18, 33, ${clear ? .12 : Math.min(.96, opacity + .04)})`)
  }

  function SkinClarityToggle({ config }) {
    const [clear, setClear] = React.useState(readSkinClarity)
    React.useEffect(() => { applySkinClarity(config, clear) }, [config.skinId, clear])
    const toggle = () => {
      setClear(current => {
        const next = !current
        try { localStorage.setItem(CLARITY_STORAGE_KEY, next ? 'clear' : 'overlay') } catch { /* Local storage can be unavailable in hardened browser profiles. */ }
        applySkinClarity(config, next)
        return next
      })
    }
    const label = clear ? '恢复蒙版' : '清透壁纸'
    return React.createElement('button', {
      type: 'button',
      className: 'deepblue-skin-clarity-toggle',
      'aria-label': clear ? '恢复壁纸蒙版' : '去除壁纸蒙版，高清直显',
      'aria-pressed': String(clear),
      title: clear ? '当前为高清直显，点击恢复蒙版' : '去除白色蒙版，直接显示高清壁纸',
      onClick: toggle
    }, React.createElement('span', { className: 'deepblue-skin-clarity-icon', 'aria-hidden': 'true' }), React.createElement('span', null, label))
  }

  /**
   * Animated GIF and WebP frames are driven by the decoder, not by CSS, so the
   * reduced-motion rule and the hidden-tab pause that cover <video> do nothing
   * for them. Reports when such media must be held on a single frame.
   */
  function useAnimationHold(active) {
    const [held, setHeld] = React.useState(false)
    React.useEffect(() => {
      if (!active) return undefined
      const motion = window.matchMedia(REDUCED_MOTION_QUERY)
      const update = () => setHeld(motion.matches || document.hidden)
      update()
      motion.addEventListener('change', update)
      document.addEventListener('visibilitychange', update)
      return () => {
        motion.removeEventListener('change', update)
        document.removeEventListener('visibilitychange', update)
      }
    }, [active])
    return active && held
  }

  function Wallpaper({ config }) {
    const videoRef = React.useRef(null)
    const imageRef = React.useRef(null)
    const canvasRef = React.useRef(null)
    const animated = config.mediaKind === 'animated-image'
    const held = useAnimationHold(animated)
    React.useEffect(() => {
      const video = videoRef.current
      if (!video) return undefined
      const onVisibility = () => document.hidden ? video.pause() : void video.play().catch(() => undefined)
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [])
    // Media is served from the loopback route, same origin as the web server,
    // so drawing it to a canvas does not taint the surface.
    React.useEffect(() => {
      if (!held) return
      const image = imageRef.current
      const canvas = canvasRef.current
      if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context) context.drawImage(image, 0, 0)
    }, [held, config.mediaUrl])
    const mediaStyle = { objectPosition: config.presentation.position, filter: config.presentation.blurPx > 0 ? `blur(${config.presentation.blurPx}px)` : undefined }
    const rootStyle = { '--deepblue-skin-overlay': config.presentation.overlay }
    if (config.mediaKind === 'video') {
      const video = React.createElement('video', { ref: videoRef, src: config.mediaUrl, poster: config.posterUrl, autoPlay: true, muted: true, loop: true, playsInline: true, preload: 'metadata', style: mediaStyle })
      return React.createElement('div', { className: 'deepblue-skin-wallpaper', 'data-media-kind': config.mediaKind, 'data-has-poster': String(Boolean(config.posterUrl)), style: rootStyle }, video)
    }
    const image = React.createElement('img', { ref: imageRef, src: config.mediaUrl, alt: '', draggable: false, style: mediaStyle })
    const children = animated
      ? [image, React.createElement('canvas', { key: 'still', ref: canvasRef, 'aria-hidden': 'true', style: mediaStyle })]
      : [image]
    return React.createElement('div', {
      className: 'deepblue-skin-wallpaper',
      'data-media-kind': config.mediaKind,
      'data-has-poster': String(Boolean(config.posterUrl)),
      'data-held': String(held),
      style: rootStyle
    }, children)
  }

  function initialPetPosition(config) {
    const fallback = { x: Math.max(12, window.innerWidth - config.behavior.widthPx - 24), y: Math.max(12, window.innerHeight - config.behavior.widthPx - 24) }
    try {
      const saved = JSON.parse(localStorage.getItem(`deepblue-pet-position:${config.petId}`) || 'null')
      if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return saved
    } catch {
      // Invalid local position data falls back to the bottom-right corner.
    }
    return fallback
  }

  function Pet({ config }) {
    const [position, setPosition] = React.useState(() => initialPetPosition(config))
    const [bubble, setBubble] = React.useState('')
    const [reaction, setReaction] = React.useState('')
    const positionRef = React.useRef(position)
    const drag = React.useRef(null)
    const imageRef = React.useRef(null)
    const canvasRef = React.useRef(null)
    const [atlasReady, setAtlasReady] = React.useState(0)
    const pixelAtlas = config.packKind === 'pixel-atlas'
    const animated = config.mediaKind === 'animated' && !pixelAtlas
    const held = useAnimationHold(animated)
    React.useEffect(() => {
      if (!held) return
      const image = imageRef.current
      const canvas = canvasRef.current
      if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (context) context.drawImage(image, 0, 0)
    }, [held, config.mediaUrl])
    React.useEffect(() => {
      if (!pixelAtlas || !atlasReady) return undefined
      const image = imageRef.current
      const canvas = canvasRef.current
      if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return undefined
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return undefined
      const columns = 8
      const rows = image.naturalHeight % 11 === 0 ? 11 : image.naturalHeight % 9 === 0 ? 9 : 1
      const frameWidth = image.naturalWidth / columns
      const frameHeight = image.naturalHeight / rows
      canvas.width = frameWidth
      canvas.height = frameHeight
      const frames = Array.from({ length: columns }, (_, frame) => frame)
      let index = 0
      const draw = () => {
        const frame = frames[index % frames.length]
        context.clearRect(0, 0, frameWidth, frameHeight)
        context.drawImage(image, frame * frameWidth, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight)
        index += 1
      }
      draw()
      const timer = setInterval(draw, 150)
      return () => clearInterval(timer)
    }, [pixelAtlas, atlasReady, config.mediaUrl])
    const bubbleTimer = React.useRef(null)
    const reactionTimer = React.useRef(null)
    const clamp = React.useCallback(point => ({ x: Math.max(6, Math.min(window.innerWidth - 90, point.x)), y: Math.max(6, Math.min(window.innerHeight - 90, point.y)) }), [])
    React.useEffect(() => {
      const onResize = () => setPosition(current => clamp(current))
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [clamp])
    React.useEffect(() => () => {
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      if (reactionTimer.current) clearTimeout(reactionTimer.current)
    }, [])
    const interact = () => {
      const lines = config.behavior.speechLines || []
      if (lines.length) setBubble(lines[Math.floor(Math.random() * lines.length)])
      setReaction(config.behavior.clickMotion)
      if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
      if (reactionTimer.current) clearTimeout(reactionTimer.current)
      bubbleTimer.current = setTimeout(() => setBubble(''), 2600)
      reactionTimer.current = setTimeout(() => setReaction(''), 700)
    }
    React.useEffect(() => {
      const seconds = Number(config.behavior.autoSpeakIntervalSec)
      const lines = config.behavior.speechLines || []
      if (!Number.isFinite(seconds) || seconds < 30 || !lines.length) return undefined
      const timer = setInterval(() => {
        if (document.hidden || drag.current) return
        setBubble(lines[Math.floor(Math.random() * lines.length)])
        if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setBubble(''), 3200)
      }, seconds * 1000)
      return () => clearInterval(timer)
    }, [config.petId, config.behavior.autoSpeakIntervalSec])
    const onPointerDown = event => {
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y, startX: event.clientX, startY: event.clientY, moved: false }
    }
    const onPointerMove = event => {
      if (!drag.current) return
      if (Math.abs(event.clientX - drag.current.startX) + Math.abs(event.clientY - drag.current.startY) > 5) drag.current.moved = true
      const nextPosition = clamp({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy })
      positionRef.current = nextPosition
      setPosition(nextPosition)
    }
    const onPointerUp = event => {
      if (!drag.current) return
      const moved = drag.current.moved
      drag.current = null
      event.currentTarget.releasePointerCapture(event.pointerId)
      try { localStorage.setItem(`deepblue-pet-position:${config.petId}`, JSON.stringify(positionRef.current)) } catch { /* Private browsing may reject local storage writes. */ }
      if (!moved) interact()
    }
    const style = { left: position.x, top: position.y, '--deepblue-pet-width': `${config.behavior.widthPx}px` }
    return ReactDOM.createPortal(React.createElement('div', { className: 'deepblue-pet-host' },
      React.createElement('button', { type: 'button', className: 'deepblue-pet', style, 'data-idle': config.behavior.idleMotion, 'data-hover': config.behavior.hoverMotion || undefined, 'data-reaction': reaction || undefined, 'data-held': String(held), 'data-pack-kind': config.packKind || 'image', 'aria-label': '网页宠物，可拖动位置，点击互动，双击表达喜欢', onDoubleClick: () => { setReaction('heart'); if (reactionTimer.current) clearTimeout(reactionTimer.current); reactionTimer.current = setTimeout(() => setReaction(''), 700) }, onPointerDown, onPointerMove, onPointerUp },
        React.createElement('span', { className: 'deepblue-pet-visual' },
          bubble ? React.createElement('span', { className: 'deepblue-pet-bubble', role: 'status' }, bubble) : null,
          React.createElement('span', { className: 'deepblue-pet-sparks' }),
          React.createElement('img', { ref: imageRef, src: config.mediaUrl, alt: '', draggable: false, onLoad: () => { if (pixelAtlas) setAtlasReady(value => value + 1) } }),
          animated || pixelAtlas ? React.createElement('canvas', { ref: canvasRef, 'aria-hidden': 'true' }) : null
        )
      )
    ), document.body)
  }

  exports.inject = ['slots', 'theme']
  exports.apply = async function apply(ctx) {
    const [skin, pet] = await Promise.all([loadConfig('/deepblue-skin/config'), loadConfig('/deepblue-pet/config')])
    if (skin?.schemaVersion === 1 && ['image', 'animated-image', 'video'].includes(skin.mediaKind) && typeof skin.mediaUrl === 'string') {
      applySkinClarity(skin, readSkinClarity())
      ctx.effect(() => ctx.theme.overrideTokens('@deepblue/dsh-skin-runtime', {
        '--dsw-alias-bg-base': { light: 'var(--deepblue-skin-bg-base-light)', dark: 'var(--deepblue-skin-bg-base-dark)' },
        '--dsw-alias-bg-layer-1': { light: 'var(--deepblue-skin-bg-layer-1-light)', dark: 'var(--deepblue-skin-bg-layer-1-dark)' },
        '--dsw-alias-bg-layer-2': { light: 'var(--deepblue-skin-bg-layer-2-light)', dark: 'var(--deepblue-skin-bg-layer-2-dark)' },
        '--dsw-alias-bg-overlay': { light: 'rgba(255, 255, 255, .94)', dark: 'rgba(12, 24, 40, .94)' },
        '--dsw-specific-sidebar-fill': { light: 'var(--deepblue-skin-sidebar-light)', dark: 'var(--deepblue-skin-sidebar-dark)' }
      }), 'deepblue skin surface translucency')
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'deepblue-skin-wallpaper', order: -1000, inject: () => ({ config: skin }) }, Wallpaper))
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'deepblue-skin-clarity-toggle', order: 90, inject: () => ({ config: skin }) }, SkinClarityToggle))
    }
    if (pet?.schemaVersion === 1 && ['static', 'animated'].includes(pet.mediaKind) && typeof pet.mediaUrl === 'string' && pet.behavior) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'deepblue-web-pet', order: 1000, inject: () => ({ config: pet }) }, Pet))
    }
  }
  return module.exports;
} });
