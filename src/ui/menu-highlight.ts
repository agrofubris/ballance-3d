import {createContext} from 'react'

/** Shared hover/focus highlight so both stereo eye copies style the same item. */
export const MenuHighlightContext=createContext<{highlighted:string|null;setHighlighted:(name:string|null)=>void}>({highlighted:null,setHighlighted:()=>{}})
