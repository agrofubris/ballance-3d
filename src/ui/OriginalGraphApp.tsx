import { cloneElement, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { DEFAULT_GAMEPAD_SETTINGS } from '../controls/gamepad'
import type { GamepadButtonAction, GamepadInfo, GamepadSettings } from '../controls/gamepad'
import { OriginalGraphHost } from '../game/original-graph-host.ts'
import { LEIA_STEREO_MODE, computeHudEyeShift } from '../game/stereo-renderer.ts'
import type { StereoSettings } from '../game/stereo-renderer.ts'
import { ArtCursor, ArtSprite, ArtStage } from './OriginalArt.tsx'
import { canvasBox, pointerLayout, stageBox, stagePointer } from './original-art.ts'
import { OriginalUiContext } from './original-art-context.ts'
import { loadOriginalUiData, originalLabel } from './original-ui.ts'
import { authoredText, extraText } from './original-extra-text.ts'
import type { OriginalUiData } from './original-ui.ts'
import { MenuHighlightContext } from './menu-highlight.ts'
import { OriginalControllerPanel, OriginalExtraEntryButtons, OriginalGraphicsExtras, OriginalPhysicsNotice, OriginalStereoPanel } from './OriginalExtraPanels.tsx'
import { OriginalStereoReadout } from './OriginalStereoReadout.tsx'
import { handleStereoHotkey, readGamepad, readStereo, saveStereo } from './original-extra-settings.ts'
import type { StereoHotkeyChange } from './original-extra-settings.ts'

type ExtraPanel = 'stereo' | 'controller'

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Storage may be unavailable. */ }
}

