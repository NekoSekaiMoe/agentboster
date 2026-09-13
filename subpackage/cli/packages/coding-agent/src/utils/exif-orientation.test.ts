import { describe, expect, it, vi } from 'vitest';

import { applyExifOrientation } from './exif-orientation.ts';

type PhotonLike = Parameters<typeof applyExifOrientation>[0];

/**
 * Build a minimal JPEG with an XMP APP1 segment placed BEFORE the EXIF APP1
 * segment — the layout written by Adobe tools and the regression case for
 * pi #8616 (the scanner previously gave up at the first non-EXIF APP1 and
 * reported orientation 1).
 */
function jpegWithXmpBeforeExif(orientation: number): Uint8Array {
  const xmpPayload = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0\0padding',
    'latin1',
  );

  // TIFF header + one IFD0 entry with the orientation tag (0x0112), LE.
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.writeUInt16LE(0x4949, 0);
  tiff.writeUInt16LE(0x002a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // entry count
  tiff.writeUInt16LE(0x0112, 10); // orientation tag
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18);
  tiff.writeUInt32LE(0, 22); // next IFD

  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);

  const segment = (payload: Buffer): Buffer => {
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt16BE(0xffe1, 0);
    seg.writeUInt16BE(2 + payload.length, 2);
    payload.copy(seg, 4);
    return seg;
  };

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(xmpPayload),
      segment(exifPayload),
    ]),
  );
}

function fakePhoton() {
  const fliph = vi.fn();
  const flipv = vi.fn();
  class PhotonImage {
    pixels: Uint8Array;
    width: number;
    height: number;
    constructor(pixels: Uint8Array, width: number, height: number) {
      this.pixels = pixels;
      this.width = width;
      this.height = height;
    }
  }
  const photon = { fliph, flipv, PhotonImage } as unknown as PhotonLike;
  return { photon, fliph, flipv };
}

function fakeImage() {
  // 1x1 RGBA
  return {
    get_width: () => 1,
    get_height: () => 1,
    get_raw_pixels: () => new Uint8Array([1, 2, 3, 4]),
  } as Parameters<typeof applyExifOrientation>[1];
}

describe('applyExifOrientation (JPEG)', () => {
  it('detects EXIF orientation after a non-EXIF (XMP) APP1 segment', () => {
    const { photon, flipv } = fakePhoton();
    // Orientation 4 = flip vertical. Before the fix the XMP segment made the
    // scanner return -1 (orientation 1) and the image came back unchanged.
    applyExifOrientation(photon, fakeImage(), jpegWithXmpBeforeExif(4));
    expect(flipv).toHaveBeenCalledTimes(1);
  });

  it('returns the original image when only XMP (no EXIF) is present', () => {
    const { photon, fliph, flipv } = fakePhoton();
    const image = fakeImage();
    const xmpOnly = new Uint8Array(
      Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        (() => {
          const payload = Buffer.from(
            'http://ns.adobe.com/xap/1.0/\0',
            'latin1',
          );
          const seg = Buffer.alloc(4 + payload.length);
          seg.writeUInt16BE(0xffe1, 0);
          seg.writeUInt16BE(2 + payload.length, 2);
          payload.copy(seg, 4);
          return seg;
        })(),
      ]),
    );
    const result = applyExifOrientation(photon, image, xmpOnly);
    expect(result).toBe(image);
    expect(fliph).not.toHaveBeenCalled();
    expect(flipv).not.toHaveBeenCalled();
  });
});
