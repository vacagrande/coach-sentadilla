// Squat seen from the FRONT: knees caving in, hips shifting to one side, shoulders tilting.
// Depth is only a rough estimate from this view (the thigh points at the camera): the side view measures it.
import { JointFilter, TimedWindow, deg, fmtDeg, inReps, kneeScore, mean, percentile } from './common.js';
import { drawFront } from './draw.js';

// Both sides are tracked at once, so every joint has the same index for "either side".
const KP = {
  lShoulder: [5, 5],
  rShoulder: [6, 6],
  lHip: [11, 11],
  rHip: [12, 12],
  lKnee: [13, 13],
  rKnee: [14, 14],
  lAnkle: [15, 15],
  rAnkle: [16, 16],
};

export const KNEE_TOL = 5; // % of slack under the target
const CLOSE_GAP = 12; // up to this many % further under = "justo"
const UP_DEG = 65; // estimated thigh angle: above = standing, the rep ends
// Below = squatting, the rep starts. Higher than the side view's 45: from the front the estimate reads
// 10-20 degrees shallower than the real angle, so 50 here is roughly a real 40.
const DOWN_DEG = 50;
const UPRIGHT_DEG = 75; // clearly upright: the standing posture (hip position, shoulder line) is learnt here
const POSTURE_TAU_S = 0.5; // how quickly that standing posture follows changes
const STAND_WINDOW_S = 6; // standing thigh length is learnt from the last seconds outside a rep...
const STAND_MIN_S = 0.4; // ...once there is this much of it
const BOTTOM_BAND_DEG = 15; // knees are judged in the deepest part of each rep: within this of its lowest point
const WARN_BELOW_DEG = 40; // the live warning only fires once clearly into the squat
const WARN_SAMPLES = 2; // ...and after this many analyses in a row
const KNEE_EXCESS = 0.03; // a knee this far past its allowance (fraction of stance width) counts as "in"
const SHIFT_WARN = 0.1; // hips moved sideways this fraction of the stance width (about 6-7 cm for real)
const TILT_WARN = 6; // degrees the shoulder line tilted compared with standing
const OFF_CENTER = 0.2; // person this far from the middle of the frame: perspective fakes a hip shift, so skip it
const FACING_MIN = 0.4; // shoulder width / torso length below this = not facing the camera
const MIN_REP_S = 0.6;

