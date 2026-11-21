// Bicep curl seen from the FRONT: elbows flaring out, one arm curling less than the other, leaning sideways.
// Each arm is followed on its own, so alternating curls are counted arm by arm.
// The elbow angle is only estimated here (the forearm swings toward the camera); the side view measures it.
import { JointFilter, TimedWindow, deg, fmtAngle, inReps, mean, percentile } from './common.js';
import { drawFrontArms } from './draw.js';

// Both sides are tracked at once, so every joint has the same index for "either side".
const KP = {
  lShoulder: [5, 5],
  rShoulder: [6, 6],
  lElbow: [7, 7],
  rElbow: [8, 8],
  lWrist: [9, 9],
  rWrist: [10, 10],
  lHip: [11, 11],
  rHip: [12, 12],
};
const ARMS = ['left', 'right'];
const ARM_JOINTS = { left: ['lShoulder', 'lElbow', 'lWrist'], right: ['rShoulder', 'rElbow', 'rWrist'] };
const other = (arm) => (arm === 'left' ? 'right' : 'left');

export const FLARE_TOL = 3; // degrees of slack over the target
const CLOSE_GAP = 6; // up to this many degrees further = "justo"
const START_BELOW = 110; // estimated elbow angle: a rep starts when the arm closes past this...
const END_ABOVE = 130; // ...and ends when it opens back past this
const REST_ABOVE = 150; // arm this straight = hanging: where the elbow rests is learnt here
const REST_TAU_S = 0.5;
const ARM_WINDOW_S = 6; // limb lengths are learnt from the last seconds
const FOREARM_TYPICAL = 0.78; // forearm / upper arm, until this person's arm has been seen hanging
const FOREARM_MIN = 0.72; // ...and never assume it shorter than this
const ELBOW_MIN_EST = 30; // the estimate bottoms out here (a hand above the shoulder would read lower)
// Upper arm looking this much shorter than when it hangs = the elbow moved toward the camera (forward).
// 0.85 is roughly 40 degrees forward once perspective is counted.
const DRIFT_RATIO = 0.85;
const PARTIAL_ABOVE = 85; // top estimate above this = the hand did not get clearly above the elbow
const ASYM_WARN = 20; // degrees between the two arms at the top
const LEAN_WARN = 8; // degrees the torso leaned sideways during the rep
const WARN_SAMPLES = 2;
const FACING_MIN = 0.4; // shoulder width / torso length below this = not facing the camera
const MIN_REP_S = 0.6;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Torso axis ("down" = shoulders toward hips), its sideways lean and how much the person faces the camera. */
function torsoOf(xy) {
  const sh = midpoint(xy.lShoulder, xy.rShoulder);
  const hip = midpoint(xy.lHip, xy.rHip);
  const len = Math.hypot(hip[0] - sh[0], hip[1] - sh[1]) || 1;
  return {
    sh,
    down: [(hip[0] - sh[0]) / len, (hip[1] - sh[1]) / len],
    lean: deg(Math.atan2(sh[0] - hip[0], hip[1] - sh[1])),
    facingRatio: len > 1 ? Math.abs(xy.lShoulder[0] - xy.rShoulder[0]) / len : 0,
  };
}

/** One arm relative to the torso: abd = upper arm opening away from the body, drop = forearm hanging length. */
export function armGeometry(xy, arm, torso = torsoOf(xy)) {
  const [s, e, w] = ARM_JOINTS[arm].map((n) => xy[n]);
  const [dx, dy] = torso.down;
  const out = Math.sign(s[0] - torso.sh[0]) || 1; // which way is "away from the body" for this arm
  const ux = e[0] - s[0];
  const uy = e[1] - s[1];
  return {
    abd: deg(Math.atan2((ux * dy - uy * dx) * out, ux * dx + uy * dy)),
    upper: Math.hypot(ux, uy),
    drop: (w[0] - e[0]) * dx + (w[1] - e[1]) * dy, // + = hand below the elbow, - = above
  };
}

/** One arm: estimated elbow angle, how far the elbow has opened from its resting place, and its own reps. */
class ArmTracker {
  constructor() {
    this.drops = new TimedWindow(ARM_WINDOW_S); // forearm hanging lengths while not curling (pixels)
    this.uppers = new TimedWindow(ARM_WINDOW_S);
    this.rest = { abd: null, t: null }; // where the upper arm hangs when the arm is straight
    this.armed = false; // reps only count after the arm has been seen straight
    this.inRep = false;
    this.elbow = 180;
    this.flare = 0;
    this.lastOpenT = 0;
    this.cur = null;
  }

