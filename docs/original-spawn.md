# Spawn teleport

`Balls.nmo` `Ball_LightningSphere 437` runs every materialization, triggered
by `Gameplay.nmo` `New Ball 2921` after positioning: `Show` the lightning
sphere while `Rotate Lighting Sphere` spins it at 2 PI/s around Y and cycles
textures 1-2-3, `Scale Lighting Sphere` grows 0-1 over 1500 ms, `Light Anim`
ramps `Ball_Lightning_PointLight` blue over 2500 ms then white, `Wave Player`
plays `Misc_Lightning Sound`, and a 2500 ms `Delayer` activates the
`BallParticle_Frame` smoke script. `Rotate` ends at 3000 ms and hides the
sphere; `New Ball` physicalizes the player at the same 3000 ms.
The graph session runs those authored scripts; `scripts/prepare-original.py`
prepares the assets.

The graph session plays that sequence in both places a ball appears:

- Level start holds the reset ball hidden while the sphere grows and crackles,
  then the smoke burst and the authored additive sphere unveil the ball at
  2.5 s while the lightning keeps running underneath; sphere hides and physics
  enables at 3 s.
- Death respawn reuses the same effect for the `forming` stage between the
  existing `position-ball` and `physicalize-ball` events, with the same sound.

Blend fidelity: material 185 recovers as `sourceBlend = 2, destBlend = 2`,
i.e. Virtools `VXBLEND_ONE, VXBLEND_ONE` (`ONE * src + ONE * dst`, matching
D3D8), rendered via `CustomBlending` rather than Three's `SRC_ALPHA, ONE`
`AdditiveBlending`. The PNGs have no alpha channel so both agree while
opacity is 1.

Sampler state (extracted, not inferred): `textureBlendMode = 2
(MODULATE)`, `textureMinMode = textureMagMode = 2 (LINEAR)`,
`textureAddressMode = 1 (WRAP)`. The effect therefore uses repeating
linear-filtered sampling with no mipmaps. The extractor exports these
fields for every material; see `scripts/extract-original.py`.

The growth and light curves are recovered into `.local/original/lightning-data.json`
as decode evidence; the graph session evaluates the authored CK2dCurve data
from the exported graph: the exact 1500 ms scale curve, the two authored light
stages (2500 ms flicker, then 1500 ms fade), the point-light offset/range, and
the one-texture-per-script-frame Sequencer cadence. The
sphere hides at 3 s while the point light continues and follows the ball until
4 s.

The smoke emitter is recovered from `SphericalParticleSystem 2243` attached to
`Ball_Particle_Frame`; `scripts/read-original-spawn.py` writes
`.local/original/spawn-smoke-data.json` from the `Balls.nmo` chunk dump. The composite
`BallParticle_Frame script` starts the particle behavior once and wires its
`Exit On` back to `Off`, so the authored zero emission delay produces one On
frame with 20 particles (capacity 60). The authored 10-particle emission
variance input is present but masked off by the saved `Variances` setting
(`Speed | Lifespan` only). Recovered values:

- `Ball_Particle_Smoke` texture object (file `Particle_Smoke.bmp`), sprite
  render mode, `SRC_ALPHA` / `ONE` (5/2) blend.
- `Ball_Particle_Frame` scale 1.5, so particles launch on a 1.5 original-unit
  sphere; speed `0.001 +/- 0.0005` original units/ms.
- Lifespan `1600 +/- 1000` ms, initial size `2`, ending size `3`.
- Initial/ending RGBA `0.7843138 -> 0`; color and size interpolate linearly
  over each particle's own lifespan, clamped by the original update order.

Because the particle script is separate from the lightning graph, emitted
smoke keeps aging and rendering after the 3 s spawn effect ends. There is no
separate white-flash or blue-shell object in the authored script: the exact
spawn visual is the single `Ball_LightningSphere` mesh with material 185, the
authored texture sequence and the point light. The renderer cycles the actual
material `map`/`emissiveMap`; it does not draw the invented blue shell,
duplicate arc mesh or expanding white sphere.

The renderer side was cross-checked against the shipped DLLs with Ghidra:
`TT_ParticleSystems_RT.dll` `CreateGeneralParticleSystemProto` (`0x25084C50`),
execution (`0x250853A0`), callback (`0x25085770`), `ShowParticles`
(`0x25085290`), `ReadSettings` (`0x25082A00`), `RenderParticles_S`
(`0x2508E240`) and `SetState` (`0x25082ED0`); `Materials.dll` `Set Texture`
(`0x25502FF0`); and `Logics.dll` `Parameter Selector` (`0x25485BE0`) and
`Sequencer` (`0x254864C0`). These confirm sprite halfsize `size / 2`, the
one-output-per-`In` Sequencer, the `PV_EMISSION` gate, `MAGFILTER = LINEAR`,
`MINFILTER = LINEARMIPLINEAR`, and the ONE/ONE + no-Z-write states. See
the local original DLL recovery notes.

Resolved visibility bug: the lightning sphere initially rendered as a smooth
blue shell because the effect's texture loader kept Three's
`ClampToEdgeWrapping` default while the authored sphere UVs span U 1-2,
V 1.25-2. The whole mesh sampled one clamped border texel. `RepeatWrapping`
(matching `OriginalMaterials` and the authored Virtools addressing) restores
the authored texture. Isolated with solid-magenta and opaque-bitmap diagnostic
builds before removal; UV report read 118/118 verts, 0 non-finite, 3 textures.
