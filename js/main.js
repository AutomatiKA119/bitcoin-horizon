import {
  PRESETS,
  isoWeekId,
  computeHorizon,
  elevation,
  money,
  formatGap,
  formatPct,
} from "./horizon.js";
import { fetchDailySeries, fetchSpot, fetchTip, fetchSellWarnings, fetchMinuteCloses, readCache, writeCache } from "./market.js";
import {
  buildVolMap,
  resolveFlip,
  crabbing,
  bowlBand,
  loadTrail,
  rememberTrail,
  sampleMinutesAgo,
} from "./motion.js";
import { PLAYLIST, createRadio, formatClock } from "./radio.js";
import { mountAd } from "./ad.js";
import { startScreensaver } from "./saver.js";

const ORIGIN_KEY = "bh.origin";
const ui = {
  price: document.querySelector("#price"),
  horizon: document.querySelector("#horizon-read"),
  origin: document.querySelector("#origin-read"),
  side: document.querySelector("#side"),
  elev: document.querySelector("#elev"),
  nose: document.querySelector("#nose"),
  buy: document.querySelector("#buy-call"),
  sell: document.querySelector("#sell-call"),
  layer: document.querySelector("#horizon-layer"),
  blockClock: document.querySelector("#block-clock"),
  blockAge: document.querySelector("#block-age"),
  blockHeight: document.querySelector("#block-height"),
  status: document.querySelector("#status"),
  modal: document.querySelector("#modal"),
  choices: document.querySelector("#choices"),
  chart: document.querySelector("#chart"),
  warn: document.querySelector("#warn"),
  warnCopy: document.querySelector("#warn-copy"),
  track: document.querySelector("#track-title"),
  trackTime: document.querySelector("#track-time"),
  radioBtn: document.querySelector("#radio-toggle"),
};

let cache = null;
let spot = null;
let tip = null;
let originId = localStorage.getItem(ORIGIN_KEY);
let warnHold = false;
const radio = createRadio(PLAYLIST);

function setStatus(text) {
  ui.status.textContent = text || "";
}

function selectedModel() {
  return cache?.horizons?.[originId] || null;
}

function renderChoices() {
  ui.choices.innerHTML = "";
  for (const preset of PRESETS) {
    const model = cache?.horizons?.[preset.id];
    const button = document.createElement("button");
    button.type = "button";
    button.className = preset.id === originId ? "selected" : "";
    const price = model ? money(model.horizon) : "…";
    button.innerHTML = `<strong>${preset.name}</strong><em>${price}</em><span>${preset.blurb}</span>`;
    button.addEventListener("click", () => chooseOrigin(preset.id));
    ui.choices.append(button);
  }
}

function chooseOrigin(id) {
  originId = id;
  localStorage.setItem(ORIGIN_KEY, id);
  ui.modal.classList.add("hidden");
  renderChoices();
  renderFlight();
  armRadio();
}

