const CACHE_KEY = "bh.horizon.v1";

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export async function fetchDailySeries() {
  const data = await fetchJson(
    "https://api.blockchain.info/charts/market-price?timespan=all&format=json&cors=true"
  );
  const points = data.values
    .map((row) => ({ t: row.x * 1000, p: Number(row.y) }))
    .filter((row) => Number.isFinite(row.p) && row.p > 0)
    .sort((a, b) => a.t - b.t);
  if (points.length < 10) throw new Error("Daily history was empty");
  return extendSeries(points);
}

async function extendSeries(points) {
  const last = points[points.length - 1].t;
  if (Date.now() - last < 3 * 86400000) return points;
  try {
    const candles = await fetchJson(
      "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"
    );
    const extra = candles
      .map((row) => ({ t: Number(row[0]) * 1000, p: Number(row[4]) }))
      .filter((row) => row.t > last && Number.isFinite(row.p) && row.p > 0);
    const merged = points.concat(extra).sort((a, b) => a.t - b.t);
    const byDay = new Map();
    for (const point of merged) {
      const day = new Date(point.t);
      const key = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
      byDay.set(key, { t: key, p: point.p });
    }
    return [...byDay.values()].sort((a, b) => a.t - b.t);
  } catch {
    return points;
  }
}

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export async function fetchMinuteCloses() {
  const candles = await fetchJson(
    "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60"
  );
  return candles
    .map((row) => ({ t: Number(row[0]) * 1000, p: Number(row[4]) }))
    .filter((row) => Number.isFinite(row.p) && row.p > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-300);
}

export async function fetchSpot() {
  try {
    const data = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
    const key = Object.keys(data.result || {})[0];
    const last = Number(data.result[key].c[0]);
    if (!Number.isFinite(last)) throw new Error("Kraken last price missing");
    return { price: last, source: "Kraken" };
  } catch {
    const data = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    return { price: Number(data.data.amount), source: "Coinbase" };
  }
}

export async function fetchTip() {
  const hash = (await fetch("https://mempool.space/api/blocks/tip/hash").then((r) => r.text())).trim();
  const block = await fetchJson(`https://mempool.space/api/block/${hash}`);
  return { time: Number(block.timestamp) * 1000, height: block.height };
}

function levels(rows) {
  return (rows || [])
    .map((row) => {
      if (Array.isArray(row)) return { price: Number(row[0]), size: Number(row[1]) };
      return { price: Number(row.price), size: Number(row.amount ?? row.size) };
    })
    .filter((row) => row.price > 0 && row.size > 0);
}

export function sellPressure(bids, asks) {
  if (!bids.length || !asks.length) return null;
  const bestBid = Math.max(...bids.map((row) => row.price));
  const bestAsk = Math.min(...asks.map((row) => row.price));
  const mid = (bestBid + bestAsk) / 2;
  const askBand = asks.filter((row) => row.price <= mid * 1.02);
  const bidBand = bids.filter((row) => row.price >= mid * 0.98);
  const askVol = askBand.reduce((sum, row) => sum + row.size, 0);
  const bidVol = bidBand.reduce((sum, row) => sum + row.size, 0);
  const big = asks.find((row) => row.size >= 25);
  const ratio = bidVol > 0 ? askVol / bidVol : askVol > 0 ? Infinity : 0;
  const warn = ratio >= 3 || Boolean(big);
  return { warn, ratio, big: big ? big.size : 0, askVol, bidVol, mid };
}

export async function fetchSellWarnings() {
  const found = [];
  try {
    const data = await fetchJson("https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=100");
    const book = data.result[Object.keys(data.result)[0]];
    const pressure = sellPressure(levels(book.bids), levels(book.asks));
    if (pressure?.warn) found.push({ venue: "Kraken", ...pressure });
  } catch {
    /* Kraken is the primary book; a miss is reported by the caller if both fail. */
  }
  try {
    // Coinbase Exchange is already used for candles and allows browser CORS.
    const book = await fetchJson("https://api.exchange.coinbase.com/products/BTC-USD/book?level=2");
    const pressure = sellPressure(levels(book.bids), levels(book.asks));
    if (pressure?.warn) found.push({ venue: "Coinbase", ...pressure });
  } catch {
    /* Kraken is checked first; a miss here only drops the second venue. */
  }
  return found;
}
