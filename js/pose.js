// Pose engine: YOLOX-nano finds the lifter, RTMPose (body, 17 keypoints) places the joints.
// Pre/post-processing follows the models' official pipeline.json (mmdeploy SDK export).
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';

const ROOT = new URL('../', import.meta.url);
export const MODEL_FILES = {
  det: 'models/yolox_nano.onnx',
  precise: 'models/rtmpose-m.onnx', // 52 MB
  fast: 'models/rtmpose-s.onnx', // 21 MB
};

const DET_SIZE = 416;
const DET_PAD = 114;
const POSE_W = 192;
const POSE_H = 256;
const MEAN = [123.675, 116.28, 103.53]; // RGB
const STD = [58.395, 57.12, 57.375];
const SIMCC_SPLIT = 2;
const BBOX_PADDING = 1.25;

const DET_EVERY = 15; // re-check who the lifter is this often (frames); follow their box in between
const DET_SCORE = 0.2; // YOLOX-nano scores a lifter half hidden by the plate at only 0.3-0.4
const MIN_KPT_SCORE = 0.3;
const MIN_GOOD_KPTS = 6;
const BOX_PAD = 0.2;
const MIN_IOU = 0.3;
const SWITCH_RATIO = 1.5; // only jump to another person if they are clearly bigger

ort.env.wasm.wasmPaths = new URL('vendor/ort/', ROOT).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
ort.env.logLevel = 'error';

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return { c, ctx };
}

