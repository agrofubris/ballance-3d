import {useContext,useEffect,useState,type CSSProperties,type ReactNode} from 'react'
import {MenuHighlightContext} from './menu-highlight'
import {BoxWidthContext,REFERENCE_WIDTH,findFont,requireSprite,useOriginalUi} from './original-art-context'
import {layoutText,materialCss,shadowOffset,spriteBox,textAlignment,textureUrl,type MaterialCss} from './original-art'
import type {OriginalUiData,OriginalUiFontStyle} from './original-ui'

/** A 4:3 window the 2D entities are laid out in, centered in the available area. */
export function ArtStage({children,className='',style}:{children:ReactNode;className?:string;style?:CSSProperties}) {
  return <div className={`art-stage ${className}`} style={style}>{children}</div>
}

function MaterialLayer({ui,material,uv,alpha}:{ui:OriginalUiData;material:string;uv:readonly number[];alpha?:number}) {
  const definition=ui.materials[material]
  if(!definition)throw new Error(`Original UI material ${material} is not in the recovered data`)
  // `Set Diffuse` rewrites the material's diffuse alpha; the colour keeps modulating the texture.
  const effective=alpha===undefined?definition:{...definition,diffuse:[definition.diffuse[0]!,definition.diffuse[1]!,definition.diffuse[2]!,alpha]}
  return <div className="art-material" style={materialCss(ui,effective,uv) as MaterialCss as CSSProperties}/>
}

export interface ArtSpriteProps {
  name:string
  /** Overrides the authored material (button states). */
  material?:string|null
  hidden?:boolean
  /** Place the sprite at another normalized rectangle (port-only layouts). */
  rect?:readonly number[]
  /** Diffuse alpha of the sprite's material (authored `Set Diffuse` fades). */
  diffuseAlpha?:number
  className?:string
  style?:CSSProperties
  children?:ReactNode
}

/** A recovered 2D entity: authored rectangle, Z order, material and texture window. */
export function ArtSprite({name,material,hidden=false,rect,diffuseAlpha,className='',style,children}:ArtSpriteProps) {
  const ui=useOriginalUi()
  if(!ui||hidden)return null
  const sprite=requireSprite(ui,name),chosen=material===undefined?sprite.material:material,box=rect??sprite.rect
  return <BoxWidthContext.Provider value={(box[2]!-box[0]!)*REFERENCE_WIDTH}><div className={`art-sprite ${className}`} data-sprite={name} style={{...spriteBox({rect:rect??sprite.rect}),zIndex:sprite.z,...style}}>
    {chosen&&<MaterialLayer ui={ui} material={chosen} uv={sprite.uv} alpha={diffuseAlpha}/>}
    {children}
  </div></BoxWidthContext.Provider>
}

const toColor=(color:readonly number[],alpha=color[3]??1)=>`rgba(${Math.round(color[0]!*255)},${Math.round(color[1]!*255)},${Math.round(color[2]!*255)},${alpha})`
const px=(value:number)=>`calc(var(--k) * ${Math.round(value*1000)/1000})`

export interface ArtTextProps {
  font:string
  text:string|number
  /** `2D Text` alignment bits: 0 centers, 1 left, 2 right, 4 top, 8 bottom. */
  align?:number
  /** Index into the font's authored `Set Font Properties` styles. */
  style?:number
  /** Replace the style colour (used for authored fades and the disabled font). */
  color?:readonly number[]
  /** `2D Text` margins (left, top, right, bottom) in render pixels; the authored default is 2. */
  margins?:readonly number[]
  /** `2D Text` offset (x, y) in render pixels, added to the aligned position. */
  offset?:readonly number[]
  className?:string
}

/**
 * Text drawn glyph by glyph from the `Font_1` atlas with the authored font
 * metrics, scale, spacing, colour and drop shadow. Glyphs are masks of the white
 * atlas, so the colour (and its alpha) is exactly the authored one.
 */
