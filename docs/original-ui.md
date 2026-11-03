# Menus, HUD and controls

The menu flow, labels in the install's language, default highscore tables and
credits come from the user-supplied Menu.nmo, Language.nmo and base.nmo. Run
`python3 scripts/read-original-ui.py <chunk-dir>` to regenerate
`.local/original/ui-data.json`; it is served as `/original/ui-data.json` and is
never committed. The app loads and validates it at startup, failing loudly when
the original pack is absent; `src/ui/original-ui.ts` also supplies functional
fallback labels for the loader error path. Source hashes, sprite rectangles and
font coordinates are kept in the file so a mismatch with the install is visible.

The interface is drawn with the original art (`src/ui/OriginalArt.tsx`,
`src/ui/original-art.ts`). Each screen is a set of the recovered CK2dEntity
sprites: the authored normalized rectangle, Z order, material and texture
window from `Menu.nmo`, `Camera.nmo` (the HUD) and `Tutorial.nmo`, laid out in a
4:3 stage centered in the window. Materials (`M_Button_Up`/`Over`/`Inactive`,
the field, score and logo materials) and their textures (`Button01_*`,
`Font_1`, `Logo`) come from the BMap pack documents; the Button01 and Font
textures are re-extracted from their TGAs so the alpha survives. Text is drawn
glyph by glyph from the `Font_1` atlas with the recovered glyph table and the
authored `Set Font Properties` values (Space, Scale, Color, Shadow Color, Angle
and Distance; the parameter order was read from the Interface.dll declaration),
aligned and word-wrapped like `2D Text` with its authored margins (alignment
bits: 0 centers, 1 left, 2 right, 4 top, 8 bottom). Fades follow the scripts
(`Set Diffuse` alpha for the score field, line and highlight; the credits pager
fades each row in and out). Everything is duplicated per eye and shifted by UI
Depth. An earlier version drew browser text on CSS frames; it has been replaced
by the original art. The menu
background uses the converted MenuLevel.nmo scene. DomeShadow,
Trafo_Shadow_Big and the lantern's Laterne_Schatten shadow decal are converted
directly from their TGA files to preserve alpha lost by BMap's image export.
Preparation includes this scene and menu sounds.

Keyboard play follows the original manual: the arrow keys roll the ball, holding
left Shift while pressing left or right turns the camera, Space lifts the camera
for an overview and Escape pauses or goes back. Every action can be rebound in
Options, and the choice (with inverted camera turning) is stored in the browser.
Binding a key that another action already uses exchanges the two keys, so all six
actions always have one. Escape, Tab and the platform's command keys cannot be
bound.

