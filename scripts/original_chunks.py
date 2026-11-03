"""Reader for the object dumps of original Ballance documents.

A dump is a TSV file with one row per saved object: index, saved identifier,
class code, name and the raw object bytes in hex. `ChunkDump` indexes those
rows and decodes parameter values, behaviour layouts, frames and data tables
from the bytes. It never executes or writes anything, and it raises on data it
does not understand instead of guessing.
"""
import struct
from pathlib import Path

MESSAGE_MANAGER = 0x466a0fac
MESSAGE_TYPE = '121e88032b4ea35b'
ATTRIBUTE_MANAGER = 0x3d242466
ATTRIBUTE_TYPE = 'e94ea33e6653fa09'
PARAMETER_TYPE = 'f57d513465495e04'  # CKPGUID_PARAMETERTYPE
ENTITY2D_LOAD_MASK = 0xFFF8F7FF
ENTITY2D_IDENTIFIERS = {0x4, 0x400, 0x10f000, 0x200000}
ENTITY2D_FLAGS = 0x7F1FFF


def chunks(data):
    """Map each chunk identifier in `data` to the byte offset of its data.

    The chunk table begins at byte 8. An entry is [identifier, word count]
    followed by the words; its data offset is the identifier's offset plus 8.
    The next entry starts at the absolute offset 8 + 4 * count of the entry just
    read (not relative to that entry). The walk records an entry and stops once
    an entry has a zero word count. The result is a plain dict (last occurrence
    of an identifier wins).
    """
    found = {}
    start = 8
    while True:
        tag, count = struct.unpack_from('<2I', data, start)
        found[tag] = start + 8
        if count == 0:
            return found
        start = 8 + 4 * count


def attribute_names(path, types=False):
    """CKAttributeManager attribute names by index from a `--managers` dump.

    The manager's data (GUID 0x3d242466:0, chunk 0x52) lists the categories,
    then each attribute slot: a presence flag and, when present, its name and
    five words (parameter type GUID, category, flags, compatible class). A
    CKPGUID_ATTRIBUTE parameter saves WriteManagerInt(manager GUID, index), so
    its value indexes this table. Returns None when no such data was saved.
    With `types`, each entry is (name, parameter type GUID hex) instead.
    """
    for line in Path(path).read_text(encoding='latin1').splitlines():
        parts = line.split('\t')
        if len(parts) != 3 or int(parts[0]) != ATTRIBUTE_MANAGER or int(parts[1]) != 0 or not parts[2]:
            continue
        data = bytes.fromhex(parts[2])
        position = chunks(data)[0x52]

        def word():
            nonlocal position
            value, = struct.unpack_from('<I', data, position); position += 4
            return value

        def string():
            nonlocal position
            length = word()
            text = data[position:position + length].split(b'\0')[0].decode('windows-1252')
            position += (length + 3) // 4 * 4
            return text

        categories, count = word(), word()
        for _ in range(categories):
            present = word()
            if present not in [0, 1]: raise ValueError((path, 'attribute category flag', present))
            if present: string(); word()
        names = {}
        for index in range(count):
            present = word()
            if present not in [0, 1]: raise ValueError((path, 'attribute flag', present))
            if present:
                name = string()
                guid = struct.pack('<II', word(), word()).hex()
                for _ in range(3): word()
                names[index] = (name, guid) if types else name
        if position != len(data):
            raise ValueError((path, 'attribute table size', position, len(data)))
        return names
    return None


def message_names(path):
    """CKMessageManager type names from a `dump-chunks <file> --managers` dump.

    The manager's data (GUID 0x466a0fac:0, chunk 0x53) is a counted list of
    CKWriteString names in message-type order. A CKMessageType parameter saves
    its value with WriteManagerInt(manager GUID, type), so the type is an index
    into this list. Returns None when the file saved no message manager data.
    """
    for line in Path(path).read_text(encoding='latin1').splitlines():
        parts = line.split('\t')
        if len(parts) != 3 or int(parts[0]) != MESSAGE_MANAGER or int(parts[1]) != 0 or not parts[2]:
            continue
        data = bytes.fromhex(parts[2])
        position = chunks(data)[0x53]
        count, = struct.unpack_from('<I', data, position); position += 4
        names = []
        for _ in range(count):
            length, = struct.unpack_from('<I', data, position); position += 4
            names.append(data[position:position + length].split(b'\0')[0].decode('windows-1252'))
            position += (length + 3) // 4 * 4
        if position != len(data):
            raise ValueError((path, 'message table size', position, len(data)))
        return names
    return None


