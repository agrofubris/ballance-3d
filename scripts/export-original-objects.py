#!/usr/bin/env python3
"""Export each chunk dump's object table for the CK object context.

Every file object in file order: its file index, name and CK class id, a
CK3dEntity's saved parent, world matrix and hidden flag, a CKGroup's members (both as file indices), a CKWaveSound's saved state,
its saved attributes by name, and the document's attribute type table.
The delete-mode dependency links come from the state chunks: a 3D entity's
meshes and current mesh, object animations and target; a curve's control
points; a mesh's face and channel materials; a material's texture slots 1..3;
and a data array's object cells. Root scripts are listed (class 8); the other
behaviors, parameters and graph links are left to the graph export. Output goes
to .local/original/objects/<stem>.json (local, derived from the user's files).

Usage: python3 scripts/export-original-objects.py
"""
import json
import os
import struct
from pathlib import Path

import sys; sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parent))
import original_curves
from original_chunks import ChunkDump


def object_animation(rows, index):
    """A CKObjectAnimation's controllers, including saved TCB key blocks.

    `original_curves.object_animation` decodes the linear controllers; the
    shipped UFO arms animate rotation with the TCB controller type
    (0x45B52A02), whose keys are time, quaternion, tension, continuity, bias,
    ease-to and ease-from. The same RCKObjectAnimation parser applies; only the
    key contents differ, so parse the shared layout here and keep both
    interpolation kinds in the exported controller data.
    """
    try:
        return original_curves.object_animation(rows, index)
    except ValueError as error:
        if 'tcb' not in str(error):
            raise
    cls, name, data = rows[index]
    if cls != original_curves.CKCID_OBJECTANIMATION:
        raise ValueError((index, 'is not a CKObjectAnimation', cls))
    if original_curves.header(data)['dataVersion'] < 1:
        raise ValueError((index, 'CKObjectAnimation data version', original_curves.header(data)['dataVersion'], 'is not decoded'))
    found = dict(original_curves.idents(data)[0])
    if original_curves.ANIM_DATA not in found:
        raise ValueError((index, 'CKObjectAnimation without ident 0x4000000'))
    w = found[original_curves.ANIM_DATA]
    flags, entity, length = w[7], w[8], original_curves.as_float(w[9])
    position = 10
    if flags & 0x80:
        raise ValueError((index, 'merged CKObjectAnimation is not decoded'))
    controllers = []
    while True:
        kind = w[position]
        position += 1
        if kind == 0:
            break
        size = w[position]
        position += 1
        blob = w[position:position + size]
        position += size
        if kind not in original_curves.CONTROLLER_KINDS:
            raise ValueError((index, 'unknown animation controller', hex(kind)))
        track, interpolation, stride = original_curves.CONTROLLER_KINDS[kind]
        count = blob[0]
        if len(blob) != 1 + count * stride:
            raise ValueError((index, track, 'controller size mismatch', len(blob), count))
        controllers.append({'type': '%08x' % kind, 'track': track, 'interpolation': interpolation,
                            'keys': count, 'stride': stride, 'data': [original_curves.as_float(x) for x in blob[1:]]})
    if position != len(w):
        raise ValueError((index, 'trailing animation data', len(w) - position))
    return {'index': index, 'name': name, 'entity': entity, 'flags': flags, 'length': length, 'controllers': controllers}

ROOT = Path(__file__).resolve().parent.parent
ORIGINAL = Path(os.environ.get('BALLANCE_IMPORT_OUTPUT', ROOT / '.local' / 'original'))
CHUNKS = Path(os.environ.get('BALLANCE_IMPORT_WORK', ROOT / '.local' / 'reference' / 'chunks'))
OUT = ORIGINAL / 'objects'
# CKCID_PARAMETERIN, PARAMETEROUT, OPERATION, BEHAVIORLINK, BEHAVIOR, BEHAVIORIO, PARAMETERLOCAL, PARAMETER
GRAPH_CLASSES = {2, 3, 4, 6, 8, 9, 45, 46}