  /** Forearm length in pixels: learnt from the arm hanging, with a floor from the upper arm. */
  forearmRef(upperRef) {
    if (!this.drops.covers(0.4)) return upperRef * FOREARM_TYPICAL;
    return Math.max(percentile(this.drops.values(), 90), upperRef * FOREARM_MIN);
  }

  /** Returns the finished rep of this arm ({ startT, topT, endT, top, flare, shortest }) or null. */
  update(t, g) {
    this.uppers.push(t, g.upper);
    const upperRef = percentile(this.uppers.values(), 90); // upper arm length when it hangs
    const shortening = g.upper / upperRef; // < 1 = the elbow came toward the camera
    // 180 = hand straight below the elbow, 90 = level with it, ~40 = up by the shoulder
    const estimate = 180 - deg(Math.acos(clamp(g.drop / this.forearmRef(upperRef), -1, 1)));
    const elbow = Math.max(ELBOW_MIN_EST, estimate);
    this.elbow = elbow;
    if (elbow > REST_ABOVE) {
      const dt = this.rest.t === null ? Infinity : clamp(t - this.rest.t, 0, 0.5);
      const a = 1 - Math.exp(-dt / REST_TAU_S);
      this.rest.abd = this.rest.abd === null ? g.abd : this.rest.abd + (g.abd - this.rest.abd) * a;
      this.rest.t = t;
    }
    this.flare = this.rest.abd === null ? 0 : Math.max(0, g.abd - this.rest.abd);
    if (!this.inRep) {
      this.drops.push(t, g.drop);
      if (elbow > END_ABOVE) {
        this.lastOpenT = t;
        this.armed = true;
      } else if (this.armed && elbow < START_BELOW) {
        this.inRep = true;
        this.cur = { startT: this.lastOpenT, topT: t, top: elbow, flare: this.flare, shortest: shortening };
      }
      return null;
    }
    const c = this.cur;
    if (elbow < c.top) {
      c.top = elbow;
      c.topT = t;
    }
    c.flare = Math.max(c.flare, this.flare);
    c.shortest = Math.min(c.shortest, shortening);
    if (elbow <= END_ABOVE) return null;
    this.inRep = false;
    this.lastOpenT = t;
    return t - c.startT >= MIN_REP_S ? { ...c, endT: t } : null;
  }
}

export function flareVerdict(flare, target) {
  if (flare <= target + FLARE_TOL) return 'objetivo';
  if (flare <= target + FLARE_TOL + CLOSE_GAP) return 'casi';
  return 'corta';
}

function positionLabel(flare, target) {
  if (flare <= target + FLARE_TOL) return 'pegados';
  if (flare <= target + FLARE_TOL + CLOSE_GAP) return 'algo abiertos';
  return 'abiertos';
}

/** Two arm trackers; curls done together become one rep, curls done in turns count one by one. */
export class CurlFrontCounter {
  constructor(target) {
    this.target = target;
    this.reps = [];
    this.arms = { left: new ArmTracker(), right: new ArmTracker() };
    this.pending = null; // an arm that finished while the other one, curling with it, is still coming down
    this.lean = { base: null, t: null, max: 0 };
    this.highRun = 0;
    this.warned = false;
  }

  get inRep() {
    return this.arms.left.inRep || this.arms.right.inRep || this.pending !== null;
  }

  /** Widest the elbows have opened in the rep in progress (for the gauge). */
  get peak() {
    return Math.max(0, ...ARMS.filter((a) => this.arms[a].inRep).map((a) => this.arms[a].cur.flare));
  }

