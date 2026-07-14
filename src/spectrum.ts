import { fft2d, fftshift2d } from "./fft";

// A channel's spectrum, kept as a window centered exactly on DC and spanning
// [-radius, +radius] on both axes. Centering the window on DC (rather than
// the [0, cutoff) crop pipeline.ts uses) is what makes the Hermitian
// symmetry in compress.ts exact: coefficient (dy, dx) and (-dy, -dx) are
// both always in range, with no off-by-one at the edge.
export interface ChannelSpectrum {
  radius: number;
  side: number; // 2*radius + 1
  re: Float64Array; // side*side, row-major, index (dy+radius)*side + (dx+radius)
  im: Float64Array;
}

// `re`/`im` are consumed in place (the FFT runs in place); pass fresh arrays.
export function channelToSpectrum(
  re: Float64Array,
  im: Float64Array,
  size: number,
  radius: number,
): ChannelSpectrum {
  fft2d(re, im, size, false);
  fftshift2d(re, im, size);

  const side = radius * 2 + 1;
  const outRe = new Float64Array(side * side);
  const outIm = new Float64Array(side * side);
  const c = size / 2;

  for (let dy = -radius; dy <= radius; dy++) {
    const srcRow = (c + dy) * size + c;
    const dstRow = (dy + radius) * side + radius;
    for (let dx = -radius; dx <= radius; dx++) {
      outRe[dstRow + dx] = re[srcRow + dx];
      outIm[dstRow + dx] = im[srcRow + dx];
    }
  }

  return { radius, side, re: outRe, im: outIm };
}

export function spectrumToChannel(spectrum: ChannelSpectrum, size: number): Float64Array {
  const { radius, side, re: specRe, im: specIm } = spectrum;
  const re = new Float64Array(size * size);
  const im = new Float64Array(size * size);
  const c = size / 2;

  for (let dy = -radius; dy <= radius; dy++) {
    const dstRow = (c + dy) * size + c;
    const srcRow = (dy + radius) * side + radius;
    for (let dx = -radius; dx <= radius; dx++) {
      re[dstRow + dx] = specRe[srcRow + dx];
      im[dstRow + dx] = specIm[srcRow + dx];
    }
  }

  fftshift2d(re, im, size); // self-inverse: undoes the centering shift
  fft2d(re, im, size, true);
  return re; // real part; caller clamps to a byte range
}
