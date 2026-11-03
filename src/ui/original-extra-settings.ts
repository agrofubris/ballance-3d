import {DEFAULT_GAMEPAD_SETTINGS,GAMEPAD_BUTTON_ACTIONS} from '../controls/gamepad.ts'
import type {GamepadSettings} from '../controls/gamepad.ts'
import {DEFAULT_STEREO_SETTINGS,LEIA_STEREO_MODE,shellLeiaActive,shellLeiaAvailable} from '../game/stereo-renderer.ts'
import type {StereoMode,StereoSettings} from '../game/stereo-renderer.ts'

function read<T,>(key:string,fallback:T):T {try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}

/** The panel step per stereo value: minimum, maximum and increment shared by the panel and its hotkeys. */
export const stereoValueRanges={
  separation:[0,1,.005],
  convergence:[1,100,1],
  uiDepth:[0,100,5],
} as const satisfies Record<'separation'|'convergence'|'uiDepth',readonly [number,number,number]>
export type StereoValueKey=keyof typeof stereoValueRanges

/** The panel's step snapping: three decimals of a step-quantized value. */
export const snap=(value:number,step:number)=>Number((Math.round(value/step)*step).toFixed(4))

/** The value text the panel draws (`Separation 0.125`, `Convergence 21`, `Menu depth 35%`). */
export function stereoValueText(key:StereoValueKey,value:number):string {
  return key==='separation'?value.toFixed(3):key==='convergence'?value.toFixed(0):`${value}%`
}

/** Serialize the stereo settings exactly as the panel's change path saves them. */
export function saveStereo(settings:StereoSettings):void {
  try{localStorage.setItem('ballance-original-stereo',JSON.stringify(settings))}catch{/* Storage may be unavailable. */}
}

/** Every saved/selectable stereo mode, with Leia SR between the full layouts and interlaced. */
export const allStereoModes:readonly {mode:StereoMode}[]=[
  {mode:'off'},
  {mode:'sbs'},
  {mode:'crossview'},
  {mode:'sbs-full'},
  {mode:'tab'},
  {mode:'tab-full'},
  {mode:LEIA_STEREO_MODE},
  {mode:'interlaced'},
  {mode:'interlaced-reversed'},
]

/** The modes the browser lists: Leia SR needs the shell's offscreen pair. */
export const stereoModes:readonly {mode:StereoMode}[]=allStereoModes.filter(option=>option.mode!==LEIA_STEREO_MODE)

/** The 3D Stereo panel's list; Leia SR is inserted only when the shell reports it. */
export function stereoModeOptions(leiaAvailable=shellLeiaAvailable()):readonly {mode:StereoMode}[] {
  return leiaAvailable?allStereoModes:stereoModes
}

export function readStereo():StereoSettings {
  const saved=read<Partial<StereoSettings>>('ballance-original-stereo',{})
  const savedMode=allStereoModes.find(option=>option.mode===saved.mode)?.mode??DEFAULT_STEREO_SETTINGS.mode
  // The offscreen pair always starts in Leia SR; a saved id read without it
  // (the browser) falls back to the default mode instead of a broken layout.
  const active=shellLeiaActive()
  const mode=active?LEIA_STEREO_MODE:savedMode===LEIA_STEREO_MODE?DEFAULT_STEREO_SETTINGS.mode:savedMode
  const separation=typeof saved.separation==='number'&&Number.isFinite(saved.separation)?saved.separation:DEFAULT_STEREO_SETTINGS.separation
  const convergence=typeof saved.convergence==='number'&&Number.isFinite(saved.convergence)?saved.convergence:DEFAULT_STEREO_SETTINGS.convergence
  const uiDepth=typeof saved.uiDepth==='number'&&Number.isFinite(saved.uiDepth)?Math.min(100,Math.max(0,saved.uiDepth)):DEFAULT_STEREO_SETTINGS.uiDepth
  const defaultEnabled=saved.defaultEnabled===true
  return {mode:active||defaultEnabled?mode:'off',separation,convergence,uiDepth,defaultEnabled}
}

/** The subset of a KeyboardEvent the stereo hotkeys read and must consume. */
export interface StereoHotkeyEvent {
  code:string
  ctrlKey:boolean
  altKey:boolean
  metaKey:boolean
  repeat:boolean
  preventDefault():void
  stopImmediatePropagation():void
}

export interface StereoHotkeyChange {
  settings:StereoSettings
  key:StereoValueKey
  shown:string
}

const STEREO_HOTKEYS:Readonly<Record<string,readonly [StereoValueKey,-1|1]>>={
  ArrowLeft:['separation',-1],
  ArrowRight:['separation',1],
  ArrowDown:['convergence',-1],
  ArrowUp:['convergence',1],
  PageDown:['uiDepth',-1],
  PageUp:['uiDepth',1],
}

/**
 * A Ctrl+arrow/Page press on an active stereo mode: the next panel value,
 * snapped and clamped like the panel, or null when the event is not a stereo
 * hotkey. A recognized event is consumed here, before the menu, the gameplay
 * keys or the host's own window listener see it.
 */
export function handleStereoHotkey(event:StereoHotkeyEvent,settings:StereoSettings):StereoHotkeyChange|null {
  if(settings.mode==='off')return null
  // The install's key table can bind either Ctrl (Menu_Opt_Keys' SetKey stores
  // the pressed DIK in the Keyboard array), so reserve it while stereo is on:
  // consuming the press keeps a Ctrl binding from starting. Keyup is left to
  // the host so its held-key set always clears.
  if(event.code==='ControlLeft'||event.code==='ControlRight'){
    event.preventDefault()
    event.stopImmediatePropagation()
    return null
  }
  const binding=STEREO_HOTKEYS[event.code]
  if(!binding||!event.ctrlKey||event.altKey||event.metaKey)return null
  // A held key repeats; consume those too so they cannot reach menu navigation,
  // but step once per physical press.
  event.preventDefault()
  event.stopImmediatePropagation()
  if(event.repeat)return null
  const [key,direction]=binding,[min,max,step]=stereoValueRanges[key]
  const value=Math.min(max,Math.max(min,snap(settings[key]+direction*step,step)))
  return {settings:{...settings,[key]:value},key,shown:stereoValueText(key,value)}
}

export function readGamepad():GamepadSettings {
  const saved=read<Partial<GamepadSettings>>('ballance-original-gamepad',{})
  const deadZone=typeof saved.deadZone==='number'&&Number.isFinite(saved.deadZone)?Math.min(.5,Math.max(0,saved.deadZone)):DEFAULT_GAMEPAD_SETTINGS.deadZone
  const buttons=Object.fromEntries(GAMEPAD_BUTTON_ACTIONS.map(action=>{
    const index=Number(saved.buttons?.[action])
    return [action,Number.isInteger(index)&&index>=0?index:DEFAULT_GAMEPAD_SETTINGS.buttons[action]]
  })) as GamepadSettings['buttons']
  return {...DEFAULT_GAMEPAD_SETTINGS,...saved,deadZone,cameraStick:saved.cameraStick===true,cameraAxisX:typeof saved.cameraAxisX==='number'&&Number.isInteger(saved.cameraAxisX)&&saved.cameraAxisX>=0?saved.cameraAxisX:DEFAULT_GAMEPAD_SETTINGS.cameraAxisX,buttons}
}
