#!/usr/bin/env python3
"""Convert the original TGA/BMP textures to RGBA PNG without ffmpeg.

Only the variants the Ballance install actually uses are decoded; anything else
raises with the file name instead of guessing. The PNG writer uses only zlib so
the importer runs under the bundled embeddable Python.
"""
import argparse
import struct
import zlib
from pathlib import Path

PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


class RgbaImage:
    """A top-down 8-bit RGBA image."""

    __slots__ = ('width', 'height', 'data')

    def __init__(self, width, height, data):
        if width <= 0 or height <= 0:
            raise ValueError(f'image size {width}x{height} is empty')
        if len(data) != width * height * 4:
            raise ValueError(f'image has {len(data)} bytes, expected {width * height * 4}')
        self.width = width
        self.height = height
        self.data = data


def _png_chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def write_png(path, image):
    """Write an RgbaImage as an 8-bit RGBA PNG (filter 0 on every row)."""
    rows = []
    stride = image.width * 4
    for y in range(image.height):
        rows.append(b'\x00' + image.data[y * stride:(y + 1) * stride])
    header = struct.pack('>IIBBBBB', image.width, image.height, 8, 6, 0, 0, 0)
    payload = PNG_SIGNATURE + _png_chunk(b'IHDR', header) + \
        _png_chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + _png_chunk(b'IEND', b'')
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def _tga_pixel(raw, depth):
    blue, green, red = raw[0], raw[1], raw[2]
    alpha = raw[3] if depth == 32 else 255
    return red, green, blue, alpha


def read_tga(path):
    """Decode an uncompressed or RLE true-colour 24/32-bit TGA, honouring both origin bits."""
    path = Path(path)
    data = path.read_bytes()
    if len(data) < 18:
        raise ValueError(f'{path}: truncated TGA header')
    id_length, colour_map, image_type = data[0], data[1], data[2]
    if colour_map != 0:
        raise ValueError(f'{path}: colour-mapped TGA is not supported')
    if image_type not in (2, 10):
        raise ValueError(f'{path}: TGA image type {image_type} is not supported')
    width, height = struct.unpack_from('<HH', data, 12)
    depth, descriptor = data[16], data[17]
    if depth not in (24, 32):
        raise ValueError(f'{path}: {depth}-bit TGA is not supported')
    if width == 0 or height == 0:
        raise ValueError(f'{path}: empty TGA image')
    top_origin = bool(descriptor & 0x20)
    right_origin = bool(descriptor & 0x10)
    step = depth // 8
    offset = 18 + id_length
    total = width * height
    pixels = []
    if image_type == 2:
        end = offset + total * step
        if end > len(data):
            raise ValueError(f'{path}: truncated TGA pixel data')
        while offset < end:
            pixels.append(_tga_pixel(data[offset:offset + step], depth))
            offset += step
    else:
        while len(pixels) < total:
            if offset >= len(data):
                raise ValueError(f'{path}: truncated TGA RLE data')
            packet = data[offset]
            offset += 1
            count = (packet & 0x7f) + 1
            if len(pixels) + count > total:
                raise ValueError(f'{path}: TGA RLE packet overruns the image')
            if packet & 0x80:
                if offset + step > len(data):
                    raise ValueError(f'{path}: truncated TGA RLE pixel')
                pixel = _tga_pixel(data[offset:offset + step], depth)
                offset += step
                pixels.extend([pixel] * count)
            else:
                if offset + count * step > len(data):
                    raise ValueError(f'{path}: truncated TGA RLE pixels')
                for _ in range(count):
                    pixels.append(_tga_pixel(data[offset:offset + step], depth))
                    offset += step
    rgba = bytearray(total * 4)
    for index, (red, green, blue, alpha) in enumerate(pixels):
        x, y = index % width, index // width
        if not top_origin:
            y = height - 1 - y
        if right_origin:
            x = width - 1 - x
        at = (y * width + x) * 4
        rgba[at:at + 4] = bytes((red, green, blue, alpha))
    return RgbaImage(width, height, bytes(rgba))


def read_bmp(path):
    """Decode an uncompressed 24/32-bit BI_RGB BMP (bottom-up or top-down)."""
    path = Path(path)
    data = path.read_bytes()
    if len(data) < 54 or data[0:2] != b'BM':
        raise ValueError(f'{path}: not a BMP file')
    pixel_offset = struct.unpack_from('<I', data, 10)[0]
    header_size = struct.unpack_from('<I', data, 14)[0]
    if header_size < 40:
        raise ValueError(f'{path}: BMP header size {header_size} is not supported')
    width, height, planes, depth, compression = struct.unpack_from('<iiHHI', data, 18)
    if planes != 1:
        raise ValueError(f'{path}: BMP has {planes} planes')
    if depth not in (24, 32):
        raise ValueError(f'{path}: {depth}-bit BMP is not supported')
    if compression != 0:
        raise ValueError(f'{path}: BMP compression {compression} is not supported')
    if width <= 0 or height == 0:
        raise ValueError(f'{path}: empty BMP image')
    top_down = height < 0
    rows = abs(height)
    stride = ((width * depth + 31) // 32) * 4
    if pixel_offset + stride * rows > len(data):
        raise ValueError(f'{path}: truncated BMP pixel data')
    step = depth // 8
    rgba = bytearray(width * rows * 4)
    for y in range(rows):
        source = pixel_offset + (y if top_down else rows - 1 - y) * stride
        target = y * width * 4
        for x in range(width):
            at = source + x * step
            blue, green, red = data[at], data[at + 1], data[at + 2]
            # BI_RGB leaves the fourth byte undefined even at 32 bits.
            rgba[target + x * 4:target + x * 4 + 4] = bytes((red, green, blue, 255))
    return RgbaImage(width, rows, bytes(rgba))


def read_image(path):
    """Decode a supported TGA or BMP by its file extension."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == '.tga':
        return read_tga(path)
    if suffix == '.bmp':
        return read_bmp(path)
    raise ValueError(f'{path}: image format {suffix or "(none)"} is not supported')


def convert_image(source, target):
    """Decode source and write an RGBA PNG to target; return the target path."""
    write_png(target, read_image(source))
    return Path(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    convert_image(args.source, args.target)


if __name__ == '__main__':
    main()
