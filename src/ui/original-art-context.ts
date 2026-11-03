import {createContext,useContext,type CSSProperties} from 'react'
import {spriteBox} from './original-art'
import type {OriginalUiData,OriginalUiSprite} from './original-ui'

/** The recovered interface data every art component draws from. */
export const OriginalUiContext=createContext<OriginalUiData|null>(null)
export const useOriginalUi=()=>useContext(OriginalUiContext)
/** Width of the enclosing sprite in render pixels (640x480 window), the wrapping width of its text. */
export const BoxWidthContext=createContext<number>(Infinity)
export const REFERENCE_WIDTH=640

export function findSprite(ui:OriginalUiData,name:string):OriginalUiSprite|undefined {
  return ui.sprites[name]??ui.hudSprites[name]??ui.tutorialSprites[name]
}
export function requireSprite(ui:OriginalUiData,name:string):OriginalUiSprite {
  const sprite=findSprite(ui,name)
  if(!sprite)throw new Error(`Original UI sprite ${name} is not in the recovered data`)
  return sprite
}
/** Fonts are keyed by their authored name; a few contain 8-bit characters. */
export function findFont(ui:OriginalUiData,name:string):string {
  if(ui.fonts[name])return name
  const match=Object.keys(ui.fonts).find(key=>key.startsWith(name))
  if(!match)throw new Error(`Original UI font ${name} is not in the recovered data`)
  return match
}

/** Positions an overlay (the hidden text input) exactly over an authored sprite. */
export function spriteStyle(ui:OriginalUiData|null,name:string):CSSProperties|undefined {
  const sprite=ui&&findSprite(ui,name)
  return sprite?{...spriteBox(sprite),zIndex:sprite.z+1}:undefined
}
