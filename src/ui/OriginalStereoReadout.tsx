import {ArtLabel,ArtStage} from './OriginalArt'
import type {StereoHotkeyChange} from './original-extra-settings'
import type {ExtraText} from './original-extra-text'

/** The hotkey readout in the 3D Stereo panel's text-only title art, at the top centre of the 4:3 stage. */
export function OriginalStereoReadout({text,change,className,'aria-hidden':ariaHidden}:{text:ExtraText;change:StereoHotkeyChange;className?:string;'aria-hidden'?:boolean}) {
  return <div className={`original-menu original-graph-extra original-stereo-readout ${className ?? ''}`} aria-hidden={ariaHidden}>
    <style>{'.original-stereo-readout:not(.stereo-eye){pointer-events:none}'}</style>
    <ArtStage>
      <ArtLabel name="M_Options_Title" rect={[.3,.004,.7,.052]}>{`${text(change.key)} ${change.shown}`}</ArtLabel>
    </ArtStage>
  </div>
}