function drawChart() {
  const canvas = ui.chart;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(0, 0, width, height);
  if (!cache?.points?.length) {
    ctx.fillStyle = "#00ff66";
    ctx.font = "16px Share Tech Mono, monospace";
    ctx.fillText("PLOTTING DAILY PRICES…", 24, height / 2);
    return;
  }
  const points = cache.points;
  const t0 = PRESETS[0].start;
  const t1 = cache.computedAt;
  const models = PRESETS.map((preset) => cache.horizons[preset.id]).filter(Boolean);
  let maxP = 1;
  for (const point of points) {
    if (point.t >= t0 && point.t <= t1) maxP = Math.max(maxP, point.p);
  }
  for (const model of models) maxP = Math.max(maxP, model.horizon, model.p0, model.meanP);
  const pad = 16;
  const xOf = (t) => pad + ((t - t0) / (t1 - t0)) * (width - pad * 2);
  const yOf = (p) => height - pad - (p / (maxP * 1.05)) * (height - pad * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  const step = Math.max(1, Math.floor(points.length / 240));
  for (let i = 0; i < points.length; i += step) {
    const point = points[i];
    if (point.t < t0 || point.t > t1) continue;
    const x = xOf(point.t);
    const y = yOf(point.p);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const colors = ["#b6ff9a", "#00ff66", "#8dffd0"];
  models.forEach((model, index) => {
    ctx.strokeStyle = colors[index % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xOf(model.t0), yOf(model.p0));
    ctx.lineTo(xOf(model.meanT), yOf(model.meanP));
    ctx.lineTo(xOf(t1), yOf(model.horizon));
    ctx.stroke();
  });
}

function renderFlight() {
  const model = selectedModel();
  ui.origin.textContent = model ? `ORIGIN ${PRESETS.find((p) => p.id === originId).name}` : "ORIGIN —";
  ui.horizon.textContent = model ? `HORIZON ${money(model.horizon)}` : "HORIZON —";
  if (!model || !spot) {
    document.body.classList.remove("above", "below");
    return;
  }
  const info = elevation(spot.price, model.horizon);
  document.body.classList.toggle("above", info.above);
  document.body.classList.toggle("below", !info.above);
  ui.price.textContent = money(spot.price);
  ui.side.textContent = info.above ? "ABOVE HORIZON" : "BELOW HORIZON";
  ui.elev.textContent = `${formatGap(info, spot.price)}  ${formatPct(info)}`;
  ui.nose.textContent = info.above ? "NOSE UP" : "NOSE DOWN";
  ui.buy.textContent = info.above ? "BUY NOW" : "WAIT";
  ui.sell.textContent = info.above ? "WAIT / LIFT OFFER" : "HURRY";
  ui.layer.style.transform = "none";
  renderMotion(model, info);
}

let volMap = null;
let trail = loadTrail();
let trailMinute = 0;

function ensureVol(model) {
  if (!cache?.points) return null;
  if (volMap && volMap.id === originId && volMap.computedAt === cache.computedAt) return volMap;
  volMap = { id: originId, computedAt: cache.computedAt, ...buildVolMap(cache.points, model) };
  return volMap;
}

function backfillTrail() {
  const model = selectedModel();
  if (!model) return Promise.resolve();
  const priced = trail.filter((sample) => sample.p > 0);
  if (priced.length >= 180) {
    trail = priced;
    return Promise.resolve();
  }
  return fetchMinuteCloses()
    .then((minutes) => {
      trail = rememberTrail(minutes.map((row) => ({ t: row.t, p: row.p })));
    })
    .catch(() => {});
}

function renderMotion(model, info) {
  const map = ensureVol(model);
  if (!map) return;
  const flip = resolveFlip(map.rows, info.above, spot.price, Date.now());
  const movement = (spot.price - flip.p) / flip.p;
  const crab = crabbing(movement, map.rows);
  document.body.classList.toggle("crab", crab);
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== trailMinute) {
    trailMinute = minute;
    trail = rememberTrail(trail.filter((sample) => sample.p > 0).concat({ t: Date.now(), p: spot.price }));
  }
  const horizon = model.horizon;
  const nowAttitude = (spot.price - horizon) / horizon;
  const ghosts = [["ghost-10", 10], ["ghost-30", 30], ["ghost-60", 60]].map(([id, minutes]) => {
    const sample = sampleMinutesAgo(trail, minutes);
    const pastPrice = sample?.p > 0 ? sample.p : spot.price;
    const pastAttitude = (pastPrice - horizon) / horizon;
    return { id, pastPrice, offset: (pastAttitude - nowAttitude) * window.innerHeight };
  });
  const span = Math.max(...ghosts.map((ghost) => ghost.offset)) - Math.min(...ghosts.map((ghost) => ghost.offset));
  const gain = span < 150 ? 150 / Math.max(span, 0.35) : 1;
  for (const ghost of ghosts) {
    const node = document.getElementById(ghost.id);
    if (!node) continue;
    node.style.transform = `translate(-50%, -50%) translateY(${(ghost.offset * gain).toFixed(1)}px)`;
    node.dataset.price = String(Math.round(ghost.pastPrice));
  }
}

function bankSway() {
  const yaw = document.getElementById("horizon-yaw");
  const transform = getComputedStyle(yaw).transform;
  let sway = 0;
  if (transform && transform !== "none") {
    const matrix = new DOMMatrix(transform);
    sway = Math.atan2(matrix.b, matrix.a) / (16 * Math.PI / 180);
  }
  return sway * 0.85 + Math.sin(Date.now() / 3400) * 0.28;
}

function drawBowl() {
  const arcs = document.querySelector("#arcs");
  if (arcs) {
    const seaPx = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sea")) || window.innerHeight / 2;
    const horizonY = (seaPx / window.innerHeight) * 1000;
    const above = document.body.classList.contains("above");
    arcs.replaceChildren();
    bowlBand(above, bankSway(), horizonY).forEach((d, index) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("stroke-width", index === 4 || index === 5 ? "2.4" : "1.35");
      path.setAttribute("opacity", (0.28 + index * 0.055).toFixed(2));
      arcs.append(path);
    });
  }
  requestAnimationFrame(drawBowl);
}

