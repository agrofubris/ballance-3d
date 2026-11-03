#!/usr/bin/env python3
"""Write the 2D interface, menu camera and label data of the original game as one JSON file.

The data comes from the chunk dumps of the original documents and from the local
pack written by prepare-original.py. The output is local data and is never
committed.
"""
import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump, chunks, table

SOURCE_LABEL = 'Menu.nmo, Camera.nmo, Tutorial.nmo, Language.nmo, MenuLevel.nmo and base.cmo'
OUTPUT_NAME = 'ui-data.json'
DEFAULT_OUTPUT = Path('.local') / 'original' / OUTPUT_NAME
OUTPUT_VARIABLE = 'BALLANCE_IMPORT_OUTPUT'

TAG_LAYOUT_2D = 0x10f000
TAG_MATERIAL_REFERENCE = 0x200000
TAG_FRAME = 0x100000
TAG_RECTANGLE = 0x40

FLAG_REQUIRED = 0x200
FLAG_UV_RECT = 0x10000
FLAG_Z_ORDER = 0x20000

CLASS_ENTITY_2D = 27
CLASS_LINK = 2
CLASS_RECTANGLE = (3, 45)

MENU_FONT_ROW = 15362
CREDITS_ROW = 15407
LABEL_ROW = 0
CAMERA_ROW = 497
MENU_CAMERA_TARGET = 'Cam_MenuLevel_Target'
HIGHSCORE_LEVELS = 12
FONT_ROW_COUNT = 255
FONT_CHECK_ROW = 48
FONT_CHECK_VALUE = 3
REQUIRED_LABELS = ['Start', 'Highscore', 'Options', 'Exit', 'Credits']

DOCUMENTS = ['menu', 'camera', 'tutorial']
HASHED_DUMPS = ['Menu', 'Language', 'MenuLevel', 'base']
DUMP_STEMS = ['Menu', 'Camera', 'Tutorial', 'Language', 'MenuLevel', 'base', 'Gameplay']
GRAPH_KEYS = ['Menu', 'Gameplay']

CREATE_FONT_NODE = 'TT CreateFontEx'
FONT_PROPERTIES_NODE = 'Set Font Properties'
TEXT_NODE = '2D Text'
FONT_NAME_PREFIXES = ('GameFont', 'Font_')
TEXT_TARGET_SUFFIXES = (' 2Dentity', ' 2dEntity')


