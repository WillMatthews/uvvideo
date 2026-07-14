import { channelToSpectrum, spectrumToChannel, type ChannelSpectrum } from "./spectrum";
import { imageDataToYCbCr, yCbCrToImageData } from "./colorspace";

// Three ideas stacked on top of the raw FFT crop:
//
// 1. Hermitian symmetry: a real-valued channel's spectrum satisfies
//    F(dy, dx) = conj(F(-dy, -dx)) about DC. Because ChannelSpectrum's
//    window is centered exactly on DC, every offset's mirror is always
//    also in range — so we only ever serialize half the window (plus the
//    single self-paired DC term) and reconstruct the rest for free.
// 2. Radial quantization: coefficient magnitude falls off away from DC for
//    natural images, so precision needed falls off too. Bit depth steps
//    down (int16 -> int8 -> 4-bit) with Chebyshev distance from DC, each
//    tier carrying its own dynamic-range scale.
// 3. Chroma subsampling: the caller uses a smaller radius for Cb/Cr than Y
//    (see compressFrame) — the eye doesn't resolve high-frequency color.

const LEVELS_16 = 32767;
const LEVELS_8 = 127;
const LEVELS_4 = 7;

const TIER_A_FRACTION = 0.15; // full int16 precision within this fraction of radius
const TIER_B_FRACTION = 0.5; // int8 out to this fraction; beyond it, 4-bit

type Offset = [number, number];
interface Tiers {
  a: Offset[];
  b: Offset[];
  c: Offset[];
}

const tierCache = new Map<number, Tiers>();

function tiersForRadius(radius: number): Tiers {
  const cached = tierCache.get(radius);
  if (cached) return cached;

  const a: Offset[] = [];
  const b: Offset[] = [];
  const c: Offset[] = [];
  const rA = Math.max(1, Math.round(radius * TIER_A_FRACTION));
  const rB = Math.max(rA, Math.round(radius * TIER_B_FRACTION));

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dy === 0 && dx === 0) continue; // DC: stored separately, always full precision
      if (dy < 0 || (dy === 0 && dx < 0)) continue; // redundant half: dropped, rebuilt by symmetry
      const d = Math.max(Math.abs(dy), Math.abs(dx));
      if (d <= rA) a.push([dy, dx]);
      else if (d <= rB) b.push([dy, dx]);
      else c.push([dy, dx]);
    }
  }

  const tiers = { a, b, c };
  tierCache.set(radius, tiers);
  return tiers;
}

function magnitudeScale(
  re: Float64Array,
  im: Float64Array,
  radius: number,
  side: number,
  offsets: Offset[],
): number {
  let max = 1e-6; // avoid div-by-zero for an all-flat tier
  for (const [dy, dx] of offsets) {
    const idx = (dy + radius) * side + (dx + radius);
    max = Math.max(max, Math.abs(re[idx]), Math.abs(im[idx]));
  }
  return max;
}

function quantize(v: number, scale: number, levels: number): number {
  const q = Math.round((v / scale) * levels);
  return Math.max(-levels, Math.min(levels, q));
}

function dequantize(q: number, scale: number, levels: number): number {
  return (q / levels) * scale;
}

export function compressChannel(spectrum: ChannelSpectrum): Uint8Array {
  const { radius, side, re, im } = spectrum;
  const dcIdx = radius * side + radius;
  const { a, b, c } = tiersForRadius(radius);

  const scaleA = magnitudeScale(re, im, radius, side, a);
  const scaleB = magnitudeScale(re, im, radius, side, b);
  const scaleC = magnitudeScale(re, im, radius, side, c);

  const headerBytes = 1 + 4 * 4; // radius + dcRe + 3 scales
  const tierABytes = a.length * 2 * 2; // int16 re,im
  const tierBBytes = b.length * 2 * 1; // int8 re,im
  const tierCBytes = Math.ceil((c.length * 2) / 2); // two 4-bit values per byte

  const buf = new ArrayBuffer(headerBytes + tierABytes + tierBBytes + tierCBytes);
  const view = new DataView(buf);
  let o = 0;
  view.setUint8(o, radius);
  o += 1;
  view.setFloat32(o, re[dcIdx]);
  o += 4;
  view.setFloat32(o, scaleA);
  o += 4;
  view.setFloat32(o, scaleB);
  o += 4;
  view.setFloat32(o, scaleC);
  o += 4;

  for (const [dy, dx] of a) {
    const idx = (dy + radius) * side + (dx + radius);
    view.setInt16(o, quantize(re[idx], scaleA, LEVELS_16));
    o += 2;
    view.setInt16(o, quantize(im[idx], scaleA, LEVELS_16));
    o += 2;
  }
  for (const [dy, dx] of b) {
    const idx = (dy + radius) * side + (dx + radius);
    view.setInt8(o, quantize(re[idx], scaleB, LEVELS_8));
    o += 1;
    view.setInt8(o, quantize(im[idx], scaleB, LEVELS_8));
    o += 1;
  }

  let pendingNibble: number | null = null;
  const pushNibble = (v: number) => {
    const nibble = v & 0xf;
    if (pendingNibble === null) {
      pendingNibble = nibble;
    } else {
      view.setUint8(o, pendingNibble | (nibble << 4));
      o += 1;
      pendingNibble = null;
    }
  };
  for (const [dy, dx] of c) {
    const idx = (dy + radius) * side + (dx + radius);
    pushNibble(quantize(re[idx], scaleC, LEVELS_4));
    pushNibble(quantize(im[idx], scaleC, LEVELS_4));
  }
  if (pendingNibble !== null) {
    view.setUint8(o, pendingNibble);
    o += 1;
  }

  return new Uint8Array(buf);
}

