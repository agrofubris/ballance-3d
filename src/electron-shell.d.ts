export {}

declare global {
  interface Window {
    /** The Electron shell bridge; undefined in the browser build. */
    ballanceShell?: {
      platform: string
      version: string
      /** Present in the shell: Leia SR is supported; `active` is the launch mode. */
      leia?: {
        available: boolean
        active: boolean
        weaveSize: { width: number; height: number }
      }
      /** Stores the launch mode, saves settings and relaunches the app. */
      setLeia?: (on: boolean) => Promise<unknown>
      /** Resizes the window content to a mode in physical pixels; resolves false when ignored (fullscreen, Leia). */
      setScreenMode?: (width: number, height: number) => Promise<boolean>
      /** Quits the app (TT Exit to System). */
      quit?: () => Promise<boolean>
    }
  }
}
