#!/usr/bin/env python3
"""Extract MenuLevel.nmo's looping I_Ball_Stone animation into the local pack.

The authoring data is a CKAnimation (MenuLevel.tsv row 1064) attached to entity
1065. Its chunk 0x4000000 holds three tracks in order: position (time + xyz),
rotation (time + xyzw) and scale (time + xyz). The graph plays it for 59246 ms
with a linear progression, so the key range is stretched across that duration.
Nothing produced here is committed.
"""
import argparse
import json
import os
import struct
import sys
from pathlib import Path

import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks

DEFAULT_OUT = Path(os.environ['BALLANCE_IMPORT_OUTPUT']) / 'menu-ball.json' if 'BALLANCE_IMPORT_OUTPUT' in os.environ else Path('.local/original/menu-ball.json')

ANIMATION_ROW = 1064
ENTITY_ID = 1065
DURATION_MS = 59246.0

parser = argparse.ArgumentParser()
parser.add_argument('dumps', type=Path)
parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
args = parser.parse_args()

dump = ChunkDump(args.dumps / 'MenuLevel.tsv')
kind, name, raw = dump.rows[ANIMATION_ROW]
if name != 'Record Anim':
    raise SystemExit(f'MenuLevel row {ANIMATION_ROW} is {name!r}, expected Record Anim')
offset = chunks(raw)[0x4000000]
entity, = struct.unpack_from('<I', raw, offset + 0x20)
if entity != ENTITY_ID:
    raise SystemExit(f'animation entity is {entity}, expected {ENTITY_ID}')
key_count, = struct.unpack_from('<I', raw, offset + 0x30)
if key_count < 2:
    raise SystemExit(f'animation has {key_count} keys')

def track(start: int, components: int):
    stride = 4 * (components + 1)
    end = start + key_count * stride
    if end > len(raw):
        raise SystemExit(f'track at {start} exceeds chunk length {len(raw)}')
    values = []
    times = []
    for index in range(key_count):
        time, *components_values = struct.unpack_from(f'<{components + 1}f', raw, start + index * stride)
        times.append(time)
        values.extend(components_values)
    return times, values

position_start = offset + 0x34
times, positions = track(position_start, 3)
if any(abs(times[i] - i) > 1e-3 for i in range(key_count)):
    raise SystemExit('position keys are not one unit apart')

rotation_start = position_start + key_count * 16 + 12
rotation_times, rotations = track(rotation_start, 4)
if rotation_times != times:
    raise SystemExit('rotation key times differ from position key times')

scale_start = rotation_start + key_count * 20 + 12
scale_times, scales = track(scale_start, 3)
if scale_times != times:
    raise SystemExit('scale key times differ from position key times')

args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps({
    'source': 'MenuLevel.nmo: CKAnimation 1064 Record Anim on I_Ball_Stone',
    'entity': 'I_Ball_Stone',
    'durationMs': DURATION_MS,
    'keyCount': key_count,
    'positions': positions,
    'rotations': rotations,
    'scales': scales,
}, separators=(',', ':')) + '\n', encoding='utf-8')
print(f'Wrote {args.out} ({key_count} keys)')
