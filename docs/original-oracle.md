# Original-game oracle

`scripts/original-oracle.py` runs the user's own Ballance files for a short,
windowed session and samples the ball's pose from process memory. It answers
"what does the original do here?" when recovered data and source are not enough.
It is Windows only and is used only with the maintainer's approval for each
session. Results are written under `.local/oracle/runs/` and are never committed.

## Launcher

The original `Player.exe` only runs in exclusive fullscreen. It always shows its
FullScreen Setup dialog: OK switches the display mode, and Cancel aborts. The
oracle therefore uses [doyaGu/BallancePlayer](https://github.com/doyaGu/BallancePlayer)
v0.3.9 (MIT), a rebuilt launcher for the same engine DLLs, behavior blocks and
game files. The setup pins its `Player.exe` by SHA-256
(`72ad4e38…306e`, from release asset `BallancePlayer-0.3.9.0-msvc2022-x86.zip`,
digest `01228e93…eddc4`). Before first use, that build was scanned: Windows
Defender, imports (no networking, registry, process creation or injection),
strings, the source of its process-termination code, and the release history.
The script never downloads anything.

`Player.ini` sets `ApplyHotfix=0`, so the launcher's script patches are off and
the original scripts run unmodified. The frame-rate unlock and the debug and
rookie modes are also off. The window is 640×480.

## Use

```sh
python scripts/original-oracle.py setup --player <extracted BallancePlayer>/Player.exe [--install C:\games\ballance]
python scripts/original-oracle.py trace --level 1 --seconds 120 [--capture-every 10]
```

`setup` builds `.local/oracle/mirror/`. It copies `Bin/*.dll`, `base.cmo` and
`Database.tdb`, and adds directory junctions to the data folders. The install
itself is never written to. `trace` waits for the menu and sends the level's
verified key sequence. Each key is sent only after the game window is confirmed
in the foreground, and focus is then returned. The trace then records every
float32 position triplet near the spawn, including those present at level start,
because the ball entity already sits at the spawn pose before it is physicalized.
For `--fast-scan` seconds (default 30) it rescans memory back to back (about 80 ms
per scan), so samples arrive about every 0.12 s. After that it rescans every 2 s
and samples at about 100 Hz. `--topmost` keeps the window on top without taking
focus. A covered window updates only about 8 times a second. Window captures use
`PrintWindow` on the game window only.

Only Level 1 has a verified menu path: Enter about 14 s after launch, then Enter
again. Other levels are rejected until their key sequence is checked.

## Pitfalls

- After its first run, Windows renders an executable path black, every time. A
  fresh path or a fresh name renders again. The cause was not found: compatibility
  stores, GameConfigStore, shader caches and the mirror files were all ruled out.
  Each launch therefore runs a uniquely named copy of the launcher and deletes it
  afterwards.
- The original reads the keyboard through DirectInput, which needs the
  foreground.
- Candidate addresses include many copies besides the ball's world matrix:
  spawn-frame matrices that never move, particle bounds that grow apart,
  followers that lag behind the ball (consistent with the camera aim's dynamic
  position), and stale copies refreshed only every few seconds. A stale copy
  makes the drop look instantaneous. Identify the ball as the group that leaves
  the spawn pose and is updated every frame.

## Findings

- Level 1 start: the ball falls from (54.0956, 17.6565, −153.0718) to Y ≈ 16.03
  and keeps rocking in the floor crease, with a period of about 1.2 s. The port
  reproduces this envelope.
- The fall itself matches the port. The original reaches Y 17.01, 16.07 and
  16.04 at steps of about 0.12 s. The port reaches 17.02 after about 0.13 s and
  16.06 after about 0.23 s. In both, the landing moves the ball toward lower X
  and higher Z (about 54.06, −152.88).