export function ArtText({font,text,align=0,style=0,color,margins=[2,2,2,2],offset,className=''}:ArtTextProps) {
  const ui=useOriginalUi(),boxWidth=useContext(BoxWidthContext)
  if(!ui)return null
  const name=findFont(ui,font),definition=ui.fonts[name]!,fontStyle:OriginalUiFontStyle=definition.styles[style]??definition.styles[0]!
  if(!fontStyle)throw new Error(`Original UI font ${name} has no authored style`)
  if(typeof fontStyle.setting!=='number')throw new Error(`Original UI font ${name} has no Set Font Properties setting; regenerate ui-data.json`)
  const layout=layoutText(ui,name,String(text),fontStyle,boxWidth-margins[0]!-margins[2]!)
  const alignment=textAlignment(align),url=textureUrl(ui,definition.texture)
  const [shadowX,shadowY]=shadowOffset(fontStyle),fill=color??fontStyle.color
  const rows=(tint:string)=>layout.lines.map((line,lineIndex)=>
    <div className="art-line" key={lineIndex} style={{width:px(line.width),height:px(layout.lineHeight),alignSelf:alignment.horizontal==='left'?'flex-start':alignment.horizontal==='right'?'flex-end':'center'}}>
      {line.glyphs.map((glyph,index)=>glyph.code===32?null:<span className="art-glyph" key={index} style={{
        left:px(glyph.x),width:px(glyph.width),height:px(glyph.height),backgroundColor:tint,
        WebkitMaskImage:`url(${url})`,maskImage:`url(${url})`,
        WebkitMaskSize:`${px(glyph.atlasWidth)} ${px(glyph.atlasHeight)}`,maskSize:`${px(glyph.atlasWidth)} ${px(glyph.atlasHeight)}`,
        WebkitMaskPosition:`calc(var(--k) * ${-Math.round(glyph.u0*glyph.atlasWidth*1000)/1000}) calc(var(--k) * ${-Math.round(glyph.v0*glyph.atlasHeight*1000)/1000})`,
        maskPosition:`calc(var(--k) * ${-Math.round(glyph.u0*glyph.atlasWidth*1000)/1000}) calc(var(--k) * ${-Math.round(glyph.v0*glyph.atlasHeight*1000)/1000})`,
      }}/>)}
    </div>)
  return <div className={`art-text ${className}`} aria-hidden="true" style={{
    padding:`${px(margins[1]!)} ${px(margins[2]!)} ${px(margins[3]!)} ${px(margins[0]!)}`,
    alignItems:alignment.horizontal==='left'?'flex-start':alignment.horizontal==='right'?'flex-end':'center',
    justifyContent:alignment.vertical==='top'?'flex-start':alignment.vertical==='bottom'?'flex-end':'center',
  }}>
    <div className="art-text-block" style={{width:px(layout.width),height:px(layout.height),...(offset?{transform:`translate(${px(offset[0]!)},${px(offset[1]!)})`}:{})}}>
      {(fontStyle.setting&2)!==0&&fontStyle.shadowColor[3]!>0&&<div className="art-text-shadow" style={{transform:`translate(${px(shadowX)},${px(shadowY)})`}}>{rows(toColor(fontStyle.shadowColor))}</div>}
      <div className="art-text-ink">{rows(toColor(fill))}</div>
    </div>
  </div>
}

/** A text-only sprite: the authored box with its bound font. */
export function ArtLabel({name,children,font,align,style,color,hidden,rect,offset,className=''}:{name:string;children:string|number;font?:string;align?:number;style?:number;color?:readonly number[];hidden?:boolean;rect?:readonly number[];offset?:readonly number[];className?:string}) {
  const ui=useOriginalUi()
  if(!ui||hidden)return null
  const binding=ui.textBindings[name]?.[0]
  const fontName=font??binding?.font??'GameFont_01'
  return <ArtSprite name={name} rect={rect} className={`art-label ${className}`}><ArtText font={fontName} text={children} align={align??binding?.align??0} style={style} color={color} margins={binding?.margins??undefined} offset={offset}/></ArtSprite>
}

export interface ArtButtonProps {
  name:string
  children?:string|number
  onClick:()=>void
  disabled?:boolean
  /** Draw the highlighted material (selected option, toggled switch). */
  selected?:boolean
  font?:string
  align?:number
  ariaLabel?:string
  /** Button art without text (the arrows): the atlas window is the whole look. */
  hidden?:boolean
  rect?:readonly number[]
  /** Force a material (switches draw their chosen value with `M_Button_Inactive`). */
  material?:string
  /** The label's `2D Text` offset in render pixels. */
  textOffset?:readonly number[]
  onFocus?:()=>void
}

/**
 * An interactive sprite. `M_Button_Up` is the idle state, `M_Button_Over` the
 * hovered/focused/selected one and `M_Button_Inactive` the disabled one, exactly
 * the materials the authored `Menu` scripts swap with `Set 2D Material`.
 */
