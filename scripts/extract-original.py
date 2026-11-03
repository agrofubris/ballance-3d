#!/usr/bin/env python3
"""Export Ballance NMO documents to JSON descriptions and PNG textures.

The BMap shared library parses the documents. This script chooses which
documents to read, checks each texture against the chunk dump of the same
document, and writes one JSON file per document plus the texture images.
"""
import argparse
import ctypes
import hashlib
import json
import os
import sys
from ctypes import byref, c_bool, c_char_p, c_float, c_uint8, c_uint16, c_uint32, c_void_p
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from original_chunks import ChunkDump

TEXTURE_CLASS = 31
BMAP_FLAGS = 2
ENCODINGS = (b'windows-1252', b'utf-8')
MENU_DOCUMENTS = ('Menu.nmo', 'MenuLevel.nmo', 'Camera.nmo', 'Tutorial.nmo')
POSITION_DECIMALS = 7
DUMP_ENVIRONMENT = 'BALLANCE_IMPORT_WORK'
LOG_CALLBACK = ctypes.CFUNCTYPE(None, c_char_p)


def decode(raw):
    return '' if raw is None else raw.decode('utf-8', errors='replace')


def print_log(raw):
    message = decode(raw)
    if message:
        print(message)


class BMap:
    """Thin ctypes wrapper around BMap.dll. Every getter reports failure by name and id."""

    def __init__(self, library_path):
        self.dll = ctypes.CDLL(str(library_path))
        self.log = LOG_CALLBACK(print_log)

    def initialise(self):
        if not self.dll.BMInit():
            raise AssertionError('BMap initialization failed')

    def shutdown(self):
        self.dll.BMDispose()

    def load(self, document, temp_dir, textures_dir):
        handle = c_void_p()
        encodings = (c_char_p * len(ENCODINGS))(*ENCODINGS)
        loaded = self.dll.BMFile_Load(
            document.as_posix().encode('utf-8'),
            temp_dir.resolve().as_posix().encode('utf-8'),
            textures_dir.resolve().as_posix().encode('utf-8'),
            self.log,
            BMAP_FLAGS,
            encodings,
            byref(handle),
        )
        if not loaded:
            raise RuntimeError(f'Cannot load {document.as_posix()}')
        return handle

    def release(self, handle):
        self.dll.BMFile_Free(handle)

    def _fetch(self, name, handle, args, object_id, out):
        if not getattr(self.dll, name)(handle, *args, byref(out)):
            raise RuntimeError(f'{name} failed for {object_id}')
        return out

    def scalar(self, ctype, name, handle, args=(), object_id=None):
        return self._fetch(name, handle, args, object_id, ctype()).value

    def vector(self, ctype, count, name, handle, args=(), object_id=None):
        return list(self._fetch(name, handle, args, object_id, (ctype * count)()))

    def block(self, ctype, size, name, handle, object_id):
        """Pointer-returning getter; the data is copied out before the next library call."""
        address = self.scalar(c_void_p, name, handle, (object_id,), object_id)
        if size == 0:
            return []
        return list((ctype * size).from_address(address))

    def name_of(self, handle, object_id):
        return decode(self.scalar(c_char_p, 'BMObject_GetName', handle, (object_id,), object_id))

    def ids(self, handle, count_name, item_name):
        count = self.scalar(c_uint32, count_name, handle)
        return [self.scalar(c_uint32, item_name, handle, (index,)) for index in range(count)]

    def save_image(self, handle, texture_id, destination):
        return self.dll.BMTexture_SaveImage(handle, texture_id, destination.as_posix().encode('utf-8'))


def parse_arguments():
    parser = argparse.ArgumentParser(description='Export Ballance NMO documents to JSON and PNG.')
    parser.add_argument('--library', type=Path, required=True, help='path of BMap.dll')
    parser.add_argument('--game', type=Path, required=True, help='Ballance game folder')
    parser.add_argument('--output', type=Path, required=True, help='output directory')
    parser.add_argument('--work', type=Path, help='directory holding the chunk dumps')
    parser.add_argument('--entities', action='store_true', help='shared gameplay models (PH)')
    parser.add_argument('--transformer', action='store_true', help='AnimTrafo.nmo')
    parser.add_argument('--menu', action='store_true', help='menu documents')
    parser.add_argument('--level', type=int, help='one level number')
    parser.add_argument('--document', action='append', help='game-relative document path (repeatable)')
    return parser.parse_args()

def select_documents(args, game, entities):
    """Later selections replace earlier ones; --level is the first of them."""
    selected = None
    if args.level:
        selected = [entities / 'Level' / f'Level_{args.level:02d}.NMO']
    if args.entities:
        selected = sorted((entities / 'PH').glob('*.nmo'))
    if args.transformer:
        selected = [entities / 'AnimTrafo.nmo']
    if args.menu:
        selected = [entities / name for name in MENU_DOCUMENTS]
    if args.document:
        selected = [game / path for path in args.document]
    if selected is None:
        selected = sorted((entities / 'Level').glob('*.NMO')) + [entities / 'Balls.nmo']
    return selected