class ChunkDump:
    def __init__(self, path):
        """Parse one object dump TSV and its optional `.managers` sibling."""
        self.rows = {}
        self.saved_ids = {}
        text = Path(path).read_text(encoding='utf-8', errors='replace')
        for line in text.splitlines():
            parts = line.split('\t')
            if len(parts) != 5:
                continue
            index, saved, kind = int(parts[0]), int(parts[1]), int(parts[2])
            self.rows[index] = (kind, parts[3], bytes.fromhex(parts[4]))
            self.saved_ids[saved] = index
        self.links = []
        for kind, _name, data in self.rows.values():
            if kind != 6:
                continue
            if len(data) < 8:
                raise struct.error('class 6 row shorter than eight bytes')
            self.links.append(struct.unpack_from('<2I', data, len(data) - 8))
        managers = Path(path).with_suffix('.managers')
        self.messages = self.attributes = self.attribute_types = None
        if managers.is_file():
            self.messages = message_names(managers)
            self.attributes = attribute_names(managers)
            self.attribute_types = attribute_names(managers, types=True)

    def attribute(self, index, offset):
        """Name of a saved CKPGUID_ATTRIBUTE value (manager GUID, then the attribute index)."""
        manager, zero, kind = struct.unpack_from('<3I', self.rows[index][2], offset + 8)
        if manager != ATTRIBUTE_MANAGER or zero != 0:
            raise ValueError((index, 'attribute parameter without the attribute manager GUID'))
        if self.attributes is None:
            raise ValueError((index, 'attribute parameter but no --managers dump'))
        if kind not in self.attributes:
            raise ValueError((index, 'attribute outside the saved table', kind))
        return self.attributes[kind]

    def message(self, index, offset):
        """Name of a saved CKMessageType value (manager GUID, then the type)."""
        manager, zero, kind = struct.unpack_from('<3I', self.rows[index][2], offset + 8)
        if manager != MESSAGE_MANAGER or zero != 0:
            raise ValueError((index, 'message parameter without the message manager GUID'))
        if self.messages is None:
            raise ValueError((index, 'message parameter but no --managers dump'))
        if not 0 <= kind < len(self.messages) or not self.messages[kind]:
            raise ValueError((index, 'message type outside the saved table', kind))
        return self.messages[kind]

    def prototype(self, index):
        """Prototype identifier 'first:second' (8 hex digits each) of a building block, or None for a script."""
        data = self.rows[index][2]
        flags, first, second = struct.unpack_from('<3I', data, chunks(data)[0x20])
        if not flags & 0x8:
            return None
        return '%08x:%08x' % (first, second)

    def script_owners(self):
        """Map each script behaviour index to the name of the object that lists it in chunk 0x800."""
        owners = {}
        for kind, name, data in self.rows.values():
            if kind in (2, 3, 6, 8, 45) or len(data) < 16:
                continue
            offset = chunks(data).get(0x800)
            if offset is None:
                continue
            count, = struct.unpack_from('<I', data, offset)
            for entry in struct.unpack_from('<%dI' % count, data, offset + 4):
                if self.rows.get(entry, (None,))[0] != 8:
                    raise ValueError((name, 'script list entry', entry, 'is not a behavior'))
                owners[entry] = name
        return owners

    def object_scripts(self, index):
        """Object indices listed in the object's chunk 0x800 script list, in stored order."""
        kind, _name, data = self.rows[index]
        if kind in (2, 3, 6, 8, 45) or len(data) < 16:
            return []
        offset = chunks(data).get(0x800)
        if offset is None:
            return []
        count, = struct.unpack_from('<I', data, offset)
        return list(struct.unpack_from('<%dI' % count, data, offset + 4))

    def null_object(self, index):
        """True when this parameter is an object reference saved as NULL."""
        kind, _name, data = self.rows[index]
        if kind == 2:
            source, = struct.unpack_from('<I', data, 24)
            if source == 0xffffffff or source not in self.rows:
                return False
            return self.null_object(source)
        if kind not in (3, 45):
            return False
        offset = chunks(data).get(0x40)
        if offset is None:
            return False
        mode, reference = struct.unpack_from('<2I', data, offset + 8)
        return mode == 2 and reference == 0xffffffff

    def value(self, index):
        """Decoded value of an object or parameter row; never None.

        Parameter-in rows (class 2) yield the value of their source row, so a
        sentinel source raises KeyError. Parameter-out rows (classes 3 and 45)
        decode their stored chunk. Any other row yields its own name.
        """
        kind, name, data = self.rows[index]
        if kind == 2:
            source, = struct.unpack_from('<I', data, 24)
            return self.value(source)
        if kind in (3, 45):
            return self.chunk_value(index, name, data)
        return name

    def struct_members(self, index, name, data, offset):
        """A structure parameter's members, saved by the type's SaveLoadFunction
        (CKParameter::Save mode 0): WriteSubChunk of a chunk holding identifier
        0x12348765, then a sub-chunk sequence with one parameter chunk per
        member. Each sub-chunk is [size, class, version, chunk size, file, ids,
        chunks, managers] then its data (CKStateChunk::WriteSubChunk)."""
        def sub_chunk(position):
            size, _cid, _version, words, _file, ids, _chunks, managers = struct.unpack_from('<8I', data, position)
            if ids or managers:
                raise ValueError((index, name, 'structure sub-chunk with object or manager references'))
            return position + 4 + size * 4, data[position + 32:position + 32 + words * 4]
        _end, body = sub_chunk(offset + 12)
        marker, _next, count = struct.unpack_from('<3I', body, 0)
        if marker != 0x12348765:
            raise ValueError((index, name, 'mode 0 parameter without the structure identifier'))
        members, position = [], 12
        for _ in range(count):
            size, = struct.unpack_from('<I', body, position)
            _cid, _version, words = struct.unpack_from('<3I', body, position + 4)
            member = body[position + 32:position + 32 + words * 4]
            # A member chunk reads like a parameter row: an 8-byte header, then identifiers.
            members.append(self.chunk_value(index, name, bytes(8) + member))
            position += 4 + size * 4
        return members

    def chunk_value(self, index, name, data):
        """Decode one parameter's stored value from its chunk table in `data`.

        `data` may be a structure member's bytes prefixed by eight zero bytes
        (see `struct_members`), so everything is read from `data` itself.
        """
        value = chunks(data)[0x40]
        type_guid = data[value:value + 8].hex()
        if type_guid == MESSAGE_TYPE:
            return self.message(index, value)
        if type_guid == ATTRIBUTE_TYPE:
            return self.attribute(index, value)
        mode, reference = struct.unpack_from('<2I', data, value + 8)
        if mode == 0:
            return self.struct_members(index, name, data, value)
        if mode == 2:
            if reference == 0xffffffff:
                return name
            return self.rows[reference][1]
        if mode != 1:
            raise AssertionError((index, name, mode))
        if type_guid == PARAMETER_TYPE:
            return data[value + 12:value + 20].hex()
        length, = struct.unpack_from('<I', data, value + 12)
        raw = data[value + 16:value + 16 + length]
        if type_guid == 'e210d06bea175611':
            return raw.split(b'\0')[0].decode('windows-1252')
        if type_guid == '8e2ad51a2019745e':
            return bool(struct.unpack('<I', raw)[0])
        if type_guid in ('3f4c8847202c2c43', '2b42b4544f0f0f73', 'f52c26113a23b030', '4e4bc8f334ccfa0f'):
            return struct.unpack('<f', raw)[0]
        if type_guid == 'ee2fd457913bbb7c':
            return list(struct.unpack('<4f', raw))
        if type_guid == '4ab3fc4e2fe47960':
            return list(struct.unpack('<2f', raw))
        if type_guid == '200db27aa9443069':
            return list(struct.unpack('<4f', raw))
        if type_guid == '6e043f64711b2165':
            return list(struct.unpack('<16f', raw))
        if len(raw) == 4:
            return struct.unpack('<i', raw)[0]
        if len(raw) == 12:
            return list(struct.unpack('<3f', raw))
        raise ValueError((index, name, type_guid))

    def parameter_guid(self, index):
        """CKParameter type GUID as hex, following a parameter-in source.

        Kind-2 parameters carry the type on their source; kind-3/45 parameters
        store it at chunk 0x40. Unknown layouts return None instead of guessing.
        """
        kind, _name, data = self.rows[index]
        if kind == 2:
            ref, = struct.unpack_from('<I', data, 24)
            return None if ref == 0xffffffff else self.parameter_guid(ref)
        if kind not in [3, 45]:
            return None
        offset = chunks(data).get(0x40)
        return None if offset is None else data[offset:offset + 8].hex()

    def parameter_reference(self, index):
        """Saved object reference of a parameter as a file index, or None.

        The index is not checked against `rows`.
        """
        kind, _name, data = self.rows[index]
        if kind == 2:
            source, = struct.unpack_from('<I', data, 24)
            if source == 0xffffffff:
                return None
            return self.parameter_reference(source)
        if kind not in (3, 45):
            return None
        offset = chunks(data).get(0x40)
        if offset is None:
            return None
        # Only a reference-mode parameter (mode 2) stores the index word after the mode.
        mode, = struct.unpack_from('<I', data, offset + 8)
        if mode != 2:
            return None
        reference, = struct.unpack_from('<I', data, offset + 12)
        return None if reference == 0xffffffff else reference

    def entity_children(self):
        """Scene hierarchy of the CK3dEntity objects: parent name -> child names.

        LibCmo discards entity parent IDs, but the serialized entity chunk
        (identifier 0x100000, CK_STATESAVE_3DENTITYNDATA) still carries them:
        u32 3dEntityFlags, u32 moveableFlags, a 4 x vec3 matrix, then optional
        place (flag 0x10000) and parent (flag 0x20000) object IDs. Chunk object
        IDs are file-object indices. Children keep file order.
        """
        entities = {index: name for index, (kind, name, _) in self.rows.items() if 0x21 <= kind <= 0x2b}
        if len(set(entities.values())) != len(entities):
            raise ValueError('duplicate entity names make the hierarchy ambiguous')
        children = {}
        for index, name in sorted(entities.items()):
            data = self.rows[index][2]
            base = chunks(data).get(0x100000)
            if base is None:
                continue
            flags, = struct.unpack_from('<I', data, base)
            cursor = base + 8 + 48 + (4 if flags & 0x10000 else 0)
            if not flags & 0x20000:
                continue
            parent, = struct.unpack_from('<I', data, cursor)
            if parent not in entities:
                raise ValueError((name, 'parent', parent, 'is not an entity'))
            children.setdefault(entities[parent], []).append(name)
        return children

    def entity_parent(self, index):
        """A CK3dEntity's saved parent as a file index (chunk 0x100000, flag 0x20000), or None."""
        kind, _name, data = self.rows[index]
        if not 0x21 <= kind <= 0x2b:
            return None
        base = chunks(data).get(0x100000)
        if base is None:
            return None
        flags, = struct.unpack_from('<I', data, base)
        if not flags & 0x20000:
            return None
        parent, = struct.unpack_from('<I', data, base + 8 + 48 + (4 if flags & 0x10000 else 0))
        return parent

    def object_attributes(self, index):
        """A CKBeObject's saved attributes (chunk 0x11) as (name, parameter index or None).

        Layout: count, the attribute parameters' file indices, then
        (count, attribute manager GUID, 0) and the attribute indices, which name
        the attributes through this document's attribute table.
        """
        kind, name, data = self.rows[index]
        offset = chunks(data).get(0x11)
        if offset is None:
            return []
        count, = struct.unpack_from('<I', data, offset)
        refs = struct.unpack_from('<%dI' % count, data, offset + 4)
        at = offset + 4 * (count + 1)
        n, guid1, guid2 = struct.unpack_from('<III', data, at)
        if (n, guid1, guid2) != (count, ATTRIBUTE_MANAGER, 0):
            raise ValueError((index, name, 'attribute chunk header', n, guid1, guid2))
        ids = struct.unpack_from('<%dI' % count, data, at + 12)
        if self.attributes is None:
            raise ValueError((index, name, 'has attributes but no --managers dump names them'))
        return [(self.attributes[attribute], ref if ref in self.rows else None) for ref, attribute in zip(refs, ids)]

    def camera(self, index):
        """A CKCamera's saved projection (RCKCamera::Load 0x1000F396, chunk 0xFC00000):
        projection type, horizontal FOV, zoom, packed aspect (width low 16 bits,
        height high 16), front and back planes. Perspective is projection & 1."""
        kind, name, data = self.rows[index]
        if kind not in (34, 35):
            raise ValueError((index, name, 'is not a CKCamera'))
        base = chunks(data).get(0xFC00000)
        if base is None:
            raise ValueError((index, name, 'camera without its 0xFC00000 projection'))
        projection, fov, zoom, aspect, near, far = struct.unpack_from('<IffIff', data, base)
        if projection & ~1:
            raise ValueError((index, name, 'unknown camera projection bits', hex(projection)))
        if not (fov > 0 and zoom > 0 and near > 0 and far > near):
            raise ValueError((index, name, 'invalid camera projection', fov, zoom, near, far))
        width, height = aspect & 0xffff, aspect >> 16
        if width <= 0 or height <= 0:
            raise ValueError((index, name, 'invalid camera aspect', aspect))
        return {
            'projection': 'perspective' if projection & 1 else 'orthographic',
            'horizontalFov': fov, 'zoom': zoom,
            'aspect': [width, height], 'near': near, 'far': far,
        }

    def texture_transparency(self, index):
        """A CKTexture's colour key (RCKTexture::Load CK2_3D 0x10079D4D, chunk
        0x2ff000). The flag dword's bit 8 (0x100) copies to
        CKBitmapData::IsTransparent, and the next dword is its transparent
        colour; the shipped layout is a 12-byte payload
        [flags][colour][videoFormat]. Only a flagged texture carries a key.
        Returns None when the flag is clear, else {'transparentColor': ARGB}."""
        kind, name, data = self.rows[index]
        if kind != 31:
            raise ValueError((index, name, 'is not a CKTexture'))
        found = chunks(data)
        offset = found.get(0x2ff000)
        if offset is None:
            raise ValueError((index, name, 'texture without its 0x2ff000 state'))
        order = sorted((position, tag) for tag, position in found.items())
        end = next((position - 8 for position, _tag in order if position > offset), len(data))
        size = end - offset
        flags, = struct.unpack_from('<I', data, offset)
        if not flags & 0x100:
            return None
        if size != 12:
            raise ValueError((index, name, 'transparent texture state size', size))
        colour, = struct.unpack_from('<I', data, offset + 4)
        return {'transparentColor': colour}

    def material_state(self, index):
        """A CKMaterial's saved members (RCKMaterial::Load, chunk 0x1000):
        diffuse, ambient, specular and emissive RGBAs, then an optional
        SpecularPower float (0 when the chunk ends after the colours)."""
        kind, name, data = self.rows[index]
        if kind != 30:
            raise ValueError((index, name, 'is not a CKMaterial'))
        base = chunks(data).get(0x1000)
        if base is None:
            raise ValueError((index, name, 'material without its 0x1000 state'))
        size = len(data) - base
        if size < 16 or size > 52:
            raise ValueError((index, name, 'material state size', size))
        values = struct.unpack_from('<4I', data, base)
        names = ('diffuse', 'ambient', 'specular', 'emissive')
        state = {name_: [((value >> shift) & 0xff) / 255 for shift in (16, 8, 0, 24)] for name_, value in zip(names, values)}
        state['specularPower'] = struct.unpack_from('<f', data, base + 16)[0] if size >= 20 else 0.0
        if size >= 24:
            texture, = struct.unpack_from('<I', data, base + 20)
            if texture != 0xffffffff:
                state['texture'] = texture
        return state

    def light(self, index):
        """A CKLight's saved state (RCKLight::Load 0x1001B50E, chunk 0x400000):
        type/packed flags, ARGB colour, attenuation (constant, linear,
        quadratic), range, optional power (chunk 0x800000), and for a spot
        light three angle/flatness floats. The three spot fields are saved in
        order but their individual names are not decoded."""
        kind, name, data = self.rows[index]
        if kind not in (38, 39):
            raise ValueError((index, name, 'is not a CKLight'))
        found = chunks(data)
        base = found.get(0x400000)
        if base is None:
            raise ValueError((index, name, 'light without its 0x400000 state'))
        packed, colour = struct.unpack_from('<II', data, base)
        light_type = packed & 0xff
        flags = packed & 0xffffff00
        if light_type not in (1, 2, 3):
            raise ValueError((index, name, 'unknown light type', light_type))
        a, r, g, b = (colour >> 24) & 0xff, (colour >> 16) & 0xff, (colour >> 8) & 0xff, colour & 0xff
        attenuation = struct.unpack_from('<3f', data, base + 8)
        total = struct.unpack_from('<f', data, base + 20)[0]
        power = 1.0
        power_base = found.get(0x800000)
        if power_base is not None:
            power, = struct.unpack_from('<f', data, power_base)
        result = {
            'type': light_type, 'flags': flags,
            'color': [r / 255, g / 255, b / 255, a / 255],
            'attenuation': list(attenuation), 'range': total, 'power': power,
        }
        if light_type == 2:
            result['spot'] = list(struct.unpack_from('<3f', data, base + 24))
        return result

    def entity_dependencies(self, index):
        """A CK3dEntity's dependency links (RCK3dEntity::Load 0x1000A7B9) as
        file indices: chunk 0x4000 holds the current mesh then the mesh array
        (consecutive duplicates skipped, 0x1000A9AA..0x1000A9FE), chunk 0x2000
        the object animations, and a target camera's or light's chunk
        0x10000000 the target entity. Null references are dropped."""
        kind, name, data = self.rows[index]
        if not 0x21 <= kind <= 0x2b:
            raise ValueError((index, name, 'is not a CK3dEntity'))
        found = chunks(data)

        def references(base, count):
            refs = struct.unpack_from('<%dI' % count, data, base)
            for ref in refs:
                if ref != 0xffffffff and ref not in self.rows:
                    raise ValueError((index, name, 'dependency outside the document', ref))
            return [ref for ref in refs if ref != 0xffffffff]

        links = {}
        base = found.get(0x4000)
        if base is not None:
            current, count = struct.unpack_from('<II', data, base)
            meshes = references(base + 8, count)
            links['meshes'] = [ref for i, ref in enumerate(meshes) if i == 0 or meshes[i - 1] != ref]
            if current != 0xffffffff:
                if current not in self.rows:
                    raise ValueError((index, name, 'current mesh outside the document', current))
                links['currentMesh'] = current
        base = found.get(0x2000)
        if base is not None:
            count, = struct.unpack_from('<I', data, base)
            links['animations'] = references(base + 4, count)
        if kind in (35, 39) and 0x10000000 in found:
            # RCKTargetCamera::Load 0x10043EBC / RCKTargetLight: ReadObjectID -> +0x1C4 / +0x218.
            target, = struct.unpack_from('<I', data, found[0x10000000])
            if target != 0xffffffff:
                if target not in self.rows:
                    raise ValueError((index, name, 'target outside the document', target))
                links['target'] = target
        if kind == 37 and 0x400000 in found:
            # RCKSprite3d::Load 0x1004340F / Save 0x1004329D: chunk 0x400000 ends with the
            # sprite material's object ID (+0x1A8), the link PrepareDependencies 0x100436BB takes.
            order = sorted((offset, tag) for tag, offset in found.items())
            ends = {tag: (order[i + 1][0] - 8 if i + 1 < len(order) else len(data)) for i, (_offset, tag) in enumerate(order)}
            if ends[0x400000] - 4 < found[0x400000]:
                raise ValueError((index, name, 'sprite chunk has no material word'))
            material, = struct.unpack_from('<I', data, ends[0x400000] - 4)
            if material != 0xffffffff:
                if material not in self.rows:
                    raise ValueError((index, name, 'sprite material outside the document', material))
                links['materials'] = [material]
        return links

    def mesh_dependencies(self, index):
        """A CKMesh's dependency links (RCKMesh::Load 0x1002816A) as file
        indices: chunk 0x100000 holds the face material array (count, then
        material and flags pairs; null slots occur) and chunk 0x4000 the
        channel array (count, then per channel a material, an int, uv count n
        and n 2D floats at 0x1002857F..0x1002872A). Null slots are dropped."""
        kind, name, data = self.rows[index]
        if kind not in (32, 53):
            raise ValueError((index, name, 'is not a CKMesh'))

        def references(refs):
            for ref in refs:
                if ref != 0xffffffff and ref not in self.rows:
                    raise ValueError((index, name, 'dependency outside the document', ref))
            return [ref for ref in refs if ref != 0xffffffff]

        found = chunks(data)
        order = sorted((offset, tag) for tag, offset in found.items())
        ends = {tag: (order[i + 1][0] - 8 if i + 1 < len(order) else len(data)) for i, (_offset, tag) in enumerate(order)}
        links = {}
        base = found.get(0x100000)
        if base is not None:
            count, = struct.unpack_from('<I', data, base)
            links['materials'] = references([struct.unpack_from('<I', data, base + 4 + 8 * i)[0] for i in range(count)])
        base = found.get(0x4000)
        if base is not None:
            count, = struct.unpack_from('<I', data, base)
            position, refs = base + 4, []
            for _ in range(count):
                material, _flags, _one, _two, uvs = struct.unpack_from('<5I', data, position)
                position += 20 + 8 * uvs
                refs.append(material)
            if position != ends[0x4000]:
                raise ValueError((index, name, 'mesh channel chunk size', position, ends[0x4000]))
            links['channelMaterials'] = references(refs)
        return links

    def material_textures(self, index):
        """A CKMaterial's texture slots 1..3 (RCKMaterial::Load 0x100655E1,
        chunk 0x2000: three object references) as file indices without nulls.
        Slot 0 (chunk 0x1000) is exported by the render links already."""
        kind, name, data = self.rows[index]
        if kind != 30:
            raise ValueError((index, name, 'is not a CKMaterial'))
        base = chunks(data).get(0x2000)
        if base is None:
            return []
        refs = struct.unpack_from('<3I', data, base)
        for ref in refs:
            if ref != 0xffffffff and (ref not in self.rows or self.rows[ref][0] != 31):
                raise ValueError((index, name, 'texture slot is not a CKTexture', ref))
        return [ref for ref in refs if ref != 0xffffffff]

    def data_array_cells(self, index):
        """A CKDataArray's object cells (CKDataArray::PrepareDependencies,
        CK2.dll 0x2402A138) as file indices. Column type 4 stores an object
        reference; type 5 stores a parameter index and, when that parameter's
        value is an object (CKParameter save mode 2), the referenced object.
        Level (21) and Scene (10) cells are skipped, as DELETE mode does."""
        kind, name, data = self.rows[index]
        if kind != 52:
            raise ValueError((index, name, 'is not a CKDataArray'))

        def string(position):
            length, = struct.unpack_from('<I', data, position)
            value = data[position + 4:position + 4 + length].split(b'\0')[0].decode('windows-1252')
            return value, position + 4 + (length + 3) // 4 * 4

        def parameter_object(parameter):
            pkind, _pname, pdata = self.rows[parameter]
            if pkind == 2:
                ref, = struct.unpack_from('<I', pdata, 24)
                return None if ref in (0xffffffff, parameter) else parameter_object(ref)
            if pkind not in (3, 45):
                raise ValueError((index, name, 'cell parameter is not a CKParameter', parameter, pkind))
            offset = chunks(pdata).get(0x40)
            if offset is None:
                return None
            mode, = struct.unpack_from('<I', pdata, offset + 8)
            if mode != 2:
                return None
            ref, = struct.unpack_from('<I', pdata, offset + 12)
            return None if ref == 0xffffffff else ref

        found = chunks(data)
        if 0x1000 not in found or 0x2000 not in found:
            raise ValueError((index, name, 'data array without its column or row chunk'))
        position = found[0x1000]
        count, = struct.unpack_from('<I', data, position)
        position += 4
        columns = []
        for _ in range(count):
            _column, position = string(position)
            column_kind, = struct.unpack_from('<I', data, position)
            position += 4
            if column_kind == 5:
                position += 8
            columns.append(column_kind)
        position = found[0x2000]
        rows, = struct.unpack_from('<I', data, position)
        position += 4
        cells = []
        for _ in range(rows):
            for column_kind in columns:
                if column_kind in (1, 4, 5):
                    value, = struct.unpack_from('<i', data, position)
                    position += 4
                    if column_kind == 4:
                        ref = None if value == -1 else value
                    elif column_kind == 5 and value >= 0:
                        ref = parameter_object(value)
                    else:
                        ref = None
                    if ref is not None:
                        if ref not in self.rows:
                            raise ValueError((index, name, 'cell outside the document', ref))
                        if self.rows[ref][0] not in (10, 21):
                            cells.append(ref)
                elif column_kind == 2:
                    position += 4
                elif column_kind == 3:
                    _value, position = string(position)
                else:
                    raise ValueError((index, name, 'unsupported column type', column_kind))
        return cells

    def entity_matrix(self, index):
        """A CK3dEntity's saved world matrix (chunk 0x100000: flags, moveable flags,
        then four row vectors), as 16 floats in Virtools row-major order, or None."""
        kind, _name, data = self.rows[index]
        if not 0x21 <= kind <= 0x2b:
            return None
        base = chunks(data).get(0x100000)
        if base is None:
            return None
        rows = struct.unpack_from('<12f', data, base + 8)
        return [*rows[0:3], 0.0, *rows[3:6], 0.0, *rows[6:9], 0.0, *rows[9:12], 1.0]

    def entity_hidden(self, index):
        """Whether a CK3dEntity was saved hidden: CKObject::Save writes the
        CK_STATESAVE_OBJECTHIDDEN identifier (0x4) for an object without
        CK_OBJECT_VISIBLE, and CK3dEntity clears VX_MOVEABLE_VISIBLE (0x2) in the
        saved moveable flags. The two must agree."""
        kind, name, data = self.rows[index]
        if not 0x21 <= kind <= 0x2b:
            return False
        found = chunks(data)
        base = found.get(0x100000)
        if base is None:
            return False
        if 0x18 in found:
            raise ValueError((index, name, 'hierarchically hidden (CK_STATESAVE_OBJECTHIERAHIDDEN) is not supported'))
        hidden = 0x4 in found
        if hidden == bool(struct.unpack_from('<2I', data, base)[1] & 0x2):
            raise ValueError((index, name, 'hidden identifier and VX_MOVEABLE_VISIBLE disagree'))
        return hidden

    def scene_flags(self, index):
        """An object's saved CKSceneObjectDesc flags in a document saved without a
        level: CKBeObject::Save writes identifier 0x400 + the flags (CK2.dll
        0x2401BEE1), CKBehavior::Save 0x200000 + the flags (0x240051B9); bit
        0x80 (INTERNAL_IC) marks an initial value. None without a record."""
        kind, name, data = self.rows[index]
        if len(data) < 16 or kind in (2, 3, 4, 5, 6, 9, 45):
            return None
        found = chunks(data)
        tag = 0x200000 if kind == 8 else 0x400
        if tag not in found:
            return None
        flags, = struct.unpack_from('<I', data, found[tag])
        if flags & ~0xF9:
            raise ValueError((index, name, 'unknown scene object flags', hex(flags)))
        return flags

    def level_scene(self):
        """The level scene a document saved with a CKLevel keeps (CKLevel::Save,
        CK_STATESAVE_LEVELSCENE 0x80000000: current scene, level scene, then
        WriteSubChunk of CKScene::Save). Returns ({file index: desc flags},
        render settings, {file index: initial value sub-chunk}), or None without
        a CKLevel. The scene's NEWDATA
        (0x20000) holds the level reference, the object IDs, one initial-value
        sub-chunk pair per object and the flags; RENDERSETTINGS (0x80000) the
        background and ambient colours, fog, background texture and camera."""
        levels = [index for index, (kind, _name, _data) in self.rows.items() if kind == 21]
        if not levels:
            return None
        if len(levels) > 1:
            raise ValueError(('several CKLevel rows', levels))
        _kind, name, raw = self.rows[levels[0]]
        size, = struct.unpack_from('<I', raw, 4)
        options = raw[3]
        if raw[1] != 21 or raw[2] != 7 or not options & 8:
            raise ValueError(('unexpected CKLevel chunk header', raw[:4].hex()))
        words = struct.unpack_from('<%dI' % size, raw, 8)

        def idents(data):
            out, pos = {}, 0
            while True:
                tag, after = data[pos], data[pos + 1]
                out[tag] = (pos + 2, after if after else len(data))
                if not after:
                    return out
                if after <= pos + 1:
                    raise ValueError(('identifier chain goes backwards', pos, after))
                pos = after

        def sub_chunk(data, pos):
            # CKStateChunk::WriteSubChunk: [size - 1][class][version][chunk size][file][ids][chunks][managers], data.
            size = data[pos]
            if size == 0:
                return None, pos + 1
            cid, _version, words_, has_file, ids, sub_chunks, managers = data[pos + 1:pos + 8]
            if 8 + words_ + ids + sub_chunks + managers != size + 1:
                raise ValueError(('sub-chunk size mismatch', pos))
            return {'cid': cid, 'version': _version, 'file': has_file, 'ids': ids, 'managers': managers, 'data': data[pos + 8:pos + 8 + words_],
                    'idPositions': list(data[pos + 8 + words_:pos + 8 + words_ + ids]), 'subChunks': sub_chunks}, pos + 1 + size

        level = idents(words)
        if set(level) - {0x800, 0x40, 0x20000000, 0x80000000, 0x2000, 0x4000}:
            raise ValueError(('unknown CKLevel identifiers', sorted(map(hex, level))))
        a, b = level[0x20000000]
        if tuple(words[a:b]) != (0, 0, 0):
            raise ValueError(('CKLevel default data lists objects or scenes', words[a:b]))
        a, b = level[0x80000000]
        scene, end = sub_chunk(words, a + 2)
        if scene is None or end != b or scene['cid'] != 10 or not scene['file'] or scene['ids'] or scene['managers']:
            raise ValueError('unsupported level scene sub-chunk')
        data = scene['data']
        found = idents(data)
        if set(found) - {0x40, 0x20000, 0x40000, 0x80000}:
            raise ValueError(('unknown CKScene identifiers', sorted(map(hex, found))))
        a, end = found[0x20000]
        count, sequence = data[a + 1], data[a + 2]
        if sequence != count or data[a + 3 + count] != 2 * count:
            raise ValueError('level scene object sequence counts')
        refs = data[a + 3:a + 3 + count]
        pos = a + 4 + count
        initials = {}
        for ref in refs:
            # The scene desc's initial value: CKSaveObjectState(obj, -1) = obj->Save(NULL, -1) (CK2.dll 0x240396E8).
            initial, pos = sub_chunk(data, pos)
            if initial is not None:
                initials[ref] = initial
            second, pos = sub_chunk(data, pos)
            if second is not None:
                raise ValueError('level scene second per-object sub-chunk is not null')
        flags = data[pos:pos + count]
        if pos + count != end:
            raise ValueError('level scene NEWDATA size')
        for ref, value in zip(refs, flags):
            if ref not in self.rows or value & ~0xF9:
                raise ValueError(('level scene object', ref, hex(value)))
        a, b = found[0x80000]
        if b - a != 9:
            raise ValueError('level scene render settings size')
        background, ambient, fog_mode, fog_color = data[a:a + 4]
        fog_start, fog_end, fog_density = struct.unpack('<3f', struct.pack('<3I', *data[a + 4:a + 7]))
        settings = {
            'environment': data[found[0x40000][0]], 'backgroundColor': background, 'ambientColor': ambient,
            'fogMode': fog_mode, 'fogColor': fog_color, 'fogStart': fog_start, 'fogEnd': fog_end, 'fogDensity': fog_density,
            'backgroundTexture': data[a + 7], 'startingCamera': data[a + 8],
        }
        return dict(zip(refs, flags)), settings, initials

    def entity2d_initial(self, index, record):
        """A CK2dEntity's scene initial value (a level scene sub-chunk, saved
        without a CKFile): CKObject::Save's 0x4 (hidden) or 0x18 (hierarchically
        hidden), RCK2dEntity::Save's 0x10F000 and 0x200000, no scripts or scene
        activity (written only with a file). Object ids are the saved CK_IDs.
        Returns entity2d()'s shape, plus hiddenHierarchical."""
        name = self.rows[index][1]
        if record['cid'] != 27 or record['file'] or record['subChunks'] or record['managers']:
            raise ValueError((index, name, 'unsupported 2d entity initial value', record['cid']))
        if record['version'] & 0xffff < 5:
            raise ValueError((index, name, 'pre-5 2d entity initial value'))
        words = record['data']
        found, pos = {}, 0
        while True:
            tag, after = words[pos], words[pos + 1]
            found[tag] = (pos + 2, after if after else len(words))
            if not after:
                break
            if after <= pos + 1:
                raise ValueError((index, name, 'identifier chain goes backwards'))
            pos = after
        if set(found) - {0x4, 0x18, 0x10F000, 0x200000} or 0x10F000 not in found:
            raise ValueError((index, name, 'unexpected initial value identifiers', sorted(map(hex, found))))
        floats = lambda values: list(struct.unpack('<%df' % len(values), struct.pack('<%dI' % len(values), *values)))
        a, b = found[0x10F000]
        save_flags = words[a]
        if save_flags & ~ENTITY2D_FLAGS:
            raise ValueError((index, name, 'unknown flag bits', hex(save_flags & ~ENTITY2D_FLAGS)))
        p = a + 1
        rect = floats(words[p:p + 4]); p += 4
        source = None
        if save_flags & 0x10000:
            source = floats(words[p:p + 4]); p += 4
        z_order = 0
        if save_flags & 0x20000:
            z_order, = struct.unpack('<i', struct.pack('<I', words[p])); p += 1
        if save_flags & 0x40000:
            raise ValueError((index, name, '2d entity initial value with a parent'))
        if p != b:
            raise ValueError((index, name, 'trailing words in the 2d entity initial value'))
        material, positions = None, set()
        if 0x200000 in found:
            a2, b2 = found[0x200000]
            if b2 - a2 != 1 or self.rows.get(self.saved_ids.get(words[a2]), (None,))[0] != 30:
                raise ValueError((index, name, 'initial value material is not a CKMaterial of the file'))
            material, positions = self.saved_ids[words[a2]], {a2}
        if set(record['idPositions']) != positions:
            raise ValueError((index, name, 'initial value object id positions', record['idPositions']))
        flags = save_flags & ENTITY2D_LOAD_MASK
        return {
            'flags': flags, 'rect': rect, 'sourceRect': source if source is not None else [0.0, 0.0, 1.0, 1.0],
            'zOrder': z_order, 'material': material,
            'hidden': 0x4 in found or 0x18 in found, 'hiddenHierarchical': 0x18 in found,
        }

    def entity2d(self, index):
        """A CK2dEntity's saved members (CK2_3D RCK2dEntity::Save 0x1005F029 / Load
        0x1005F20D): chunk 0x10F000 holds the save flags (Load keeps
        flags & 0xFFF8F7FF; 0x10000, 0x20000, 0x40000 mark the optional source
        rect, z order and parent), the rect (homogeneous with flag 0x200, else
        pixels), then the optional fields; chunk 0x200000 the material. Only
        plain CK2dEntity rows (class 27) are understood."""
        kind, name, data = self.rows[index]
        if kind != 27:
            # Classes 28 (CKSprite) and 29 (CKSpriteText) add chunks that no shipped file uses.
            raise ValueError((index, name, 'class', kind, 'is not a plain CK2dEntity'))
        header, = struct.unpack_from('<I', data, 0)
        version = header & 0xff
        if version < 5 or (header >> 8) & 0xff != 27:
            raise ValueError((index, name, 'unsupported 2d entity chunk header', hex(header)))
        found = chunks(data)
        unknown = set(found) - ENTITY2D_IDENTIFIERS
        if unknown:
            raise ValueError((index, name, 'unknown identifiers', sorted(map(hex, unknown))))
        if 0x10f000 not in found:
            raise ValueError((index, name, 'no 2d entity chunk'))
        # Chunk bounds: each identifier's data runs to the next header.
        order = sorted((offset, tag) for tag, offset in found.items())
        ends = {tag: (order[i + 1][0] - 8 if i + 1 < len(order) else len(data)) for i, (_o, tag) in enumerate(order)}
        p = found[0x10f000]
        save_flags, = struct.unpack_from('<I', data, p); p += 4
        if save_flags & ~ENTITY2D_FLAGS:
            raise ValueError((index, name, 'unknown flag bits', hex(save_flags & ~ENTITY2D_FLAGS)))
        rect = list(struct.unpack_from('<4f', data, p)); p += 16
        source = None
        if save_flags & 0x10000:
            source = list(struct.unpack_from('<4f', data, p)); p += 16
        z_order = 0
        if save_flags & 0x20000:
            z_order, = struct.unpack_from('<i', data, p); p += 4
        parent = None
        if save_flags & 0x40000:
            parent, = struct.unpack_from('<I', data, p); p += 4
            if parent not in self.rows:
                raise ValueError((index, name, 'parent is not a file object', parent))
        if p != ends[0x10f000]:
            raise ValueError((index, name, 'trailing bytes in the 2d entity chunk', p, ends[0x10f000]))
        material = None
        if 0x200000 in found:
            material, = struct.unpack_from('<I', data, found[0x200000])
            if material not in self.rows or self.rows[material][0] != 30:
                raise ValueError((index, name, 'material is not a CKMaterial', material))
            if found[0x200000] + 4 != ends[0x200000]:
                raise ValueError((index, name, 'trailing bytes in the material chunk'))
        activity = None
        if 0x400 in found:
            activity, = struct.unpack_from('<I', data, found[0x400])
        flags = save_flags & ENTITY2D_LOAD_MASK
        homogeneous = bool(flags & 0x200)
        return {
            'flags': flags,
            'homogeneous': homogeneous,
            # The saved rect is homogeneous (0..1 of the relative rect) or pixels, by the flag.
            'rect': rect,
            # Absent source rect: (0,0,1,1) for class 27, zeros for the sprite classes.
            'sourceRect': source if source is not None else [0.0, 0.0, 1.0, 1.0],
            'sourceRectSaved': source is not None,
            'zOrder': z_order,
            'parent': parent,
            'material': material,
            'hidden': 0x4 in found,
            'singleActivity': activity,
        }

    def wave_sound(self, index):
        """A CKWaveSound's saved state, as CK2.dll CKWaveSound::Save (0x2401A060)
        writes it: 0x1000 save options and file name (CKSound::Save), 0x800000
        the duration in ms, and 0x400000 GetState, GetPriority, the raw gain,
        GetPan, GetPitch, three zero floats, the cone (in, out angle, out
        gain), min and max distance, distance behavior, the attached object,
        the position and direction buffers and a zero dword. Values as stored."""
        kind, name, data = self.rows[index]
        if kind != 25:
            raise ValueError((index, name, 'is not a wave sound'))
        found = chunks(data)
        if not {0x1000, 0x800000, 0x400000} <= set(found) <= {0x400, 0x1000, 0x800000, 0x400000}:
            raise ValueError((index, name, 'unexpected wave sound identifiers', sorted(map(hex, found))))
        options, length = struct.unpack_from('<II', data, found[0x1000])
        raw = data[found[0x1000] + 8:found[0x1000] + 8 + length]
        if options != 2 or not raw.endswith(b'\0'):
            raise ValueError((index, name, 'sound file record with save options', options))
        p = found[0x400000]
        state, priority, gain, pan, pitch, *reserved = struct.unpack_from('<I7f', data, p)
        cone_in, cone_out, cone_gain, near, far = struct.unpack_from('<5f', data, p + 32)
        behavior, attached = struct.unpack_from('<Ii', data, p + 52)
        if any(reserved) or attached != -1:
            raise ValueError((index, name, 'wave sound with reserved fields or an attached object'))
        vectors, p = [], p + 60
        for _ in range(2):
            if struct.unpack_from('<I', data, p)[0] != 12:
                raise ValueError((index, name, 'wave sound vector buffer size'))
            vectors.append(list(struct.unpack_from('<3f', data, p + 4)))
            p += 16
        if struct.unpack_from('<I', data, p)[0] != 0:
            raise ValueError((index, name, 'wave sound trailing dword set'))
        return {
            'file': raw[:-1].decode('windows-1252'), 'duration': struct.unpack_from('<i', data, found[0x800000])[0],
            'state': state, 'priority': priority, 'gain': gain, 'pan': pan, 'pitch': pitch,
            'coneInAngle': cone_in, 'coneOutAngle': cone_out, 'coneOutGain': cone_gain,
            'minDistance': near, 'maxDistance': far, 'distanceBehavior': behavior,
            'position': vectors[0], 'direction': vectors[1],
        }

    def group_members(self, index):
        """Member object indices of a group (class 23), in stored order."""
        kind, name, data = self.rows[index]
        if kind != 23:
            raise ValueError((index, name, 'is not a group'))
        offset = chunks(data).get(0xfffff)
        if offset is None:
            return []
        count, = struct.unpack_from('<I', data, offset)
        return list(struct.unpack_from('<%dI' % count, data, offset + 4))

    def parameter_targets(self, index):
        """Target parameter indices of a parameter-out (classes 3 and 45), from chunk 0x20."""
        kind, _name, data = self.rows[index]
        if kind not in (3, 45):
            return []
        offset = chunks(data).get(0x20)
        if offset is None:
            return []
        count, = struct.unpack_from('<I', data, offset)
        return list(struct.unpack_from('<%dI' % count, data, offset + 4))

    def keyed_animation(self, index):
        """A CKKeyedAnimation (class 18): its length and sub-animation file indices.

        `RCKKeyedAnimation::Load` saves the animation length as one float in chunk
        0x40 and the object animation list (count, then file indices) in chunk
        0x1000. The list is what Play Global Animation steps.
        """
        kind, name, data = self.rows[index]
        if kind != 18:
            raise ValueError((index, name, 'is not a CKKeyedAnimation', kind))
        found = chunks(data)
        if 0x40 not in found:
            raise ValueError((index, name, 'CKKeyedAnimation without its length'))
        length, = struct.unpack_from('<f', data, found[0x40])
        if 0x1000 not in found:
            raise ValueError((index, name, 'CKKeyedAnimation without its animation list'))
        count, = struct.unpack_from('<I', data, found[0x1000])
        animations = list(struct.unpack_from('<' + 'I' * count, data, found[0x1000] + 4))
        for animation in animations:
            if self.rows.get(animation, (None,))[0] != 15:
                raise ValueError((index, name, 'animation list entry', animation, 'is not a CKObjectAnimation'))
        return {'length': length, 'animations': animations}

    def behavior(self, index, target_class=None):
        """A behavior's layout from chunk 0x20: its version, its target (when a
        class is given) and the index lists selected by the mask word."""
        _kind, _name, data = self.rows[index]
        start = chunks(data)[0x20]
        if (len(data) - start) % 4:
            raise struct.error('behavior chunk ends in a partial word')
        words = struct.unpack_from('<%dI' % ((len(data) - start) // 4), data, start)
        flags = words[0]
        result = {'version': words[3]}
        pos = 5 if flags & 0x4 else 4
        if target_class is not None:
            if words[pos] != target_class:
                raise AssertionError((index, list(words)))
            result['target'] = self.value(words[pos + 1])
            pos += 2
        mask = words[pos]
        pos += 1
        for bit, key in ((0x200, 'inputs'), (0x400, 'outputs'), (0x20000, 'locals'), (0x800, 'inIO'), (0x1000, 'outIO')):
            if mask & bit:
                count = words[pos]
                result[key] = list(words[pos + 1:pos + 1 + count])
                pos += 1 + count
        return result

    def frame(self, name):
        """The 16-element frame matrix of the first named class 33 or 41 row,
        as four groups of three floats and an integer (0, 0, 0, then 1)."""
        data = next(row[2] for row in self.rows.values() if row[1] == name and row[0] in (33, 41))
        offset = chunks(data)[0x100000]
        values = struct.unpack_from('<12f', data, offset + 8)
        return [*values[0:3], 0, *values[3:6], 0, *values[6:9], 0, *values[9:12], 1]

    def definition(self, index):
        """A behavior's declared structure from chunk 0x20: priority, version,
        target, and the child, link, operation and parameter index lists."""
        _kind, _name, data = self.rows[index]
        start = chunks(data)[0x20]
        if (len(data) - start) % 4:
            raise struct.error('behavior chunk ends in a partial word')
        words = struct.unpack_from('<%dI' % ((len(data) - start) // 4), data, start)
        flags = words[0]
        result = {}
        pos = 4 if flags & 0x8 else 1
        if flags & 0x4:
            result['priority'] = struct.unpack('<i', struct.pack('<I', words[pos]))[0]
            pos += 1
        if flags & 0x8:
            result['version'] = words[3]
        if flags & 0x10:
            result['targetClass'] = words[pos]
            pos += 1
        if flags & 0x40000:
            target = words[pos]
            pos += 1
            if target == 0xffffffff:
                result['targetIndex'] = None
                result['target'] = None
            else:
                result['targetIndex'] = target
                result['target'] = self.value(target)
                if self.rows[target][0] == 2:
                    result['targetSource'], = struct.unpack_from('<I', self.rows[target][2], 24)
        mask = words[pos]
        pos += 1
        selections = (
            (0x100, 'children'), (0x80000, 'links'), (0x4000, 'operations'), (0x200, 'inputs'),
            (0x400, 'outputs'), (0x20000, 'locals'), (0x800, 'inIO'), (0x1000, 'outIO'),
        )
        for bit, key in selections:
            if mask & bit:
                count = words[pos]
                if pos + count >= len(words):
                    raise AssertionError((index, key, count))
                result[key] = list(words[pos + 1:pos + 1 + count])
                pos += 1 + count
        return result

    def operation(self, index):
        """A parameter operation (class 4): its GUID string, two input indices and output index."""
        kind, name, data = self.rows[index]
        if kind != 4:
            raise ValueError((index, name, 'is not a parameter operation'))
        offset = chunks(data)[0x400]
        first, second, count = struct.unpack_from('<3I', data, offset)
        if count != 3:
            raise ValueError((index, name, 'has', count, 'parameters'))
        input_a, input_b, output = struct.unpack_from('<3I', data, offset + 12)
        return {'guid': '%08x:%08x' % (first, second), 'inputs': [input_a, input_b], 'output': output}

    def physicalize(self, index):
        """Physics body settings of a physicalize building block (class 33 behavior)."""
        layout = self.behavior(index, 33)
        inputs = [self.value(i) for i in layout['inputs']]
        local_values = [self.value(i) for i in layout['locals']]
        if local_values[1] != 0 or local_values[2] != 0:
            raise AssertionError('Only convex shapes are handled here')
        return {
            'index': index,
            'target': layout['target'],
            'fixed': inputs[0],
            'friction': inputs[1],
            'restitution': inputs[2],
            'mass': inputs[3],
            'collisionGroup': inputs[4],
            'startFrozen': inputs[5],
            'enableCollision': inputs[6],
            'automaticMassCenter': inputs[7],
            'linearDamping': inputs[8],
            'angularDamping': inputs[9],
            'hulls': inputs[11:11 + local_values[0]],
            'massCenter': local_values[3],
        }

def table(data):
    """Rows of a data-table object as dicts keyed by column name, in stored order.

    Header (chunk 0x1000): a column count, then per column a string name and a
    kind word; kind 5 is followed by a parameter type GUID (8 bytes, skipped).
    Rows (chunk 0x2000): a row count, then one value per column: kind 3 a
    string, kind 2 a float rounded to six places, kind 5 {'parameterIndex': n},
    any other kind an unsigned word.
    """
    found = chunks(data)

    def read_word(at):
        return struct.unpack_from('<I', data, at)[0], at + 4

    def read_text(at):
        length, at = read_word(at)
        text = data[at:at + length].split(b'\0')[0].decode('windows-1252')
        return text, at + (length + 3) // 4 * 4

    columns = []
    count, at = read_word(found[0x1000])
    for _ in range(count):
        name, at = read_text(at)
        kind, at = read_word(at)
        if kind == 5:
            at += 8
        columns.append((name, kind))

    total, at = read_word(found[0x2000])
    result = []
    for _ in range(total):
        row = {}
        for name, kind in columns:
            if kind == 3:
                row[name], at = read_text(at)
            elif kind == 2:
                row[name] = round(struct.unpack_from('<f', data, at)[0], 6)
                at += 4
            elif kind == 5:
                parameter, at = read_word(at)
                row[name] = {'parameterIndex': parameter}
            else:
                row[name], at = read_word(at)
        result.append(row)
    return result
