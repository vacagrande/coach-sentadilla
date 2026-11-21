// Helpers shared by every exercise: angles, formatting, statistics and joint smoothing.

export const deg = (rad) => (rad * 180) / Math.PI;

/** Signed angle: +12°, −10°, 0°. */
export function fmtDeg(value) {
  const r = Math.round(value);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`;
}

/** Unsigned angle: 45°. */
export const fmtAngle = (value) => `${Math.round(value)}°`;

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  const idx = ((s.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/** Inner angle at b (degrees) between b→a and b→c. */
export function innerAngle(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
  return deg(Math.acos(Math.max(-1, Math.min(1, cos))));
}

const EMA_ALPHA = 0.55; // 1 = no smoothing; lower = smoother but laggier
const SIDE_HYSTERESIS = 0.1;
const MAX_MISSED = 10; // frames we keep the last skeleton when the pose drops out
const LENGTH_HISTORY = 90;
const LENGTH_MIN_SAMPLES = 15;

/**
 * Online smoothing and sanity check of the joints one exercise needs, on the more visible body side.
 * cfg = { kp: {name: [leftIdx, rightIdx]}, sideJoints: [...], lengthPairs: [[a, b], ...], lengthTol }
 * A frame is dropped when any limb segment suddenly changes length (a joint was put in the wrong place).
 */
export class JointFilter {
  constructor(cfg) {
    this.cfg = cfg;
    this.joints = Object.keys(cfg.kp);
    this.xy = null;
    this.side = 1;
    this.lengths = cfg.lengthPairs.map(() => []);
    this.missed = 0;
  }

  miss() {
    this.missed += 1;
    if (this.missed > MAX_MISSED) this.xy = null;
    return this.xy;
  }

  /** found = { kps: Float32Array(17*2), scores: Float32Array(17) } or null. Returns {joint: [x, y]} or null. */
  update(found) {
    if (!found) return this.miss();
    const { kps, scores } = found;
    const { kp, sideJoints, lengthPairs, lengthTol } = this.cfg;
    const conf = [0, 1].map((side) => sideJoints.reduce((acc, n) => acc + scores[kp[n][side]], 0) / sideJoints.length);
    if (conf[1 - this.side] > conf[this.side] + SIDE_HYSTERESIS) this.side = 1 - this.side;
    const pts = {};
    for (const name of this.joints) {
      const i = kp[name][this.side];
      pts[name] = [kps[2 * i], kps[2 * i + 1]];
    }
    const lens = lengthPairs.map(([a, b]) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]));
    const bad = lens.some(
      (len, i) =>
        this.lengths[i].length >= LENGTH_MIN_SAMPLES && Math.abs(len / median(this.lengths[i]) - 1) > lengthTol,
    );
    if (bad) return this.miss(); // implausible limb length: the model put a joint in the wrong place
    lens.forEach((len, i) => {
      this.lengths[i].push(len);
      if (this.lengths[i].length > LENGTH_HISTORY) this.lengths[i].shift();
    });
    this.missed = 0;
    if (!this.xy) {
      this.xy = pts;
    } else {
      for (const name of this.joints) {
        const [x, y] = pts[name];
        const [px, py] = this.xy[name];
        this.xy[name] = [EMA_ALPHA * x + (1 - EMA_ALPHA) * px, EMA_ALPHA * y + (1 - EMA_ALPHA) * py];
      }
    }
    return this.xy;
  }
}

/** "en la rep 3" / "en las reps 2, 4 y 5". */
export function inReps(nums) {
  if (nums.length === 1) return `en la rep ${nums[0]}`;
  return `en las reps ${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}`;
}
