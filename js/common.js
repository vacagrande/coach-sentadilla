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

// Smoothing is time based, so a phone that analyses 10 frames/s does not lag 3x more than one doing 30:
// weight of a new sample = 1 - exp(-dt / SMOOTH_TAU_S), which is 0.55 at 30 analyses per second.
const SMOOTH_TAU_S = 0.0417;
const DEFAULT_DT_S = 1 / 30;
const HOLD_S = 0.35; // keep the last skeleton this long when the pose drops out
const SIDE_HYSTERESIS = 0.1;
const LENGTH_HISTORY = 90;
const LENGTH_MIN_SAMPLES = 15;

/**
 * Online smoothing and sanity check of the joints one exercise needs, on the more visible body side.
 * cfg = { kp: {name: [leftIdx, rightIdx]}, sideJoints: [...], lengthPairs: [[a, b], ...], lengthTol,
 *         required?: [names], minScore?: number }
 * A frame is dropped when any limb segment suddenly changes length (a joint was put in the wrong place),
 * or when a `required` joint scores under `minScore` (the model is guessing where it is).
 */
export class JointFilter {
  constructor(cfg) {
    this.cfg = cfg;
    this.joints = Object.keys(cfg.kp);
    this.xy = null;
    this.side = 1;
    this.lengths = cfg.lengthPairs.map(() => []);
    this.seenT = null; // time of the last accepted sample
    this.clock = 0; // fallback clock when the caller passes no time
  }

  miss(t) {
    if (this.seenT === null || t - this.seenT > HOLD_S) this.xy = null;
    return this.xy;
  }

  /**
   * found = { kps: Float32Array(17*2), scores: Float32Array(17) } or null; t = time of the frame in seconds.
   * Returns {joint: [x, y]} or null.
   */
  update(found, t) {
    if (t === undefined) t = this.clock += DEFAULT_DT_S;
    if (!found) return this.miss(t);
    const { kps, scores } = found;
    const { kp, sideJoints, lengthPairs, lengthTol, required, minScore = 0 } = this.cfg;
    const conf = [0, 1].map((side) => sideJoints.reduce((acc, n) => acc + scores[kp[n][side]], 0) / sideJoints.length);
    if (conf[1 - this.side] > conf[this.side] + SIDE_HYSTERESIS) this.side = 1 - this.side;
    if (required?.some((n) => scores[kp[n][this.side]] < minScore)) return this.miss(t);
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
    if (bad) return this.miss(t); // implausible limb length: the model put a joint in the wrong place
    lens.forEach((len, i) => {
      this.lengths[i].push(len);
      if (this.lengths[i].length > LENGTH_HISTORY) this.lengths[i].shift();
    });
    if (!this.xy) {
      this.xy = pts;
    } else {
      const dt = Math.max(1 / 120, Math.min(0.5, t - this.seenT));
      const a = 1 - Math.exp(-dt / SMOOTH_TAU_S);
      for (const name of this.joints) {
        const [x, y] = pts[name];
        const [px, py] = this.xy[name];
        this.xy[name] = [a * x + (1 - a) * px, a * y + (1 - a) * py];
      }
    }
    this.seenT = t;
    return this.xy;
  }
}

/**
 * The values pushed during the last `seconds` of observation. Used for "what does standing look like":
 * counting seconds instead of samples keeps it the same on a phone doing 8 analyses per second and on
 * one doing 60. Only time while values are being pushed counts (pauses, like a rep in progress, do not).
 */
export class TimedWindow {
  constructor(seconds) {
    this.seconds = seconds;
    this.items = []; // [clock, value]
    this.clock = 0;
    this.lastT = null;
  }

  push(t, value) {
    const dt = this.lastT === null ? DEFAULT_DT_S : Math.max(0, Math.min(0.25, t - this.lastT));
    this.lastT = t;
    this.clock += dt;
    this.items.push([this.clock, value]);
    while (this.items.length > 1 && this.clock - this.items[0][0] > this.seconds) this.items.shift();
    if (this.items.length > 900) this.items.shift();
  }

  /** True once it holds at least `seconds` of data (and a handful of samples). */
  covers(seconds) {
    return this.items.length >= 6 && this.clock - this.items[0][0] >= seconds;
  }

  values() {
    return this.items.map((item) => item[1]);
  }
}

const ONE_KNEE_SLACK = 15; // % a single knee may fall behind the pair before it alone sets the score

/**
 * Knee score for the front view, from how far each knee sits inside its own ankle (fractions of the
 * stance width; negative = outside). 100 = knees over the feet, more = further out, less = caving in.
 * It is the knee separation as % of the foot separation, unless one knee alone is clearly worse.
 */
export function kneeScore(inL, inR) {
  const pair = (1 - inL - inR) * 100;
  const worstKnee = (1 - 2 * Math.max(inL, inR)) * 100 + ONE_KNEE_SLACK;
  return Math.min(pair, worstKnee);
}

/** "en la rep 3" / "en las reps 2, 4 y 5". */
export function inReps(nums) {
  if (nums.length === 1) return `en la rep ${nums[0]}`;
  return `en las reps ${nums.slice(0, -1).join(', ')} y ${nums[nums.length - 1]}`;
}
