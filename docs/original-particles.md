# Particle systems (TT_ParticleSystems_RT)

`src/game/original-particle-system.ts` ports the authored particle building
blocks from TT_ParticleSystems_RT: `GeneralParticleSystem.cpp` (the behavior),
`ParticleEmitter.cpp` (`ReadInputs`, `InitiateDirection`, `AddParticles`,
`UpdateParticles`), `SphericalEmitter.cpp`, `PointEmitter.cpp` and the
`RenderParticles_L` / `RenderParticles_OS` / `RenderParticles_FS` render
callbacks. `SphericalParticleSystem` and `Point Particle System` are registered.

## Behavior

- Inputs On / Off / Freeze. On sets the emission clock to the Emission Delay,
  so one batch leaves on the activation frame, and shows the particles. Off
  stops emitting; the behavior keeps updating until the last particle has died,
  then hides them and fires Exit Off. Freeze toggles. The activity starts from
  its saved local (1 for the flames, 0 for the extra-life bursts).
- `Activate Script` with reset runs `InitParticleSystem` (an empty pool).
  Deactivating the behavior's script hides its particles and keeps them;
  activating it again shows them (`CKM_BEHAVIOR(DE)ACTIVATESCRIPT`). The graph
  runtime forwards both to the particle binding.
- Each active frame: read the inputs, add `Emission Delay + Variance·RANDNUM`
  (drawn every frame) to the clock and emit one batch per elapsed delay (or one
  batch when the delay is 0), then update every particle by the frame's
  DeltaTime.
- `ReadInputs` reads a variance or ending value only when the saved Variances /
  Evolutions settings enable it; other members keep the emitter constructor's
  defaults. The emitter is created, and its inputs first read, at load.
- `AddParticles`: Emission (plus variance with `PV_EMISSION`) particles, capped
  by the Maximum Number input and the pool size setting. A spherical emitter
  starts each particle on the unit sphere through the owner frame's world
  matrix (a normalized cube sample) moving along that normal at
  `Speed (+ variance)`. A point emitter starts at the frame position and aims
  along `InitiateDirection`'s cone around the frame's Z axis (`cos/sin` of
  `Pitch/Yaw Variance·RANDNUM`, four draws in source order), transformed with
  the frame's rotation and scale. Life, colour, size and texture frame follow
  the flags. Line and oriented-sprite modes use the angular speed as latency;
  facing sprites start at angle 0 and turn by `Angular Speed (+ variance)` only
  with `PV_ANGULARSPEED`.
- `UpdateParticles`: position along the direction, then colour (clamped), size
  and texture frame evolutions; dead particles leave on the next update.
  Interactors and deflectors are not implemented and fail loudly, as do render
  modes other than line (2), oriented sprite (5) and facing sprite (7) and
  unlisted blend factors.
- Randomness is the MSVC CRT `rand()` (`x·214013 + 2531011`), seeded as without
  `srand`. Virtools shares it process-wide, so only the distribution matches.

## Rendering

Particles stay in world space in original units under a group that maps them to
render space. Each shown system draws after the scene with its authored blend
factors, Z test on, Z write off, no culling:

- Lines: one untextured segment per particle from its previous position to its
  current one (plus latency), previous and current colours.
- Oriented sprites: a quad from the previous position (previous size) to the
  current one (current size), as wide as the size across the view direction,
  textured with MODULATEALPHA. The texture is bound at render time.
- Facing sprites: one triangle per particle, `pos + up`, `pos + right − up`,
  `pos − right − up`, with right/up the viewpoint's axes times half the size
  (turned by the particle angle); UVs `(u + ½, v)`, `(u + 1, v + 1)`,
  `(u, v + 1)` over the texture frame cell.

## Flames

The level-start, checkpoint and menu flames are Point Particle Systems in
facing-sprite mode with source alpha / one blending, 50 particles, a 20 ms
emission delay, 3° yaw and pitch variance and the `Particle_Flames` texture.
Colour evolves from (235, 42, 70) to transparent black; there is no tint.

| Script | Speed (units/ms) | Life | Size |
|---|---|---|---|
| PS_FourFlames A–D, PC side flames, menu flames | 0.008 ± 0.003 | 1000 ± 250 ms | 3 ± 0.3 → 0.1 |
| PC_TwoFlames CenterFlame | 0.012 ± 0.004 | 1000 ± 500 ms | 5 ± 0.3 → 0.1 (alpha 250/255) |

- Each PS_Levelstart placement runs the whole PS_FourFlames graph in the
  session: Init resolves `Ball_Pos_Frame`, and the MF Script, when
  CurrentLevel's `Activation Phase?` cell is true, converts the texture name
  and watches the ball within 70 units of `PS_FourFlames_MF`; EnterRange
  activates (reset) the four flame scripts, ExitRange deactivates them.
- Each checkpoint runs PC_TwoFlames' authored graph (the former
  `OriginalFlameScripts`/`OriginalCheckpoint` hand-ports were removed in commit
  502bd84). Its gate state follows Activate / Deactivate Script: the center
  flame while the next checkpoint is armed, the two side flames (A, then B) of
  reached checkpoints while the ball is in range.
- The menu backdrop runs MenuLevel's four flame scripts in MenuLevel_Init's
  order (A, B, C, D) with the menu's own `I_Particle_Flames` texture.

## Extra life

On pickup, `P_Extra_Life_MF` activates (with reset) `P_Extra_Life_Particle_Blob
Script` and then `P_Extra_Life_Particle_Fizz Script`. Each turns its
SphericalParticleSystem on and, through a 5-frame-delayed link, off again, so
each pickup releases one batch:

| System | Particles | Look | Life | Speed (units/ms) | Size |
|---|---|---|---|---|---|
| Blob | 10 | oriented sprites, `P_Extra_Life_Particle`, alpha fading to 100/255 | 150 ± 100 ms | 0.01 ± 0.004 | 1 ± 0.6 → 0.5 ± 0.1 |
| Fizz | 50 | 1-pixel lilac lines (208, 176, 213) | 200 ± 200 ms | 0.01 ± 0.005 | — |

Both use source alpha / one (additive) blending and emit from a radius-2 sphere
(the frames have scale 2) at the pickup's placement. Each placement runs its
own P_Extra_Life graph, whose MF Script activates the two particle scripts.

Known: the Blob texture is dark (mean ≈ 31/255) and additive, so the effect is
subtle. Blending happens on sRGB-encoded values, like the original's D3D
framebuffer, in mono and in every stereo mode: `StereoRenderer`'s eye targets
take the canvas' output encoding into plain RGBA8 storage (see
`createEyeTarget` in `src/game/stereo-renderer.ts`).