def scripts(dump):
    """Root behaviors (scripts and top-level behaviors): no compound lists them as a child."""
    behaviors, owned = [], set()
    for index, (kind, _name, _data) in dump.rows.items():
        if kind != 8:
            continue
        try:
            definition = dump.definition(index)
        except (ValueError, KeyError, AssertionError, struct.error):
            continue
        behaviors.append(index)
        owned.update(definition.get('children', []))
    return {index for index in behaviors if index not in owned}


def render_links(stem, objects):
    """Entity -> meshes, mesh -> materials, material -> textures (file indices).

    The rendering export (`.local/original/<stem>.json`, from LibCmo) already
    resolved these references with its own IDs; they are mapped onto this
    dump's file indices by name within each class. A name used twice in a class
    is left unlinked and recorded in `ambiguous`, so a dependency walk that
    reaches it fails loudly.
    """
    render = ORIGINAL / f'{stem.lower()}.json'
    if not render.is_file():
        return
    data = json.loads(render.read_text(encoding='utf-8'))
    by_class = {}
    for item in objects:
        by_class.setdefault((item['class'], item['name']), []).append(item)
    def index(cls, name):
        found = by_class.get((cls, name), [])
        return found[0]['index'] if len(found) == 1 else None
    names = {kind: {entry['id']: entry['name'] for entry in data.get(kind, [])} for kind in ('meshes', 'materials', 'textures')}
    def link(item_class, item_name, key, target_class, target_names):
        found = by_class.get((item_class, item_name), [])
        # A link decoded from the chunk dump is exact (file indices); the render
        # export only fills the links the chunks do not carry.
        if len(found) != 1 or key in found[0]:
            return
        targets = []
        for name in target_names:
            if name is None:
                continue
            target = index(target_class, name)
            if target is None:
                found[0].setdefault('ambiguous', []).append(name)
            else:
                targets.append(target)
        if targets:
            found[0][key] = targets
    for entry in data.get('objects', []):
        mesh = names['meshes'].get(entry.get('mesh'))
        link(41, entry['name'], 'meshes', 32, [mesh] if mesh else [])
    for entry in data.get('meshes', []):
        link(32, entry['name'], 'materials', 30, [names['materials'].get(m) for m in entry.get('materials', [])])
    for entry in data.get('materials', []):
        texture = names['textures'].get(entry.get('texture'))
        link(30, entry['name'], 'textures', 31, [texture] if texture else [])