export function decompressChannel(bytes: Uint8Array): ChannelSpectrum {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const radius = view.getUint8(o);
  o += 1;
  const dcRe = view.getFloat32(o);
  o += 4;
  const scaleA = view.getFloat32(o);
  o += 4;
  const scaleB = view.getFloat32(o);
  o += 4;
  const scaleC = view.getFloat32(o);
  o += 4;

  const side = radius * 2 + 1;
  const re = new Float64Array(side * side);
  const im = new Float64Array(side * side);
  const dcIdx = radius * side + radius;
  re[dcIdx] = dcRe;

  const { a, b, c } = tiersForRadius(radius);

  const setConjugatePair = (dy: number, dx: number, vRe: number, vIm: number) => {
    const idx = (dy + radius) * side + (dx + radius);
    re[idx] = vRe;
    im[idx] = vIm;
    const mIdx = (-dy + radius) * side + (-dx + radius);
    re[mIdx] = vRe;
    im[mIdx] = -vIm;
  };

  for (const [dy, dx] of a) {
    const vRe = dequantize(view.getInt16(o), scaleA, LEVELS_16);
    o += 2;
    const vIm = dequantize(view.getInt16(o), scaleA, LEVELS_16);
    o += 2;
    setConjugatePair(dy, dx, vRe, vIm);
  }
  for (const [dy, dx] of b) {
    const vRe = dequantize(view.getInt8(o), scaleB, LEVELS_8);
    o += 1;
    const vIm = dequantize(view.getInt8(o), scaleB, LEVELS_8);
    o += 1;
    setConjugatePair(dy, dx, vRe, vIm);
  }

  let pendingByte = 0;
  let haveHighNibble = false;
  const readNibble = (): number => {
    if (!haveHighNibble) {
      pendingByte = view.getUint8(o);
      o += 1;
      haveHighNibble = true;
      const v = pendingByte & 0xf;
      return v >= 8 ? v - 16 : v;
    }
    haveHighNibble = false;
    const v = (pendingByte >> 4) & 0xf;
    return v >= 8 ? v - 16 : v;
  };
  for (const [dy, dx] of c) {
    const vRe = dequantize(readNibble(), scaleC, LEVELS_4);
    const vIm = dequantize(readNibble(), scaleC, LEVELS_4);
    setConjugatePair(dy, dx, vRe, vIm);
  }

  return { radius, side, re, im };
}

export interface CompressedFrame {
  size: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
}

export function compressFrame(
  imageData: ImageData,
  size: number,
  radiusY: number,
  radiusChroma: number,
): CompressedFrame {
  const { y, cb, cr } = imageDataToYCbCr(imageData, size);
  const ySpectrum = channelToSpectrum(y, new Float64Array(size * size), size, radiusY);
  const cbSpectrum = channelToSpectrum(cb, new Float64Array(size * size), size, radiusChroma);
  const crSpectrum = channelToSpectrum(cr, new Float64Array(size * size), size, radiusChroma);

  return {
    size,
    y: compressChannel(ySpectrum),
    cb: compressChannel(cbSpectrum),
    cr: compressChannel(crSpectrum),
  };
}

export function decompressFrame(frame: CompressedFrame): ImageData {
  const ySpectrum = decompressChannel(frame.y);
  const cbSpectrum = decompressChannel(frame.cb);
  const crSpectrum = decompressChannel(frame.cr);

  const y = spectrumToChannel(ySpectrum, frame.size);
  const cb = spectrumToChannel(cbSpectrum, frame.size);
  const cr = spectrumToChannel(crSpectrum, frame.size);

  return yCbCrToImageData(y, cb, cr, frame.size);
}

export function compressedByteLength(frame: CompressedFrame): number {
  return frame.y.byteLength + frame.cb.byteLength + frame.cr.byteLength;
}