async function fetchBytes(path, onProgress) {
  const res = await fetch(new URL(path, ROOT));
  if (!res.ok) throw new Error(`No se pudo descargar ${path} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(got / total, 1));
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.length;
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);

/** Draw source rect (x, y, w, h) into (0, 0, dw, dh), clipping to the source like cv2.warpAffine's black border. */
function drawCrop(ctx, src, srcW, srcH, x, y, w, h, dw, dh) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(srcW, x + w);
  const y1 = Math.min(srcH, y + h);
  if (x1 <= x0 || y1 <= y0) return;
  const kx = dw / w;
  const ky = dh / h;
  ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, (x0 - x) * kx, (y0 - y) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

function argmaxRow(data, offset, len) {
  let best = 0;
  let val = data[offset];
  for (let i = 1; i < len; i++) {
    const v = data[offset + i];
    if (v > val) {
      val = v;
      best = i;
    }
  }
  return [best, val];
}

/** Deterministic pseudo-random tensor for the backend self-test. */
function testInput() {
  const n = 3 * POSE_H * POSE_W;
  const data = new Float32Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (s / 0x7fffffff) * 4 - 2;
  }
  return new ort.Tensor('float32', data, [1, 3, POSE_H, POSE_W]);
}

async function timeRuns(session, feeds, n) {
  let out = await session.run(feeds); // warm-up (shader compile)
  const t0 = performance.now();
  for (let i = 0; i < n; i++) out = await session.run(feeds);
  return { out, ms: (performance.now() - t0) / n };
}

function sameKeypoints(a, b) {
  const [ax, ay] = [a.simcc_x, a.simcc_y];
  const [bx, by] = [b.simcc_x, b.simcc_y];
  const k = ax.dims[1];
  let agree = 0;
  for (let i = 0; i < k; i++) {
    const [px] = argmaxRow(ax.data, i * ax.dims[2], ax.dims[2]);
    const [qx] = argmaxRow(bx.data, i * bx.dims[2], bx.dims[2]);
    const [py] = argmaxRow(ay.data, i * ay.dims[2], ay.dims[2]);
    const [qy] = argmaxRow(by.data, i * by.dims[2], by.dims[2]);
    if (Math.abs(px - qx) <= 2 && Math.abs(py - qy) <= 2) agree++;
  }
  return agree >= k - 1;
}

/**
 * Pick the pose backend: WebGPU if it gives the same answer as the CPU and is faster, else CPU (WebAssembly).
 * ONNX Runtime does not officially support WebGPU on Safari, so this checks instead of trusting it.
 */
async function createPoseSession(bytes, allowGpu) {
  const cpu = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  if (!allowGpu || !navigator.gpu) return { session: cpu, backend: 'CPU' };
  let gpu = null;
  try {
    const feeds = { [cpu.inputNames[0]]: testInput() };
    const ref = await timeRuns(cpu, feeds, 3);
    gpu = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
    const test = await timeRuns(gpu, feeds, 3);
    if (sameKeypoints(ref.out, test.out) && test.ms < ref.ms * 0.8) {
      await cpu.release();
      return { session: gpu, backend: 'GPU' };
    }
    console.info(`WebGPU descartado (cpu ${ref.ms.toFixed(0)} ms, gpu ${test.ms.toFixed(0)} ms)`);
  } catch (err) {
    console.info('WebGPU no disponible:', err?.message || err);
  }
  if (gpu) await gpu.release().catch(() => {});
  return { session: cpu, backend: 'CPU' };
}

export class PoseEngine {
  /** variant: 'precise' | 'fast'. onProgress(fraction, message). */
  static async load(variant, { allowGpu = true, onProgress } = {}) {
    const files = [MODEL_FILES.det, MODEL_FILES[variant]];
    const sizes = [3.6, variant === 'fast' ? 21 : 52];
    const total = sizes[0] + sizes[1];
    const detBytes = await fetchBytes(files[0], (f) => onProgress?.((f * sizes[0]) / total, 'Descargando modelos…'));
    const poseBytes = await fetchBytes(files[1], (f) =>
      onProgress?.((sizes[0] + f * sizes[1]) / total, 'Descargando modelos…'),
    );
    onProgress?.(1, 'Preparando el modelo…');
    const det = await ort.InferenceSession.create(detBytes, { executionProviders: ['wasm'] });
    const { session, backend } = await createPoseSession(poseBytes, allowGpu);
    return new PoseEngine(det, session, backend, variant);
  }

  constructor(det, pose, backend, variant) {
    this.det = det;
    this.pose = pose;
    this.backend = backend;
    this.variant = variant;
    this.threads = ort.env.wasm.numThreads;
    this.box = null;
    this.frame = 0;
    this.detCanvas = makeCanvas(DET_SIZE, DET_SIZE);
    this.poseCanvas = makeCanvas(POSE_W, POSE_H);
    this.detBuf = new Float32Array(3 * DET_SIZE * DET_SIZE);
    this.poseBuf = new Float32Array(3 * POSE_W * POSE_H);
    this.timing = { det: 0, pose: 0 };
  }

  reset() {
    this.box = null;
    this.frame = 0;
  }

  async detect(src, w, h) {
    const t0 = performance.now();
    const { ctx } = this.detCanvas;
    const r = Math.min(DET_SIZE / h, DET_SIZE / w);
    ctx.fillStyle = `rgb(${DET_PAD},${DET_PAD},${DET_PAD})`;
    ctx.fillRect(0, 0, DET_SIZE, DET_SIZE);
    ctx.drawImage(src, 0, 0, w, h, 0, 0, Math.floor(w * r), Math.floor(h * r));
    const px = ctx.getImageData(0, 0, DET_SIZE, DET_SIZE).data;
    const n = DET_SIZE * DET_SIZE;
    const buf = this.detBuf;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      buf[i] = px[p + 2]; // BGR, raw 0-255 (pipeline.json: to_rgb false, no normalization)
      buf[n + i] = px[p + 1];
      buf[2 * n + i] = px[p];
    }
    const out = await this.det.run({
      [this.det.inputNames[0]]: new ort.Tensor('float32', buf, [1, 3, DET_SIZE, DET_SIZE]),
    });
    const dets = out[this.det.outputNames[0]];
    const boxes = [];
    for (let k = 0; k < dets.dims[1]; k++) {
      const o = k * 5;
      if (dets.data[o + 4] > DET_SCORE) {
        boxes.push([dets.data[o] / r, dets.data[o + 1] / r, dets.data[o + 2] / r, dets.data[o + 3] / r]);
      }
    }
    this.timing.det = performance.now() - t0;
    return boxes;
  }

  /** Choose the lifter among detections, sticking with the tracked person when sensible. */
  pick(boxes) {
    if (!boxes.length) return this.box;
    const areas = boxes.map(area);
    const biggest = areas.indexOf(Math.max(...areas));
    if (!this.box) return boxes[biggest];
    const ious = boxes.map((b) => iou(b, this.box));
    const bestIou = Math.max(...ious);
    if (bestIou >= MIN_IOU) {
      const same = ious.indexOf(bestIou);
      return areas[biggest] > SWITCH_RATIO * areas[same] ? boxes[biggest] : boxes[same];
    }
    return areas[biggest] > SWITCH_RATIO * area(this.box) ? boxes[biggest] : this.box;
  }

  async estimate(src, w, h, box) {
    const t0 = performance.now();
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    let sw = (box[2] - box[0]) * BBOX_PADDING;
    let sh = (box[3] - box[1]) * BBOX_PADDING;
    const aspect = POSE_W / POSE_H;
    if (sw > sh * aspect) sh = sw / aspect;
    else sw = sh * aspect;
    const { ctx } = this.poseCanvas;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, POSE_W, POSE_H);
    drawCrop(ctx, src, w, h, cx - sw / 2, cy - sh / 2, sw, sh, POSE_W, POSE_H);
    const px = ctx.getImageData(0, 0, POSE_W, POSE_H).data;
    const n = POSE_W * POSE_H;
    const buf = this.poseBuf;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      buf[i] = (px[p] - MEAN[0]) / STD[0];
      buf[n + i] = (px[p + 1] - MEAN[1]) / STD[1];
      buf[2 * n + i] = (px[p + 2] - MEAN[2]) / STD[2];
    }
    const out = await this.pose.run({
      [this.pose.inputNames[0]]: new ort.Tensor('float32', buf, [1, 3, POSE_H, POSE_W]),
    });
    const sx = out.simcc_x;
    const sy = out.simcc_y;
    const k = sx.dims[1];
    const kps = new Float32Array(2 * k);
    const scores = new Float32Array(k);
    for (let i = 0; i < k; i++) {
      const [lx, vx] = argmaxRow(sx.data, i * sx.dims[2], sx.dims[2]);
      const [ly, vy] = argmaxRow(sy.data, i * sy.dims[2], sy.dims[2]);
      const score = (vx + vy) / 2;
      scores[i] = score;
      kps[2 * i] = ((score > 0 ? lx : -1) / SIMCC_SPLIT / POSE_W) * sw + cx - sw / 2;
      kps[2 * i + 1] = ((score > 0 ? ly : -1) / SIMCC_SPLIT / POSE_H) * sh + cy - sh / 2;
    }
    this.timing.pose = performance.now() - t0;
    return { kps, scores };
  }

  /** Find and follow the lifter in `src` (a canvas w x h). Returns { kps, scores } or null. */
  async process(src, w, h) {
    let box = this.box;
    this.timing.det = 0;
    if (!box || this.frame % DET_EVERY === 0) {
      const boxes = await this.detect(src, w, h);
      box = boxes.length ? this.pick(boxes) : this.box;
    }
    this.frame += 1;
    // Detector missed and nobody is tracked: try the whole frame (the lifter usually fills it);
    // the keypoint check below rejects it if there is nobody there.
    if (!box) box = [0, 0, w, h];
    const found = await this.estimate(src, w, h, box);
    const { kps, scores } = found;
    let good = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] <= MIN_KPT_SCORE) continue;
      good++;
      x0 = Math.min(x0, kps[2 * i]);
      y0 = Math.min(y0, kps[2 * i + 1]);
      x1 = Math.max(x1, kps[2 * i]);
      y1 = Math.max(y1, kps[2 * i + 1]);
    }
    if (good < MIN_GOOD_KPTS) {
      this.box = null;
      return null;
    }
    const px = (x1 - x0) * BOX_PAD;
    const py = (y1 - y0) * BOX_PAD;
    this.box = [Math.max(0, x0 - px), Math.max(0, y0 - py), Math.min(w, x1 + px), Math.min(h, y1 + py)];
    return found;
  }
}
