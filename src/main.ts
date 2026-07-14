import "./style.css";
import { decodeFrame, encodeFrame, encodedByteLength, rawByteLength } from "./pipeline";
import { compressFrame, decompressFrame, compressedByteLength } from "./compress";

const SIZES = [64, 128, 256] as const;

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <h1>UVideo</h1>
  <p class="subtitle">
    Send frequency-domain coefficients instead of pixels. Only the low-frequency
    corner of the 2D FFT is ever computed and "transmitted" — the reconstruction
    on the right is genuinely high-resolution, not an upscaled blur.
  </p>

  <div class="controls">
    <div class="control">
      <label for="size">Resolution (N&times;N)</label>
      <select id="size">
        ${SIZES.map((s) => `<option value="${s}"${s === 128 ? " selected" : ""}>${s}&times;${s}</option>`).join("")}
      </select>
    </div>
    <div class="control">
      <label for="mode">Encoding</label>
      <select id="mode">
        <option value="raw">Raw FFT crop</option>
        <option value="compressed" selected>Compressed (symmetry + quant + chroma)</option>
      </select>
    </div>
    <div class="control" id="cutoff-control">
      <label for="cutoff">Cutoff (kept coefficients per side): <span id="cutoff-val"></span></label>
      <input type="range" id="cutoff" min="2" max="128" step="2" value="24" />
    </div>
    <div class="control" id="radius-y-control">
      <label for="radius-y">Luma radius: <span id="radius-y-val"></span></label>
      <input type="range" id="radius-y" min="2" max="63" step="1" value="16" />
    </div>
    <div class="control" id="radius-c-control">
      <label for="radius-c">Chroma radius: <span id="radius-c-val"></span></label>
      <input type="range" id="radius-c" min="1" max="63" step="1" value="6" />
    </div>
    <div class="control">
      <button id="toggle">Start camera</button>
    </div>
    <div class="control">
      <button id="compare">Compare vs JPEG/WebP</button>
    </div>
  </div>

  <div class="canvases">
    <div class="canvas-block">
      <h2>Source (cropped, unsent)</h2>
      <canvas id="source"></canvas>
    </div>
    <div class="canvas-block">
      <h2>Reconstruction (from kept coefficients only)</h2>
      <canvas id="output"></canvas>
    </div>
  </div>

  <div class="stats" id="stats">press start</div>
  <div class="stats" id="compare-stats" style="display: none"></div>
  <div id="error"></div>
