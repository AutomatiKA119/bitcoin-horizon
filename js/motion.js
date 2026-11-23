import { priceOnLine } from "./horizon.js";

export function pitchOf(price, horizon) {
  if (!horizon) return 0;
  const raw = (price - horizon) / horizon / 0.2;
  return Math.max(-1, Math.min(1, raw));
}

export function buildVolMap(points, model) {
  const start = Date.UTC(2013, 0, 1);
  const days = points.filter((point) => point.t >= start && point.p > 0);
  const rows = [];
  let previous = null;
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const horizon = priceOnLine(model, day.t);
    const above = day.p > horizon;
    const flip = previous !== null && above !== previous;
    const ret = i === 0 ? 0 : (day.p - days[i - 1].p) / days[i - 1].p;
    rows.push({ t: day.t, p: day.p, horizon, above, flip, ret, flips30: 0 });
    previous = above;
  }
  let rolling = 0;
  const counts = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].flip) rolling += 1;
    if (i >= 30 && rows[i - 30].flip) rolling -= 1;
    rows[i].flips30 = rolling;
    counts.push(rolling);
  }
  counts.sort((a, b) => a - b);
  return { rows, counts };
}

export function percentile(sorted, value) {
  if (!sorted.length) return 0;
  let below = 0;
  for (const entry of sorted) if (entry <= value) below += 1;
  return below / sorted.length;
}

const LIVE_FLIP_KEY = "bh.liveFlip";

export function resolveFlip(rows, above, spot, now) {
  const lastDaily = rows[rows.length - 1];
  if (!lastDaily) return { t: now, p: spot, above };
  if (above === lastDaily.above) {
    localStorage.removeItem(LIVE_FLIP_KEY);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].flip) return { t: rows[i].t, p: rows[i].p, above: rows[i].above };
    }
    return { t: rows[0].t, p: rows[0].p, above: rows[0].above };
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LIVE_FLIP_KEY) || "null"); } catch { saved = null; }
  if (!saved || saved.above !== above) {
    saved = { t: now, p: spot, above };
    localStorage.setItem(LIVE_FLIP_KEY, JSON.stringify(saved));
  }
  return saved;
}

export function ribbonMode(rows, flip, spot, horizon) {
  const since = rows.filter((row) => row.t >= flip.t);
  const extraFlips = since.filter((row) => row.flip && row.t > flip.t).length;
  if (extraFlips >= 2) return "chop";
  const recent = since.slice(-14).map((row) => row.p);
  recent.push(spot);
  const recentSlope = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / recent[0] : 0;
  if (spot > horizon && recentSlope < -0.005) return "return-high";
  if (spot < horizon && recentSlope > 0.005) return "return-low";
  if (spot >= horizon) return "climb";
  return "fall";
}

export function spanChange(points, days, spot) {
  if (!points.length) return 0;
  const now = Date.now();
  const cutoff = now - days * 86400000;
  let prior = points[0];
  for (const point of points) {
    if (point.t <= cutoff) prior = point;
  }
  if (!prior.p) return 0;
  return (spot - prior.p) / prior.p;
}

export function crabbing(movement, rows) {
  const recent = rows.slice(-7);
  const wobble = recent.reduce((sum, row) => sum + Math.abs(row.ret), 0) / (recent.length || 1);
  return Math.abs(movement) < 0.04 && wobble < 0.035;
}

const TRAIL_KEY = "bh.reticuleBG";
const TRAIL_MS = 300 * 60000;

export function loadTrail() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRAIL_KEY) || "[]");
    const cutoff = Date.now() - TRAIL_MS;
    return Array.isArray(saved) ? saved.filter((sample) => sample.t >= cutoff) : [];
  } catch {
    return [];
  }
}

export function rememberTrail(samples) {
  const cutoff = Date.now() - TRAIL_MS;
  const trimmed = samples.filter((sample) => sample.t >= cutoff).slice(-300);
  localStorage.setItem(TRAIL_KEY, JSON.stringify(trimmed));
  return trimmed;
}

export function sampleMinutesAgo(trail, minutes) {
  if (!trail.length) return null;
  const target = Date.now() - minutes * 60000;
  return trail.reduce((best, sample) => (
    Math.abs(sample.t - target) < Math.abs(best.t - target) ? sample : best
  ));
}

export function ribbonPath(mode) {
  const steps = 32;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const z = i / steps;
    const scale = 1 / (1 + z * 2.4);
    let rise = 0;
    if (mode === "climb") rise = -z * z * 150;
    else if (mode === "fall") rise = z * z * 150;
    else if (mode === "chop") rise = Math.sin(z * Math.PI * 7) * 18;
    else if (mode === "return-high") rise = -Math.sin(z * Math.PI) * 96;
    else rise = Math.sin(z * Math.PI) * 96;
    points.push({
      x: 0,
      y: 48 + rise * scale - z * 18,
      half: (46 + z * 6) * scale,
    });
  }
  let path = `M ${points[0].x - points[0].half} ${points[0].y}`;
  for (const point of points) path += ` L ${point.x - point.half} ${point.y}`;
  for (let i = points.length - 1; i >= 0; i -= 1) path += ` L ${points[i].x + points[i].half} ${points[i].y}`;
  return `${path} Z`;
}

export function volatilityRatios(trail) {
  const now = Date.now();
  const rows = trail.filter((sample) => sample.p > 0).sort((a, b) => a.t - b.t);
  const nearest = (minutesAgo) => {
    const target = now - minutesAgo * 60000;
    return rows.reduce((best, sample) => (
      Math.abs(sample.t - target) < Math.abs(best.t - target) ? sample : best
    ));
  };
  const signedMove = (minutes) => {
    if (rows.length < 2) return 0;
    const recent = nearest(0);
    const past = nearest(minutes);
    return (recent.p - past.p) / recent.p;
  };
  const older = rows.filter((sample) => sample.t < now - 60 * 60000);
  let perMinute = 0;
  let count = 0;
  for (let i = 1; i < older.length; i += 1) {
    const dt = (older[i].t - older[i - 1].t) / 60000;
    if (dt <= 0 || dt > 5) continue;
    perMinute += Math.abs(older[i].p - older[i - 1].p) / older[i].p / dt;
    count += 1;
  }
  const baseline = count ? perMinute / count : 0.00004;
  const pack = (minutes) => {
    const move = signedMove(minutes);
    const expected = Math.max(baseline * minutes, 0.00002);
    return { ratio: Math.abs(move) / expected, sign: move >= 0 ? 1 : -1 };
  };
  return { m10: pack(10), m30: pack(30), m60: pack(60) };
}

export function bowlBand(above, sway, horizonY) {
  const amp = 230;
  const k = above ? -1 : 1;
  const center = Math.max(-0.55, Math.min(0.55, sway));
  const paths = [];
  for (let i = 0; i < 10; i += 1) {
    const lane = (i - 4.5) / 9;
    let d = "";
    for (let step = 0; step <= 24; step += 1) {
      const nx = center + (step / 24 - 0.5) * 0.9;
      const x = 500 + nx * 520 + lane * 22;
      const y = horizonY + k * amp * (1 - nx * nx) + lane * 14 * k;
      d += `${step === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    paths.push(d);
  }
  return paths;
}

export const RIBBON_LABEL = {
  climb: "PATH CLIMB",
  fall: "PATH FALL",
  chop: "PATH WAVE",
  "return-high": "PATH RETURN HIGH",
  "return-low": "PATH RETURN LOW",
};