  update(t, xy) {
    const torso = torsoOf(xy);
    const curling = this.arms.left.inRep || this.arms.right.inRep;
    if (!curling) {
      const dt = this.lean.t === null ? Infinity : clamp(t - this.lean.t, 0, 0.5);
      const a = 1 - Math.exp(-dt / REST_TAU_S);
      this.lean.base = this.lean.base === null ? torso.lean : this.lean.base + (torso.lean - this.lean.base) * a;
      this.lean.t = t;
    } else {
      this.lean.max = Math.max(this.lean.max, Math.abs(torso.lean - this.lean.base));
    }

    const done = {};
    for (const arm of ARMS) {
      const rep = this.arms[arm].update(t, armGeometry(xy, arm, torso));
      if (rep) done[arm] = rep;
    }
    const events = [];

    // live warning: an elbow opening while its arm is curling
    const flareNow = Math.max(0, ...ARMS.filter((a) => this.arms[a].inRep).map((a) => this.arms[a].flare));
    if (flareNow > this.target + FLARE_TOL) {
      this.highRun += 1;
      if (!this.warned && this.highRun >= WARN_SAMPLES) {
        this.warned = true;
        events.push({ kind: 'warn', text: '¡Codos pegados!' });
      }
    } else {
      this.highRun = 0;
    }

    const finished = ARMS.filter((a) => done[a]);
    const together = (a, b) => a.startT < b.topT && b.startT < a.topT; // each started before the other peaked
    if (finished.length === 2) {
      if (together(done.left, done.right)) events.push(this.emit(done));
      else for (const arm of finished.sort((a, b) => done[a].endT - done[b].endT)) events.push(this.emit({ [arm]: done[arm] }));
    } else if (finished.length === 1) {
      const arm = finished[0];
      const partner = this.arms[other(arm)];
      if (this.pending?.arm === other(arm)) {
        events.push(this.emit({ [arm]: done[arm], [this.pending.arm]: this.pending.rep }));
      } else if (partner.inRep && partner.cur.startT < done[arm].topT) {
        this.pending = { arm, rep: done[arm] };
      } else {
        events.push(this.emit({ [arm]: done[arm] }));
      }
    } else if (this.pending && !this.arms[other(this.pending.arm)].inRep) {
      events.push(this.emit({ [this.pending.arm]: this.pending.rep })); // its partner's rep did not count
    }
    return events;
  }

  emit(parts) {
    const arms = ARMS.filter((a) => parts[a]);
    const limit = this.target + FLARE_TOL;
    const wide = arms.filter((a) => parts[a].flare > limit);
    const widest = arms.reduce((a, b) => (parts[b].flare > parts[a].flare ? b : a));
    const startT = Math.min(...arms.map((a) => parts[a].startT));
    const topT = mean(arms.map((a) => parts[a].topT));
    const endT = Math.max(...arms.map((a) => parts[a].endT));
    const rep = {
      number: this.reps.length + 1,
      arm: arms.length === 2 ? 'both' : arms[0],
      startT,
      topT,
      endT,
      topLeft: parts.left ? parts.left.top : null, // estimated elbow angle at the top, per arm
      topRight: parts.right ? parts.right.top : null,
      flare: Math.max(...arms.map((a) => parts[a].flare)),
      flareArm: wide.length === 2 ? 'both' : wide.length === 1 ? wide[0] : widest,
      shortest: Math.min(...arms.map((a) => parts[a].shortest)), // upper arm vs hanging length (elbow forward)
      lean: this.lean.max,
      liftS: topT - startT,
      lowerS: endT - topT,
    };
    this.reps.push(rep);
    this.pending = null;
    this.lean.max = 0;
    this.highRun = 0;
    this.warned = false;
    return { kind: 'rep', rep };
  }
}

const ARM_NAME = { left: 'izquierdo', right: 'derecho' };
const ARM_SHORT = { left: 'izq.', right: 'der.', both: 'los dos' };
const OPENED = { left: 'Se abrió el izquierdo.', right: 'Se abrió el derecho.', both: 'Se abrieron los dos.' };
const tops = (rep) => [rep.topLeft, rep.topRight].filter((v) => v !== null);
const lagging = (rep) => (rep.topLeft > rep.topRight ? 'left' : 'right'); // the arm that curled less

/** Technique problems other than the elbows, most important first: [spoken, short text]. */
function otherFaults(rep) {
  const faults = [];
  if (rep.arm === 'both' && Math.abs(rep.topLeft - rep.topRight) > ASYM_WARN) {
    faults.push([`El ${ARM_NAME[lagging(rep)]} subió menos.`, `el ${ARM_NAME[lagging(rep)]} subió menos`]);
  }
  if (Math.max(...tops(rep)) > PARTIAL_ABOVE) faults.push(['Sube más.', 'sube más']);
  if (rep.shortest < DRIFT_RATIO) faults.push(['Codo quieto.', 'el codo se adelantó']);
  if (rep.lean > LEAN_WARN) faults.push(['Sin inclinarte.', 'sin inclinarte']);
  return faults;
}

