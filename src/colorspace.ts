// Full-range RGB <-> YCbCr (same formulas JPEG uses), so we can spend more
// spectrum on luma and subsample chroma the way every real video codec does.
export interface YCbCrChannels {
  y: Float64Array;
  cb: Float64Array;
  cr: Float64Array;
}

export function imageDataToYCbCr(imageData: ImageData, size: number): YCbCrChannels {
  const { data } = imageData;
  const y = new Float64Array(size * size);
  const cb = new Float64Array(size * size);
  const cr = new Float64Array(size * size);

  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  return { y, cb, cr };
}

export function yCbCrToImageData(
  y: Float64Array,
  cb: Float64Array,
  cr: Float64Array,
  size: number,
): ImageData {
  const imageData = new ImageData(size, size);
  const { data } = imageData;

  for (let i = 0, p = 0; i < size * size; i++, p += 4) {
    const Y = y[i];
    const Cb = cb[i] - 128;
    const Cr = cr[i] - 128;
    data[p] = clampByte(Y + 1.402 * Cr);
    data[p + 1] = clampByte(Y - 0.344136 * Cb - 0.714136 * Cr);
    data[p + 2] = clampByte(Y + 1.772 * Cb);
    data[p + 3] = 255;
  }

  return imageData;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