export function ArtButton({name,children,onClick,disabled=false,selected=false,font,align,ariaLabel,hidden=false,rect,material:forced,textOffset,onFocus}:ArtButtonProps) {
  const ui=useOriginalUi(),{highlighted,setHighlighted}=useContext(MenuHighlightContext)
  if(!ui||hidden)return null
  const sprite=requireSprite(ui,name),box=rect??sprite.rect
  // Several controls share one authored sprite (the stereo modes reuse a small button); the rectangle tells them apart.
  const id=`${name}@${box.map(v=>v.toFixed(4)).join(',')}`,mirrored=highlighted===id
  const material=mirrored&&!disabled?'M_Button_Over':forced??(disabled?'M_Button_Inactive':selected?'M_Button_Over':'M_Button_Up')
  const binding=ui.textBindings[name]?.[0]
  const label=children===undefined?undefined:String(children)
  return <button type="button" className={`art-button ${selected?'selected':''} ${mirrored?'stereo-highlight':''}`} data-sprite={name} data-control={id} data-rect={box.join(',')} disabled={disabled}
    style={{...spriteBox({rect:box}),zIndex:sprite.z}} aria-label={ariaLabel??label} aria-pressed={selected||undefined}
    onClick={()=>{setHighlighted(null);onClick()}} onFocus={()=>{onFocus?.();setHighlighted(id)}} onBlur={()=>setHighlighted(null)}
    onMouseEnter={()=>setHighlighted(id)} onMouseLeave={()=>setHighlighted(null)}>
    <BoxWidthContext.Provider value={(box[2]!-box[0]!)*REFERENCE_WIDTH}>
    <MaterialLayer ui={ui} material={material} uv={sprite.uv}/>
    {label!==undefined&&<ArtText font={font??binding?.font??'GameFont_01'} text={label} align={align??binding?.align??0} margins={binding?.margins??undefined} offset={textOffset} color={disabled&&ui.fonts['GameFont_03a']?ui.fonts['GameFont_03a'].styles[0]!.color:undefined}/>}
    </BoxWidthContext.Provider>
  </button>
}

/**
 * The blinking caret of a left-aligned text entry, placed at the end of the
 * string the way `2D Text`'s caret is (the caret material is `M_Caret`).
 */
export function ArtCaret({value,font='GameFont_02'}:{value:string;font?:string}) {
  const ui=useOriginalUi()
  if(!ui)return null
  const name=findFont(ui,font),style=ui.fonts[name]!.styles[0]!,layout=layoutText(ui,name,value,style)
  const caret=ui.materials.M_Caret
  return <div className="art-caret" aria-hidden="true" style={{
    position:'absolute',left:px(layout.width+2),top:'50%',width:px(2),height:px(layout.lineHeight),transform:'translateY(-50%)',
    backgroundColor:caret?toColor(caret.diffuse):'#fff',animation:'art-caret-blink 1s steps(1) infinite',
  }}/>
}

const CREDITS_FADE_MS=500
/**
 * `Menu_Credits`: one row of the credits array at a time, the title in the big
 * credits font and the text in the small one, fading in over 500 ms, held for
 * `length * 50 + 1500` ms (the script's Calculator on the text length) and fading
 * out over 500 ms, then the next row. The logos' fades are not reproduced.
 */
export function ArtCredits({credits}:{credits:readonly {'Title Strings':string;'Text Strings':string}[]}) {
  const ui=useOriginalUi(),[clock,setClock]=useState({page:0,age:0})
  useEffect(()=>{
    if(!credits.length)return
    let frame=0,last=performance.now()
    const tick=(now:number)=>{
      const dt=now-last;last=now
      setClock(current=>{
        const hold=credits[current.page]!['Text Strings'].length*50+1500
        const age=current.age+dt
        return age>=CREDITS_FADE_MS*2+hold?{page:(current.page+1)%credits.length,age:0}:{page:current.page,age}
      })
      frame=requestAnimationFrame(tick)
    }
    frame=requestAnimationFrame(tick)
    return ()=>cancelAnimationFrame(frame)
  },[credits])
  if(!ui||!credits.length)return null
  const row=credits[clock.page]!,hold=row['Text Strings'].length*50+1500
  const alpha=clock.age<CREDITS_FADE_MS?clock.age/CREDITS_FADE_MS:clock.age<CREDITS_FADE_MS+hold?1:Math.max(0,1-(clock.age-CREDITS_FADE_MS-hold)/CREDITS_FADE_MS)
  const white=[1,1,1,alpha]
  return <ArtSprite name="M_Credits_Text" material={null}>
    <ArtText font="GameFont_Credits_Big" text={row['Title Strings']} align={4} color={white}/>
    <ArtText font="GameFont_Credits_Small" text={row['Text Strings']} align={4} color={white}/>
  </ArtSprite>
}

/**
 * The original `Cursor.tga` arrow, drawn inside the UI stage so both eye copies
 * show it at the UI's depth. Used instead of the operating-system pointer in the
 * stereo modes, where that pointer exists in only one eye.
 */
export function ArtCursor({point}:{point:{u:number;v:number}|null}) {
  if(!point||point.u<0||point.u>1||point.v<0||point.v>1)return null
  return <img className="art-cursor" alt="" aria-hidden="true" src="/original/textures/Cursor.png" draggable={false}
    style={{left:`${point.u*100}%`,top:`${point.v*100}%`,width:px(32),height:px(32)}} onError={event=>{event.currentTarget.style.display='none'}}/>
}
