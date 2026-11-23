export const PRESETS = [
  {
    id: "genesis",
    name: "2010 GENESIS",
    blurb: "Straight line from $1 on 1 Jan 2010. This horizon sits lower.",
    start: Date.UTC(2010, 0, 1),
    anchorPrice: 1,
  },
  {
    id: "og",
    name: "2013 OG",
    blurb: "Early holders. Real daily prices from the first day on or after 1 Jan 2013.",
    start: Date.UTC(2013, 0, 1),
    anchorPrice: null,
  },
  {
    id: "takeoff",
    name: "2017 TAKEOFF",
    blurb: "From the first day on or after 1 Jan 2017, when Bitcoin took off.",
    start: Date.UTC(2017, 0, 1),
    anchorPrice: null,
  },
];

export function isoWeekId(ms) {
  const date = new Date(ms);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function computeHorizon(points, preset, nowMs) {
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const series = points.filter((p) => p.t >= preset.start && p.t < today && p.p > 0);
  if (series.length < 2) {
    throw new Error(`Not enough daily prices for ${preset.name}`);
  }
  let sumT = 0;
  let sumP = 0;
  for (const point of series) {
    sumT += point.t;
    sumP += point.p;
  }
  const meanT = sumT / series.length;
  const meanP = sumP / series.length;
  const t0 = preset.anchorPrice == null ? series[0].t : preset.start;
  const p0 = preset.anchorPrice == null ? series[0].p : preset.anchorPrice;
  const slope = (meanP - p0) / (meanT - t0);
  const horizon = p0 + slope * (nowMs - t0);
  return {
    id: preset.id,
    horizon,
    meanT,
    meanP,
    t0,
    p0,
    slope,
    count: series.length,
    computedAt: nowMs,
  };
}

export function priceOnLine(model, timeMs) {
  return model.p0 + model.slope * (timeMs - model.t0);
}

export function elevation(spot, horizon) {
  const minGap = spot / 1e8;
  let gap = spot - horizon;
  let forced = false;
  if (!Number.isFinite(gap) || gap === 0) {
    gap = minGap;
    forced = true;
  } else if (Math.abs(gap) < minGap) {
    gap = Math.sign(gap) * minGap;
    forced = true;
  }
  const above = gap > 0;
  const pct = (gap / horizon) * 100;
  return { above, gap, forced, pct };
}

export function money(amount) {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatGap(info, spot) {
  if (info.forced || Math.abs(info.gap) < 0.01) {
    const satUsd = spot / 1e8;
    const sats = Math.max(1, Math.round(Math.abs(info.gap) / satUsd));
    return `${info.above ? "+" : "−"}${sats} sat`;
  }
  const body = money(Math.abs(info.gap));
  return info.above ? `+${body}` : `−${body}`;
}

export function formatPct(info) {
  if (info.forced || Math.abs(info.pct) < 0.01) return info.above ? "+1 sat" : "−1 sat";
  const body = `${Math.abs(info.pct).toFixed(2)}%`;
  return info.above ? `+${body}` : `−${body}`;
}