`;

const video = document.createElement("video");
video.playsInline = true;
video.muted = true;

const sourceCanvas = document.querySelector<HTMLCanvasElement>("#source")!;
const outputCanvas = document.querySelector<HTMLCanvasElement>("#output")!;
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true })!;
const outputCtx = outputCanvas.getContext("2d")!;

const sizeSelect = document.querySelector<HTMLSelectElement>("#size")!;
const modeSelect = document.querySelector<HTMLSelectElement>("#mode")!;
const cutoffControl = document.querySelector<HTMLDivElement>("#cutoff-control")!;
const cutoffInput = document.querySelector<HTMLInputElement>("#cutoff")!;
const cutoffVal = document.querySelector<HTMLSpanElement>("#cutoff-val")!;
const radiusYControl = document.querySelector<HTMLDivElement>("#radius-y-control")!;
const radiusYInput = document.querySelector<HTMLInputElement>("#radius-y")!;
const radiusYVal = document.querySelector<HTMLSpanElement>("#radius-y-val")!;
const radiusCControl = document.querySelector<HTMLDivElement>("#radius-c-control")!;
const radiusCInput = document.querySelector<HTMLInputElement>("#radius-c")!;
const radiusCVal = document.querySelector<HTMLSpanElement>("#radius-c-val")!;
const toggleBtn = document.querySelector<HTMLButtonElement>("#toggle")!;
const compareBtn = document.querySelector<HTMLButtonElement>("#compare")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const compareStatsEl = document.querySelector<HTMLDivElement>("#compare-stats")!;
const errorEl = document.querySelector<HTMLDivElement>("#error")!;

let size = Number(sizeSelect.value);
let mode = modeSelect.value as "raw" | "compressed";
let cutoff = Number(cutoffInput.value);
let radiusY = Number(radiusYInput.value);
let radiusC = Number(radiusCInput.value);
let running = false;
let stream: MediaStream | null = null;
let rafHandle = 0;

function syncCanvasSizes() {
  sourceCanvas.width = size;
  sourceCanvas.height = size;
  outputCanvas.width = size;
  outputCanvas.height = size;
}

function syncCutoffRange() {
  cutoffInput.max = String(size);
  if (cutoff > size) cutoff = size;
  cutoffInput.value = String(cutoff);
  cutoffVal.textContent = String(cutoff);
}

// spectrum.ts requires radius <= size/2 - 1 so the DC-centered window fits
function syncRadiusRanges() {
  const maxRadius = size / 2 - 1;
  radiusYInput.max = String(maxRadius);
  radiusCInput.max = String(maxRadius);
  if (radiusY > maxRadius) radiusY = maxRadius;
  if (radiusC > maxRadius) radiusC = maxRadius;
  radiusYInput.value = String(radiusY);
  radiusCInput.value = String(radiusC);
  radiusYVal.textContent = String(radiusY);
  radiusCVal.textContent = String(radiusC);
}

function syncModeVisibility() {
  const isRaw = mode === "raw";
  cutoffControl.style.display = isRaw ? "" : "none";
  radiusYControl.style.display = isRaw ? "none" : "";
  radiusCControl.style.display = isRaw ? "none" : "";
}

syncCanvasSizes();
syncCutoffRange();
syncRadiusRanges();
syncModeVisibility();

sizeSelect.addEventListener("change", () => {
  size = Number(sizeSelect.value);
  syncCanvasSizes();
  syncCutoffRange();
  syncRadiusRanges();
});

modeSelect.addEventListener("change", () => {
  mode = modeSelect.value as "raw" | "compressed";
  syncModeVisibility();
});

cutoffInput.addEventListener("input", () => {
  cutoff = Number(cutoffInput.value);
  cutoffVal.textContent = String(cutoff);
});

radiusYInput.addEventListener("input", () => {
  radiusY = Number(radiusYInput.value);
  radiusYVal.textContent = String(radiusY);
});

radiusCInput.addEventListener("input", () => {
  radiusC = Number(radiusCInput.value);
  radiusCVal.textContent = String(radiusC);
});

toggleBtn.addEventListener("click", () => {
  if (running) {
    stop();
  } else {
    start();
  }
});

async function start() {
  errorEl.textContent = "";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    errorEl.textContent = `Could not access camera: ${(err as Error).message}`;
    return;
  }
  video.srcObject = stream;
  await video.play();
  running = true;
  toggleBtn.textContent = "Stop camera";
  loop();
}

function stop() {
  running = false;
  toggleBtn.textContent = "Start camera";
  cancelAnimationFrame(rafHandle);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  statsEl.textContent = "stopped";
}

const fpsWindow: number[] = [];
let lastPayloadBytes = 0;

function loop() {
  if (!running) return;
  rafHandle = requestAnimationFrame(loop);

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // center-crop the video to a square before drawing at NxN
  const cropSize = Math.min(vw, vh);
  const sx = (vw - cropSize) / 2;
  const sy = (vh - cropSize) / 2;
  sourceCtx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, size, size);

  const t0 = performance.now();
  const imageData = sourceCtx.getImageData(0, 0, size, size);
  const t1 = performance.now();

  let kept: number;
  let t2: number;
  let t3: number;

  if (mode === "raw") {
    const encoded = encodeFrame(imageData, size, cutoff);
    t2 = performance.now();
    const decoded = decodeFrame(encoded);
    t3 = performance.now();
    outputCtx.putImageData(decoded, 0, 0);
    kept = encodedByteLength(encoded);
  } else {
    const encoded = compressFrame(imageData, size, radiusY, radiusC);
    t2 = performance.now();
    const decoded = decompressFrame(encoded);
    t3 = performance.now();
    outputCtx.putImageData(decoded, 0, 0);
    kept = compressedByteLength(encoded);
  }

  const now = performance.now();
  fpsWindow.push(now);
  while (fpsWindow.length && now - fpsWindow[0] > 1000) fpsWindow.shift();

  lastPayloadBytes = kept;
  const raw = rawByteLength(size);
  statsEl.textContent = [
    `fps: ${fpsWindow.length}  mode: ${mode}`,
    `capture: ${(t1 - t0).toFixed(1)}ms  encode: ${(t2 - t1).toFixed(1)}ms  decode: ${(t3 - t2).toFixed(1)}ms`,
    `payload: ${kept} bytes/frame  vs raw ${raw} bytes/frame  (${(raw / kept).toFixed(1)}x smaller)`,
  ].join("\n");
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Traditional-codec quality high enough that further increases barely
// shrink the file — a stand-in for "as good as JPEG/WebP get here".
const COMPARISON_QUALITY = 0.92;

compareBtn.addEventListener("click", async () => {
  if (!running || lastPayloadBytes === 0) {
    errorEl.textContent = "Start the camera first so there's a live frame to compare.";
    return;
  }
  compareBtn.disabled = true;
  compareStatsEl.style.display = "";
  compareStatsEl.textContent = "encoding comparison frames…";

  const [jpegSharp, jpegBlurred, webpBlurred] = await Promise.all([
    canvasToBlob(sourceCanvas, "image/jpeg", COMPARISON_QUALITY),
    canvasToBlob(outputCanvas, "image/jpeg", COMPARISON_QUALITY),
    canvasToBlob(outputCanvas, "image/webp", COMPARISON_QUALITY),
  ]);

  const ours = lastPayloadBytes;
  const lines = [`UVideo payload: ${ours} bytes (this is what's actually being compared against)`, ""];

  if (jpegSharp) {
    lines.push(
      `JPEG of SHARP source (q=${COMPARISON_QUALITY}): ${jpegSharp.size} bytes  ` +
        `(${(jpegSharp.size / ours).toFixed(1)}x more than UVideo) — this is the "send full video, blur on receive" cost`,
    );
  }
  if (jpegBlurred) {
    lines.push(
      `JPEG of the BLURRED reconstruction: ${jpegBlurred.size} bytes  ` +
        `(${(jpegBlurred.size / ours).toFixed(1)}x more than UVideo) — "pre-blur then compress with a standard codec"`,
    );
  }
  if (webpBlurred && webpBlurred.type === "image/webp") {
    lines.push(
      `WebP of the BLURRED reconstruction: ${webpBlurred.size} bytes  ` +
        `(${(webpBlurred.size / ours).toFixed(1)}x more than UVideo)`,
    );
  } else if (webpBlurred) {
    lines.push(`WebP not supported by this browser (canvas fell back to ${webpBlurred.type})`);
  }

  compareStatsEl.textContent = lines.join("\n");
  compareBtn.disabled = false;
});