Every panel (the main menu, level choice, pause, the option pages, highscores,
credits, confirmations, level completion and name entry) is laid out from the
authored sprites. All twelve levels remain selectable. The in-game HUD is the authored
Camera.nmo plate (background, glow and `Font_Punktezähler` digits) at the left
and the life balls at the right: `Gameplay_Energy` copies `Interface_Life_Kugel`
once per life, each one `0.0387` further left (the first copy one step left of
the template), and moves `Interface_Life_End` to `0.9288 - lives * 0.0387`;
each group is anchored to its screen corner. Graphics uses the authored
resolution field: the host lists the original 4:3 modes as 16-bit entries up to
the monitor height, and in widescreen appends the port's 16:9/16:10 modes
(1280x720 through 3840x2160, plus 3440x1440) after base's own
`ScreenModes` filter, which keeps only 4:3 modes no wider than 1600. The
selected mode's height is the render scale; the widescreen canvas fills the
window, so the 3D backgrounds get the wider Hor+ frame while the 2D art and
authored UI keep their 4:3 area. The original Clouds and Synch fields are not
offered. The 3D Stereo
and Controller screens, and the Options entries that reach them, are port
additions built from the same sprites at their authored sizes, with the
authored 2D Text offsets (`TT ConvertPixel-Homogen` in Menu_Opt_Keys,
Menu_Opt_Graphics and Menu_Opt_Sound) and the chosen yes/no answer drawn
`M_Button_Up`, as Menu_Opt_Keys does. Their own text follows the install's
registry `Language` in the language table's five languages
(`src/ui/original-extra-text.ts`); the shared Yes/No/Back labels come from the
table. The Controller screen also has an optional Analog steering field
(default off, saved with the other controller settings): with it on, the
shaped movement-stick deflection scales each direction's authored drive force,
while the keyboard, d-pad and touch overlay stay digital. Every analog axis is
ignored until it has reported a centred value once, so a worn stick that rests
outside the dead zone cannot steer the ball or suppress the d-pad. The pad
plays the keys the authored scripts poll: Select holds Return (the menus'
choice and the tutorial's continue key) and Back holds Escape (the menus' back
key, and pause in a level). Stick and d-pad directions hold the Keyboard row's
direction keys and also the fixed arrows the Menu Key Events poll, unless the
row binds that arrow to another function. On the port's own panels the pad
moves the focus, presses the focused button and goes back; a Select or Back
still held when a panel closes acts only after it is released. A seventh
Controller row, Quit tutorial (default X), holds Q, which only Gameplay_Tutorial
polls; it reuses the sixth authored row's sprites one step lower, the fields
below move down by one step and Reset sits left of Back. The menu and key-name
tables are corrected at load
(`src/game/original-text-corrections.ts`, approved by the maintainer):
spelling and accents, untranslated or mistranslated entries, the swapped
French arrow names and the Italian O key, French spacing before `?`, `!` and
`:`, and shorter wording where the authored text ran onto a button's ball or a
field's cap. Each correction pins the original cell by hash, so the original
text is not redistributed and a different install fails loudly.
Text shadows draw only when the font's `Set Font Properties` setting has the
Shadow bit (only `GameFont_04`); `read-original-ui.py` exports that setting.
Each `2D Text` behavior draws its own text, so the highscore places show both
the name and the right-aligned score.
In 3D Stereo, the menu and HUD are duplicated per eye. Hover and keyboard
focus now mirror the red highlight into both eye copies, and the one-eye focus
outline is suppressed in stereo. The 3D Stereo screen offers Off, Side by side,
Cross-view, Full side by side, Top and bottom, Full top and bottom, Interlaced
and Interlaced reversed, plus Leia SR in the Electron shell only (between Full
top and bottom and Interlaced; the browser never offers it). Full layouts render
each eye at the complete selected screen-mode resolution and pack the two
frames into a doubled drawing buffer (twice the width side by side, twice the
height top and bottom); half layouts squeeze both eyes into one buffer. The
canvas CSS display box stays mono-sized, so the browser scales a full layout's
doubled buffer into it. Leia SR instead makes the page itself the full eye pair:
the offscreen window is `2*W x H`, the drawing buffer equals the window, each
eye target is half the width at full height, and each half holds an unscaled
DOM UI with the 4:3 area, HUD corners and UI Depth of one `sbs-full` eye. Its
launch mode and capture bridge are described in `docs/electron.md`.
Separation ranges 0..1 in 0.005 steps. A persisted **UI Depth** slider in
Options â†’ 3D Stereo controls the overlay's crossed disparity: 0% is exactly
screen depth, 100% is the maximum pop-out (four times the first pass's reach),
and every layout applies the matching inward sign. Separation rules the whole
picture's strength, so the pop-out scales with it in proportion: the stated
reach is at the default separation 0.08, twice the separation doubles it, and
separation 0 keeps the UI at screen depth. The HTML rows and the WebGL menu
measure the shift against the same width, the game canvas (the 4:3 stage when
Widescreen is off). While a stereo mode other
than Off is active, Ctrl+Left/Right step separation by 0.005, Ctrl+Down/Up step
convergence by 1 (1..100), and Ctrl+PageDown/PageUp step UI Depth by 5%
(0..100). Each change applies and saves live and shows a two-second readout in
the 3D Stereo screen's title font at the top centre of the 4:3 stage, drawn per
eye like the rest of the overlay. The hotkeys do nothing in Off mode and
consume the modified key before menu or gameplay input; while a stereo mode is
active both Ctrl keys are reserved, so a Ctrl binding in the install's key table
is suspended until stereo is switched off. Ctrl releases still reach the host,
so a held key cannot stick. Developer inspection was
removed with the hand-port cleanup; local development uses IVP by default, with `solver=rapier` available for explicit comparisons. Production builds now also use IVP by default; the live deployment received that packaging update on September 9, 2026.

The tutorial is the authored `Gameplay_Tutorial` script (Gameplay.nmo), hosted
by the graph session with the Tutorial document next to `Gameplay_Init`,
`Refresh` and `Sky`. `Gameplay_Refresh` supplies the navigation key codes from
`Keyboard`, and the Gameplay binding owns the Data Arrays and the physics
freeze. Its 3D arrows are Tutorial.nmo's meshes, built
from `.local/original/tutorial.json` and the Tutorial frames
(`.local/original/frames/tutorial.json`) by `src/game/original-tutorial-scene.ts`,
with the recovered Tutorial.nmo hierarchy (`Tut_Pfeile` owns the arrow meshes
and `Pfeil_Runter` is under `Tut_ExtraPoint`). The script shows, hides, scales,
fades and moves them with the 3D scene, so they follow the stereo modes and UI
Depth. The 2D panel and text are the
original `Tutorial_Interface` sprites: `2D Text` writes the chapter text
(`2D Text` On/Off with the authored Exit On/Off), `Set Font Properties` fades the
text colour, and `Set Diffuse` sets the panel alpha. The text is read at runtime
from `/original/text/tutorial<language>.txt` (Windows-1252, `*`-separated).
The file follows the install's registry `Language` (base's `Set Language`), and
the host applies the hash-pinned chapter corrections of
`src/game/original-text-corrections.ts` (spelling, grammar, apostrophes, local
key names), keeping each chapter's line structure and length. `TT LookAt` is reproduced from the DLL
(execution 0x10010E00, core 0x10011190): it interpolates the target's selected
local axis toward the aim point by Following Speed, rebuilds the X/Y/Z basis,
applies the Look X/Y/Z axis locks and rotates by Roll. The `InGameCam`
referential is the live engine camera, so the arrow frame stays turned toward
the view as it rotates.