def colour_keys(dump, document_name):
    """Map each texture name to its colour key (an int, or None when it has none)."""
    recorded = {}
    for index, (kind, name, _data) in dump.rows.items():
        if kind != TEXTURE_CLASS:
            continue
        state = dump.texture_transparency(index)
        recorded.setdefault(name, set()).add(None if state is None else state['transparentColor'])
    keys = {}
    for name, values in recorded.items():
        if len(values) > 1:
            ordered = sorted(values, key=lambda colour: (colour is not None, colour or 0))
            raise RuntimeError(f'{document_name}: texture {name} maps to conflicting colour keys {ordered}')
        keys[name] = next(iter(values))
    return keys


def export_textures(bmap, handle, textures_dir, keys, document_name):
    records = []
    for texture_id in bmap.ids(handle, 'BMFile_GetTextureCount', 'BMFile_GetTexture'):
        source = decode(bmap.scalar(c_char_p, 'BMTexture_GetFileName', handle, (texture_id,), texture_id))
        source = source.replace('\\', '/')
        last_part = source.rsplit('/', 1)[-1]
        stem = last_part.rsplit('.', 1)[0] if '.' in last_part else last_part
        file_name = f'{stem}.png' if stem else f'texture-{texture_id}.png'
        if not bmap.save_image(handle, texture_id, textures_dir / file_name):
            raise RuntimeError(f'Cannot export texture {source}')
        name = bmap.name_of(handle, texture_id)
        if name not in keys:
            raise RuntimeError(f'{document_name}: texture {name} has no chunk-dump record')
        record = {'id': texture_id, 'name': name, 'source': source, 'file': f'textures/{file_name}'}
        if keys[name] is not None:
            record['transparent'] = True
            record['transparentColor'] = keys[name]
        records.append(record)
    return records


def export_materials(bmap, handle):
    records = []
    for material_id in bmap.ids(handle, 'BMFile_GetMaterialCount', 'BMFile_GetMaterial'):
        args = (material_id,)
        records.append({
            'id': material_id,
            'name': bmap.name_of(handle, material_id),
            'texture': bmap.scalar(c_uint32, 'BMMaterial_GetTexture', handle, args, material_id),
            'diffuse': bmap.vector(c_float, 4, 'BMMaterial_GetDiffuse', handle, args, material_id),
            'ambient': bmap.vector(c_float, 4, 'BMMaterial_GetAmbient', handle, args, material_id),
            'specular': bmap.vector(c_float, 4, 'BMMaterial_GetSpecular', handle, args, material_id),
            'emissive': bmap.vector(c_float, 4, 'BMMaterial_GetEmissive', handle, args, material_id),
            'AlphaBlendEnabled': bmap.scalar(c_bool, 'BMMaterial_GetAlphaBlendEnabled', handle, args, material_id),
            'AlphaTestEnabled': bmap.scalar(c_bool, 'BMMaterial_GetAlphaTestEnabled', handle, args, material_id),
            'TwoSidedEnabled': bmap.scalar(c_bool, 'BMMaterial_GetTwoSidedEnabled', handle, args, material_id),
            'ZWriteEnabled': bmap.scalar(c_bool, 'BMMaterial_GetZWriteEnabled', handle, args, material_id),
            'alphaRef': bmap.scalar(c_uint8, 'BMMaterial_GetAlphaRef', handle, args, material_id),
            'alphaFunc': bmap.scalar(c_uint32, 'BMMaterial_GetAlphaFunc', handle, args, material_id),
            'sourceBlend': bmap.scalar(c_uint32, 'BMMaterial_GetSourceBlend', handle, args, material_id),
            'destBlend': bmap.scalar(c_uint32, 'BMMaterial_GetDestBlend', handle, args, material_id),
            'textureBlendMode': bmap.scalar(c_uint32, 'BMMaterial_GetTextureBlendMode', handle, args, material_id),
            'textureMinMode': bmap.scalar(c_uint32, 'BMMaterial_GetTextureMinMode', handle, args, material_id),
            'textureMagMode': bmap.scalar(c_uint32, 'BMMaterial_GetTextureMagMode', handle, args, material_id),
            'textureAddressMode': bmap.scalar(c_uint32, 'BMMaterial_GetTextureAddressMode', handle, args, material_id),
            'textureBorderColor': bmap.vector(c_float, 4, 'BMMaterial_GetTextureBorderColor', handle, args, material_id),
            'specularPower': bmap.scalar(c_float, 'BMMaterial_GetSpecularPower', handle, args, material_id),
        })
    return records

def rounded(values):
    return [round(value, POSITION_DECIMALS) for value in values]


