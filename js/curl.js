// Bicep curl: elbow angle (shoulder-elbow-wrist), full range at the top and bottom, elbow kept still,
// no torso swing, controlled lowering. Seen from the side; follows the arm closest to the camera.
import { JointFilter, deg, fmtAngle, inReps, innerAngle, mean } from './common.js';
import { drawArm } from './draw.js';

export const CURL_TOL = 5; // degrees of slack at the top
const START_BELOW = 110; // a rep starts when the elbow closes past this...
const END_ABOVE = 130; // ...and ends when it opens back past this (low, so half-extended reps still count)
const EXTENDED_OK = 155; // full extension at the bottom
const CLOSE_GAP = 20; // within this many degrees of the target = "casi"
const DRIFT_WARN = 30; // upper arm vs torso line: elbow travelled forward
const SWING_WARN = 15; // torso lean change during the rep: body swing
// Lowering faster than this = dropping the weight. Measured from the top until the elbow passes END_ABOVE,
// so 0.8 s here is a full lowering of about 1.2 s.
const FAST_LOWER_S = 0.8;
const MIN_REP_S = 0.6;
const MIN_PLAUSIBLE = 20; // an elbow can't close more than this: smaller = a misplaced wrist, ignore the frame

// lShoulder / rShoulder are both shoulders whatever the side: only used to notice the person is facing the camera.
const KP = { shoulder: [5, 6], elbow: [7, 8], wrist: [9, 10], hip: [11, 12], lShoulder: [5, 5], rShoulder: [6, 6] };
const FACING_MAX = 0.6; // shoulder width / torso length: ~0.1 side-on, ~0.75 facing the camera

function viewHint({ shoulder, hip, lShoulder, rShoulder }) {
  const torso = Math.hypot(shoulder[0] - hip[0], shoulder[1] - hip[1]);
  const facing = torso > 1 ? Math.abs(lShoulder[0] - rShoulder[0]) / torso : 0;
  return facing > FACING_MAX ? 'Estás de frente: ponte de lado o elige la vista De frente' : null;
}

/** elbow = inner angle (180 straight, ~40 fully curled); drift = upper arm vs torso; torso = signed lean. */
export function curlAngles({ shoulder, elbow, wrist, hip }) {
  return {
    elbow: innerAngle(shoulder, elbow, wrist),
    drift: innerAngle(hip, shoulder, elbow),
    torso: deg(Math.atan2(shoulder[0] - hip[0], hip[1] - shoulder[1])),
  };
}

export function positionLabel(elbow, target = 50) {
  if (elbow >= EXTENDED_OK) return 'brazo estirado';
  if (elbow > 100) return 'a medio camino';
  if (elbow > target + CURL_TOL) return 'casi arriba';
  return 'arriba';
}

export function curlVerdict(top, target) {
  if (top <= target + CURL_TOL) return 'objetivo';
  if (top <= target + CLOSE_GAP) return 'casi';
  return 'corta';
}

/** Real-time rep detection with hysteresis on the elbow angle. */
export class CurlCounter {
  constructor(target) {
    this.target = target;
    this.reps = [];
    this.inRep = false;
    this.hit = false;
    this.minElbow = Infinity;
    this.lastOpenT = 0;
    this.preMax = 0; // most open elbow since the last rep: how far the arm was straightened
    this.armed = false; // reps only count after the arm has been seen open once (not mid-curl at start)
    this.cur = null;
  }

  /** Most closed elbow of the rep in progress (for the gauge). */
  get peak() {
    return this.minElbow;
  }

  update(t, xy) {
    const a = curlAngles(xy);
    const events = [];
    if (a.elbow < MIN_PLAUSIBLE) return events;
    if (!this.inRep) {
      this.preMax = Math.max(this.preMax, a.elbow);
      if (a.elbow > END_ABOVE) {
        this.lastOpenT = t;
        this.armed = true;
      }
      if (this.armed && a.elbow < START_BELOW) {
        this.inRep = true;
        this.hit = false;
        this.minElbow = a.elbow;
        this.cur = {
          startT: this.lastOpenT,
          topT: t,
          extension: this.preMax,
          torsoMin: a.torso,
          torsoMax: a.torso,
          drift: a.drift,
        };
      }
      return events;
    }
    const c = this.cur;
    if (a.elbow < this.minElbow) {
      this.minElbow = a.elbow;
      c.topT = t;
    }
    c.torsoMin = Math.min(c.torsoMin, a.torso);
    c.torsoMax = Math.max(c.torsoMax, a.torso);
    c.drift = Math.max(c.drift, a.drift);
    if (!this.hit && this.minElbow <= this.target + CURL_TOL) {
      this.hit = true;
      events.push({ kind: 'depth' });
    }
    if (a.elbow > END_ABOVE) {
      this.inRep = false;
      this.lastOpenT = t;
      this.preMax = a.elbow;
      if (t - c.startT >= MIN_REP_S) {
        const rep = {
          number: this.reps.length + 1,
          startT: c.startT,
          topT: c.topT,
          endT: t,
          topElbow: this.minElbow,
          extension: c.extension,
          swing: c.torsoMax - c.torsoMin,
          drift: c.drift,
          liftS: c.topT - c.startT,
          lowerS: t - c.topT,
        };
        this.reps.push(rep);
        events.push({ kind: 'rep', rep });
      }
    }
    return events;
  }
}