Known differences:

- The exported `Create String` does not carry its language pin, so the text
  file name arrives without the language digit; any `tutorial*.txt` resolves to
  the selected text.
- `Set Current Slot` (the HUD life-ball frame) and `Streaming Event` are
  acknowledged without effect: the React HUD owns the lives, and nothing streams.
- `Set Parent` is a no-op and the authored groups are not modelled, so the
  script's `Parent` name is reported by the host; the tutorial scene keeps the
  recovered Tutorial.nmo hierarchy instead.
- The authored 25 s intro wait is reproduced: without Enter or Q the tutorial
  ends on its own, which is what the script does.

Score transitions follow Menu.nmo's `Menu_Score` script: 200 ms fade-in, the
1000 ms row waits, the authored level bonus, the segmented Time Points count
(step 1/5/25), the 610 ms per-life drain at 200 points, the 4 s hold and the
200 ms fade-out. Space, Enter or Escape use the authored Fast Scoring branch.
After scoring the host runs the recovered highscore check, name entry and the
End menu (Restart Level, Highscore, Options, Home, Next level). The lost path
opens the recovered dead menu (Restart Level, Home) instead of a score screen.
Values come from the live `GameState`.

The menu backdrop now follows MenuLevel.nmo: the authored closed 44 s camera
curve (arc-length Hermite), the 59.246 s looping `I_Ball_Stone` recording, the
four PS_FourFlames emitters, the authored fog and the `Menu_atmo` one-shot
scheduler (1-10 s random waits, no loop point or fade). A single scene and main
camera feed the stereo compositor, so both eyes share one animation clock. The
converted cube sky remains in place instead of the authored MenuSky cylinder.

Validation: the current suite passes 597 tests, including key mapping/swap/reserved-key
checks and new menu-camera, menu-demo, score and tutorial tests. The browser was
checked at 1280x720 and inside a 390x680 viewport; main menu, HUD, pause, score,
dead and end panels remained readable without clipping. The five original
stereo modes (Off, Side by side, Cross-view, Interlaced and Interlaced reversed)
were exercised for the menu, HUD, pause and score panels; the Level 12 UFO
ending was verified in SBS, crossview and interlaced. Keyboard-only menu
navigation, rebinding and restoring Forward, Escape pause/resume, the Level 1
tutorial chapters, Level 1 loading and the minimal HUD were exercised. A fresh
reload had no console errors. Build, lint, hygiene and the representative
dual-solver harness scenarios pass.

Unverified against the running original (the files do not state them, and the
original game was not run): the glyph pixel scale (text is scaled with the 4:3
stage as if rendered at 640x480, `UI_REFERENCE_HEIGHT`), the shadow direction
(authored angle used as `(cos, sin)` in screen space), and whether `End Color`
is a vertical gradient (it is not applied). Left-aligned text uses the authored
2 px margin, so labels begin over the rivet cap of field bars. Not ported: the
credits logo fades, the authored tutorial arrow meshes and camera look-at
prompts, and the exact MenuSky cylinder. Phone controls are outside this pass.
All-level end-to-end verification remains open.

The sprite renderer draws the menu and HUD from the recovered 2D entities. The
graph session runs `Menu.nmo` and `Gameplay.nmo`, including the 2D
text/material/sprite behaviors; the tutorial and score presentation feed the
same per-eye overlay and keep the UI Depth behavior.