function renderBlock() {
  if (!tip) return;
  const clock = new Date(tip.time);
  const hh = String(clock.getUTCHours()).padStart(2, "0");
  const mm = String(clock.getUTCMinutes()).padStart(2, "0");
  const ss = String(clock.getUTCSeconds()).padStart(2, "0");
  ui.blockClock.textContent = `${hh}:${mm}:${ss} UTC`;
  const age = Math.max(0, Date.now() - tip.time);
  const mins = Math.floor(age / 60000);
  const secs = Math.floor((age % 60000) / 1000);
  ui.blockAge.textContent = `${mins}m ${String(secs).padStart(2, "0")}s AGO`;
  ui.blockHeight.textContent = `BLK ${tip.height.toLocaleString("en-US")}`;
}

function showWarning(rows) {
  if (!rows.length) {
    warnHold = false;
    ui.warn.classList.add("hidden");
    return;
  }
  if (warnHold) return;
  const parts = rows.map((row) => {
    if (row.big >= 25) return `${row.venue} has an ask of ${row.big.toFixed(1)} BTC`;
    return `${row.venue} asks are ${row.ratio.toFixed(1)}× the bids within 2%`;
  });
  ui.warnCopy.textContent = `Public books: ${parts.join(". ")}.`;
  ui.warn.classList.remove("hidden");
}

async function refreshSpot() {
  try {
    spot = await fetchSpot();
    setStatus(`${spot.source}  ·  horizon locked ${cache?.week || ""}`.trim());
    renderFlight();
  } catch (error) {
    setStatus(error.message);
  }
}

async function refreshTip() {
  try {
    tip = await fetchTip();
    renderBlock();
  } catch (error) {
    ui.blockAge.textContent = error.message;
  }
}

async function refreshBooks() {
  try {
    const rows = await fetchSellWarnings();
    showWarning(rows);
  } catch {
    /* keep flying if a poll fails */
  }
}

async function ensureHorizon() {
  const week = isoWeekId(Date.now());
  const stored = readCache();
  if (stored?.week === week && stored.horizons?.genesis && stored.points?.length) {
    cache = stored;
    return;
  }
  setStatus("LOCKING HORIZON");
  const fresh = await fetchDailySeries();
  const now = Date.now();
  const horizons = {};
  for (const preset of PRESETS) horizons[preset.id] = computeHorizon(fresh, preset, now);
  cache = { week, computedAt: now, points: fresh, horizons };
  writeCache(cache);
}

function renderRadio() {
  ui.track.textContent = radio.state.playing ? radio.state.title : `${radio.state.title}  STANDBY`;
  ui.trackTime.textContent = formatClock(radio.position());
  ui.radioBtn.textContent = radio.state.playing ? "HOLD" : "ENGAGE";
}

let arming = null;

async function armRadio() {
  if (radio.state.playing) return;
  if (arming) return arming;
  arming = radio.startRandom()
    .then(() => renderRadio())
    .catch(() => {
      ui.track.textContent = "RADIO BLOCKED — PRESS ENGAGE";
    })
    .finally(() => {
      arming = null;
    });
  return arming;
}

