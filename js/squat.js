// Squat: thigh angle vs the floor, depth beep, spoken verdict per rep.
// Port of src/squat_coach/live.py and metrics.py (same thresholds as the Mac version).
import { JointFilter, TimedWindow, deg, fmtDeg, innerAngle, mean, percentile } from './common.js';
import { drawLegs } from './draw.js';

export const DEPTH_TOL = 3; // degrees of slack when judging depth
const TORSO_WARN = 50; // torso lean from vertical at the bottom
const MIN_REP_S = 0.6;
const UP_MAX = 65; // rep ends when thigh rises above min(UP_MAX, baseline - 12)
const DOWN_DELTA = 20; // rep starts this far below the "up" threshold
const BASELINE_DEFAULT = 80;
const STAND_WINDOW_S = 5; // "standing" is learnt from the last seconds outside a rep...
const STAND_MIN_S = 0.6; // ...once there is this much of it
const FAST_DESCENT_S = 1.0;
const INCONSISTENT_RANGE = 8;

// COCO-17 keypoint indices (left, right) = subject's left / right
// lShoulder / rShoulder are both shoulders whatever the side: only used to notice the person is facing the camera.
const KP = { shoulder: [5, 6], hip: [11, 12], knee: [13, 14], ankle: [15, 16], lShoulder: [5, 5], rShoulder: [6, 6] };
const FACING_MAX = 0.6; // shoulder width / torso length: ~0.1 side-on, ~0.75 facing the camera

function viewHint({ shoulder, hip, lShoulder, rShoulder }) {
  const torso = Math.hypot(shoulder[0] - hip[0], shoulder[1] - hip[1]);
  const facing = torso > 1 ? Math.abs(lShoulder[0] - rShoulder[0]) / torso : 0;
  return facing > FACING_MAX ? 'Estás de frente: ponte de lado o elige la vista De frente' : null;
}

export function positionLabel(thigh) {
  if (thigh > 15) return 'sobre paralelo';
  if (thigh > DEPTH_TOL) return 'justo sobre paralelo';
  if (thigh >= -DEPTH_TOL) return 'en paralelo';
  return 'bajo paralelo';
}

export function depthVerdict(bottom, target) {
  if (bottom <= target + DEPTH_TOL) return 'objetivo';
  if (bottom <= DEPTH_TOL) return 'casi';
  return 'corta';
}

/** Thigh angle vs horizontal (+90 standing, 0 parallel, negative = hip below knee), knee and torso angles. */
export function angles({ shoulder, hip, knee, ankle }) {
  const thigh = deg(Math.atan2(knee[1] - hip[1], Math.abs(knee[0] - hip[0])));
  const torso = deg(Math.atan2(Math.abs(shoulder[0] - hip[0]), hip[1] - shoulder[1]));
  return { thigh, knee: innerAngle(hip, knee, ankle), torso };
}

/** Real-time rep detection with hysteresis on the thigh angle. */
export class RepCounter {
  constructor(target) {
    this.target = target;
    this.standing = new TimedWindow(STAND_WINDOW_S); // thigh angles while not squatting
    this.reps = [];
    this.inRep = false;
    this.depthHit = false;
    this.minThigh = Infinity;
    this.lastStandT = 0;
    this.startT = 0;
    this.bottom = null;
  }

  /** Deepest angle of the rep in progress (for the gauge). */
  get peak() {
    return this.minThigh;
  }

  thresholds() {
    const base = this.standing.covers(STAND_MIN_S) ? percentile(this.standing.values(), 90) : BASELINE_DEFAULT;
    const up = Math.min(UP_MAX, base - 12);
    return [up, up - DOWN_DELTA];
  }