def export_meshes(bmap, handle):
    records = []
    for mesh_id in bmap.ids(handle, 'BMFile_GetMeshCount', 'BMFile_GetMesh'):
        vertices = bmap.scalar(c_uint32, 'BMMesh_GetVertexCount', handle, (mesh_id,), mesh_id)
        faces = bmap.scalar(c_uint32, 'BMMesh_GetFaceCount', handle, (mesh_id,), mesh_id)
        positions = bmap.block(c_float, vertices * 3, 'BMMesh_GetVertexPositions', handle, mesh_id)
        normals = bmap.block(c_float, vertices * 3, 'BMMesh_GetVertexNormals', handle, mesh_id)
        uvs = bmap.block(c_float, vertices * 2, 'BMMesh_GetVertexUVs', handle, mesh_id)
        indices = bmap.block(c_uint16, faces * 3, 'BMMesh_GetFaceIndices', handle, mesh_id)
        face_materials = bmap.block(c_uint16, faces, 'BMMesh_GetFaceMaterialSlotIndexs', handle, mesh_id)
        slot_count = bmap.scalar(c_uint32, 'BMMesh_GetMaterialSlotCount', handle, (mesh_id,), mesh_id)
        slots = [bmap.scalar(c_uint32, 'BMMesh_GetMaterialSlot', handle, (mesh_id, slot), mesh_id)
                 for slot in range(slot_count)]
        records.append({
            'id': mesh_id,
            'name': bmap.name_of(handle, mesh_id),
            'positions': rounded(positions),
            'normals': rounded(normals),
            'uvs': rounded(uvs),
            'indices': indices,
            'faceMaterials': face_materials,
            'materials': slots,
        })
    return records


def export_objects(bmap, handle):
    records = []
    for entity_id in bmap.ids(handle, 'BMFile_Get3dObjectCount', 'BMFile_Get3dObject'):
        args = (entity_id,)
        records.append({
            'id': entity_id,
            'name': bmap.name_of(handle, entity_id),
            'mesh': bmap.scalar(c_uint32, 'BM3dEntity_GetCurrentMesh', handle, args, entity_id),
            'matrix': bmap.vector(c_float, 16, 'BM3dEntity_GetWorldMatrix', handle, args, entity_id),
            'visible': bmap.scalar(c_bool, 'BM3dEntity_GetVisibility', handle, args, entity_id),
        })
    return records


def export_groups(bmap, handle):
    records = []
    for group_id in bmap.ids(handle, 'BMFile_GetGroupCount', 'BMFile_GetGroup'):
        count = bmap.scalar(c_uint32, 'BMGroup_GetObjectCount', handle, (group_id,), group_id)
        members = [bmap.scalar(c_uint32, 'BMGroup_GetObject', handle, (group_id, member), group_id)
                   for member in range(count)]
        records.append({'name': bmap.name_of(handle, group_id), 'members': members})
    return records

def export_document(bmap, document, work, output, game_textures):
    temp_dir = output / '.temp'
    textures_dir = output / 'textures'
    handle = bmap.load(document, temp_dir, game_textures)

    dump_path = work / f'{document.stem}.tsv'
    if not dump_path.is_file():
        raise RuntimeError(f'Missing chunk dump {dump_path}; prepare-original.py dumps every document first')
    keys = colour_keys(ChunkDump(dump_path), document.name)

    textures = export_textures(bmap, handle, textures_dir, keys, document.name)
    materials = export_materials(bmap, handle)
    meshes = export_meshes(bmap, handle)
    objects = export_objects(bmap, handle)
    groups = export_groups(bmap, handle)
    record = {
        'version': 1,
        'source': document.name,
        'sha256': hashlib.sha256(document.read_bytes()).hexdigest(),
        'objects': objects,
        'meshes': meshes,
        'materials': materials,
        'textures': textures,
        'groups': groups,
    }
    target = output / f'{document.stem.lower()}.json'
    target.write_text(json.dumps(record, separators=(',', ':')))
    print(f'EXPORTED {document.name}: {len(objects)} objects, {len(meshes)} meshes, '
          f'{len(textures)} textures -> {target}')
    bmap.release(handle)


def main():
    args = parse_arguments()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    (output / 'textures').mkdir(exist_ok=True)
    (output / '.temp').mkdir(exist_ok=True)

    if args.work is not None:
        work = args.work
    elif DUMP_ENVIRONMENT in os.environ:
        work = Path(os.environ[DUMP_ENVIRONMENT])
    else:
        work = Path(__file__).resolve().parent.parent / '.local' / 'reference' / 'chunks'
    work = work.resolve()

    game = args.game
    entities = game / '3D Entities'
    if not entities.is_dir():
        entities = game / '3D_Entities'
    documents = select_documents(args, game, entities)

    bmap = BMap(args.library)
    bmap.initialise()
    for document in documents:
        export_document(bmap, document, work, output, game / 'Textures')
    bmap.shutdown()


if __name__ == '__main__':
    main()