document.querySelector("#origin-btn").addEventListener("click", () => {
  ui.modal.classList.remove("hidden");
  drawChart();
});
document.querySelector("#warn-dismiss").addEventListener("click", () => {
  warnHold = true;
  ui.warn.classList.add("hidden");
});
ui.radioBtn.addEventListener("click", async () => {
  await radio.toggle();
  renderRadio();
});

renderChoices();
if (originId && PRESETS.some((preset) => preset.id === originId)) ui.modal.classList.add("hidden");

const reticle = document.querySelector("#reticle");
for (const id of ["ghost-60", "ghost-30", "ghost-10"]) {
  const ghost = reticle.cloneNode(true);
  ghost.id = id;
  ghost.classList.add("ghost");
  reticle.before(ghost);
}

// Pixel row (in each source image) where the painted horizon line sits.
// Measured from the files: horizon-bg.jpg is a 2px dark line on rows 288-289 of 576,
// sea-bg.jpg is a dark line centred on row 283 of 720. These are read off the images,
// not tuned by eye - re-measure if either image is replaced.
const HORIZON_ROW = { sky: 289, sea: 283.5 };
const IMAGE_SIZE = { sky: [1024, 576], sea: [1280, 720] };

function placeHorizon() {
  const world = document.getElementById("world");
  const boxW = world.offsetWidth;
  const boxH = world.offsetHeight;
  const boxTop = Number.parseFloat(getComputedStyle(world).top) || 0;
  const key = sea ? "sea" : "sky";
  const [imgW, imgH] = IMAGE_SIZE[key];
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const displayedH = imgH * scale;
  const yInWorld = (boxH - displayedH) / 2 + (HORIZON_ROW[key] / imgH) * displayedH;
  const screenY = boxTop + yInWorld;
  document.documentElement.style.setProperty("--sea", `${screenY}px`);
  world.style.transformOrigin = `50% ${(yInWorld / boxH) * 100}%`;
  document.getElementById("horizon-yaw").style.transformOrigin = `50% ${screenY}px`;
}

const sky = document.querySelector("#sky");
const skyBtn = document.querySelector("#sky-btn");
let sea = localStorage.getItem("bh.view") === "sea";
function applyView() {
  document.body.classList.toggle("sea", sea);
  sky.style.backgroundImage = sea ? 'url("/sea-bg.jpg")' : 'url("/horizon-bg.jpg")';
  skyBtn.textContent = sea ? "SEA" : "SKY";
  placeHorizon();
}
applyView();
skyBtn.addEventListener("click", () => {
  sea = !sea;
  localStorage.setItem("bh.view", sea ? "sea" : "sky");
  applyView();
});
window.addEventListener("resize", placeHorizon);

ensureHorizon()
  .then(() => {
    renderChoices();
    drawChart();
    return backfillTrail();
  })
  .then(() => refreshSpot())
  .catch((error) => {
    setStatus(error.message);
    drawChart();
  });

refreshTip();
refreshBooks();
setInterval(refreshSpot, 15000);
setInterval(refreshTip, 30000);
setInterval(renderBlock, 1000);
setInterval(refreshBooks, 45000);
setInterval(renderRadio, 500);
mountAd(document.querySelector("#ad-slot"));
// Radio is armed on the first user gesture (below), never at load: browsers block
// audio before a gesture and log "AudioContext was not allowed to start".
requestAnimationFrame(drawBowl);
startScreensaver({
  button: document.querySelector("#fs-btn"),
  countEl: document.querySelector("#ss-count"),
  hintEl: document.querySelector("#ss-hint"),
});
function armOnFirstGesture(event) {
  if (event.target.closest && event.target.closest("#radio")) return;
  window.removeEventListener("pointerdown", armOnFirstGesture);
  window.removeEventListener("keydown", armOnFirstGesture);
  armRadio();
}
window.addEventListener("pointerdown", armOnFirstGesture);
window.addEventListener("keydown", armOnFirstGesture);
