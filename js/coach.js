// Squat logic: joint smoothing, rep counting and coaching phrases.
// Port of src/squat_coach/live.py and metrics.py (same thresholds as the Mac version).

export const DEPTH_TOL = 3; // degrees of slack when judging depth
export const TORSO_WARN = 50; // torso lean from vertical at the bottom
const THIGH_LEN_TOL = 0.4; // drop frames whose thigh length jumps this much (joint misplaced)
const MIN_REP_S = 0.6;
const UP_MAX = 65; // rep ends when thigh rises above min(UP_MAX, baseline - 12)
const DOWN_DELTA = 20; // rep starts this far below the "up" threshold
const EMA_ALPHA = 0.55; // 1 = no smoothing
const SIDE_HYSTERESIS = 0.1;
const MAX_MISSED = 10; // frames we keep the last skeleton when the pose drops out
const BASELINE_DEFAULT = 80;
const FAST_DESCENT_S = 1.0;
const INCONSISTENT_RANGE = 8;

export const JOINTS = ['shoulder', 'hip', 'knee', 'ankle'];
// COCO-17 keypoint indices (left, right) = subject's left / right
const KP = { shoulder: [5, 6], hip: [11, 12], knee: [13, 14], ankle: [15, 16] };

const deg = (rad) => (rad * 180) / Math.PI;

