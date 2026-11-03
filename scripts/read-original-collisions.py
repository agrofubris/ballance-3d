#!/usr/bin/env python3
"""Describe the original collision groups from the Levelinit, Balls and module chunk dumps.

The group names of the floors, the player balls, the level modules and the
fragment creation nodes are verified against the authored link graph, then
printed as one JSON document on standard output.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump, table

BEHAVIOR_CLASS = 33
PARAMETER_CLASS = 45
COLLISION_GROUP_NAME = 'Collision Group'
SOURCE_LABEL = 'Levelinit.nmo / Balls.nmo / P_Modul_*.nmo'

FLOOR_TABLE_OBJECT = 4002
PLAYER_TABLE_OBJECT = 2260
MODULE_NUMBERS = ['01', '03', '08', '17', '18', '19', '25', '26', '29', '30', '34', '37', '41']
EXPECTED_IDENTIFIERS = {'', 'Ball', 'Floor', 'Modul29'}

# Fragment creation nodes, in document order: (name, node, link pair into it).
FRAGMENT_NODES = [
    ('wood', 501, (456, 468)),
    ('stone', 756, (717, 723)),
    ('paper', 627, (629, 595)),
]
MUST_FOLLOW_CREATION = 'must follow creation, not Unphysicalize cleanup'
# Cleanup-only nodes: (node, link pair into its second endpoint).
CLEANUP_NODES = [(857, (861, 824)), (970, (974, 937)), (1169, (1173, 1136))]


def ensure(condition, detail=''):
    if not condition:
        raise AssertionError(detail)


class Dump:
    def __init__(self, path):
        self.chunks = ChunkDump(path)

    def resolve(self, cell):
        if isinstance(cell, dict):
            return self.chunks.value(cell['parameterIndex'])
        return cell

    def table_rows(self, index):
        return [{column: self.resolve(cell) for column, cell in row.items()}
                for row in table(self.chunks.rows[index][2])]

    def behavior(self, index):
        return self.chunks.behavior(index, BEHAVIOR_CLASS)

    def input(self, behavior, slot):
        return self.chunks.value(behavior['inputs'][slot])

    def collision_groups(self):
        values = set()
        for index, (kind, name, _raw) in self.chunks.rows.items():
            if kind == PARAMETER_CLASS and name == COLLISION_GROUP_NAME:
                values.add(self.chunks.value(index))
        return values


def read_floors(levelinit):
    floors = {}
    for row in levelinit.table_rows(FLOOR_TABLE_OBJECT):
        ensure(row['Enable Col?'] is True, 'floor collision disabled')
        floors[row['Group_Name']] = row['Col Group']
    return floors


def read_players(balls):
    return {row['Ballname']: row['CollGroup'] for row in balls.table_rows(PLAYER_TABLE_OBJECT)}


def read_fragments(balls):
    fragments = {}
    for name, node, pair in FRAGMENT_NODES:
        behavior = balls.behavior(node)
        ensure(pair in balls.chunks.links and pair[1] == behavior['inIO'][0],
               MUST_FOLLOW_CREATION)
        group = balls.input(behavior, 4)
        enabled = balls.input(behavior, 6)
        ensure(enabled is True, ('fragment disabled', name))
        fragments[name] = {'index': node, 'group': group, 'enabled': enabled}
    return fragments


def check_cleanup_nodes(balls):
    for node, pair in CLEANUP_NODES:
        behavior = balls.behavior(node)
        ensure(pair in balls.chunks.links and pair[1] == behavior['inIO'][1], ('cleanup link', node))
        first_endpoint = behavior['inIO'][0]
        ensure(all(target != first_endpoint for _source, target in balls.chunks.links),
               ('cleanup feeds fragment input', node))


def read_modules(chunk_directory):
    modules = {}
    for number in MODULE_NUMBERS:
        module = Dump(chunk_directory / f'P_Modul_{number}.tsv')
        modules[f'P_Modul_{number}'] = sorted(module.collision_groups())
    return modules


def build_document(chunk_directory):
    levelinit = Dump(chunk_directory / 'Levelinit.tsv')
    balls = Dump(chunk_directory / 'Balls.tsv')

    floors = read_floors(levelinit)
    players = read_players(balls)
    fragments = read_fragments(balls)
    check_cleanup_nodes(balls)
    modules = read_modules(chunk_directory)

    found = set(floors.values()) | set(players.values())
    found |= {fragment['group'] for fragment in fragments.values()}
    for groups in modules.values():
        found |= set(groups)
    ensure(found == EXPECTED_IDENTIFIERS, found)

    return {
        'source': SOURCE_LABEL,
        'floors': floors,
        'players': players,
        'modules': modules,
        'fragments': fragments,
        'identifiers': sorted(found),
    }


def main():
    parser = argparse.ArgumentParser(description='Read the original collision groups from chunk dumps.')
    parser.add_argument('chunk_directory', type=Path)
    arguments = parser.parse_args()

    document = build_document(arguments.chunk_directory)
    print(json.dumps(document, indent=2))


if __name__ == '__main__':
    main()