/** Technique problems of one rep, most important first: [spoken, short text]. */
function repFaults(rep) {
  const faults = [];
  if (rep.extension < EXTENDED_OK) faults.push(['Estira completo abajo.', 'estira abajo']);
  if (rep.swing > SWING_WARN) faults.push(['Sin balanceo.', 'sin balanceo']);
  if (rep.drift > DRIFT_WARN) faults.push(['Codo quieto.', 'codo quieto']);
  if (rep.lowerS < FAST_LOWER_S) faults.push(['Baja más lento.', 'baja lento']);
  return faults;
}

export function repFeedback(rep, target) {
  const verdict = curlVerdict(rep.topElbow, target);
  const gap = Math.max(0, Math.round(rep.topElbow - target));
  let spoken;
  let status;
  let color;
  if (verdict === 'objetivo') {
    [spoken, status, color] = [`${rep.number}. ¡Buena!`, 'arriba completo', 'green'];
  } else if (verdict === 'casi') {
    [spoken, status, color] = [`${rep.number}. Casi, sube ${gap} grados más.`, `casi · faltaron ${gap}°`, 'orange'];
  } else {
    [spoken, status, color] = [`${rep.number}. Sube más, faltaron ${gap} grados.`, `faltaron ${gap}°`, 'red'];
  }
  const [fault] = repFaults(rep); // one correction at a time: easier to act on mid-set
  if (fault) {
    spoken += ` ${fault[0]}`;
    status += ` · ${fault[1]}`;
    if (color === 'green') color = 'orange';
  }
  return { spoken, text: `Rep ${rep.number}: codo ${fmtAngle(rep.topElbow)} · ${status}`, color };
}

export function sessionNotes(reps, target) {
  if (!reps.length) {
    return [
      'No conté ninguna repetición. Ponte de lado a la cámara, con hombro, codo, muñeca y cadera en cuadro, ' +
        'y estira el brazo completo entre reps.',
    ];
  }
  const notes = [];
  const tops = reps.map((r) => r.topElbow);
  const hit = reps.filter((r) => curlVerdict(r.topElbow, target) === 'objetivo');
  if (hit.length === reps.length) {
    notes.push(`Rango arriba: las ${reps.length} reps llegaron arriba (codo ≤ ${fmtAngle(target + CURL_TOL)}).`);
  } else {
    const avg = mean(tops);
    notes.push(
      `Rango arriba: subiste completo en ${hit.length} de ${reps.length} reps. En promedio el codo cerró hasta ` +
        `${fmtAngle(avg)}; te faltan ~${Math.round(avg - target)}° para ${fmtAngle(target)}. ` +
        'Lleva la mano hacia el hombro sin mover el codo; si no llegas, baja el peso.',
    );
  }
  const bent = reps.filter((r) => r.extension < EXTENDED_OK);
  if (bent.length) {
    notes.push(
      `Rango abajo: ${inReps(bent.map((r) => r.number))} no estiraste el brazo completo ` +
        `(llegaste a ${fmtAngle(mean(bent.map((r) => r.extension)))}; busca ~${EXTENDED_OK}° o más). ` +
        'La parte de abajo también trabaja el bíceps.',
    );
  }
  const swing = reps.filter((r) => r.swing > SWING_WARN);
  if (swing.length) {
    notes.push(
      `Balanceo: ${inReps(swing.map((r) => r.number))} el torso se movió más de ${SWING_WARN}°. ` +
        'Abdomen firme, rodillas suaves; si necesitas impulso, el peso es demasiado.',
    );
  }
  const drift = reps.filter((r) => r.drift > DRIFT_WARN);
  if (drift.length) {
    notes.push(
      `Codo: ${inReps(drift.map((r) => r.number))} el codo se adelantó (más de ${DRIFT_WARN}°). ` +
        'Mantenlo pegado al costado: que solo se mueva el antebrazo.',
    );
  }
  const fast = reps.filter((r) => r.lowerS < FAST_LOWER_S);
  if (fast.length) {
    notes.push(
      `Tempo: bajaste en menos de ${FAST_LOWER_S} s ${inReps(fast.map((r) => r.number))}. ` +
        'Controla la bajada (2–3 s): es donde más se gana.',
    );
  }
  notes.push('Límite: análisis 2D con la cámara de lado; mide el brazo más cercano a la cámara. Ángulos ±5°.');
  return notes;
}