/** Spoken phrase, on-screen text and color for a finished rep: elbows first, then at most one other correction. */
export function repFeedback(rep, target) {
  const verdict = flareVerdict(rep.flare, target);
  let spoken;
  let status;
  let color;
  if (verdict === 'objetivo') {
    [spoken, status, color] = [`${rep.number}. ¡Buena!`, 'codos pegados', 'green'];
    const [fault] = otherFaults(rep);
    if (fault) {
      spoken += ` ${fault[0]}`;
      status += ` · ${fault[1]}`;
      color = 'orange';
    }
  } else if (verdict === 'casi') {
    [spoken, status, color] = [`${rep.number}. Codos más pegados.`, 'codos algo abiertos', 'orange'];
  } else {
    [spoken, status, color] = [`${rep.number}. Codos pegados. ${OPENED[rep.flareArm]}`, OPENED[rep.flareArm].slice(0, -1).toLowerCase(), 'red'];
  }
  const which = rep.arm === 'both' ? '' : ` (${ARM_SHORT[rep.arm]})`;
  return { spoken, text: `Rep ${rep.number}${which}: codos ${fmtAngle(rep.flare)} · ${status}`, color };
}

export function sessionNotes(reps, target) {
  if (!reps.length) {
    return [
      'No conté ninguna repetición. Ponte de frente a la cámara, con hombros, codos, manos y cadera en cuadro, ' +
        'y estira los brazos entre reps.',
    ];
  }
  const notes = [];
  const single = reps.filter((r) => r.arm !== 'both');
  if (single.length) {
    const count = (arm) => reps.filter((r) => r.arm === arm).length;
    notes.push(
      `Conté cada brazo por separado: ${count('left')} con el izquierdo y ${count('right')} con el derecho` +
        `${reps.length > single.length ? `, y ${reps.length - single.length} con los dos a la vez` : ''}.`,
    );
  }
  const good = reps.filter((r) => flareVerdict(r.flare, target) === 'objetivo');
  if (good.length === reps.length) {
    notes.push(
      `Codos: en las ${reps.length} reps se quedaron pegados al cuerpo ` +
        `(lo máximo que se abrieron fue ${fmtAngle(Math.max(...reps.map((r) => r.flare)))}).`,
    );
  } else {
    notes.push(
      `Codos: se quedaron pegados en ${good.length} de ${reps.length} reps. En las demás se abrieron en promedio ` +
        `${fmtAngle(mean(reps.filter((r) => !good.includes(r)).map((r) => r.flare)))} ` +
        `(objetivo: ${fmtAngle(target)} o menos). Pégalos a las costillas y baja el peso si se siguen abriendo.`,
    );
    const wide = reps.filter((r) => flareVerdict(r.flare, target) === 'corta');
    for (const [arm, label] of [
      ['left', 'el codo izquierdo'],
      ['right', 'el codo derecho'],
      ['both', 'los dos codos'],
    ]) {
      const nums = wide.filter((r) => r.flareArm === arm).map((r) => r.number);
      if (nums.length) notes.push(`Se ${arm === 'both' ? 'abrieron' : 'abrió'} ${label} ${inReps(nums)}.`);
    }
  }
  const unevenRep = (r) => r.arm === 'both' && Math.abs(r.topLeft - r.topRight) > ASYM_WARN;
  const partial = reps.filter((r) => Math.max(...tops(r)) > PARTIAL_ABOVE && !unevenRep(r)); // uneven reps get their own note
  if (partial.length) {
    notes.push(`Rango: ${inReps(partial.map((r) => r.number))} la mano no pasó con claridad la altura del codo. Sube más.`);
  }
  const uneven = reps.filter(unevenRep);
  if (uneven.length) {
    const arm = mean(uneven.map((r) => r.topLeft - r.topRight)) > 0 ? 'left' : 'right';
    notes.push(
      `Simetría: ${inReps(uneven.map((r) => r.number))} el brazo ${ARM_NAME[arm]} subió menos que el otro. ` +
        'Sube los dos a la misma altura; si uno no puede, baja el peso.',
    );
  }
  const drifted = reps.filter((r) => r.shortest < DRIFT_RATIO);
  if (drifted.length) {
    notes.push(
      `Codo: ${inReps(drifted.map((r) => r.number))} el codo se fue hacia adelante (el brazo se ve más corto en la imagen). ` +
        'Déjalo quieto al costado; con la vista De lado se mide mejor.',
    );
  }
  const leaned = reps.filter((r) => r.lean > LEAN_WARN);
  if (leaned.length) {
    notes.push(
      `Torso: ${inReps(leaned.map((r) => r.number))} te inclinaste hacia un lado más de ${LEAN_WARN}°. ` +
        'Mantén el tronco quieto y derecho.',
    );
  }
  notes.push(
    'Límite: de frente no se ve el balanceo adelante-atrás, y el ángulo del codo es solo una estimación. ' +
      'Para el rango exacto y el balanceo usa la vista De lado.',
  );
  return notes;
}

