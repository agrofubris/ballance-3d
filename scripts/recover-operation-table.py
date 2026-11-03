#!/usr/bin/env python3
"""Recover the parameter-operation GUID table from ParameterOperations.dll.

Each operation is registered with the byte pattern
`mov ecx,G1; mov eax,G2; push <name>; push ecx; push eax` (the two `mov`s may be
swapped). The operation GUID is `CKGUID(eax, ecx)`. Requires a PE32 module.

Usage: python3 scripts/recover-operation-table.py <ParameterOperations.dll>
"""
import struct
import sys


def main():
    data = open(sys.argv[1], 'rb').read()

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

    def string_at_va(va):
        for _, vaddr, vsize, rawptr, rawsize in sections:
            if vaddr <= va - image_base < vaddr + vsize:
                off = rawptr + (va - image_base - vaddr)
                end = data.find(b'\x00', off)
                return data[off:end].decode('latin1', 'replace')

    registrations = {}
    i = 0
    while True:
        j = data.find(b'\x51\x50', i)
        if j < 0:
            break
        i = j + 1
        if j < 15 or data[j - 5] != 0x68:
            continue
        name_va = u32(j - 4)
        movs = data[j - 15:j - 5]
        if movs[0] == 0xB8 and movs[5] == 0xB9:
            eax_val, ecx_val = u32(j - 14), u32(j - 9)
        elif movs[0] == 0xB9 and movs[5] == 0xB8:
            ecx_val, eax_val = u32(j - 14), u32(j - 9)
        else:
            continue
        name = string_at_va(name_va)
        if name:
            registrations[(eax_val, ecx_val)] = name

    print(f'{len(registrations)} operations')
    for (g1, g2), name in sorted(registrations.items(), key=lambda kv: kv[1]):
        print('  CKGUID(0x%08X, 0x%08X)  %s' % (g1, g2, name))


if __name__ == '__main__':
    main()
