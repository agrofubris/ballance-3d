// Visuals/Behaviors/PlanarFilter.cpp, decoded from Visuals.dll (image base
// 0x25780000). The behavior's On input calls AddPostSpriteRenderCallBack
// (CKRenderContext vtable +0x90) with the callback at 0x25787CD0; Off and the
// lifecycle callback (0x25787BE0) remove it (+0x94). A post-sprite callback
// runs after the foreground 2D root, so the quad covers the 3D scene and the
// HUD. The render callback reads its inputs live every frame:
//
//   - SetState(28, 0)                    fog off
//   - SetState(128, 0)                   wrap0 = 0 (clamp)
//   - SetState(22, 1)                    cull none
//   - SetState(19, source blend)
//   - SetState(20, dest blend)
//   - SetState(27, 1)                    alpha blending on
//   - SetState(7, 0) / SetState(14, 0)   Z test and write off
//   - SetTextureStageState(39, 4, 0)     texture map blend MODULATEALPHA
//   - SetTextureStageState(17, min, 0)
//   - SetTextureStageState(16, mag, 0)
//   - SetState(29, 1)                    specular on
//   - GetDrawPrimitiveStructure(0x230, 4) (pre-transformed, diffuse + specular,
//     stage-0 texture coordinates)
//   - GetViewRect(&rect), then a TRIANGLEFAN of four vertices at the view
//     rect's corners, (x, y, z = 0, rhw = 1), UVs (0,0) (1,0) (1,1) (0,1)
//   - diffuse = RGBAFTOCOLOR(Filtering Color), specular =
//     RGBAFTOCOLOR(Additional Color), texture = the Texture input
//   - after the draw, Z write/test are restored to 1 and fog is restored to 1
//     when GetFogMode() is not VXFOG_NONE
//
// The other render states are left as set; the next frame's scene resets them.
import type { GraphFilterBinding, GraphFilterSettings } from './original-graph-bindings.ts'

/** One shown filter's live inputs, in callback registration order. */
export interface OriginalPlanarFilterItem {
  key: string
  settings: GraphFilterSettings
}

/**
 * The render-context post-sprite callback list for `Planar Filter`. Keys are
 * the behavior node indices, as the runtime builds them; `items()` reads every
 * shown filter's inputs, in the order the callbacks were added.
 */
export class OriginalPlanarFilter implements GraphFilterBinding {
  private readonly entries = new Map<string, () => GraphFilterSettings>()

  show(key: string, read: () => GraphFilterSettings): void {
    this.entries.set(key, read)
  }

  hide(key: string): void {
    this.entries.delete(key)
  }

  /** Every shown filter's live inputs, in registration order. */
  items(): OriginalPlanarFilterItem[] {
    return [...this.entries].map(([key, read]) => ({ key, settings: read() }))
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
