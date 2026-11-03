# Original sky recovery

Recovered by static analysis of the original NMO data (no script execution).
The authoritative extractor is `scripts/read-original-sky.py`; it asserts every
value below and emits `.local/original/sky-data.json`.

## Who populates the sky at runtime

`Gameplay.nmo` keeps a local DataArray reference named `Skytextures Array`
(null when authored). `Gameplay_Init` resolves the object named **`Skytextures`**
(Levelinit.nmo) into that local, and `Gameplay_Sky` reads row 0 with `Get Row`.

`Levelinit.nmo` `Skytextures` holds one row with five cells that are references
to the five shared materials:

| column | material |
|---|---|
| Back | Sky_Back |
| Right | Sky_Right |
| Front | Sky_Front |
| Left | Sky_Left |
| Down | Sky_Down |

The materials are authored, but their textures are loaded per level by
`Load Sky-Textures` (Levelinit.nmo): it reads the current level row of the
`AllLevel` DataArray, takes the `Sky` cell (for example `Sky_L`), picks
`Textures\sky\` or `Textures\sky_low\` from the `GameSettings` quality column,
builds `<Sky>\<X>_<suffix>.bmp` for the five face suffixes
(`_Back, _Right, _Front, _Left, _Down`), loads each as a texture and assigns it
to the matching `Sky_*` material. `Gameplay_Sky` then feeds the array row into
`TT Sky`, which builds the sky entity (see below).

## Exact level to sky-set mapping (`AllLevel` rows, 1-based)

| level | file | sky | scroll (u/s, v/s) |
|---|---|---|---|
| 1 | Level_01.nmo | Sky_L | 0.01, 0.01 |
| 2 | Level_02.nmo | Sky_E | -0.01, 0.005 |
| 3 | Level_03.nmo | Sky_A | 0.02, 0.01 |
| 4 | Level_04.nmo | Sky_F | -0.01, 0.005 |
| 5 | Level_05.nmo | Sky_C | 0.01, 0.005 |
| 6 | Level_06.nmo | Sky_H | -0.01, 0.005 |
| 7 | Level_07.nmo | Sky_D | -0.005, -0.005 |
| 8 | Level_08.nmo | Sky_G | 0.01, 0 |
| 9 | Level_09.nmo | Sky_K | -0.005, 0.01 |
| 10 | Level_10.nmo | Sky_B | 0.02, 0.01 |
| 11 | Level_11.nmo | Sky_J | 0.01, 0.01 |
| 12 | Level_12.nmo | Sky_I | 0.01, 0.04 |

The same rows carry a per-level `Light` color, which `Gameplay_Sky` applies with
`Set Light Color` on `Light_Ingame`; the port's directional gameplay light is
that light.

## TT Sky (TT_Gravity_RT `Sky.cpp`)

Gameplay_Sky's `TT Sky` has the settings *Side Materials* 4, *Top Material*
off, *Bottom Material* on, and the inputs Distortion 0.15, Vertex Color
(1,1,1,1), no Orientation Object, Radius 100, Quadratic SideFaces on and
Y-Position 0. `On` builds one mesh:

- Per side `k` (of `n`), four vertices on the circle of the radius at the
  angles `2πk/n + 1.25π` and `2π(k+1)/n + 1.25π`, bottom then top, with UVs
  (1,1)(0,1)(0,0)(1,0) and faces (c,a,b),(c,d,a) using material input `7+k`.
- Quadratic sides take the chord between neighbouring corners as their height
  (r·√2 for four sides), centred on the Y-Position.
- With a bottom material each side adds a triangle fan wedge (corner b,
  centre, corner a) with UVs `cos/sin · sin(π/4) + 0.5` (v negated) and the
  bottom material. A top face is built the same way only when *Top Material*
  is on; **Gameplay's sky has no top face**.
- The entity renders first, without Z test or write, as a prelit mesh whose
  vertex color (bytes, `RGBAFTOCOLOR`) multiplies the face textures. Every
  frame it is placed at the camera with the Orientation Object's world matrix
  (identity when absent).
- Its pre-render callback swaps in its own projection: the view's horizontal
  field of view `f` becomes `f + distortion·(π − f)`, the aspect is kept, near
  1 and far 200; the post-render callback restores the view projection.

## SkyLayer positioning, scrolling and gating

- **Positioning** is authored per level: each level NMO owns the `SkyLayer`
  entity (invisible by default) with its `SkyLayer_Mesh` and material. Levels
  1-11 use a two-triangle quad with `SkyLayer.bmp`; level 12 uses a 400-vertex
  vortex with `Sky_Vortex.bmp`.
- **Scrolling**: `Gameplay_Sky` → `animate SkyLayer` runs `Per Second`
  (`Skytranslation` from the level's `AllLevel` row) into `Texture Scroller`
  targeting the `SkyLayer_Mesh`, channel -1. The scroll vector is texture units
  per second.
- **Gating**: both `Binary Switch` nodes of `animate SkyLayer` test the shared
  local `Skylayer ein?`, which `Gameplay_Sky` sets from `Get Cell` on
  `DB_Options`, row 0, column 10 (`CloudLayer?`) — the options-menu entry
  `Menu_Opt_Graphics Clouds` ("Clouds?"). On `Init On` the switch shows the
  layer and starts the scroll when on, and does nothing when off (no False
  link). Each `Refresh` message re-reads the cell and re-enters `On/Off`,
  which shows the layer and lets the per-frame switch hide it and stop the
  scroll when the option is off. The exported `DB_Options` default is on.
- **Runtime material state** (`init SkyLayer`, Levelinit.nmo): entity filter
  color 200/255 = 0.7843137 gray, additional color 0, blend enabled with
  source/destination ONE/ONE and texture blend MODULATE, Z buffer write off.
  The port maps this to a `CustomBlending` One/One material.
- **Ending fade** (`fadeout Sky`, Gameplay.nmo): the same prelit color is
  interpolated 0.7843137 → black over 3000 ms while the layer stays visible.

## Port behavior

The authored Gameplay scripts drive the sky. The graph session hosts
Gameplay.nmo and MenuLevel.nmo, so `Gameplay_Init`, `Gameplay_Refresh`,
`Gameplay_Sky` and `MenuLevel_Init` run from the exported graphs; the light
colour, the TT Sky entity and the SkyLayer gate and scroll come from the graph
and the exported Data Arrays (`TT Sky` and `Texture Scroller` are in
`src/game/original-graph-gameplay.ts`).

- `src/game/original-graph-host.ts` reads each level's sky set from the
  exported `AllLevel` row, as `Load Sky-Textures` (Levelinit) does.
- `src/game/original-sky-box.ts` builds the TT Sky mesh exactly as above (no
  top face) in original units with Z reflected, and `OriginalSkyBox` draws it
  as `StereoRenderer`'s background pass: per eye the target is cleared, the
  sky is drawn with a camera that has the eye's rotation and the TT Sky
  projection, then the scene is drawn over it without clearing. The eye
  projection's off-axis terms are kept, so stereo eyes see the sky with the
  same parallax as the former cube background. The old `CubeTexture`
  background, which repeated the `Down` face above, is gone.
- The session loads the level's `SkyLayer` object with its authored matrix and
  Levelinit's blending, prelit as `Set Prelit Color` leaves it (lighting off, vertex colour 200/255). The authored `Texture Scroller` moves its channel -1 UVs
  as `TextureScroller.cpp` does (float32 Virtools UVs, less the integer part of
  the first vertex), and Show/Hide set its visibility.
- The authored `fadeout Sky` script interpolates the recovered 3000 ms prelit
  fade during the ending. The fade targets only `SkyLayer Entity`; the former
  background-intensity fade of the dome was not authored and was removed.
- Both the initial prelit colour and every fade step go through `Set Prelit
  Color`'s `RGBAFTOCOLOR(r, g, b, a)` (`src/game/original-color.ts`), so the
  vertex colour steps in whole bytes, as the original does. That VxMath export
  (0x242824A0) scales blue and alpha by 255, green by 255·256 and red by
  255·65536. It then rounds to nearest and keeps each channel's byte, with no
  clamping: blue and alpha round, while red and green keep the integer part.
  The particle callbacks use the other export, `RGBAFTOCOLOR(const VxColor *)`
  (0x24282540). On SSE it truncates a float32 product and saturates to 0..255.

Known residuals: `Database.tdb` (the options database that would hold the
"Clouds?" default) is obfuscated, so the exported `DB_Options` row is the
default. The TT Sky face materials' own texture address and blend states are
not decoded; the faces use clamped, opaque textures.

## Menu (MenuLevel.nmo)

`MenuLevel_Init` runs `Load Sky-Textures` with AllLevel row 4, so the menu uses
Level 5's sky set, `Sky_C`, loaded into the `MSky_Back` … `MSky_Down`
materials. It then activates the four flame scripts, sets `Light_Ingame` to
white with `Set Light Color`, starts the ball animation and feeds `Get Row` of
the `MenuSky` Data Array (the five `MSky_*` names) into its own `TT Sky`:
*Side Materials* 4, *Top Material* off, *Bottom Material* on, Distortion 0.1,
Vertex Color (1,1,1,1), no Orientation Object, Radius 70, Quadratic SideFaces
on, Y-Position 0.

The graph session runs those nodes of the exported MenuLevel graph: the `Op`
and `Get Cell` that name the sky set, the flame scripts, the `Op` and
`Set Light Color` for `Light_Ingame`, and `Get Row` into `TT Sky`, which draws
through `OriginalSkyBox` as `StereoRenderer`'s background pass in every stereo
mode. The former cube background with the `Sky_A` set and the menu's own
hand-set lights are gone; `Light_Ingame` is the same directional light as in
game (the session's light binding in `src/game/original-graph-host.ts`), lit by the fixed-function equation ([original-lighting.md](original-lighting.md)). `Light_Ingame` (Gameplay.nmo) is a directional light with the
specular flag set; no script moves it, so it shines along its saved world Z
axis (0.30222, −0.73314, 0.60922), which replaced the port's invented offset.
Texture loading, fog, the camera path, the ball animation and the ambience come
from the menu scene and the MenuLevel/Menu graphs
(`src/game/original-graph-curve.ts`).