const VERDICT_LABEL = { objetivo: 'Bien', casi: 'Justo', corta: 'Se abren' };
const topCell = (v) => (v === null ? '—' : `~${fmtAngle(v)}`);

/** Everything the app needs to coach a bicep curl from the front. */
export const curlFront = {
  id: 'curl-front',
  group: 'curl',
  view: 'front',
  name: 'Curl de frente',
  intro: 'Te mira de frente y revisa si los codos se abren, si un brazo sube menos que el otro y si te inclinas.',
  target: {
    default: 12,
    min: 5,
    max: 30,
    step: 1,
    label: 'Apertura máxima de codos',
    hint: 'Cuánto puede separarse el codo del cuerpo respecto a cuando tienes el brazo abajo. 0° = no se mueve.',
  },
  targetLabel: 'máximo',
  tol: FLARE_TOL,
  metric: 'apertura codos',
  fmt: fmtAngle,
  gauge: { top: 40, bottom: 0, ref: 0 }, // dot goes up as the elbows open; the good end (0) is the bottom
  tips: [
    'iPhone fijo, <b>de frente a ti</b>, a la altura del pecho, a 1.5–2.5 m.',
    'Hombros, codos, manos y cadera en cuadro. Estira los brazos entre reps.',
    'Cuenta los dos brazos: juntos (barra) o por turnos (mancuernas alternadas).',
  ],
  ready: 'Listo. Ponte de frente, con los brazos a la vista.',
  lost: 'Ponte de frente, con hombros, codos y manos en cuadro',
  hit: '',
  makeFilter: () =>
    new JointFilter({
      kp: KP,
      sideJoints: ['lShoulder', 'rShoulder'],
      lengthPairs: [['lShoulder', 'rShoulder']],
      lengthTol: 0.5,
      required: ['lShoulder', 'rShoulder', 'lElbow', 'rElbow'],
      minScore: 0.3,
    }),
  makeCounter: (target) => new CurlFrontCounter(target),
  value: (xy, counter) => (counter ? Math.max(counter.arms.left.flare, counter.arms.right.flare) : null),
  positionLabel,
  draw: drawFrontArms,
  viewHint: (xy) => (torsoOf(xy).facingRatio < FACING_MIN ? 'Estás de lado: ponte de frente o elige la vista De lado' : null),
  repFeedback,
  verdict: (rep, target) => flareVerdict(rep.flare, target),
  verdictLabel: VERDICT_LABEL,
  repValue: (rep) => rep.flare,
  columns: ['Rep', 'Brazo', 'Codos', 'Resultado', 'Arriba izq.', 'Arriba der.', 'Torso'],
  row: (rep) => [
    rep.number,
    ARM_SHORT[rep.arm],
    fmtAngle(rep.flare),
    null, // verdict cell, filled by the app
    topCell(rep.topLeft),
    topCell(rep.topRight),
    rep.lean > LEAN_WARN ? `${Math.round(rep.lean)}° de lado` : 'quieto',
  ],
  stats(reps, target) {
    const good = reps.filter((r) => flareVerdict(r.flare, target) === 'objetivo').length;
    const count = (arm) => reps.filter((r) => r.arm === arm || r.arm === 'both').length;
    return [
      ['Izq. / Der.', `${count('left')} / ${count('right')}`],
      ['Codos bien', `${good} / ${reps.length}`],
      ['Más abiertos', fmtAngle(Math.max(...reps.map((r) => r.flare)))],
    ];
  },
  shareLine: (rep, target) =>
    `Rep ${rep.number} (${ARM_SHORT[rep.arm]}): codos ${fmtAngle(rep.flare)} (${VERDICT_LABEL[flareVerdict(rep.flare, target)]})`,
  historyLine(reps, target) {
    const good = reps.filter((r) => flareVerdict(r.flare, target) === 'objetivo').length;
    return `${reps.length} reps · ${good} con codos bien · máx. ${fmtAngle(Math.max(...reps.map((r) => r.flare)))}`;
  },
  notes: sessionNotes,
  setPhrase(reps, target) {
    const ok = reps.filter((r) => flareVerdict(r.flare, target) === 'objetivo').length;
    return {
      spoken: `Serie terminada. ${reps.length} repeticiones, ${ok} con los codos pegados.`,
      text: `Serie: ${reps.length} reps · ${ok} con codos pegados`,
    };
  },
};
