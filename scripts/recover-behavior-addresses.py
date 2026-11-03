#!/usr/bin/env python3
"""Locate CKBehavior creation/execution/callback functions in a Virtools DLL.

For each behavior name, finds the CKObjectDeclaration's name string, then the
`CreateCKBehaviorPrototype` call site whose immediately preceding instruction is
the name `push`, and reads the `SetFunction` / `SetBehaviorCallbackFct` pushes
that follow. Requires the capstone package and a PE32/PE32+ module.

Usage: python3 scripts/recover-behavior-addresses.py <dll> <Name> [<Name> ...]
"""
import struct
import sys

from capstone import Cs, CS_ARCH_X86, CS_MODE_32

# Call-site thunks differ per DLL; pass them or use the defaults for Logics.dll.
CREATE_PROTO = 0x254a0278
SET_FUNCTION = 0x254a026c
SET_CALLBACK = 0x254a02cc


def load(path):
    data = open(path, 'rb').read()

    def u16(o): return struct.unpack_from('<H', data, o)[0]
    def u32(o): return struct.unpack_from('<I', data, o)[0]

    e = u32(0x3c); coff = e + 4
    num = u16(coff + 2); opt_size = u16(coff + 16); opt = coff + 20
    image_base = u32(opt + 28)
    sections = []
    for i in range(num):
        s = opt + opt_size + i * 40
        sections.append((data[s:s + 8].rstrip(b'\x00').decode('latin1'),
                         u32(s + 12), u32(s + 8), u32(s + 20), u32(s + 16)))
    return data, image_base, sections


def main():
    path = sys.argv[1]
    data, image_base, sections = load(path)
    text = next(s for s in sections if s[0] == '.text')
    tvaddr, tvsize, trawptr, trawsize = text[1], text[2], text[3], text[4]
    code = data[trawptr:trawptr + trawsize]
    md = Cs(CS_ARCH_X86, CS_MODE_32)

    def rva_of(off):
        for _, vaddr, vsize, rawptr, rawsize in sections:
            if rawptr <= off < rawptr + rawsize:
                return vaddr + (off - rawptr)

    def instructions(start, length):
        base = start - image_base - tvaddr
        return list(md.disasm(code[base:base + length], start))

    for name in sys.argv[2:]:
        needle = name.encode('latin1') + b'\x00'
        off = data.find(needle)
        if off < 0:
            print(f'{name}: NOT FOUND'); continue
        va = image_base + rva_of(off)
        pattern = b'\x68' + struct.pack('<I', va)
        creation = None
        j = code.find(pattern)
        while j >= 0:
            following = instructions(image_base + tvaddr + j, 16)
            if len(following) >= 2 and following[1].mnemonic == 'call' and following[1].op_str == hex(CREATE_PROTO):
                creation = image_base + tvaddr + j
                break
            j = code.find(pattern, j + 1)
        if creation is None:
            print(f'{name}: NO CREATION'); continue
        execution = callback = None
        last_push = None
        for ins in instructions(creation, 0x300):
            if ins.mnemonic == 'push' and ins.op_str.startswith('0x'):
                last_push = int(ins.op_str, 16)
            if ins.mnemonic == 'call' and ins.op_str == hex(SET_CALLBACK):
                callback = last_push
            if ins.mnemonic == 'call' and ins.op_str == hex(SET_FUNCTION):
                execution = last_push
                break  # SetFunction is the last registration in the creation body
        print('%-14s creation=0x%x execution=%s callback=%s' % (
            name, creation, hex(execution) if execution else None, hex(callback) if callback else None))


if __name__ == '__main__':
    main()