export function OriginalGraphApp() {
  const host = useRef<HTMLDivElement>(null)
  const driver = useRef<OriginalGraphHost>(null)
  const [progress, setProgress] = useState('Loading original files')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [ui, setUi] = useState<OriginalUiData | null>(null)
  const [language, setLanguage] = useState<number | null>(null)
  const [optionsActive, setOptionsActive] = useState(false)
  const [graphicsActive, setGraphicsActive] = useState(false)
  const [mainActive, setMainActive] = useState(false)
  const [approximatePhysics, setApproximatePhysics] = useState(false)
  const [widescreen, setWidescreen] = useState(false)
  const [panel, setPanel] = useState<ExtraPanel | null>(null)
  const [stereo, setStereo] = useState<StereoSettings>(readStereo)
  const [stereoReadout, setStereoReadout] = useState<StereoHotkeyChange | null>(null)
  const [gamepadSettings, setGamepadSettings] = useState<GamepadSettings>(readGamepad)
  const [controllerInfo, setControllerInfo] = useState<GamepadInfo>({ connected: false, id: '', mapping: '', index: -1 })
  const [gamepadBinding, setGamepadBinding] = useState<GamepadButtonAction | null>(null)
  const controllerBindingFrame = useRef(-1)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ u: number; v: number } | null>(null)
  const [stereoUi, setStereoUi] = useState(() => ({ dpr: Math.max(1, window.devicePixelRatio || 1), width: window.innerWidth, height: window.innerHeight }))

  useEffect(() => {
    const graph = new OriginalGraphHost(host.current!, {
      onProgress: setProgress,
      onReady: () => {
        const value = graph.language()
        if (value === undefined) setError('The install has no registry Language value; re-export the install files')
        else setLanguage(value)
        setReady(true)
      },
      onError: failure => setError(failure.message),
    })
    driver.current = graph
    void graph.start()
    let cancelled = false
    void loadOriginalUiData().then(data => { if (!cancelled) setUi(data) }).catch((failure: unknown) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
    })
    return () => {
      cancelled = true
      driver.current = null
      graph.dispose()
    }
  }, [])

  useEffect(() => {
    driver.current?.setStereo(stereo)
    saveStereo(stereo)
  }, [stereo, ready])

  useEffect(() => {
    if (stereo.mode === 'off') return
    const key = (event: KeyboardEvent) => {
      const change = handleStereoHotkey(event, stereo)
      if (!change) return
      setStereo(change.settings)
      setStereoReadout(change)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [stereo])

  useEffect(() => {
    if (!stereoReadout) return
    const timer = window.setTimeout(() => setStereoReadout(null), 2000)
    return () => window.clearTimeout(timer)
  }, [stereoReadout])

  useEffect(() => {
    driver.current?.setGamepadSettings(gamepadSettings)
    save('ballance-original-gamepad', gamepadSettings)
  }, [gamepadSettings, ready])

  useEffect(() => {
    const update = () => setStereoUi({ dpr: Math.max(1, window.devicePixelRatio || 1), width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    if (ready) {
      setWidescreen(driver.current!.widescreen)
      setApproximatePhysics(driver.current!.physicsBackend === 'rapier')
    }
  }, [ready])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      const graph = driver.current
      const active = graph?.isMenuOptionsActive() ?? false
      setOptionsActive(current => current === active ? current : active)
      const graphics = graph?.isMenuGraphicsActive() ?? false
      setGraphicsActive(current => current === graphics ? current : graphics)
      const main = graph?.isMenuMainActive() ?? false
      setMainActive(current => current === main ? current : main)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    let timer = 0
    const update = () => {
      const info = driver.current?.getGamepadInfo()
      if (info) setControllerInfo(info)
      timer = window.setTimeout(update, 500)
    }
    update()
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!panel || !gamepadBinding) return
    let frame = 0, last = controllerBindingFrame.current
    const tick = () => {
      const graph = driver.current
      if (graph) {
        const snapshot = graph.getGamepadSnapshot()
        if (snapshot.frame !== last) {
          last = snapshot.frame
          const index = graph.gamepadBindingPress()
          if (index !== undefined) {
            setGamepadSettings(current => ({ ...current, buttons: { ...current.buttons, [gamepadBinding]: index } }))
            setGamepadBinding(null)
            graph.playMenuSound()
            return
          }
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [panel, gamepadBinding])

  // The stereo modes draw the pointer themselves (OriginalArt.ArtCursor) and
  // hit-test in shared stage coordinates so both eye copies address the same control.
  useEffect(() => {
    if (stereo.mode === 'off' || !(panel || optionsActive || graphicsActive)) return
    const layout = pointerLayout(stereo.mode), app = host.current?.parentElement
    if (!app) return
    const locate = (event: MouseEvent) => {
      const box = app.getBoundingClientRect()
      const x = event.clientX - box.left, y = event.clientY - box.top
      // The Leia page is the pair: the x fold uses the page half, but each
      // half is a complete eye frame, so map inside its own 4:3 stage.
      if (stereo.mode === LEIA_STEREO_MODE) {
        const frameWidth = box.width / 2
        return stagePointer(x, y, box.width, box.height, layout, stageBox(frameWidth, box.height), frameWidth)
      }
      return stagePointer(x, y, box.width, box.height, layout)
    }
    const hit = (point: { u: number; v: number }) => {
      const root = app.querySelector<HTMLElement>('.original-menu.stereo-eye-left')
      if (!root) return null
      let found: HTMLButtonElement | null = null
      for (const button of root.querySelectorAll<HTMLButtonElement>('.art-button:not(:disabled)')) {
        const [x0, y0, x1, y1] = (button.dataset.rect ?? '').split(',').map(Number)
        if (x0 !== undefined && y0 !== undefined && x1 !== undefined && y1 !== undefined && point.u >= x0 && point.u <= x1 && point.v >= y0 && point.v <= y1) found = button
      }
      return found
    }
    const move = (event: PointerEvent) => {
      const point = locate(event)
      setPointer(point)
      setHighlighted(hit(point)?.dataset.control ?? null)
    }
    const click = (event: MouseEvent) => {
      const button = hit(locate(event))
      if (!button) return
      event.preventDefault()
      event.stopImmediatePropagation()
      button.click()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('click', click, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('click', click, true)
      setPointer(null)
    }
  }, [stereo.mode, panel, optionsActive, graphicsActive])

  // Leia is a launch mode (a window cannot switch to offscreen live). Crossing
  // into or out of it saves the panel settings synchronously, then asks the
  // shell to store the flag and relaunch.
  const changeStereo = (next: StereoSettings) => {
    const wasLeia = stereo.mode === LEIA_STEREO_MODE
    const isLeia = next.mode === LEIA_STEREO_MODE
    setStereo(next)
    if (wasLeia !== isLeia) {
      saveStereo(next)
      void Promise.resolve(window.ballanceShell?.setLeia?.(isLeia)).catch(() => {})
    }
  }

  const playMenuSound = () => driver.current?.playMenuSound()

  const changeWidescreen = (value: boolean) => {
    driver.current?.setWidescreen(value)
    setWidescreen(value)
    playMenuSound()
  }

  const openPanel = (next: ExtraPanel) => {
    const graph = driver.current
    if (!graph?.openExtraPanel()) return
    graph.playMenuSound()
    if (next === 'controller') {
      setGamepadSettings(readGamepad())
      graph.reloadGamepadSettings()
      setControllerInfo(graph.getGamepadInfo())
    }
    setHighlighted(null)
    setPanel(next)
  }

  const closePanel = () => {
    if (gamepadBinding) { setGamepadBinding(null); return }
    const graph = driver.current
    graph?.closeExtraPanel()
    graph?.playMenuSound()
    setHighlighted(null)
    setPanel(null)
  }
  const closeRef = useRef(closePanel)
  useEffect(() => { closeRef.current = closePanel })

  // The pad drives the port's panels like their keys: up/down move the focus,
  // accept presses the focused button and cancel goes back.
  useEffect(() => {
    if (!panel || gamepadBinding) return
    let frame = 0, last = driver.current?.getGamepadSnapshot().frame ?? -1
    let vertical = Math.sign(driver.current?.getGamepadSnapshot().moveZ ?? 0)
    const tick = () => {
      const snapshot = driver.current?.getGamepadSnapshot()
      if (snapshot && snapshot.frame !== last) {
        last = snapshot.frame
        const sign = Math.sign(snapshot.moveZ)
        const step = sign !== vertical ? sign : 0
        vertical = sign
        if (snapshot.justPressed.has('cancel')) { closeRef.current(); return }
        if (snapshot.justPressed.has('accept')) {
          const focused = document.activeElement
          if (focused instanceof HTMLButtonElement && !focused.disabled) focused.click()
        } else if (step) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: step < 0 ? 'ArrowUp' : 'ArrowDown', bubbles: true }))
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [panel, gamepadBinding])

  useEffect(() => {
    if (!panel) return
    const root = host.current?.parentElement?.querySelector<HTMLElement>('.original-menu.stereo-eye-left') ?? host.current?.parentElement?.querySelector<HTMLElement>('.original-menu')
    const key = (event: KeyboardEvent) => {
      if (gamepadBinding) {
        if (event.code === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setGamepadBinding(null) }
        return
      }
      if (event.code === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return }
      if ((event.target as HTMLElement).tagName === 'INPUT') return
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Space'].includes(event.code)) event.stopImmediatePropagation()
      if (['ArrowUp', 'ArrowDown', 'Tab'].includes(event.code) && root) {
        event.preventDefault()
        const items = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const delta = event.code === 'ArrowUp' || event.shiftKey ? -1 : 1
        items[(current + delta + items.length) % items.length]?.focus()
        playMenuSound()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  useEffect(() => {
    if (!panel) return
    const root = host.current?.parentElement?.querySelector<HTMLElement>('.original-menu.stereo-eye-left') ?? host.current?.parentElement?.querySelector<HTMLElement>('.original-menu')
    root?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [panel])

  const label = (index: number) => language === null ? originalLabel(ui, index) : authoredText(language, index)
  const text = extraText(language ?? 1)
  // One half is one eye frame in Leia SR, so its UI Depth shift is measured
  // against the half's width like an sbs-full eye. Otherwise it is measured
  // against the game canvas, as the host measures the WebGL menu's shift.
  const stereoEyeWidth = stereo.mode === LEIA_STEREO_MODE ? stereoUi.width / 2 : canvasBox(stereoUi.width, stereoUi.height, widescreen).width
  const stereoStageStyle = {
    '--stereo-row-height': `${1 / stereoUi.dpr}px`,
    '--stereo-eye-shift': `${computeHudEyeShift(stereoEyeWidth, stereo.separation, stereo.uiDepth)}px`,
  } as CSSProperties

  type Layer = ReactElement<{ className?: string; 'aria-hidden'?: boolean }>
  const renderLayer = (element: Layer, interactive: boolean, eye: 'left' | 'right') =>
    cloneElement(element, {
      className: `${element.props.className ?? ''} stereo-eye stereo-eye-${eye}`,
      'aria-hidden': interactive ? undefined : true,
    })
  const withEyes = (element: Layer) => stereo.mode === 'off' ? element
    : <div className="stereo-menu-stage menu-stereo-stage" data-mode={stereo.mode} style={stereoStageStyle}>
      {renderLayer(element, true, 'left')}
      {renderLayer(element, false, 'right')}
    </div>

  const panelElement = panel && <div className="original-menu" data-panel={panel} role="dialog" aria-modal="true" aria-label={text(panel === 'stereo' ? 'stereo' : 'controller')}>
    <ArtStage>
      <ArtSprite name="M_BlackScreen" />
      {panel === 'stereo' && <OriginalStereoPanel ui={ui} stereo={stereo} onChange={changeStereo} onBack={closePanel} label={label} text={text} />}
      {panel === 'controller' && <OriginalControllerPanel ui={ui} controllerInfo={controllerInfo} gamepadSettings={gamepadSettings} gamepadBinding={gamepadBinding} onBind={action => { controllerBindingFrame.current = driver.current?.getGamepadSnapshot().frame ?? -1; playMenuSound(); setGamepadBinding(action) }} onSettings={setGamepadSettings} onReset={() => { setGamepadBinding(null); setGamepadSettings({ ...DEFAULT_GAMEPAD_SETTINGS, buttons: { ...DEFAULT_GAMEPAD_SETTINGS.buttons } }) }} onBack={closePanel} label={label} text={text} language={language ?? 1} />}
      <ArtCursor point={stereo.mode === 'off' ? null : pointer} />
    </ArtStage>
  </div>

  const extraElement = optionsActive && !panel && language !== null && <div className="original-menu original-graph-extra">
    <style>{'.original-graph-extra:not(.stereo-eye){pointer-events:none}.original-graph-extra:not(.stereo-eye) .art-button{pointer-events:auto}'}</style>
    <ArtStage>
      <OriginalExtraEntryButtons text={text} onStereo={() => openPanel('stereo')} onController={() => openPanel('controller')} />
    </ArtStage>
  </div>

  const graphicsElement = graphicsActive && !panel && language !== null && <div className="original-menu original-graph-extra">
    <style>{'.original-graph-extra:not(.stereo-eye){pointer-events:none}.original-graph-extra:not(.stereo-eye) .art-button{pointer-events:auto}'}</style>
    <ArtStage>
      <OriginalGraphicsExtras ui={ui} text={text} label={label} widescreen={widescreen} onWidescreen={changeWidescreen} />
    </ArtStage>
  </div>

  const physicsElement = approximatePhysics && mainActive && !panel && language !== null && <div className="original-menu original-graph-extra">
    <style>{'.original-graph-extra:not(.stereo-eye){pointer-events:none}'}</style>
    <ArtStage>
      <OriginalPhysicsNotice text={text} />
    </ArtStage>
  </div>

  const readoutElement = stereoReadout && stereo.mode !== 'off' && language !== null && <OriginalStereoReadout text={text} change={stereoReadout} />

  return <OriginalUiContext.Provider value={ui}>
    <main className={`original-app original-graph-app ${stereo.mode !== 'off' && (panel || optionsActive || graphicsActive) ? 'stereo-pointer' : ''}`}>
      <div className="game-canvas" ref={host} />
      <MenuHighlightContext.Provider value={{ highlighted, setHighlighted }}>
        {panelElement && withEyes(panelElement)}
        {extraElement && withEyes(extraElement)}
        {graphicsElement && withEyes(graphicsElement)}
        {physicsElement && withEyes(physicsElement)}
        {readoutElement && withEyes(readoutElement)}
      </MenuHighlightContext.Provider>
      {!ready && !error && <div className="original-loading" role="status" aria-label="Loading"><div className="loading-track"><span /></div><p>{progress}</p></div>}
      {error && <div className="original-error" role="alert"><p>{error}</p><button onClick={() => location.reload()}>Retry</button></div>}
    </main>
  </OriginalUiContext.Provider>
}
