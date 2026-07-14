import { fft2d, fftshift2d } from "./fft";

// A frame "on the wire": just the low-frequency corner of the spectrum,
// per RGB channel. This is the actual payload — everything outside the
// cutoff square is never computed on the sender or transmitted.
export interface EncodedFrame {
  size: number; // full (square) reconstruction resolution, N
  cutoff: number; // K: side length of the retained low-frequency block
  channels: [Float32Array, Float32Array, Float32Array]; // interleaved re/im, length K*K*2
}

export function encodedByteLength(frame: EncodedFrame): number {
  return frame.channels.reduce((sum, c) => sum + c.byteLength, 0);
}

export function rawByteLength(size: number): number {
  return size * size * 3; // RGB, one byte per sample
}

// Sender side: full-res image in, low-frequency coefficients out.
export function encodeFrame(imageData: ImageData, size: number, cutoff: number): EncodedFrame {
  const { data } = imageData;
  const channels: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(cutoff * cutoff * 2),
    new Float32Array(cutoff * cutoff * 2),
    new Float32Array(cutoff * cutoff * 2),
  ];

  const re = new Float64Array(size * size);
  const im = new Float64Array(size * size);
  const half = cutoff / 2;
  const centerLo = size / 2 - half;

  for (let ch = 0; ch < 3; ch++) {
    im.fill(0);
    for (let i = 0, p = ch; i < size * size; i++, p += 4) {
      re[i] = data[p];
    }

    fft2d(re, im, size, false);
    fftshift2d(re, im, size);

    const out = channels[ch];
    for (let y = 0; y < cutoff; y++) {
      const srcRow = (centerLo + y) * size + centerLo;
      const dstRow = y * cutoff;
      for (let x = 0; x < cutoff; x++) {
        out[(dstRow + x) * 2] = re[srcRow + x];
        out[(dstRow + x) * 2 + 1] = im[srcRow + x];
      }
    }
  }

  return { size, cutoff, channels };
}

// Receiver side: low-frequency coefficients in, full-res (smoothly
// reconstructed) image out. Zero-padding the spectrum before the inverse
// transform is what produces a genuinely high-resolution image with no
// high-frequency detail — not a resize of a small blurry frame.
export function decodeFrame(frame: EncodedFrame): ImageData {
  const { size, cutoff, channels } = frame;
  const imageData = new ImageData(size, size);
  const re = new Float64Array(size * size);
  const im = new Float64Array(size * size);
  const half = cutoff / 2;
  const centerLo = size / 2 - half;

  for (let ch = 0; ch < 3; ch++) {
    re.fill(0);
    im.fill(0);

    const src = channels[ch];
    for (let y = 0; y < cutoff; y++) {
      const dstRow = (centerLo + y) * size + centerLo;
      const srcRow = y * cutoff;
      for (let x = 0; x < cutoff; x++) {
        re[dstRow + x] = src[(srcRow + x) * 2];
        im[dstRow + x] = src[(srcRow + x) * 2 + 1];
      }
    }

    fftshift2d(re, im, size); // self-inverse: undoes the encoder's shift
    fft2d(re, im, size, true);

    for (let i = 0, p = ch; i < size * size; i++, p += 4) {
      imageData.data[p] = clampByte(re[i]);
    }
  }

  for (let i = 3; i < imageData.data.length; i += 4) {
    imageData.data[i] = 255;
  }

  return imageData;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
