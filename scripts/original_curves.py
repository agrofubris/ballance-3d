"""CKCurve / CKCurvePoint (Position On Curve) and CKObjectAnimation (Play
Animation 3D Entity) state chunks, decoded from CK2_3D.dll (image base
0x10000000):

CKCurve   (class 43)  RCKCurve::Load       0x10016342
CKCurvePoint (class 36) RCKCurvePoint::Load 0x1001701D
CKObjectAnimation (class 15) Load           0x10058C51

`rows` is ChunkDump.rows (file index -> (class, name, data)).
"""
import struct

# CKClassID values (CKDefines.h)
CKCID_OBJECTANIMATION = 15
CKCID_CURVEPOINT = 36
CKCID_CURVE = 43

# CKCurve::Load identifiers (data version >= 5)
CURVE_DATA = 0xFFC00000          # object array of points, fitting float, steps int, open int
CURVE_SUBCHUNKS = 0xFF000000     # only read when loaded without a CKFile (not present in .nmo)
# CKCurvePoint::Load identifiers (data version >= 5)
POINT_DATA = 0x10000000          # curve, flags, linear, tension, continuity, bias, tangents
# CKObjectAnimation::Load identifier used by every Ballance animation
ANIM_DATA = 0x04000000

# Animation controller type ids (CKANIMATION_CONTROLLER, CKKeyframeData.h)
CONTROLLER_KINDS = {
    0x637C4301: ('position', 'linear', 4),    # time, x, y, z
    0x49ED4002: ('rotation', 'linear', 5),    # time, x, y, z, w
    0x654A3A04: ('scale', 'linear', 4),       # time, x, y, z
    0x2F200B08: ('scaleaxis', 'linear', 5),   # time, quaternion
    0x347E4A01: ('position', 'tcb', 9),       # time, xyz, t, c, b, easeto, easefrom
    0x45B52A02: ('rotation', 'tcb', 10),      # time, xyzw, t, c, b, easeto, easefrom
    0x1B545904: ('scale', 'tcb', 9),
    0x32595908: ('scaleaxis', 'tcb', 10),
    0x921AB801: ('position', 'bezier', 12),   # time, xyz, flags, in xyz, out xyz
    0x18AB4404: ('scale', 'bezier', 12),
}


def idents(data):
    """Identifier chain of a state chunk row: [(tag, words)], and all words."""
    size, = struct.unpack_from('<I', data, 4)
    words = list(struct.unpack_from('<%dI' % size, data, 8))
    out, offset = [], 0
    while True:
        tag, following = words[offset], words[offset + 1]
        end = following if following else size
        out.append((tag, words[offset + 2:end]))
        if not following:
            return out, words
        offset = following


def header(data):
    word, = struct.unpack_from('<I', data, 0)
    return {'dataVersion': word & 0xFF, 'classId': (word >> 8) & 0xFF, 'chunkVersion': (word >> 16) & 0xFF, 'options': word >> 24}


def as_float(word):
    return struct.unpack('<f', struct.pack('<I', word))[0]


def entity_world_matrix(data):
    """CK3dEntity chunk 0x100000: flags, moveable flags, four row vectors (xyz); WORLD matrix."""
    for tag, words in idents(data)[0]:
        if tag == 0x100000:
            rows = [as_float(w) for w in words[2:14]]
            return {'flags': words[0], 'moveable': words[1],
                    'matrix': [*rows[0:3], 0.0, *rows[3:6], 0.0, *rows[6:9], 0.0, *rows[9:12], 1.0]}
    return None


# ---------------------------------------------------------------------------
# CKCurvePoint
# ---------------------------------------------------------------------------
def curve_point(rows, index):
    """RCKCurvePoint::Load 0x1001701D, ident 0x10000000, data version >= 5:
        ReadObject                -> [this+0x1A8]  owning curve (file index)
        ReadDword                 -> [this+0x1EC]  0 = tangents are computed from TCB
                                                   (vtable 0x1FC returns [1EC] == 0); 1 = use the saved tangents
        ReadDword                 -> [this+0x1F0]  linear flag (IsLinear, vtable 0x1F0)
        ReadFloat x3              -> [0x1AC] tension, [0x1B0] continuity, [0x1B4] bias
        ReadData 12 bytes         -> [0x1C8] incoming tangent
        ReadData 12 bytes         -> [0x1D4] outgoing tangent
    The 3D-entity part (ident 0x100000) is the point's world matrix.
    `[0x1BC]` (curve-local position) and `[0x1E0]` (fitted position) are NOT saved:
    CKCurve::Update (0x1001586D) fills both from CK3dEntity::GetPosition(&p, curve).
    """
    cls, name, data = rows[index]
    if cls != CKCID_CURVEPOINT:
        raise ValueError((index, 'is not a CKCurvePoint', cls))
    h = header(data)
    if h['dataVersion'] < 5:
        raise ValueError((index, 'CKCurvePoint data version', h['dataVersion'], 'is not decoded'))
    found = dict(idents(data)[0])
    if POINT_DATA not in found:
        raise ValueError((index, 'CKCurvePoint without ident 0x10000000'))
    w = found[POINT_DATA]
    if len(w) != 12:
        raise ValueError((index, 'unexpected CKCurvePoint payload size', len(w)))
    return {
        'index': index, 'name': name,
        'curve': w[0],
        'savedTangents': w[1] != 0,          # [1EC]: when set Update keeps the saved tangents
        'linear': w[2] != 0,                 # [1F0]
        'tension': as_float(w[3]), 'continuity': as_float(w[4]), 'bias': as_float(w[5]),
        'incoming': [as_float(x) for x in w[6:9]],   # saved; recomputed by Update unless savedTangents
        'outgoing': [as_float(x) for x in w[9:12]],
    }


