// Iterative radix-2 Cooley-Tukey FFT. `n` must be a power of two.
// Operates in place on parallel real/imaginary arrays.
export function fft1d(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;

  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angStep = ((invert ? 1 : -1) * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const ang = angStep * k;
        const wRe = Math.cos(ang);
        const wIm = Math.sin(ang);
        const evenIdx = i + k;
        const oddIdx = i + k + half;
        const uRe = re[evenIdx];
        const uIm = im[evenIdx];
        const vRe = re[oddIdx] * wRe - im[oddIdx] * wIm;
        const vIm = re[oddIdx] * wIm + im[oddIdx] * wRe;
        re[evenIdx] = uRe + vRe;
        im[evenIdx] = uIm + vIm;
        re[oddIdx] = uRe - vRe;
        im[oddIdx] = uIm - vIm;
      }
    }
  }

  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// 2D FFT over a square NxN complex array stored row-major.
// Transforms rows, then columns, in place.
export function fft2d(re: Float64Array, im: Float64Array, n: number, invert: boolean): void {
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);

  for (let y = 0; y < n; y++) {
    const offset = y * n;
    rowRe.set(re.subarray(offset, offset + n));
    rowIm.set(im.subarray(offset, offset + n));
    fft1d(rowRe, rowIm, invert);
    re.set(rowRe, offset);
    im.set(rowIm, offset);
  }

  const colRe = new Float64Array(n);
  const colIm = new Float64Array(n);

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      colRe[y] = re[y * n + x];
      colIm[y] = im[y * n + x];
    }
    fft1d(colRe, colIm, invert);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = colRe[y];
      im[y * n + x] = colIm[y];
    }
  }
}

// Swaps quadrants so the DC (zero-frequency) term moves to the center.
// Self-inverse for even n, so the same function undoes the shift.
export function fftshift2d(re: Float64Array, im: Float64Array, n: number): void {
  const half = n / 2;
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const a = y * n + x;
      const b = (y + half) * n + (x + half);
      [re[a], re[b]] = [re[b], re[a]];
      [im[a], im[b]] = [im[b], im[a]];

      const c = y * n + (x + half);
      const d = (y + half) * n + x;
      [re[c], re[d]] = [re[d], re[c]];
      [im[c], im[d]] = [im[d], im[c]];
    }
  }
}
