import {Fragment} from 'react'
import {gamepadButtonLabel,GAMEPAD_BUTTON_ACTIONS} from '../controls/gamepad'
import type {GamepadButtonAction,GamepadInfo,GamepadSettings} from '../controls/gamepad'
import type {StereoSettings} from '../game/stereo-renderer'
import {ArtButton,ArtLabel,ArtSprite,ArtText} from './OriginalArt'
import {REFERENCE_WIDTH} from './original-art-context'
import {snap,stereoModeOptions,stereoValueRanges,stereoValueText} from './original-extra-settings'
import {gamepadActionText,type ExtraText} from './original-extra-text'
import type {OriginalUiData} from './original-ui'
/** The pad's name on one line: browsers append `(STANDARD GAMEPAD Vendor: ...)`; the status line holds about 28 characters. */
const padName=(id:string)=>{const name=id.replace(/\s*\(.*$/,'')||id;return name.length>28?`${name.slice(0,25)}...`:name}
const shiftRect=(ui:OriginalUiData|null,name:string,dy:number)=>{const rect=ui?.sprites[name]?.rect;return rect?[rect[0]!,rect[1]!+dy,rect[2]!,rect[3]!+dy]:undefined}
// The authored 2D Text offsets (`TT ConvertPixel-Homogen`, homogeneous -> render pixels): Menu_Opt_Keys Init
// 13194 (0.03, 0) the row labels, 13203 (0.013, 0) the keys, 13185 (0, 0.017) the invert question; Menu_Opt_Graphics
// 12316 (0, 0.017) its field labels; Menu_Opt_Sound 15003 (0, 0.015) the volume label.
const REFERENCE_HEIGHT=REFERENCE_WIDTH*3/4
const KEYS_ROW_OFFSET=[.03*REFERENCE_WIDTH,0],KEYS_KEY_OFFSET=[.013*REFERENCE_WIDTH,0]
const FIELD_LABEL_OFFSET=[0,.017*REFERENCE_HEIGHT],VOLUME_LABEL_OFFSET=[0,.015*REFERENCE_HEIGHT]
// The panels reuse the authored Options sprites at their authored size; only the vertical place changes.
const GRA_RES_FIELD_TOP=.295,GRA_CLOUDS_FIELD_TOP=.595,SOUND_VOL_FIELD_TOP=.3,KEYS_INV_FIELD_TOP=.7,KEYS_FIELD1_TOP=.3,KEYS_ROW_STEP=.04,KEYS_AUTHORED_ROWS=6,KEYS_AUTHORED_ROW_STEP=.06

/** The two extra Options entries in the original `M_Start_But_01` art. */
export function OriginalExtraEntryButtons({text,onStereo,onController}:{text:ExtraText;onStereo:()=>void;onController:()=>void}) {
  return <>
    <ArtButton name="M_Start_But_01" rect={[.403,.72,.597,.77]} font="GameFont_03" onClick={onStereo}>{text('stereo')}</ArtButton>
    <ArtButton name="M_Start_But_01" rect={[.403,.78,.597,.83]} font="GameFont_03" onClick={onController}>{text('controller')}</ArtButton>
  </>
}

/** A Sound-volume style field: the label on the field, the value between the two arrows. */
function ValueField({ui,top,name,value,onDecrease,onIncrease}:{ui:OriginalUiData|null;top:number;name:string;value:string;onDecrease:()=>void;onIncrease:()=>void}) {
  const dy=top-SOUND_VOL_FIELD_TOP
  return <>
    <ArtSprite name="M_Opt_Sound_VolField" rect={shiftRect(ui,'M_Opt_Sound_VolField',dy)}><ArtText font="GameFont_03" text={name} align={4} offset={VOLUME_LABEL_OFFSET}/></ArtSprite>
    <ArtButton name="M_Opt_Sound_VolButLeft" rect={shiftRect(ui,'M_Opt_Sound_VolButLeft',dy)} ariaLabel={`${name} -`} onClick={onDecrease}/>
    <ArtLabel name="M_Opt_Sound_VolText" rect={shiftRect(ui,'M_Opt_Sound_VolText',dy)}>{value}</ArtLabel>
    <ArtButton name="M_Opt_Sound_VolButRight" rect={shiftRect(ui,'M_Opt_Sound_VolButRight',dy)} ariaLabel={`${name} +`} onClick={onIncrease}/>
  </>
}

/** A Control-screen style yes/no field (`M_Opt_Keys_Inv_*`): Menu_Opt_Keys Init draws the chosen answer `M_Button_Up` and the other `M_Button_Inactive`. */
type YesNoSprites={field:string;yes:string;no:string;authoredTop:number}
const KEYS_INV_SPRITES:YesNoSprites={field:'M_Opt_Keys_Inv_Field',yes:'M_Opt_Keys_Inv_Yes',no:'M_Opt_Keys_Inv_No',authoredTop:KEYS_INV_FIELD_TOP}
const GRA_CLOUDS_SPRITES:YesNoSprites={field:'M_Opt_Gra_CloudsField',yes:'M_Opt_Gra_CloudsYes',no:'M_Opt_Gra_CloudsNo',authoredTop:GRA_CLOUDS_FIELD_TOP}
function YesNoField({ui,top,name,value,onChange,label,sprites=KEYS_INV_SPRITES}:{ui:OriginalUiData|null;top:number;name:string;value:boolean;onChange:(value:boolean)=>void;label:(index:number)=>string;sprites?:YesNoSprites}) {
  const dy=top-sprites.authoredTop
  return <>
    <ArtSprite name={sprites.field} rect={shiftRect(ui,sprites.field,dy)}><ArtText font="GameFont_03" text={name} align={4} offset={FIELD_LABEL_OFFSET}/></ArtSprite>
    <ArtButton name={sprites.yes} rect={shiftRect(ui,sprites.yes,dy)} font="GameFont_03" material={value?'M_Button_Up':'M_Button_Inactive'} onClick={()=>onChange(true)}>{label(34)}</ArtButton>
    <ArtButton name={sprites.no} rect={shiftRect(ui,sprites.no,dy)} font="GameFont_03" material={value?'M_Button_Inactive':'M_Button_Up'} onClick={()=>onChange(false)}>{label(35)}</ArtButton>
  </>
}

/** The port's notice under the main menu when the game runs on Rapier instead of the original IVP physics. */
export function OriginalPhysicsNotice({text}:{text:ExtraText}) {
  return <ArtSprite name="M_Opt_Gra_ResText" rect={[.1,.9,.9,.95]}><ArtText font="GameFont_03" text={text('approximatePhysics')}/></ArtSprite>
}

/** The port's own Widescreen? field on the authored Graphics screen, below its Clouds? field. */
export function OriginalGraphicsExtras({ui,text,label,widescreen,onWidescreen}:{ui:OriginalUiData|null;text:ExtraText;label:(index:number)=>string;widescreen:boolean;onWidescreen:(value:boolean)=>void}) {
  return <YesNoField ui={ui} top={.745} name={text('widescreen')} value={widescreen} onChange={onWidescreen} label={label} sprites={GRA_CLOUDS_SPRITES}/>
}

export function OriginalStereoPanel({ui,stereo,onChange,onBack,label,text}:{
  ui:OriginalUiData|null
  stereo:StereoSettings
  onChange:(settings:StereoSettings)=>void
  onBack:()=>void
  label:(index:number)=>string
  text:ExtraText
}) {
  // The mode picker is the Graphics resolution field; its arrows sit at the field's inner edges so the longest mode fits.
  const modes=stereoModeOptions(),modeDy=.14-GRA_RES_FIELD_TOP,modeIndex=Math.max(0,modes.findIndex(option=>option.mode===stereo.mode))
  const stepMode=(delta:number)=>onChange({...stereo,mode:modes[(modeIndex+delta+modes.length)%modes.length]!.mode})
  const arrowTop=.345+modeDy,arrowBottom=.3717+modeDy
  return <>
    <ArtLabel name="M_Options_Title" rect={[.35,.03,.65,.13]}>{text('stereo')}</ArtLabel>
    <ArtSprite name="M_Opt_Gra_ResField" rect={shiftRect(ui,'M_Opt_Gra_ResField',modeDy)}><ArtText font="GameFont_03" text={text('mode')} align={4} offset={FIELD_LABEL_OFFSET}/></ArtSprite>
    <ArtButton name="M_Opt_Gra_ResButLeft" rect={[.4,arrowTop,.42,arrowBottom]} ariaLabel={`${text('mode')} -`} onClick={()=>stepMode(-1)}/>
    <ArtLabel name="M_Opt_Gra_ResText" rect={[.421,arrowTop,.609,.374+modeDy]}>{text(stereo.mode)}</ArtLabel>
    <ArtButton name="M_Opt_Gra_ResButRight" rect={[.61,arrowTop,.63,arrowBottom]} ariaLabel={`${text('mode')} +`} onClick={()=>stepMode(1)}/>
    {([['separation',stereo.separation,(v:number)=>onChange({...stereo,separation:v})],['convergence',stereo.convergence,(v:number)=>onChange({...stereo,convergence:v})],['uiDepth',stereo.uiDepth,(v:number)=>onChange({...stereo,uiDepth:v})]] as const).map(([key,value,set],i)=>{
      const [min,max,step]=stereoValueRanges[key]
      return <ValueField key={key} ui={ui} top={.27+i*.13} name={text(key)} value={stereoValueText(key,value)} onDecrease={()=>set(Math.max(min,snap(value-step,step)))} onIncrease={()=>set(Math.min(max,snap(value+step,step)))}/>
    })}
    <YesNoField ui={ui} top={.66} name={text('stereoDefault')} value={stereo.defaultEnabled} onChange={defaultEnabled=>onChange({...stereo,defaultEnabled})} label={label}/>
    <ArtButton name="M_Opt_Gra_Back" onClick={onBack}>{label(15)}</ArtButton>
  </>
}

export function OriginalControllerPanel({ui,controllerInfo,gamepadSettings,gamepadBinding,onBind,onSettings,onReset,onBack,label,text,language}:{
  ui:OriginalUiData|null
  controllerInfo:GamepadInfo
  gamepadSettings:GamepadSettings
  gamepadBinding:GamepadButtonAction|null
  onBind:(action:GamepadButtonAction)=>void
  onSettings:(settings:GamepadSettings)=>void
  onReset:()=>void
  onBack:()=>void
  label:(index:number)=>string
  text:ExtraText
  language:number
}) {
  const rowDy=.15-KEYS_FIELD1_TOP
  return <>
    <ArtLabel name="M_Options_Title" rect={[.35,.01,.65,.11]}>{text('controller')}</ArtLabel>
    <ArtSprite name="M_Opt_Gra_ResText" rect={[.3,.1,.7,.14]}><ArtText font="GameFont_03" text={controllerInfo.connected?(controllerInfo.id?padName(controllerInfo.id):text('detected')):text('noController')}/></ArtSprite>
    {GAMEPAD_BUTTON_ACTIONS.map((action,i)=>{
      // The authored screen has six rows; a seventh reuses the sixth row's sprites one step lower.
      const row=Math.min(i,KEYS_AUTHORED_ROWS-1)
      const dy=rowDy-row*(KEYS_AUTHORED_ROW_STEP-KEYS_ROW_STEP)+(i-row)*KEYS_ROW_STEP
      return <Fragment key={action}>
        <ArtButton name={`M_Opt_Keys_Field${row+1}`} rect={shiftRect(ui,`M_Opt_Keys_Field${row+1}`,dy)} align={1} textOffset={KEYS_ROW_OFFSET} font="GameFont_03" onClick={()=>onBind(action)}>{gamepadActionText(text,language,action)}</ArtButton>
        <ArtLabel name={`M_Opt_Keys_Key${row+1}`} rect={shiftRect(ui,`M_Opt_Keys_Key${row+1}`,dy)} align={1} offset={KEYS_KEY_OFFSET}>{gamepadBinding===action?'...':gamepadButtonLabel(gamepadSettings.buttons[action])}</ArtLabel>
      </Fragment>
    })}
    <YesNoField ui={ui} top={.435} name={text('analogSteering')} value={gamepadSettings.analogSteering} onChange={analogSteering=>onSettings({...gamepadSettings,analogSteering})} label={label}/>
    <ValueField ui={ui} top={.535} name={text('deadZone')} value={`${Math.round(gamepadSettings.deadZone*100)}%`}
      onDecrease={()=>onSettings({...gamepadSettings,deadZone:Math.max(0,Math.round((gamepadSettings.deadZone-.05)*100)/100)})}
      onIncrease={()=>onSettings({...gamepadSettings,deadZone:Math.min(.5,Math.round((gamepadSettings.deadZone+.05)*100)/100)})}/>
    <YesNoField ui={ui} top={.635} name={text('cameraStick')} value={gamepadSettings.cameraStick} onChange={cameraStick=>onSettings({...gamepadSettings,cameraStick})} label={label}/>
    <YesNoField ui={ui} top={.735} name={text('invertY')} value={gamepadSettings.invertY} onChange={invertY=>onSettings({...gamepadSettings,invertY})} label={label}/>
    <ArtButton name="M_Start_But_01" rect={[.19,.872,.384,.922]} font="GameFont_03" onClick={onReset}>{text('reset')}</ArtButton>
    <ArtButton name="M_Opt_Gra_Back" onClick={onBack}>{label(15)}</ArtButton>
  </>
}
