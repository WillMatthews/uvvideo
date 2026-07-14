// Adaptive binary range coder (the same construction LZMA/7-Zip use): an
// arithmetic coder restricted to binary decisions with adaptive
// probabilities, extended to byte streams via a 256-leaf binary trie of
// contexts. The trie matters — it means the high bits of a byte condition
// the model for the low bits, which is what actually captures the skew in
// our quantized coefficients (small magnitudes dominate, so most bytes are
// close to 0 or 255 depending on sign encoding).
//
// This replaces the fixed-width int16/int8/nibble packing in compress.ts's
// output with something that spends near-zero bits on predictable values —
// the same lever JPEG/WebP pull with Huffman/arithmetic coding after their
// own quantization step.

const PROB_BITS = 11;
const PROB_MAX = 1 << PROB_BITS; // 2048
const PROB_INIT = PROB_MAX >> 1;
const MOVE_BITS = 5;
const TOP = 1 << 24;

export class RangeEncoder {
  private low = 0; // transiently exceeds 0xFFFFFFFF; safe as a JS double (<2^53)
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private bytes: number[] = [];

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low > 0xffffffff) {
      const carry = this.low > 0xffffffff ? 1 : 0;
      let temp = this.cache;
      do {
        this.bytes.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / TOP) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % TOP) * 256;
  }

  encodeBit(probs: Uint16Array, index: number, bit: 0 | 1): void {
    const prob = probs[index];
    const bound = (this.range >>> PROB_BITS) * prob;
    if (bit === 0) {
      this.range = bound;
      probs[index] = prob + ((PROB_MAX - prob) >>> MOVE_BITS);
    } else {
      this.low += bound;
      this.range -= bound;
      probs[index] = prob - (prob >>> MOVE_BITS);
    }
    while (this.range < TOP) {
      this.range *= 256;
      this.shiftLow();
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return new Uint8Array(this.bytes.slice(1)); // drop the encoder's leading dummy byte
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    for (let i = 0; i < 4; i++) {
      this.code = this.code * 256 + this.readByte();
    }
  }

  private readByte(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : 0;
  }

  decodeBit(probs: Uint16Array, index: number): 0 | 1 {
    const prob = probs[index];
    const bound = (this.range >>> PROB_BITS) * prob;
    let bit: 0 | 1;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = prob + ((PROB_MAX - prob) >>> MOVE_BITS);
      bit = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      probs[index] = prob - (prob >>> MOVE_BITS);
      bit = 1;
    }
    while (this.range < TOP) {
      this.range *= 256;
      this.code = (this.code % TOP) * 256 + this.readByte();
    }
    return bit;
  }
}

function newByteProbs(): Uint16Array {
  const probs = new Uint16Array(256);
  probs.fill(PROB_INIT);
  return probs;
}

function encodeByte(rc: RangeEncoder, probs: Uint16Array, byte: number): void {
  let context = 1;
  for (let i = 7; i >= 0; i--) {
    const bit = ((byte >> i) & 1) as 0 | 1;
    rc.encodeBit(probs, context, bit);
    context = (context << 1) | bit;
  }
}

function decodeByte(rc: RangeDecoder, probs: Uint16Array): number {
  let context = 1;
  for (let i = 0; i < 8; i++) {
    const bit = rc.decodeBit(probs, context);
    context = (context << 1) | bit;
  }
  return context & 0xff;
}

// Order-0 adaptive entropy coding of an arbitrary byte buffer. The
// probability model starts uniform and is rebuilt identically by the
// decoder in lockstep — no model/table needs to be transmitted.
export function entropyEncode(data: Uint8Array): Uint8Array {
  const rc = new RangeEncoder();
  const probs = newByteProbs();
  for (let i = 0; i < data.length; i++) {
    encodeByte(rc, probs, data[i]);
  }
  const body = rc.finish();
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(body, 4);
  return out;
}

export function entropyDecode(data: Uint8Array): Uint8Array {
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  const rc = new RangeDecoder(data.subarray(4));
  const probs = newByteProbs();
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = decodeByte(rc, probs);
  }
  return out;
}
