# Ball shadow

The player's shadow is the original `TT Simple Shadow` (TT_Gravity_RT
`Behaviors/SimpleShadow.cpp`), run from Balls.nmo's authored `Ball_Shadow`
script.

## Original

- Gameplay's `New Ball` (BallManager in `Gameplay_Ingame`) physicalizes the ball
  after the spawn lightning and then activates `Ball_Shadow` with reset.
- `Ball_Shadow` turns `TT Simple Shadow` on the next frame. Its target is the
  ball named by `CurrentLevel` row 0, column 1; Texture `HardShadow`, Size Scale
  1.3, Maximum Height 20. A `Get Cell`/`Test` loop turns it off if that cell
  becomes empty, and `Reset Level`/`Exit Level` (sent by the pause, dead and end
  menus) turn it off.
- Every active frame the behavior adds a one-shot pre-render callback:
  - The floors are the members of the level's `Shadow` group, which Levelinit's
    `set Floor` gives the floor attribute. A floor gets the shadow when it is
    visible, overlaps the target's world bounding box in X and Z, its bottom is
    not above the target's top, its top is at most Maximum Height below the
    target's bottom, and its local bounding box reaches the projected texture.
  - The shadow material (texture blend COPY, clamp addressing) is added to each
    such floor as an extra material channel with source/destination blend
    ZERO/SRCCOLOR, so it multiplies the floor colour. Floors the target left
    lose the channel.
  - UVs are projected straight down in the floor's local frame:
    `u = (p.x·k + 0.5) − x·k`, `v = (p.z·k + 0.5) − z·k`, with `p` the target's
    position in the floor's frame and `k = floor scale / (Size Scale · width)`,
    `width` the target's local bounding-box width times its world X scale. The
    texture therefore spans 1.3 ball widths, centred under the ball.
- Off, reset or deactivation removes the channel from every floor and destroys
  the material.

## Port

- `TT Simple Shadow` is in `src/game/original-graph-gameplay.ts`; the session's
  `GraphShadowBinding` records each frame's projection in the render context,
  in original units and float32. The host draws it with `OriginalBallShadow`
  (`src/game/original-ball-shadow.ts`, restored from the hand-port's projector:
  `A_GetFloors`, the projected UVs and the ZERO/SRCCOLOR overlay on the level's
  `Shadow` floors), fed every frame with the recorded projections; the Texture
  input arrives as a context reference and is resolved to `HardShadow`.
- The graph session runs Balls.nmo's `Ball_Shadow`, `Balls_Init` and `New Ball`
  scripts on its level runtime; the shadow behavior records the projection
  right before each rendered frame.
- No Three.js shadow maps are used, as the original casts no real-time shadows.

Known differences of the removed hand-port:

- `IsAllOutsideFrustrum` is not tested; it only skips floors that are not drawn.
- `Reset Level`/`Exit Level` are not posted by the port's React menus; a
  restarted or exited level is rebuilt, which discards the shadow too.
