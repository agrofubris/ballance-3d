#!/usr/bin/env python3
"""Describe the original sector-managed loose objects from the Levelinit and Gameplay chunk dumps.

Each object's physical settings come from its row in the Levelinit object
tables, joined to the group table that decides its activation. Every stored
fact the description depends on is verified before the JSON document is written.
"""
import argparse
import json
import os
import struct
import sys
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))
from original_chunks import ChunkDump, table

REPOSITORY = SCRIPT_DIRECTORY.parent
SOURCE_NAME = 'Levelinit.nmo'
OUTPUT_NAME = 'object-data.json'

GROUP_TABLE = 4025
# (table index, activation the group row must carry, shape name)
OBJECT_TABLES = [(4015, 2, 'convex'), (4024, 3, 'sphere')]
GROUP_RESET = 2

MASS_CENTER_CONVEX = 6248
MASS_CENTER_SPHERE = 6457
BALL_CENTER = 6451

# Physicalize chain and cleanup links that must exist in the Gameplay link set.
LINK_PAIRS = [
    (6252, 6194), (6195, 6201), (6202, 6219), (6220, 6228), (6230, 6281),
    (6461, 6402), (6403, 6408), (6409, 6426), (6427, 6435), (6437, 6488),
    (6110, 6068), (6070, 6101), (6102, 6111),
]
CLEANUP_BEHAVIOUR = 6100
CLEANUP_TARGET = 6068
ENABLE_FLAG = 6103
UNIT_LOCALS = [(6250, (1, 0, 0)), (6459, (0, 1, 0))]
# (get-key-row behaviour, first object of the row, first output index)
KEY_ROW_LINKS = [(6218, 6232, 6207), (6425, 6439, 6413)]
KEY_ROW_CLASS = 52
KEY_ROW_COUNT = 10
OBJECT_CLASS = 33
WORD_OFFSET = 24


def require(condition, message=None):
    if not condition:
        raise AssertionError(message)


def default_chunk_directory():
    if 'BALLANCE_IMPORT_WORK' in os.environ:
        return Path(os.environ['BALLANCE_IMPORT_WORK'])
    return REPOSITORY / '.local' / 'reference' / 'chunks'


def default_output_path():
    if 'BALLANCE_IMPORT_OUTPUT' in os.environ:
        directory = Path(os.environ['BALLANCE_IMPORT_OUTPUT'])
    else:
        directory = REPOSITORY / '.local' / 'original'
    return directory / OUTPUT_NAME


def resolve(dump, cell):
    """A table cell is a plain value or a parameter reference to one."""
    if isinstance(cell, dict):
        return dump.value(cell['parameterIndex'])
    return cell


def vector(dump, index):
    return [float(component) for component in dump.value(index)]


def read_object(dump, gameplay, row, group, activation, shape):
    cells = {name: resolve(dump, value) for name, value in row.items()}
    group_cells = {name: resolve(dump, value) for name, value in group.items()}
    require(group_cells['Activation'] == activation and group_cells['Reset'] == GROUP_RESET, cells['Group Name'])
    require(cells['Col Group'] == '')
    require(not bool(cells['Frozen?']))
    require(not bool(cells['autm. Mass Center?']))

    mass_center = MASS_CENTER_SPHERE if shape == 'sphere' else MASS_CENTER_CONVEX
    entry = {
        'source': SOURCE_NAME,
        'activation': activation,
        'reset': GROUP_RESET,
        'shape': shape,
        'fixed': bool(cells['Fixed?']),
        'friction': float(cells['Friction']),
        'restitution': float(cells['Elasticity']),
        'mass': float(cells['Mass']),
        'collisionGroup': '',
        'startFrozen': False,
        'enableCollision': bool(cells['Enable Col?']),
        'automaticMassCenter': False,
        'linearDamping': float(cells['Linear Damp']),
        'angularDamping': float(cells['Rot Damp']),
        'massCenter': vector(gameplay, mass_center),
    }
    if shape == 'sphere':
        entry['radius'] = float(cells['Radius'])
        entry['ballCenter'] = vector(gameplay, BALL_CENTER)
    return cells['Group Name'], entry


def verify_gameplay(gameplay):
    for pair in LINK_PAIRS:
        require(pair in gameplay.links, pair)

    require(gameplay.behavior(CLEANUP_BEHAVIOUR, OBJECT_CLASS)['inIO'][1] == CLEANUP_TARGET)
    require(gameplay.value(ENABLE_FLAG) is True)

    for index, expected in UNIT_LOCALS:
        locals_ = gameplay.behavior(index, OBJECT_CLASS)['locals'][:3]
        require([gameplay.value(i) for i in locals_] == list(expected))

    for index, first_object, first_output in KEY_ROW_LINKS:
        outputs = gameplay.behavior(index, KEY_ROW_CLASS)['outputs']
        require(outputs[1:1 + KEY_ROW_COUNT] == list(range(first_output, first_output + KEY_ROW_COUNT)))
        for offset in range(KEY_ROW_COUNT):
            word, = struct.unpack_from('<I', gameplay.rows[first_object + offset][2], WORD_OFFSET)
            require(word == outputs[1 + offset])


def main():
    parser = argparse.ArgumentParser(description='Read the original object settings from chunk dumps.')
    parser.add_argument('chunk_directory', nargs='?', type=Path, default=default_chunk_directory())
    parser.add_argument('--out', type=Path, default=default_output_path())
    arguments = parser.parse_args()
    chunk_directory = arguments.chunk_directory

    levelinit = ChunkDump(chunk_directory / 'Levelinit.tsv')
    gameplay = ChunkDump(chunk_directory / 'Gameplay.tsv')
    groups = table(levelinit.rows[GROUP_TABLE][2])

    document = {}
    for index, activation, shape in OBJECT_TABLES:
        for row in table(levelinit.rows[index][2]):
            group_name = resolve(levelinit, row['Group Name'])
            group = next(g for g in groups if resolve(levelinit, g['Group Names']) == group_name)
            name, entry = read_object(levelinit, gameplay, row, group, activation, shape)
            document[name] = entry

    verify_gameplay(gameplay)

    text = json.dumps(document, indent=2, ensure_ascii=True) + '\n'
    output = arguments.out
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('w', encoding='utf-8', newline='\n') as data:
        data.write(text)
    print(f'Wrote {output}')


if __name__ == '__main__':
    main()