def sha256_hex(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_sprite(dump, name, data):
    offsets = chunks(data)
    layout = offsets[TAG_LAYOUT_2D]
    flags, = struct.unpack_from('<I', data, layout)
    assert flags & FLAG_REQUIRED, name
    rect = list(struct.unpack_from('<4f', data, layout + 4))
    if flags & FLAG_UV_RECT:
        uv = list(struct.unpack_from('<4f', data, layout + 20))
    else:
        uv = [0, 0, 1, 1]
    if flags & FLAG_UV_RECT and flags & FLAG_Z_ORDER:
        z, = struct.unpack_from('<i', data, layout + 36)
    elif flags & FLAG_Z_ORDER:
        z, = struct.unpack_from('<i', data, layout + 20)
    else:
        z = 0
    reference = offsets.get(TAG_MATERIAL_REFERENCE)
    if reference is None:
        material = None
    else:
        material_row, = struct.unpack_from('<I', data, reference)
        material = dump.rows[material_row][1]
    return {
        'rect': rect,
        'uv': uv,
        'z': z,
        'flags': flags,
        'material': material,
        'textOnly': reference is None,
    }


def sprite_map(dump):
    sprites = {}
    for index in sorted(dump.rows):
        kind, name, data = dump.rows[index]
        if kind == CLASS_ENTITY_2D:
            sprites[name] = read_sprite(dump, name, data)
    return sprites


def load_document(pack, key):
    return json.loads((pack / (key + '.json')).read_text(encoding='utf-8'))


def png_size(path):
    header = Path(path).read_bytes()
    width, height = struct.unpack_from('>II', header, 16)
    return width, height


def read_textures_and_materials(pack, textures, materials):
    for key in DOCUMENTS:
        document = load_document(pack, key)
        names_by_id = {}
        for record in document['textures']:
            name = record['name']
            names_by_id[record['id']] = name
            width, height = png_size(pack / 'textures' / (name + '.png'))
            textures[name] = {
                'file': 'textures/' + name + '.png',
                'width': width,
                'height': height,
            }
        for record in document['materials']:
            materials[record['name']] = {
                'texture': names_by_id.get(record['texture']),
                'diffuse': record['diffuse'],
                'blend': {
                    'enabled': record['AlphaBlendEnabled'],
                    'source': record['sourceBlend'],
                    'dest': record['destBlend'],
                },
                'addressMode': record['textureAddressMode'],
            }


def load_graph(pack, key):
    return json.loads((pack / 'graphs' / (key + '.json')).read_text(encoding='utf-8'))


def index_parameters(graph):
    """Return the nodes in ascending index order and a map of parameter index to (record, owning node)."""
    nodes = sorted(graph['nodes'].values(), key=lambda node: node['index'])
    parameters = {}
    for node in nodes:
        for key in ('inputs', 'outputs', 'locals', 'inIO', 'outIO'):
            for record in node.get(key, []):
                parameters.setdefault(record['index'], (record, node))
    return nodes, parameters


def font_name_of(parameters, start_index):
    """Follow the source links from a parameter until a font name is found, or return None."""
    current = start_index
    while True:
        entry = parameters.get(current)
        if entry is None:
            return None
        record, owner = entry
        if owner['name'] == CREATE_FONT_NODE:
            return owner['inputs'][0]['value']
        name = record.get('name') or ''
        if name.startswith(FONT_NAME_PREFIXES):
            return record['name']
        source = record.get('source')
        if source is None:
            return None
        current = source


def create_fonts(nodes, fonts):
    for node in nodes:
        if node['name'] != CREATE_FONT_NODE:
            continue
        inputs = node['inputs']
        name = inputs[0]['value']
        if name in fonts:
            continue
        fonts[name] = {
            'texture': inputs[1]['value'].replace(' Texture', ''),
            'grid': inputs[2]['value'],
            'styles': [],
        }


def add_font_styles(nodes, parameters, fonts):
    for node in nodes:
        if node['name'] != FONT_PROPERTIES_NODE:
            continue
        name = font_name_of(parameters, node['inputs'][0]['index'])
        if name is None:
            continue
        inputs = node['inputs']

        def value(position):
            return inputs[position].get('value')

        shadow_distance = value(8)
        if isinstance(shadow_distance, list):
            shadow_distance = shadow_distance[0]
        fonts[name]['styles'].append({
            'node': node['index'],
            'space': value(1),
            'scale': value(2),
            'italic': value(3),
            'color': value(4),
            'endColor': value(5),
            'shadowColor': value(6),
            'shadowAngle': value(7),
            'shadowDistance': shadow_distance,
            'setting': node['locals'][0].get('value'),
        })


def rectangle_value(dump, index):
    """Margins rectangle reached from a 2D Text input: follow class 2 links to a class 3 or 45 row."""
    while True:
        kind, _name, data = dump.rows[index]
        if kind in CLASS_RECTANGLE:
            offsets = chunks(data)
            if TAG_RECTANGLE not in offsets:
                return None
            at = offsets[TAG_RECTANGLE]
            if struct.unpack_from('<I', data, at + 8)[0] != 1 or struct.unpack_from('<I', data, at + 12)[0] != 16:
                return None
            return list(struct.unpack_from('<4f', data, at + 16))
        if kind != CLASS_LINK:
            return None
        index, = struct.unpack_from('<I', data, 24)
        if index == 0xFFFFFFFF:
            return None


def add_text_bindings(nodes, parameters, dump, bindings):
    for node in nodes:
        if node['name'] != TEXT_NODE or not node.get('target'):
            continue
        target = node['target']
        for suffix in TEXT_TARGET_SUFFIXES:
            target = target.replace(suffix, '')
        bindings.setdefault(target, []).append({
            'font': font_name_of(parameters, node['inputs'][0]['index']),
            'align': node['inputs'][2].get('value'),
            'margins': rectangle_value(dump, node['inputs'][3]['index']),
        })


def read_graph_fonts(pack, key, dump, fonts, bindings):
    nodes, parameters = index_parameters(load_graph(pack, key))
    create_fonts(nodes, fonts)
    add_font_styles(nodes, parameters, fonts)
    add_text_bindings(nodes, parameters, dump, bindings)


def highscore_tables(base):
    tables = []
    for level in range(1, HIGHSCORE_LEVELS + 1):
        wanted = 'DB_Highscore_Lv%02d' % level
        for _kind, name, data in base.rows.values():
            if name == wanted:
                tables.append(table(data))
                break
        else:
            raise AssertionError(wanted)
    return tables


def menu_camera_values(level):
    data = level.rows[CAMERA_ROW][2]
    at = chunks(data)[TAG_FRAME]
    return list(struct.unpack_from('<12f', data, at + 8))


def parse_arguments():
    parser = argparse.ArgumentParser(description='Write the original interface data as JSON.')
    parser.add_argument('dumps', help='directory holding the chunk dumps (TSV)')
    parser.add_argument('--out', help='output JSON path')
    return parser.parse_args()


def output_path(arguments):
    """Return the output path text, exactly as it is printed."""
    if arguments.out is not None:
        return arguments.out
    if OUTPUT_VARIABLE in os.environ:
        return str(Path(os.environ[OUTPUT_VARIABLE]) / OUTPUT_NAME)
    return str(DEFAULT_OUTPUT)


def main():
    arguments = parse_arguments()
    out_text = output_path(arguments)
    out = Path(out_text)
    pack = out.parent
    dumps_directory = Path(arguments.dumps)
    dumps = {stem: ChunkDump(dumps_directory / (stem + '.tsv')) for stem in DUMP_STEMS}
    menu = dumps['Menu']
    language = dumps['Language']
    menu_level = dumps['MenuLevel']

    textures = {}
    materials = {}
    read_textures_and_materials(pack, textures, materials)

    fonts = {}
    bindings = {}
    for key in GRAPH_KEYS:
        read_graph_fonts(pack, key, dumps[key], fonts, bindings)

    font = table(menu.rows[MENU_FONT_ROW][2])
    assert len(font) == FONT_ROW_COUNT, len(font)
    assert round(font[FONT_CHECK_ROW]['vstart'] * 16) == FONT_CHECK_VALUE, font[FONT_CHECK_ROW]
    labels = [row['english'] for row in table(language.rows[LABEL_ROW][2])]
    assert labels[:5] == REQUIRED_LABELS, labels[:5]

    document = {
        'source': SOURCE_LABEL,
        'hashes': {stem: sha256_hex(dumps_directory / (stem + '.tsv')) for stem in HASHED_DUMPS},
        'sprites': sprite_map(menu),
        'hudSprites': sprite_map(dumps['Camera']),
        'tutorialSprites': sprite_map(dumps['Tutorial']),
        'materials': materials,
        'textures': textures,
        'fonts': fonts,
        'textBindings': bindings,
        'font': font,
        'labels': labels,
        'credits': table(menu.rows[CREDITS_ROW][2]),
        'highscores': highscore_tables(dumps['base']),
        'menuCamera': menu_camera_values(menu_level),
        'menuTarget': menu_level.frame(MENU_CAMERA_TARGET),
    }
    out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('Wrote ' + out_text)


if __name__ == '__main__':
    main()