def export(path):
    dump = ChunkDump(path)
    roots = scripts(dump)
    level_scene = dump.level_scene()
    objects = []
    for index, (kind, name, _data) in sorted(dump.rows.items()):
        # Root scripts are context objects (Execute Script resolves them by name).
        if kind in GRAPH_CLASSES and index not in roots:
            continue
        item = {'index': index, 'name': name, 'class': kind}
        parent = dump.entity_parent(index)
        if parent is not None:
            item['parent'] = parent
        matrix = dump.entity_matrix(index)
        if matrix is not None:
            item['matrix'] = matrix
        if dump.entity_hidden(index):
            item['hidden'] = True
        if kind == 23:
            item['members'] = dump.group_members(index)
        if kind == 25:
            item['sound'] = dump.wave_sound(index)
        if kind == 30:
            item['material'] = dump.material_state(index)
        if kind in (34, 35):
            item['camera'] = dump.camera(index)
        if kind in (38, 39):
            item['light'] = dump.light(index)
        if kind == 43:
            decoded = original_curves.curve(dump.rows, index)
            item['curve'] = {'closed': decoded['closed'], 'fitting': decoded['fitting'], 'points': [
                {key: point[key] for key in ('index', 'tension', 'continuity', 'bias', 'linear', 'savedTangents', 'incoming', 'outgoing')}
                for point in decoded['points']]}
            # RCKCurve::PrepareDependencies (0x100166A1) takes the point array unconditionally.
            item['controlPoints'] = [point['index'] for point in decoded['points']]
        if 0x21 <= kind <= 0x2b:
            links = dump.entity_dependencies(index)
            for key in ('meshes', 'currentMesh', 'animations', 'target', 'materials'):
                if links.get(key) not in (None, []):
                    item[key] = links[key]
        if kind in (32, 53):
            links = dump.mesh_dependencies(index)
            for key in ('materials', 'channelMaterials'):
                if links.get(key) not in (None, []):
                    item[key] = links[key]
        if kind == 52:
            cells = dump.data_array_cells(index)
            if cells:
                item['cells'] = cells
        if kind == 15:
            try:
                decoded = object_animation(dump.rows, index)
                item['animation'] = {key: decoded[key] for key in ('entity', 'flags', 'length', 'controllers')}
            except ValueError as error:
                # Kept as a marker: playing it fails loudly with the reason.
                item['animation'] = {'undecoded': repr(error.args[0])}
        entity = original_curves.entity_world_matrix(dump.rows[index][2]) if 0x21 <= kind <= 0x2b else None
        if entity is not None and entity['flags']:
            # CK_3DENTITY_FLAGS (chunk 0x100000, first word).
            item['entityFlags'] = entity['flags']
        if kind in (27, 28, 29):
            saved = dump.entity2d(index)
            if saved['parent'] is not None:
                raise ValueError((index, name, '2D entity parents are not exported'))
            if saved['hidden']:
                item['hidden'] = True
            if saved['material'] is not None:
                item['materials'] = [saved['material']]
            item['entity2d'] = {key: saved[key] for key in ('flags', 'rect', 'sourceRect', 'zOrder')}
        # Start flags: the level scene's descriptor, or the object's own record in a level-less document.
        flags = level_scene[0].get(index) if level_scene else dump.scene_flags(index)
        if flags is not None:
            item['sceneFlags'] = flags
        # The level scene's initial value (Restore IC reloads it); only 2D entities' are decoded.
        initial = level_scene[2].get(index) if level_scene else None
        if initial is not None:
            if initial['cid'] == 27:
                saved = dump.entity2d_initial(index, initial)
                item['initial'] = {
                    'hidden': saved['hidden'], 'hiddenHierarchical': saved['hiddenHierarchical'],
                    'entity2d': {key: saved[key] for key in ('flags', 'rect', 'sourceRect', 'zOrder')},
                    'materials': [saved['material']] if saved['material'] is not None else [],
                }
            else:
                item['initial'] = {'class': initial['cid']}
        owned = dump.object_scripts(index)
        if owned:
            item['scripts'] = owned
        if kind not in GRAPH_CLASSES:
            attributes = []
            for attribute, ref in dump.object_attributes(index):
                entry = {'name': attribute}
                if ref is not None:
                    try:
                        entry['value'] = dump.value(ref)
                    except (ValueError, KeyError, AssertionError, struct.error):
                        entry['raw'] = dump.rows[ref][2].hex()
                attributes.append(entry)
            if attributes:
                item['attributes'] = attributes
        objects.append(item)
    render_links(Path(path).stem, objects)
    # Slots 1..3 of a material's textures come only from the chunk dump.
    for item in objects:
        if item['class'] == 30:
            extra = dump.material_textures(item['index'])
            if extra:
                item['textures'] = [*item.get('textures', []), *extra]
    result = {'source': Path(path).stem, 'objects': objects}
    if level_scene:
        result['levelScene'] = level_scene[1]
    if dump.attribute_types:
        # The document's attribute table: name -> parameter type GUID (empty for none).
        result['attributeTypes'] = {name: guid for name, guid in dump.attribute_types.values()}
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for path in sorted(CHUNKS.glob('*.tsv')):
        data = export(path)
        (OUT / f'{path.stem}.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
        print(f'{path.stem}: {len(data["objects"])} objects')


if __name__ == '__main__':
    main()