export function fmtDeg(value) {
  const r = Math.round(value);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`;
}

export function positionLabel(thigh) {
  if (thigh > 15) return 'sobre paralelo';
  if (thigh > DEPTH_TOL) return 'justo sobre paralelo';
  if (thigh >= -DEPTH_TOL) return 'en paralelo';
  return 'bajo paralelo';
}

export function depthVerdict(bottom, target) {
  if (bottom <= target + DEPTH_TOL) return 'objetivo';
  if (bottom <= DEPTH_TOL) return 'paralelo';
  return 'corta';
}

export const VERDICT_TEXT = { objetivo: 'Objetivo', paralelo: 'Casi', corta: 'Corta' };

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  const idx = ((s.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Thigh angle vs horizontal (+90 standing, 0 parallel, negative = hip below knee), knee and torso angles. */
export function angles({ shoulder, hip, knee, ankle }) {
  const thigh = deg(Math.atan2(knee[1] - hip[1], Math.abs(knee[0] - hip[0])));
  const v1 = [hip[0] - knee[0], hip[1] - knee[1]];
  const v2 = [ankle[0] - knee[0], ankle[1] - knee[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
  const kneeAngle = deg(Math.acos(Math.max(-1, Math.min(1, cos))));
  const torso = deg(Math.atan2(Math.abs(shoulder[0] - hip[0]), hip[1] - shoulder[1]));
  return { thigh, knee: kneeAngle, torso };
}

/** Online smoothing and sanity check of the leg joints. */
export class LegFilter {
  constructor() {
    this.xy = null;
    this.side = 1;
    this.lengths = [];
    this.missed = 0;
  }

  miss() {
    this.missed += 1;
    if (this.missed > MAX_MISSED) this.xy = null;
    return this.xy;
  }

  /** found = { kps: Float32Array(17*2), scores: Float32Array(17) } or null. */
  update(found) {
    if (!found) return this.miss();
    const { kps, scores } = found;
    const conf = [0, 1].map((side) => (scores[KP.hip[side]] + scores[KP.knee[side]] + scores[KP.ankle[side]]) / 3);
    if (conf[1 - this.side] > conf[this.side] + SIDE_HYSTERESIS) this.side = 1 - this.side;
    const pts = {};
    for (const name of JOINTS) {
      const i = KP[name][this.side];
      pts[name] = [kps[2 * i], kps[2 * i + 1]];
    }
    const thighLen = Math.hypot(pts.hip[0] - pts.knee[0], pts.hip[1] - pts.knee[1]);
    if (this.lengths.length >= 15 && Math.abs(thighLen / median(this.lengths) - 1) > THIGH_LEN_TOL) {
      return this.miss(); // implausible leg: the model put a joint in the wrong place
    }
    this.lengths.push(thighLen);
    if (this.lengths.length > 90) this.lengths.shift();
    this.missed = 0;
    if (!this.xy) {
      this.xy = pts;
    } else {
      for (const name of JOINTS) {
        const [x, y] = pts[name];
        const [px, py] = this.xy[name];
        this.xy[name] = [EMA_ALPHA * x + (1 - EMA_ALPHA) * px, EMA_ALPHA * y + (1 - EMA_ALPHA) * py];
      }
    }
    return this.xy;
  }
}

/** Real-time rep detection with hysteresis on the thigh angle. */
export class RepCounter {
  constructor(target) {
    this.target = target;
    this.standing = [];
    this.reps = [];
    this.inRep = false;
    this.depthHit = false;
    this.minThigh = Infinity;
    this.lastStandT = 0;
    this.startT = 0;
    this.bottom = null;
  }

  thresholds() {
    const base = this.standing.length >= 20 ? percentile(this.standing, 90) : BASELINE_DEFAULT;
    const up = Math.min(UP_MAX, base - 12);
    return [up, up - DOWN_DELTA];
  }

  /** Returns events: { kind: 'depth' } when target depth is reached, { kind: 'rep', rep } when a rep ends. */
  update(t, thigh, knee, torso) {
    const [up, down] = this.thresholds();
    const events = [];
    if (!this.inRep) {
      this.standing.push(thigh);
      if (this.standing.length > 150) this.standing.shift();
      if (thigh > up) {
        this.lastStandT = t;
      } else if (thigh < down) {
        this.inRep = true;
        this.depthHit = false;
        this.minThigh = thigh;
        this.startT = this.lastStandT;
        this.bottom = { t, knee, torso };
      }
      return events;
    }
    if (thigh < this.minThigh) {
      this.minThigh = thigh;
      this.bottom = { t, knee, torso };
    }
    if (!this.depthHit && this.minThigh <= this.target + DEPTH_TOL) {
      this.depthHit = true;
      events.push({ kind: 'depth' });
    }
    if (thigh > up) {
      this.inRep = false;
      this.lastStandT = t;
      if (t - this.startT >= MIN_REP_S) {
        const rep = {
          number: this.reps.length + 1,
          startT: this.startT,
          bottomT: this.bottom.t,
          endT: t,
          bottomThigh: this.minThigh,
          bottomKnee: this.bottom.knee,
          bottomTorso: this.bottom.torso,
        };
        rep.descentS = rep.bottomT - rep.startT;
        rep.ascentS = rep.endT - rep.bottomT;
        this.reps.push(rep);
        events.push({ kind: 'rep', rep });
      }
    }
    return events;
  }
}

/** Spoken phrase, on-screen text and color for a finished rep. */
export function repFeedback(rep, target) {
  const verdict = depthVerdict(rep.bottomThigh, target);
  const gap = Math.max(0, Math.round(rep.bottomThigh - target));
  let spoken;
  let status;
  let color;
  if (verdict === 'objetivo') {
    [spoken, status, color] = [`${rep.number}. ¡Buena!`, 'profundidad objetivo', 'green'];
  } else if (verdict === 'paralelo') {
    [spoken, status, color] = [`${rep.number}. Casi, faltaron ${gap} grados.`, `casi · faltaron ${gap}°`, 'orange'];
  } else {
    [spoken, status, color] = [`${rep.number}. Más abajo, faltaron ${gap} grados.`, `faltaron ${gap}°`, 'red'];
  }
  if (rep.bottomTorso > TORSO_WARN) {
    spoken += ' Pecho arriba.';
    status += ' · pecho arriba';
  }
  return { spoken, text: `Rep ${rep.number}: muslo ${fmtDeg(rep.bottomThigh)} · ${status}`, color };
}

export function setSummaryPhrase(reps, target) {
  const ok = reps.filter((r) => depthVerdict(r.bottomThigh, target) === 'objetivo').length;
  return {
    spoken: `Serie terminada. ${reps.length} repeticiones, ${ok} a profundidad.`,
    text: `Serie: ${reps.length} reps · ${ok} a profundidad`,
  };
}

/** Coaching notes for the summary screen (port of metrics.feedback). */
export function sessionNotes(reps, target) {
  if (!reps.length) {
    return [
      'No conté ninguna repetición. Revisa que la cámara te vea de lado, con cadera, rodilla y tobillo en cuadro.',
    ];
  }
  const notes = [];
  const bottoms = reps.map((r) => r.bottomThigh);
  const mean = bottoms.reduce((a, b) => a + b, 0) / bottoms.length;
  const best = reps[bottoms.indexOf(Math.min(...bottoms))];
  const worst = reps[bottoms.indexOf(Math.max(...bottoms))];
  const hit = reps.filter((r) => depthVerdict(r.bottomThigh, target) === 'objetivo');
  if (hit.length === reps.length) {
    notes.push(
      `Profundidad: las ${reps.length} reps llegaron al objetivo (${fmtDeg(target)}). ` +
        `La más profunda fue la rep ${best.number} (${fmtDeg(best.bottomThigh)}).`,
    );
  } else {
    notes.push(
      `Profundidad: llegaste al objetivo en ${hit.length} de ${reps.length} reps. En promedio tu muslo quedó en ` +
        `${fmtDeg(mean)} (${positionLabel(mean)}); te faltan ~${Math.round(mean - target)}° para ${fmtDeg(target)}. ` +
        'Pista: piensa en «sentarte entre los talones», empuja las rodillas hacia afuera y baja más lento.',
    );
    if (worst.number !== best.number) {
      notes.push(
        `Tu rep más corta fue la ${worst.number} (${fmtDeg(worst.bottomThigh)}) y la más profunda ` +
          `la ${best.number} (${fmtDeg(best.bottomThigh)}).`,
      );
    }
  }
  const range = Math.max(...bottoms) - Math.min(...bottoms);
  if (reps.length > 1 && range > INCONSISTENT_RANGE) {
    notes.push(
      `Consistencia: la profundidad varió ${Math.round(range)}° entre reps. ` +
        'Busca la misma profundidad en cada una (un cajón o banco bajo como referencia ayuda).',
    );
  }
  const leaning = reps.filter((r) => r.bottomTorso > TORSO_WARN).map((r) => r.number);
  if (leaning.length) {
    notes.push(
      `Torso: en las reps ${leaning.join(', ')} el torso se inclinó más de ${TORSO_WARN}° en el fondo. ` +
        'Pecho arriba, abdomen firme; puede ser movilidad de tobillo o cadera.',
    );
  }
  const fast = reps.filter((r) => r.descentS < FAST_DESCENT_S).map((r) => r.number);
  if (fast.length) {
    notes.push(
      `Tempo: bajaste en menos de ${FAST_DESCENT_S} s en las reps ${fast.join(', ')}. ` +
        'Controla la bajada (2–3 s) para tener más control y profundidad.',
    );
  }
  notes.push('Límite: análisis 2D con una sola cámara; ángulos aproximados (±5°). La cámara debe estar de lado.');
  return notes;
}
