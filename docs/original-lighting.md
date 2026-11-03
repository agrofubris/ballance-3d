# Lighting (fixed function)

The original renders every mesh through the Virtools render engine's
fixed-function pipeline. `src/game/original-fixed-function.ts` reproduces it:
`OriginalMaterials` builds an `OriginalFixedFunctionMaterial` for every
CKMaterial, and all of them read one `OriginalLighting` (the scene's lights and
ambient). There is no hemisphere fill or tuned intensity.

## What the original does

- Render states (CKRenderEngine rasterizer defaults): lighting on, Gouraud
  shading, local viewer, normalized normals, colour vertex off (colours from
  the material).
- Every shipped mesh is `VX_LITMESH` (BMap `BMMesh_GetLitMode` over all level,
  entity and module files). A mesh becomes prelit only through
  `Set Prelit Color` (the SkyLayer, in Levelinit's `init SkyLayer`).
- `CKMaterial::SetAsCurrent` sets the material's diffuse, ambient, specular,
  emissive and power, and enables specular when power > 0.05.
- Global ambient: `CKScene`'s default `0x0F0F0F`; no shipped file saves a
  scene, and no script sets it.
- Lights (the only CKLights in the pack, decoded from the chunk dumps):

| Light | File | Type | Colour | Flags | Attenuation | Range |
|---|---|---|---|---|---|---|
| `Light_Ingame` | Gameplay.nmo | directional | white | active, specular | — | — |
| `Light_Blitz` | Gameplay.nmo | directional | white | active, hidden | — | — |
| `Ball_Lightning_PointLight` | Balls.nmo | point | black (animated) | active, hidden | (0, 1, 0) | 20 |
| `PE_UFO_Light1` / `2` | PE_Balloon.nmo | point | (92, 143, 218) | active, hidden | (0, 0, 1.5) / (0, 0, 1) | 50 |

  None saves a power chunk (power 1). `CKLight::Setup` skips hidden lights and
  sets diffuse = colour·power, specular = the same when the specular flag is
  set, otherwise black. `Light_Ingame` has no parent and no script moves it, so
  it shines along its saved world Z axis (0.30222, −0.73314, 0.60922).

## The equation

Per vertex, on byte values (the frame buffer's gamma space):

```
colour   = clamp(Ce + Ca·Ga + Cd·Σ Ld·max(N·L, 0)·att)
specular = clamp(Cs·Σ Ls·(N·H)^P·att)      (P > 0.05, N·L > 0, H = normalize(L + V))
att      = 1 / (a0 + a1·d + a2·d²) within Range   (point lights; d in original units)
```

The texture stage then gives `colour · texel` (MODULATE / MODULATEALPHA, alpha
`Cd.a · texel.a`) or `mix(colour, texel, texel.a)` (DECALALPHA, alpha `Cd.a`,
only `P_Extra_Life_Sphere`); the specular is added, and fog (the menu's linear
`Set Fog`) mixes toward its colour. The shader converts texels back to their
stored bytes, computes in that space and converts the result to linear only so
the renderer's output encoding restores the bytes. Prelit materials skip the
lighting: the vertex colour and specular are the prelit ones.

## In the port

- Game: `Light_Ingame` (Set Light Color from Gameplay_Sky) and the spawn's
  `Ball_Lightning_PointLight` (its authored colour animation) are registered;
  the host updates the lighting once per rendered frame.
- Menu: `Light_Ingame`, coloured by MenuLevel_Init's `Set Light Color`.
- Not yet driven: `Light_Blitz` (Gameplay's lightning) and the UFO lights;
  both start hidden.
- Known residuals: per-material texture filter modes are only applied to the
  extra-life shell; the rest keep mipmapped, anisotropic filtering.