# ---------------------------------------------------------------------------
# CKCurve
# ---------------------------------------------------------------------------
def curve(rows, index):
    """RCKCurve::Load 0x10016342, ident 0xFFC00000, data version >= 5:
        ReadObjectArray           -> [this+0x1A8]  control points, in curve order
        ReadFloat                 -> [this+0x1C0]  fitting coefficient (0 = no smoothing)
        ReadDword                 -> [this+0x1BC]  render step count (100)
        ReadDword                 -> [this+0x1B4]  open flag: 0 = CLOSED curve (loops), 1 = open
    The curve is also a CK3dEntity: its world matrix (chunk 0x100000) transforms every result.
    """
    cls, name, data = rows[index]
    if cls != CKCID_CURVE:
        raise ValueError((index, 'is not a CKCurve', cls))
    h = header(data)
    if h['dataVersion'] < 5:
        raise ValueError((index, 'CKCurve data version', h['dataVersion'], 'is not decoded'))
    found = dict(idents(data)[0])
    if CURVE_DATA not in found:
        raise ValueError((index, 'CKCurve without ident 0xFFC00000'))
    w = found[CURVE_DATA]
    count = w[0]
    point_ids = w[1:1 + count]
    fitting, steps, is_open = as_float(w[1 + count]), w[2 + count], w[3 + count]
    if len(w) != 4 + count:
        raise ValueError((index, 'unexpected CKCurve payload size', len(w), count))
    entity = entity_world_matrix(data)
    return {
        'index': index, 'name': name, 'closed': is_open == 0, 'fitting': fitting, 'steps': steps,
        'world': entity['matrix'] if entity else None,
        'points': [curve_point(rows, i) for i in point_ids],
    }


# ---------------------------------------------------------------------------
# CKObjectAnimation
# ---------------------------------------------------------------------------
def object_animation(rows, index):
    """RCKObjectAnimation::Load 0x10058C51 (data version >= 1), ident 0x4000000:
        ReadFloat x3 + ReadFloat x4 (ignored)                      7 words
        ReadDword  -> [this+0x20]  animation flags: 0x04 position disabled, 0x08 rotation disabled,
                                   0x10 scale disabled, 0x80 merged animation
        ReadObject -> [this+0x24]  the entity the animation drives (file index)
        ReadFloat  -> controller length in FRAMES (CKAnimController::SetLength; SetStep scales by it)
        (flags & 0x80: ReadFloat factor, ReadObject, ReadObject  - merged animations; not decoded)
        repeat: ReadDword controller type id (0 ends the list)
                ReadDword size in words, then `size` words = CKAnimController::ReadKeysFrom buffer
                (linear controllers: [key count][keys]; key = time followed by the value floats)
    """
    cls, name, data = rows[index]
    if cls != CKCID_OBJECTANIMATION:
        raise ValueError((index, 'is not a CKObjectAnimation', cls))
    h = header(data)
    if h['dataVersion'] < 1:
        raise ValueError((index, 'CKObjectAnimation data version', h['dataVersion'], 'is not decoded'))
    found = dict(idents(data)[0])
    if ANIM_DATA not in found:
        raise ValueError((index, 'CKObjectAnimation without ident 0x4000000'))
    w = found[ANIM_DATA]
    flags, entity, length = w[7], w[8], as_float(w[9])
    pos = 10
    if flags & 0x80:
        raise ValueError((index, 'merged CKObjectAnimation is not decoded'))
    controllers = []
    while True:
        kind = w[pos]
        pos += 1
        if kind == 0:
            break
        size = w[pos]
        pos += 1
        blob = w[pos:pos + size]
        pos += size
        if kind not in CONTROLLER_KINDS:
            raise ValueError((index, 'unknown animation controller', hex(kind)))
        track, interpolation, stride = CONTROLLER_KINDS[kind]
        count = blob[0]
        if interpolation == 'linear' and len(blob) != 1 + count * stride:
            raise ValueError((index, track, 'controller size mismatch', len(blob), count))
        if interpolation != 'linear':
            raise ValueError((index, track, interpolation, 'keys are not decoded here (PE_Balloon.nmo uses TCB rotation; not needed by MenuLevel.nmo)'))
        controllers.append({'type': '%08x' % kind, 'track': track, 'interpolation': interpolation,
                            'keys': count, 'stride': stride, 'data': [as_float(x) for x in blob[1:]]})
    if pos != len(w):
        raise ValueError((index, 'trailing animation data', len(w) - pos))
    return {'index': index, 'name': name, 'entity': entity, 'flags': flags, 'length': length, 'controllers': controllers}
