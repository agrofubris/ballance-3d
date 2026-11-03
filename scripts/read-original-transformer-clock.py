#!/usr/bin/env python3
"""Recover Gameplay's transformer clock from its chunk dump.

The Trafo Manager compound (Gameplay node 876) is fixed data: three Delayer
durations, the capture radius, the two-frame entry link, the two-frame new-ball
link, the three-frame rearm chain and the manager's own link list. Values are
read from the dump; every selected node and link is checked so a different
layout fails instead of emitting guessed timing.
"""
import argparse
import hashlib
import json
import os
import struct
from pathlib import Path

import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
from original_chunks import ChunkDump

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CHUNKS = Path(os.environ.get('BALLANCE_IMPORT_WORK', ROOT / '.local' / 'reference' / 'chunks'))
DEFAULT_OUT = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', ROOT / '.local' / 'original')) / 'transformer-clock-data.json'

TIMERS = [568, 5, 487]
RADIUS = 444
LINKS = [3112, 857, 569, 573, 859, 860, 874, 855, 854, 164, 858, 871, 865, 873]
EXPECTED_LINKS = {
    3112: (1572, 875, 0), 857: (875, 6, 0), 569: (564, 496, 0),
    573: (497, 563, 0), 859: (480, 574, 0), 860: (575, 0, 0),
    874: (1, 401, 0), 855: (402, 482, 0), 854: (483, 167, 0),
    164: (135, 168, 2), 858: (168, 339, 0), 871: (840, 804, 2),
    865: (805, 6, 1), 873: (846, 479, 2),
}


def link(dump, index):
    kind, name, data = dump.rows[index]
    if kind != 6 or len(data) != 28:
        raise ValueError((index, name, 'is not a link'))
    initial, current, source, destination = struct.unpack_from('<HHII', data, 16)
    if initial != current:
        raise ValueError((index, 'link delay changed', initial, current))
    return {'index': index, 'delayFrames': current, 'source': source, 'destination': destination}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('chunks', nargs='?', type=Path, default=DEFAULT_CHUNKS)
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    path = args.chunks / 'Gameplay.tsv'
    dump = ChunkDump(path)
    for index in TIMERS:
        kind, name, _ = dump.rows[index]
        if kind != 8 or name != 'Delayer':
            raise ValueError((index, name, 'is not a Delayer'))
    timers = [{'index': index, 'durationMs': dump.value(dump.definition(index)['inputs'][0])} for index in TIMERS]
    if [timer['durationMs'] for timer in timers] != [1350.0, 1000.0, 150.0]:
        raise ValueError(('Delayer durations changed', timers))
    capture_radius = dump.value(RADIUS)
    if capture_radius != 4.300000190734863:
        raise ValueError(('capture radius changed', capture_radius))
    links = [link(dump, index) for index in LINKS]
    for row in links:
        expected = EXPECTED_LINKS[row['index']]
        actual = (row['source'], row['destination'], row['delayFrames'])
        if actual != expected:
            raise ValueError((row['index'], 'link changed', actual, expected))
    result = {
        'source': 'Gameplay.nmo: Trafo Manager 876',
        'dumpSha256': hashlib.sha256(path.read_bytes().replace(bytes([13, 10]), bytes([10]))).hexdigest(),
        'timers': timers,
        'captureRadius': capture_radius,
        'physicalizeDelayFrames': links[9]['delayFrames'],
        'entryDelayFrames': links[13]['delayFrames'],
        'rearmDelayFrames': links[-2]['delayFrames'] + links[-1]['delayFrames'],
        'links': links,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Wrote {args.out}')


if __name__ == '__main__':
    main()
