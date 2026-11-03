import {originalDataArray} from '../game/original-data-arrays'
import type {GamepadButtonAction} from '../controls/gamepad'

/**
 * Text of the port's own 3D Stereo and Controller panels, in the five
 * languages of the authored language table (German, English, Spanish,
 * Italian, French: the registry `Language` value indexes them). These
 * strings are the port's; the authored menu text comes from the table itself.
 */
const EXTRA_TEXT={
  stereo:['3D-Stereo','3D Stereo','Estéreo 3D','Stereo 3D','Stéréo 3D'],
  controller:['Controller','Controller','Mando','Controller','Manette'],
  mode:['3D-Modus','3D mode','Modo 3D','Modalità 3D','Mode 3D'],
  off:['Aus','Off','Desactivado','Disattivato','Désactivé'],
  sbs:['Nebeneinander','Side by side','Lado a lado','Affiancato','Côte à côte'],
  crossview:['Kreuzblick','Cross-view','Visión cruzada','Visione incrociata','Vision croisée'],
  'sbs-full':['Nebeneinander voll','Full side by side','Lado a lado total','Affiancato pieno','Côte à côte complet'],
  tab:['Übereinander','Top and bottom','Arriba y abajo','Sopra e sotto','Haut et bas'],
  'tab-full':['Übereinander voll','Full top and bottom','Arriba y abajo total','Sopra e sotto pieno','Haut et bas complet'],
  'leia-sr':['Leia SR','Leia SR','Leia SR','Leia SR','Leia SR'],
  interlaced:['Zeilenweise','Interlaced','Entrelazado','Interlacciato','Entrelacé'],
  'interlaced-reversed':['Zeilenweise umgekehrt','Interlaced reversed','Entrelazado invertido','Interlacciato inverso','Entrelacé inversé'],
  separation:['Trennung','Separation','Separación','Separazione','Séparation'],
  convergence:['Konvergenz','Convergence','Convergencia','Convergenza','Convergence'],
  uiDepth:['Menütiefe','Menu depth','Profundidad del menú','Profondità del menu','Profondeur du menu'],
  stereoDefault:['Als Standard verwenden?','Use as default?','¿Usar por defecto?','Usare come predefinito?','Utiliser par défaut ?'],
  noController:['Kein Controller erkannt','No controller detected','Ningún mando detectado','Nessun controller rilevato','Aucune manette détectée'],
  detected:['Erkannt','Detected','Detectado','Rilevato','Détectée'],
  accept:['Auswählen','Select','Seleccionar','Seleziona','Choisir'],
  cancel:['Zurück','Back','Atrás','Indietro','Retour'],
  pause:['Pause','Pause','Pausa','Pausa','Pause'],
  cameraLeft:['Kamera li.','View left','Cámara izq.','Camera sx','Caméra g.'],
  cameraRight:['Kamera re.','View right','Cámara der.','Camera dx','Caméra d.'],
  quitTutorial:['Tutorial beenden','Quit tutorial','Salir del tutorial','Esci dal tutorial','Quitter tutoriel'],
  deadZone:['Totzone','Dead zone','Zona muerta','Zona morta','Zone morte'],
  cameraStick:['Kamera mit rechtem Stick?','Right stick turns camera?','¿Cámara con stick derecho?','Visuale con stick destro?','Caméra au stick droit ?'],
  invertY:['Vertikale Achse umkehren?','Invert vertical axis?','¿Invertir eje vertical?','Invertire asse verticale?',"Inverser l'axe vertical ?"],
  analogSteering:['Analoge Steuerung?','Analog steering?','¿Control analógico?','Controllo analogico?','Contrôle analogique ?'],
  widescreen:['Breitbild?','Widescreen?','¿Panorámica?','Schermo largo?','Écran large ?'],
  reset:['Zurücksetzen','Reset','Restablecer','Ripristina','Réinitialiser'],
  approximatePhysics:['Physik angenähert: IVP nicht verfügbar','Approximate physics: IVP unavailable','Física aproximada: IVP no disponible','Fisica approssimata: IVP non disponibile','Physique approchée : IVP indisponible'],
} as const satisfies Record<string,readonly [string,string,string,string,string]>

export type ExtraTextKey=keyof typeof EXTRA_TEXT
export type ExtraText=(key:ExtraTextKey)=>string

/** The Overview row reuses the authored Control screen's label (`Menu_Opt_Keys Overview`). */
const AUTHORED_ROW:Partial<Record<GamepadButtonAction,number>>={overview:41}

function checkLanguage(language:number) {
  if(!Number.isInteger(language)||language<0||language>4)throw new Error(`Registry Language ${language} is not one of the language table's five columns`)
}

export function extraText(language:number):ExtraText {
  checkLanguage(language)
  return key=>EXTRA_TEXT[key][language]!
}

/** A row of the authored language table in the install's language (column `Language + 1`), trimmed as the panels draw it. */
export function authoredText(language:number,row:number):string {
  checkLanguage(language)
  const value=originalDataArray('language')?.rows[row]?.[language+1]
  if(typeof value!=='string')throw new Error(`The language Data Array has no row ${row}; regenerate the local pack`)
  return value.trim()
}

export function gamepadActionText(text:ExtraText,language:number,action:GamepadButtonAction):string {
  const row=AUTHORED_ROW[action]
  return row===undefined?text(action as Exclude<GamepadButtonAction,'overview'>):authoredText(language,row)
}