const VERDICT_LABEL = { objetivo: 'Completa', casi: 'Casi', corta: 'Corta' };

/** Everything the app needs to coach a bicep curl. */
export const curl = {
  id: 'curl',
  group: 'curl',
  view: 'side',
  name: 'Curl de bíceps',
  intro: 'Te mira de lado, mide el ángulo del codo y te avisa si subes completo, si estiras abajo y si te balanceas.',
  target: {
    default: 50,
    min: 30,
    max: 90,
    label: 'Ángulo del codo arriba',
    hint: 'Cuánto debe cerrarse el codo arriba. 180° = brazo estirado; 40–50° = curl completo.',
  },
  tol: CURL_TOL,
  metric: 'ángulo del codo',
  fmt: fmtAngle,
  gauge: { top: 180, bottom: 20, ref: 90 }, // dot goes down as you curl; blue mark = forearm horizontal
  tips: [
    'iPhone fijo, <b>de lado a ti</b>, a la altura del pecho, a 1.5–2.5 m.',
    'Hombro, codo, muñeca y cadera en cuadro. Mide el brazo más cercano a la cámara.',
    'Con mancuernas alternas, cuenta solo el brazo que da a la cámara.',
  ],
  ready: 'Listo. Ponte de lado, con el brazo a la vista.',
  lost: 'Ponte de lado, con hombro, codo y muñeca en cuadro',
  hit: '¡ARRIBA! Baja lento',
  makeFilter: () =>
    new JointFilter({
      kp: KP,
      sideJoints: ['shoulder', 'elbow', 'wrist'],
      lengthPairs: [
        ['shoulder', 'elbow'],
        ['elbow', 'wrist'],
      ],
      lengthTol: 0.4,
    }),
  makeCounter: (target) => new CurlCounter(target),
  value: (xy) => curlAngles(xy).elbow,
  positionLabel,
  draw: drawArm,
  viewHint,
  repFeedback,
  verdict: (rep, target) => curlVerdict(rep.topElbow, target),
  verdictLabel: VERDICT_LABEL,
  repValue: (rep) => rep.topElbow,
  columns: ['Rep', 'Codo arriba', 'Resultado', 'Estirado', 'Subida', 'Bajada'],
  row: (rep) => [
    rep.number,
    fmtAngle(rep.topElbow),
    null, // verdict cell, filled by the app
    fmtAngle(rep.extension),
    `${rep.liftS.toFixed(1)} s`,
    `${rep.lowerS.toFixed(1)} s`,
  ],
  stats(reps, target) {
    const v = reps.map((r) => r.topElbow);
    const hit = reps.filter((r) => curlVerdict(r.topElbow, target) === 'objetivo').length;
    return [
      ['Completas', `${hit} / ${reps.length}`],
      ['Mejor arriba', fmtAngle(Math.min(...v))],
      ['Promedio', fmtAngle(mean(v))],
    ];
  },
  shareLine: (rep, target) =>
    `Rep ${rep.number}: codo ${fmtAngle(rep.topElbow)} (${VERDICT_LABEL[curlVerdict(rep.topElbow, target)]})`,
  historyLine(reps, target) {
    const hit = reps.filter((r) => curlVerdict(r.topElbow, target) === 'objetivo').length;
    return `${reps.length} reps · ${hit} completas · mejor ${fmtAngle(Math.min(...reps.map((r) => r.topElbow)))}`;
  },
  notes: sessionNotes,
  setPhrase(reps, target) {
    const ok = reps.filter((r) => curlVerdict(r.topElbow, target) === 'objetivo').length;
    return {
      spoken: `Serie terminada. ${reps.length} repeticiones, ${ok} completas.`,
      text: `Serie: ${reps.length} reps · ${ok} completas`,
    };
  },
};