  /** Returns events: { kind: 'depth' } when target depth is reached, { kind: 'rep', rep } when a rep ends. */
  update(t, xy) {
    const { thigh, knee, torso } = angles(xy);
    const [up, down] = this.thresholds();
    const events = [];
    if (!this.inRep) {
      this.standing.push(t, thigh);
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
  } else if (verdict === 'casi') {
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

/** Coaching notes for the summary screen (port of metrics.feedback). */
export function sessionNotes(reps, target) {
  if (!reps.length) {
    return [
      'No conté ninguna repetición. Revisa que la cámara te vea de lado, con cadera, rodilla y tobillo en cuadro.',
    ];
  }
  const notes = [];
  const bottoms = reps.map((r) => r.bottomThigh);
  const avg = mean(bottoms);
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
        `${fmtDeg(avg)} (${positionLabel(avg)}); te faltan ~${Math.round(avg - target)}° para ${fmtDeg(target)}. ` +
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

const VERDICT_LABEL = { objetivo: 'Objetivo', casi: 'Casi', corta: 'Corta' };

/** Everything the app needs to coach a squat. */
export const squat = {
  id: 'squat',
  group: 'squat',
  view: 'side',
  name: 'Sentadilla',
  intro: 'Te mira de lado, mide tu muslo contra el paralelo y te dice en voz alta cómo fue cada repetición.',
  target: {
    default: -10,
    min: -25,
    max: 10,
    label: 'Profundidad objetivo',
    hint: '0° = muslo paralelo al suelo. Negativo = cadera por debajo de la rodilla.',
  },
  tol: DEPTH_TOL,
  metric: 'ángulo del muslo',
  fmt: fmtDeg,
  gauge: { top: 90, bottom: -30, ref: 0 }, // dot goes down as you go deeper; blue mark = parallel
  tips: [
    'iPhone fijo (trípode o apoyado), <b>de lado a ti</b>, a la altura de la cadera, a 2–3 m.',
    'Cuerpo completo en cuadro: cadera, rodilla y tobillo siempre visibles.',
    'Si el disco tapa la cadera, gira el teléfono 20–30° hacia tu frente.',
  ],
  ready: 'Listo. Ponte de lado, con el cuerpo completo en cuadro.',
  lost: 'Ponte de lado, cuerpo completo en cuadro',
  hit: '¡PROFUNDIDAD! Sube',
  makeFilter: () =>
    new JointFilter({ kp: KP, sideJoints: ['hip', 'knee', 'ankle'], lengthPairs: [['hip', 'knee']], lengthTol: 0.4 }),
  makeCounter: (target) => new RepCounter(target),
  value: (xy) => angles(xy).thigh,
  positionLabel,
  draw: drawLegs,
  viewHint,
  repFeedback,
  verdict: (rep, target) => depthVerdict(rep.bottomThigh, target),
  verdictLabel: VERDICT_LABEL,
  repValue: (rep) => rep.bottomThigh,
  columns: ['Rep', 'Muslo', 'Resultado', 'Bajada', 'Subida', 'Torso'],
  row: (rep) => [
    rep.number,
    fmtDeg(rep.bottomThigh),
    null, // verdict cell, filled by the app
    `${rep.descentS.toFixed(1)} s`,
    `${rep.ascentS.toFixed(1)} s`,
    `${Math.round(rep.bottomTorso)}°`,
  ],
  stats(reps, target) {
    const v = reps.map((r) => r.bottomThigh);
    const hit = reps.filter((r) => depthVerdict(r.bottomThigh, target) === 'objetivo').length;
    return [
      ['A profundidad', `${hit} / ${reps.length}`],
      ['Más profunda', fmtDeg(Math.min(...v))],
      ['Promedio', fmtDeg(mean(v))],
    ];
  },
  shareLine: (rep, target) =>
    `Rep ${rep.number}: muslo ${fmtDeg(rep.bottomThigh)} (${VERDICT_LABEL[depthVerdict(rep.bottomThigh, target)]})`,
  historyLine(reps, target) {
    const hit = reps.filter((r) => depthVerdict(r.bottomThigh, target) === 'objetivo').length;
    return `${reps.length} reps · ${hit} a profundidad · mejor ${fmtDeg(Math.min(...reps.map((r) => r.bottomThigh)))}`;
  },
  notes: sessionNotes,
  setPhrase(reps, target) {
    const ok = reps.filter((r) => depthVerdict(r.bottomThigh, target) === 'objetivo').length;
    return {
      spoken: `Serie terminada. ${reps.length} repeticiones, ${ok} a profundidad.`,
      text: `Serie: ${reps.length} reps · ${ok} a profundidad`,
    };
  },
};