const fmtPct = (v) => `${Math.round(v)}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Everything measured on one frame. Distances across the body are fractions of the stance (ankle) width. */
export function frontMetrics(xy) {
  const { lShoulder, rShoulder, lHip, rHip, lKnee, rKnee, lAnkle, rAnkle } = xy;
  const stance = Math.abs(lAnkle[0] - rAnkle[0]) || 1;
  const mid = (lAnkle[0] + rAnkle[0]) / 2;
  // how far each knee sits inside its own ankle (negative = outside, which is what you want)
  const inL = ((lKnee[0] - lAnkle[0]) * Math.sign(mid - lAnkle[0])) / stance;
  const inR = ((rKnee[0] - rAnkle[0]) * Math.sign(mid - rAnkle[0])) / stance;
  const hipMid = [(lHip[0] + rHip[0]) / 2, (lHip[1] + rHip[1]) / 2];
  const shoulderMid = [(lShoulder[0] + rShoulder[0]) / 2, (lShoulder[1] + rShoulder[1]) / 2];
  const torso = Math.hypot(shoulderMid[0] - hipMid[0], shoulderMid[1] - hipMid[1]);
  const facing = Math.sign(lHip[0] - rHip[0]) || 1; // +1 = facing the camera (their left is on the image's right)
  return {
    ratio: kneeScore(inL, inR), // 100 = knees over the feet, less = caving in (see kneeScore)
    inL,
    inR,
    drop: (lKnee[1] + rKnee[1]) / 2 - hipMid[1], // hips above knees in pixels: thigh length standing, ~0 at parallel
    shank:
      (Math.hypot(lKnee[0] - lAnkle[0], lKnee[1] - lAnkle[1]) + Math.hypot(rKnee[0] - rAnkle[0], rKnee[1] - rAnkle[1])) / 2,
    shift: ((hipMid[0] - mid) / stance) * facing, // + = hips toward the person's left
    tilt: deg(Math.atan2(lShoulder[1] - rShoulder[1], Math.abs(lShoulder[0] - rShoulder[0]))), // + = left shoulder lower
    facingRatio: torso > 1 ? Math.abs(lShoulder[0] - rShoulder[0]) / torso : 0,
    mid,
  };
}

export function kneeVerdict(kneeMin, target) {
  if (kneeMin >= target - KNEE_TOL) return 'objetivo';
  if (kneeMin >= target - KNEE_TOL - CLOSE_GAP) return 'casi';
  return 'corta';
}

function positionLabel(ratio, target) {
  if (ratio >= target + KNEE_TOL) return 'rodillas afuera';
  if (ratio >= target - KNEE_TOL) return 'sobre los pies';
  return 'hacia adentro';
}

/** Rep detection on the estimated depth, plus the knee / hip / shoulder readings of each rep. */
export class FrontCounter {
  constructor(target) {
    this.target = target;
    this.reps = [];
    this.inRep = false;
    this.armed = false; // reps only count after the person has been seen standing
    this.standing = new TimedWindow(STAND_WINDOW_S); // hips-above-knees heights while not squatting (pixels)
    this.base = { shift: 0, tilt: 0, t: null }; // posture while standing: the rep is compared against it
    this.lastStandT = 0;
    this.depth = 90; // latest estimated thigh angle (+90 standing, 0 parallel)
    this.minRatio = Infinity;
    this.lowRun = 0;
    this.warned = false;
    this.cur = null;
  }

  /** Lowest knee separation of the rep in progress (for the gauge). */
  get peak() {
    return this.minRatio;
  }

  /** Thigh length in pixels when standing: the shank is about as long, until real standing samples arrive. */
  thighRef(shank) {
    if (!this.standing.covers(STAND_MIN_S)) return shank;
    return Math.max(percentile(this.standing.values(), 90), shank * 0.7);
  }

  learnPosture(t, m) {
    const dt = this.base.t === null ? Infinity : clamp(t - this.base.t, 0, 0.5);
    const a = 1 - Math.exp(-dt / POSTURE_TAU_S);
    this.base.shift += (m.shift - this.base.shift) * a;
    this.base.tilt += (m.tilt - this.base.tilt) * a;
    this.base.t = t;
  }

  update(t, xy, frame) {
    const m = frontMetrics(xy);
    const depth = deg(Math.asin(clamp(m.drop / this.thighRef(m.shank), -1, 1)));
    this.depth = depth;
    const events = [];
    if (!this.inRep) {
      this.standing.push(t, m.drop);
      if (depth > UP_DEG) {
        this.lastStandT = t;
        this.armed = true;
        if (depth > UPRIGHT_DEG) this.learnPosture(t, m);
      } else if (this.armed && depth < DOWN_DEG) {
        this.inRep = true;
        this.minRatio = m.ratio;
        this.lowRun = 0;
        this.warned = false;
        this.cur = { startT: this.lastStandT, bottomT: t, minDepth: depth, samples: [] };
      }
      if (!this.inRep) return events;
    }
    const c = this.cur;
    if (depth < c.minDepth) {
      c.minDepth = depth;
      c.bottomT = t;
    }
    this.minRatio = Math.min(this.minRatio, m.ratio);
    c.samples.push({
      depth,
      ratio: m.ratio,
      inL: m.inL,
      inR: m.inR,
      shift: m.shift - this.base.shift,
      tilt: m.tilt - this.base.tilt,
      offCenter: frame?.w ? Math.abs(m.mid - frame.w / 2) / frame.w : 0,
    });
    if (depth < WARN_BELOW_DEG && m.ratio < this.target - KNEE_TOL) {
      this.lowRun += 1;
      if (!this.warned && this.lowRun >= WARN_SAMPLES) {
        this.warned = true;
        events.push({ kind: 'warn', text: '¡Rodillas afuera!' });
      }
    } else {
      this.lowRun = 0;
    }
    if (depth > UP_DEG) {
      this.inRep = false;
      this.lastStandT = t;
      if (t - c.startT >= MIN_REP_S) {
        const rep = this.buildRep(c, t);
        this.reps.push(rep);
        events.push({ kind: 'rep', rep });
      }
    }
    return events;
  }

  buildRep(c, endT) {
    const band = c.samples.filter((s) => s.depth <= c.minDepth + BOTTOM_BAND_DEG);
    const ratios = band.map((s) => s.ratio).sort((a, b) => a - b);
    const kneeMin = ratios[ratios.length >= 5 ? 1 : 0]; // second lowest: one odd frame does not decide
    const worst = band.reduce((a, b) => (Math.abs(b.ratio - kneeMin) < Math.abs(a.ratio - kneeMin) ? b : a));
    const allowed = (1 - this.target / 100) / 2; // how far inside its ankle each knee may sit
    const exL = worst.inL - allowed;
    const exR = worst.inR - allowed;
    let side = null;
    if (kneeMin < this.target - KNEE_TOL) {
      side = exL > KNEE_EXCESS && exR > KNEE_EXCESS ? 'both' : exL >= exR ? 'left' : 'right';
    }
    const centered = band.every((s) => s.offCenter <= OFF_CENTER);
    return {
      number: this.reps.length + 1,
      startT: c.startT,
      bottomT: c.bottomT,
      endT,
      kneeMin,
      side,
      shift: centered ? mean(band.map((s) => s.shift)) : null, // null = not judged (person off centre)
      tilt: mean(band.map((s) => s.tilt)),
      depthEst: c.minDepth,
      descentS: c.bottomT - c.startT,
      ascentS: endT - c.bottomT,
    };
  }
}

const SIDE_SPOKEN = { left: 'Se metió la izquierda.', right: 'Se metió la derecha.', both: 'Se metieron las dos.' };
const SIDE_TEXT = { left: 'se metió la izquierda', right: 'se metió la derecha', both: 'se metieron las dos' };
const SIDE_CELL = { left: 'izquierda', right: 'derecha', both: 'las dos' };
const shiftSide = (shift) => (shift > 0 ? 'izquierda' : 'derecha');
const lowShoulder = (tilt) => (tilt > 0 ? 'izquierdo' : 'derecho');

/** Spoken phrase, on-screen text and color for a finished rep: knees first, then at most one other correction. */
export function repFeedback(rep, target) {
  const verdict = kneeVerdict(rep.kneeMin, target);
  let spoken;
  let status;
  let color;
  if (verdict === 'objetivo') {
    [spoken, status, color] = [`${rep.number}. ¡Buena!`, 'rodillas bien', 'green'];
    if (rep.shift != null && Math.abs(rep.shift) > SHIFT_WARN) {
      spoken += ` Cadera al centro, se fue a la ${shiftSide(rep.shift)}.`;
      status += ` · cadera a la ${shiftSide(rep.shift)}`;
      color = 'orange';
    } else if (Math.abs(rep.tilt) > TILT_WARN) {
      spoken += ' Hombros parejos.';
      status += ` · hombro ${lowShoulder(rep.tilt)} más bajo`;
      color = 'orange';
    }
  } else if (verdict === 'casi') {
    [spoken, status, color] = [`${rep.number}. Abre más las rodillas.`, 'rodillas justas', 'orange'];
  } else {
    [spoken, status, color] = [`${rep.number}. Rodillas afuera. ${SIDE_SPOKEN[rep.side]}`, SIDE_TEXT[rep.side], 'red'];
  }
  return { spoken, text: `Rep ${rep.number}: rodillas ${fmtPct(rep.kneeMin)} · ${status}`, color };
}

export function sessionNotes(reps, target) {
  if (!reps.length) {
    return [
      'No conté ninguna repetición. Ponte de frente a la cámara, con hombros, cadera, rodillas y pies en cuadro, ' +
        'y párate derecho entre reps.',
    ];
  }
  const notes = [];
  const mins = reps.map((r) => r.kneeMin);
  const good = reps.filter((r) => kneeVerdict(r.kneeMin, target) === 'objetivo');
  if (good.length === reps.length) {
    notes.push(
      `Rodillas: en las ${reps.length} reps se mantuvieron sobre los pies o más afuera ` +
        `(lo mínimo fue ${fmtPct(Math.min(...mins))}; 100% = justo sobre los pies).`,
    );
  } else {
    notes.push(
      `Rodillas: se mantuvieron afuera en ${good.length} de ${reps.length} reps. En el fondo quedaron en promedio al ` +
        `${fmtPct(mean(mins))} (100% = justo sobre los pies; objetivo: ${fmtPct(target)} o más). ` +
        'Pista: «abre el piso» con los pies y empuja las rodillas hacia los dedos pequeños; suele pasar al subir.',
    );
    for (const [side, label] of [
      ['left', 'la rodilla izquierda'],
      ['right', 'la rodilla derecha'],
      ['both', 'las dos rodillas'],
    ]) {
      const nums = reps.filter((r) => r.side === side).map((r) => r.number);
      if (nums.length) notes.push(`Se ${side === 'both' ? 'metieron' : 'metió'} ${label} ${inReps(nums)}.`);
    }
  }
  const shifted = reps.filter((r) => r.shift != null && Math.abs(r.shift) > SHIFT_WARN);
  if (shifted.length) {
    const avg = mean(shifted.map((r) => r.shift));
    notes.push(
      `Cadera: ${inReps(shifted.map((r) => r.number))} se fue hacia tu ${shiftSide(avg)} ` +
        `(~${Math.round(Math.abs(avg) * 100)}% del ancho de tus pies). Reparte el peso parejo en los dos pies.`,
    );
  }
  const skipped = reps.filter((r) => r.shift == null).length;
  if (skipped) {
    notes.push(
      `No revisé el desplazamiento de la cadera en ${skipped} rep${skipped > 1 ? 's' : ''}: no estabas centrado ` +
        'en la imagen y la perspectiva lo falsea. Ponte al medio del cuadro.',
    );
  }
  const tilted = reps.filter((r) => Math.abs(r.tilt) > TILT_WARN);
  if (tilted.length) {
    notes.push(
      `Hombros: ${inReps(tilted.map((r) => r.number))} el hombro ${lowShoulder(mean(tilted.map((r) => r.tilt)))} ` +
        `bajó más de ${TILT_WARN}° respecto a cuando estás de pie. Mantén la barra pareja.`,
    );
  }
  notes.push(
    `Profundidad (estimación desde el frente): tu rep más profunda llegó a ~${fmtDeg(Math.min(...reps.map((r) => r.depthEst)))}. ` +
      'Desde el frente suele marcar 10–20° menos profundo de lo real; para medirla bien usa la vista De lado.',
  );
  notes.push('Límite: análisis 2D de frente; la cámara debe estar centrada, quieta y a la altura de la cadera.');
  return notes;
}

const VERDICT_LABEL = { objetivo: 'Bien', casi: 'Justo', corta: 'Se meten' };

function shiftCell(shift) {
  if (shift == null) return 'n/d';
  if (Math.abs(shift) < 0.05) return 'centrada';
  return `${Math.round(Math.abs(shift) * 100)}% ${shift > 0 ? 'izq.' : 'der.'}`;
}

/** Everything the app needs to coach a squat from the front. */
export const squatFront = {
  id: 'squat-front',
  group: 'squat',
  name: 'Sentadilla de frente',
  intro: 'Te mira de frente y revisa si las rodillas se meten, si la cadera se va a un lado y si los hombros se inclinan.',
  target: {
    default: 100,
    min: 80,
    max: 130,
    step: 5,
    label: 'Apertura mínima de rodillas',
    hint: 'Dónde quedan las rodillas respecto a los pies, en el fondo. 100% = sobre los pies; más = más afuera; menos = se meten.',
  },
  tol: KNEE_TOL,
  higherIsBetter: true,
  metric: 'rodillas vs pies',
  fmt: fmtPct,
  gauge: { top: 60, bottom: 150, ref: 100 }, // dot goes down as the knees open; blue mark = knees over feet
  tips: [
    'iPhone fijo, <b>de frente a ti</b>, a la altura de la cadera, a 2–3 m, y tú <b>al centro</b> de la imagen.',
    'Cuerpo completo en cuadro: hombros, cadera, rodillas y pies visibles.',
    'Esta vista revisa rodillas y simetría. La profundidad se mide mejor con la vista De lado.',
  ],
  ready: 'Listo. Ponte de frente, con el cuerpo completo en cuadro.',
  lost: 'Ponte de frente, cuerpo completo en cuadro',
  hit: '',
  makeFilter: () =>
    new JointFilter({
      kp: KP,
      sideJoints: ['lHip', 'rHip'],
      lengthPairs: [
        ['lAnkle', 'rAnkle'],
        ['lHip', 'rHip'],
      ],
      lengthTol: 0.5,
      required: ['lHip', 'rHip', 'lKnee', 'rKnee', 'lAnkle', 'rAnkle'],
      minScore: 0.3,
    }),
  makeCounter: (target) => new FrontCounter(target),
  // the knee reading only means something while squatting: standing, knees sit between hips and feet
  value: (xy, counter) => (counter && !counter.inRep ? null : frontMetrics(xy).ratio),
  idleLabel: 'de pie',
  positionLabel,
  draw: drawFront,
  viewHint: (xy) => (frontMetrics(xy).facingRatio < FACING_MIN ? 'Estás de lado: ponte de frente o elige la vista De lado' : null),
  repFeedback,
  verdict: (rep, target) => kneeVerdict(rep.kneeMin, target),
  verdictLabel: VERDICT_LABEL,
  repValue: (rep) => rep.kneeMin,
  columns: ['Rep', 'Rodillas', 'Resultado', 'Cuál', 'Cadera', 'Hombros', 'Prof. aprox.'],
  row: (rep) => [
    rep.number,
    fmtPct(rep.kneeMin),
    null, // verdict cell, filled by the app
    rep.side ? SIDE_CELL[rep.side] : '—',
    shiftCell(rep.shift),
    Math.abs(rep.tilt) > TILT_WARN ? `${Math.round(Math.abs(rep.tilt))}° ${rep.tilt > 0 ? 'izq.' : 'der.'}` : 'parejos',
    `~${fmtDeg(rep.depthEst)}`,
  ],
  stats(reps, target) {
    const v = reps.map((r) => r.kneeMin);
    const good = reps.filter((r) => kneeVerdict(r.kneeMin, target) === 'objetivo').length;
    return [
      ['Rodillas bien', `${good} / ${reps.length}`],
      ['Peor rep', fmtPct(Math.min(...v))],
      ['Promedio', fmtPct(mean(v))],
    ];
  },
  shareLine: (rep, target) =>
    `Rep ${rep.number}: rodillas ${fmtPct(rep.kneeMin)} (${VERDICT_LABEL[kneeVerdict(rep.kneeMin, target)]})`,
  historyLine(reps, target) {
    const good = reps.filter((r) => kneeVerdict(r.kneeMin, target) === 'objetivo').length;
    return `${reps.length} reps · ${good} con rodillas bien · peor ${fmtPct(Math.min(...reps.map((r) => r.kneeMin)))}`;
  },
  notes: sessionNotes,
  setPhrase(reps, target) {
    const ok = reps.filter((r) => kneeVerdict(r.kneeMin, target) === 'objetivo').length;
    return {
      spoken: `Serie terminada. ${reps.length} repeticiones, ${ok} con rodillas bien.`,
      text: `Serie: ${reps.length} reps · ${ok} con rodillas bien`,
    };
  },
};
