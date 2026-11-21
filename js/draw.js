// Overlays on the camera frame. Squat: green = your leg, red = target depth, blue dashed = knee height.
// Curl: green = your arm, red = forearm at the target angle, blue dashed = torso line (keep the elbow on it).

const GREEN = 'rgb(70, 230, 90)';
const RED = 'rgb(235, 60, 75)';
const BLUE = 'rgb(60, 170, 245)';
const WHITE = 'rgb(255, 255, 255)';

/** Where the hip would be with the same thigh length at the target angle. */
export function targetHip(hip, knee, target) {
  const len = Math.hypot(hip[0] - knee[0], hip[1] - knee[1]);
  const dir = hip[0] >= knee[0] ? 1 : -1;
  const rad = (target * Math.PI) / 180;
  return [knee[0] + dir * len * Math.cos(rad), knee[1] - len * Math.sin(rad)];
}

function line(ctx, a, b, color, width, dash = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function joint(ctx, p, color, r, ring) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = ring;
  ctx.stroke();
}

/** s = UI scale (short side / 720). */
export function drawLegs(ctx, xy, target, showTarget, s) {
  const { hip, knee, ankle } = xy;
  const t = Math.max(2, 5 * s);
  const r = Math.max(4, 9 * s);
  const ring = Math.max(1, 2 * s);
  const thighLen = Math.hypot(hip[0] - knee[0], hip[1] - knee[1]);
  const span = thighLen * 1.5;
  ctx.lineCap = 'round';
  line(ctx, [knee[0] - span, knee[1]], [knee[0] + span, knee[1]], BLUE, Math.max(1, t / 2), [10 * s, 10 * s]);
  if (showTarget) {
    const tgt = targetHip(hip, knee, target);
    line(ctx, knee, tgt, RED, t);
    joint(ctx, tgt, RED, r, ring);
  }
  line(ctx, hip, knee, GREEN, t + 1);
  line(ctx, knee, ankle, GREEN, t + 1);
  for (const p of [hip, knee, ankle]) joint(ctx, p, GREEN, r, ring);
}

/** Where the wrist would be with the same forearm length at the target elbow angle (same side as now). */
export function targetWrist(shoulder, elbow, wrist, target) {
  const ux = shoulder[0] - elbow[0];
  const uy = shoulder[1] - elbow[1];
  const ul = Math.hypot(ux, uy) || 1;
  const fl = Math.hypot(wrist[0] - elbow[0], wrist[1] - elbow[1]);
  const side = Math.sign(ux * (wrist[1] - elbow[1]) - uy * (wrist[0] - elbow[0])) || 1;
  const a = (side * target * Math.PI) / 180;
  const dx = (ux / ul) * Math.cos(a) - (uy / ul) * Math.sin(a);
  const dy = (ux / ul) * Math.sin(a) + (uy / ul) * Math.cos(a);
  return [elbow[0] + dx * fl, elbow[1] + dy * fl];
}

export function drawArm(ctx, xy, target, showTarget, s) {
  const { shoulder, elbow, wrist, hip } = xy;
  const t = Math.max(2, 5 * s);
  const r = Math.max(4, 9 * s);
  const ring = Math.max(1, 2 * s);
  ctx.lineCap = 'round';
  const upper = Math.hypot(shoulder[0] - elbow[0], shoulder[1] - elbow[1]);
  const tx = hip[0] - shoulder[0];
  const ty = hip[1] - shoulder[1];
  const tl = Math.hypot(tx, ty) || 1;
  const ref = [shoulder[0] + (tx / tl) * upper * 1.15, shoulder[1] + (ty / tl) * upper * 1.15];
  line(ctx, shoulder, ref, BLUE, Math.max(1, t / 2), [10 * s, 10 * s]);
  if (showTarget) {
    const tgt = targetWrist(shoulder, elbow, wrist, target);
    line(ctx, elbow, tgt, RED, t);
    joint(ctx, tgt, RED, r, ring);
  }
  line(ctx, shoulder, elbow, GREEN, t + 1);
  line(ctx, elbow, wrist, GREEN, t + 1);
  for (const p of [shoulder, elbow, wrist]) joint(ctx, p, GREEN, r, ring);
}
