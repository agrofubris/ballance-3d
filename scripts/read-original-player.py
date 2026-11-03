#!/usr/bin/env python3
"""Describe the original player ball from the Gameplay chunk dump.

Three creation paths of the ActiveBall body and the four drive keys with their
force controllers are checked against the authored link graph, then written as
one JSON document. Nothing is written unless every check passes.
"""
import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump

BEHAVIOR_CLASS = 33
PLAYER_TARGET = 'ActiveBall'
CAMERA_REFERENCE = 'Cam_OrientRef Frame'
SOURCE_LABEL = 'Gameplay.nmo: ActiveBall creation'

# (creation behaviour, the link that must lead into its first input endpoint)
CREATION_PATHS = [(233, (172, 201)), (262, (173, 234)), (291, (174, 263))]
WAKE_BEHAVIOR = 1653
# (direction name, key event behaviour, force controller behaviour)
DRIVE_KEYS = [
    ('right', 1613, 1589),
    ('left', 1635, 1627),
    ('backward', 1605, 1649),
    ('forward', 1597, 1667),
]
UNIT_VECTORS = ([1, 0, 0], [0, 1, 0])


def ensure(condition, detail=''):
    if not condition:
        raise AssertionError(detail)


class Gameplay:
    """Thin accessor over the dump: parameter values by behaviour slot."""

    def __init__(self, dump):
        self.dump = dump

    def behavior(self, index, target_class=BEHAVIOR_CLASS):
        return self.dump.behavior(index, target_class)

    def link(self, pair):
        return pair in self.dump.links

    def input(self, behavior, slot):
        return self.dump.value(behavior['inputs'][slot])

    def local(self, behavior, slot):
        return self.dump.value(behavior['locals'][slot])


def read_body(graph, index, link):
    behavior = graph.behavior(index)
    ensure(behavior['target'] == PLAYER_TARGET, ('creation target', index))
    ensure(graph.link(link), ('creation link', index))
    ensure(link[1] == behavior['inIO'][0], ('creation endpoint', index))

    locals_vector = [graph.local(behavior, slot) for slot in range(3)]
    ensure(locals_vector in UNIT_VECTORS, ('creation shape vector', index))
    convex = bool(graph.local(behavior, 0))

    body = {
        'index': index,
        'fixed': bool(graph.input(behavior, 0)),
        'startFrozen': bool(graph.input(behavior, 5)),
        'enableCollision': bool(graph.input(behavior, 6)),
        'automaticMassCenter': bool(graph.input(behavior, 7)),
        'massCenter': list(graph.local(behavior, 3)),
        'shape': 'convex' if convex else 'sphere',
    }
    if not convex:
        body['center'] = list(graph.input(behavior, 11))
        body['radius'] = graph.input(behavior, 12)
    return body


def read_key(graph, name, key_index, force_index):
    # Key event behaviours carry no target class, so the class check is skipped.
    key = graph.behavior(key_index, target_class=None)
    force = graph.behavior(force_index)
    wake = graph.behavior(WAKE_BEHAVIOR)

    for source, destination in zip(key['outIO'], force['inIO']):
        ensure(graph.link((source, destination)), ('key link', name))
    for source in force['outIO']:
        ensure(graph.link((source, wake['inIO'][0])), ('wake link', name))

    ensure(force['target'] == PLAYER_TARGET, ('controller target', name))
    ensure(graph.input(force, 0) == [0, 0, 0], ('controller origin', name))
    ensure(graph.input(force, 1) == PLAYER_TARGET, ('controller object', name))
    ensure(graph.input(force, 3) == CAMERA_REFERENCE, ('controller reference', name))

    return {
        'name': name,
        'keyBehavior': key_index,
        'forceBehavior': force_index,
        'direction': list(graph.input(force, 2)),
        'directionReference': graph.input(force, 3),
        'wakeOnCreate': True,
        'wakeOnShutdown': True,
    }


def build_document(dump):
    graph = Gameplay(dump)
    bodies = [read_body(graph, index, link) for index, link in CREATION_PATHS]

    ensure(graph.behavior(WAKE_BEHAVIOR)['target'] == PLAYER_TARGET, 'wake target')
    keys = [read_key(graph, name, key, force) for name, key, force in DRIVE_KEYS]

    return {
        'source': SOURCE_LABEL,
        'bodies': bodies,
        'input': {'wakeBehavior': WAKE_BEHAVIOR, 'keys': keys},
    }


def parse_arguments():
    default_dumps = os.environ.get('BALLANCE_IMPORT_WORK', REPO_ROOT / '.local' / 'reference' / 'chunks')
    default_out = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', REPO_ROOT / '.local' / 'original')) / 'player-data.json'

    parser = argparse.ArgumentParser(description='Read the original player ball from the Gameplay chunk dump.')
    parser.add_argument('dumps', nargs='?', type=Path, default=Path(default_dumps))
    parser.add_argument('--out', type=Path, default=default_out)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    dumps = arguments.dumps
    dump_path = dumps / 'Gameplay.tsv' if dumps.is_dir() else dumps

    document = build_document(ChunkDump(dump_path))
    text = json.dumps(document, indent=2) + '\n'

    arguments.out.parent.mkdir(parents=True, exist_ok=True)
    with open(arguments.out, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)
    print(f'Wrote {arguments.out}')


if __name__ == '__main__':
    main()
