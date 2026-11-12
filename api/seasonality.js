// Vercel Serverless Function: GET /api/seasonality
// Берёт месячные свечи с Yahoo Finance, считает сезонность за последние 20 полных лет
// и факт прошлого и текущего года. Ответ кэшируется на CDN Vercel на 12 часов.

const fs = require('fs');
const path = require('path');

const INSTRUMENTS = [
  { id: 'XAUUSD', yahoo: 'GC=F' },
  { id: 'XAGUSD', yahoo: 'SI=F' },
  { id: 'XPTUSD', yahoo: 'PL=F' },
  { id: 'USOIL', yahoo: 'CL=F' },
  { id: 'UKOIL', yahoo: 'BZ=F' },
  { id: 'NDX100', yahoo: '^NDX' },
  { id: 'US500', yahoo: '^GSPC' },
  { id: 'US30', yahoo: '^DJI' },
  { id: 'US2000', yahoo: '^RUT' },
  { id: 'GER30', yahoo: '^GDAXI' },
  { id: 'FRA40', yahoo: '^FCHI' },
  { id: 'EU50', yahoo: '^STOXX50E' },
  { id: 'UK100', yahoo: '^FTSE' },
  { id: 'JP225', yahoo: '^N225' },
  { id: 'HK50', yahoo: '^HSI' },
  { id: 'AUS200', yahoo: '^AXJO' },
  { id: 'DXY', yahoo: 'DX-Y.NYB' },
  { id: 'EURUSD', yahoo: 'EURUSD=X' },
  { id: 'GBPUSD', yahoo: 'GBPUSD=X' },
  { id: 'USDJPY', yahoo: 'JPY=X' },
  { id: 'USDCHF', yahoo: 'CHF=X' },
  { id: 'USDCAD', yahoo: 'CAD=X' },
  { id: 'AUDUSD', yahoo: 'AUDUSD=X' },
  { id: 'NZDUSD', yahoo: 'NZDUSD=X' },
  { id: 'EURJPY', yahoo: 'EURJPY=X' },
  { id: 'GBPJPY', yahoo: 'GBPJPY=X' },
  { id: 'AUDJPY', yahoo: 'AUDJPY=X' },
  { id: 'CADJPY', yahoo: 'CADJPY=X' },
  { id: 'EURGBP', yahoo: 'EURGBP=X' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function round(x, d = 2) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

// Yahoo chart JSON (дневные свечи) -> закрытия по месяцам:
//   m:   последнее закрытие месяца
//   d10: последнее закрытие с 1 по 10 число
//   d20: последнее закрытие с 1 по 20 число
// Дата берётся в часовом поясе биржи, поэтому летнее время и пояса бирж ничего не сдвигают.
function parseDaily(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('no data');
  const meta = r.meta || {};
  const tz = meta.gmtoffset || 0;
  let fmt = null;
  try {
    if (meta.exchangeTimezoneName) fmt = new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (e) { fmt = null; }
  const adj = r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  const close = r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
  const vals = adj && adj.some((v) => v != null) ? adj : close;
  const out = { m: {}, d10: {}, d20: {} };
  r.timestamp.forEach((t, i) => {
    const v = vals[i];
    if (v == null || !isFinite(v) || v <= 0) return;
    let y, mo, d;
    if (fmt) {
      const p = fmt.formatToParts(new Date(t * 1000));
      y = p.find((x) => x.type === 'year').value; mo = p.find((x) => x.type === 'month').value; d = +p.find((x) => x.type === 'day').value;
    } else {
      const dt = new Date((t + tz + 43200) * 1000);
      y = String(dt.getUTCFullYear()); mo = String(dt.getUTCMonth() + 1).padStart(2, '0'); d = dt.getUTCDate();
    }
    const key = y + '-' + mo;
    out.m[key] = v; // свечи идут по порядку, остаётся последнее закрытие
    if (d <= 10) out.d10[key] = v;
    if (d <= 20) out.d20[key] = v;
  });
  return out;
}
function monthlyCloses(json) { return parseDaily(json).m; }

function prevKey(y, m) { return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); }

function summarize(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const pos = v.filter((x) => x > 0), neg = v.filter((x) => x < 0);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return {
    avg: round(v.reduce((a, b) => a + b, 0) / v.length),
    med: round(med),
    up: Math.round((100 * pos.length) / v.length),
    abs: round(v.reduce((a, b) => a + Math.abs(b), 0) / v.length),
    n: v.length,
    avgUp: pos.length ? round(pos.reduce((a, b) => a + b, 0) / pos.length) : null,
    avgDn: neg.length ? round(neg.reduce((a, b) => a + b, 0) / neg.length) : null,
  };
}

// Части месяца: 1–10, 11–20, 21–конец. Для каждой: 12 месяцев × 3 части.
function partsFor(p, y0, y1) {
  const res = [];
  for (let m = 1; m <= 12; m++) {
    const v = [[], [], []];
    for (let y = y0; y <= y1; y++) {
      const k = y + '-' + String(m).padStart(2, '0'), pk = prevKey(y, m);
      const c0 = p.m[pk], c10 = p.d10[k], c20 = p.d20[k], c30 = p.m[k];
      if (c0 && c10) v[0].push(round((c10 / c0 - 1) * 100));
      if (c10 && c20) v[1].push(round((c20 / c10 - 1) * 100));
      if (c20 && c30) v[2].push(round((c30 / c20 - 1) * 100));
    }
    res.push(v.map((x) => { const r = summarize(x); if (r) { delete r.abs; } return r; }));
  }
  return res;
}

function monthReturn(closes, y, m) {
  const k = y + '-' + String(m).padStart(2, '0');
  const pk = m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  if (closes[k] == null || closes[pk] == null) return null;
  return round((closes[k] / closes[pk] - 1) * 100);
}

// Устойчивость: тот же месяц за последние 10 лет и за всю доступную историю (до 40 лет).
// u = сколько лет рост, n = сколько лет есть, a = средний ход, yM = первый год истории.
function windowsFor(closes, yMin, y1) {
  const res = [];
  for (let m = 1; m <= 12; m++) {
    const all = [];
    for (let y = yMin; y <= y1; y++) { const r = monthReturn(closes, y, m); if (r != null) all.push([y, r]); }
    const last = all.filter((x) => x[0] >= y1 - 9);
    const cnt = (a) => a.filter((x) => x[1] > 0).length;
    const avg = (a) => (a.length ? round(a.reduce((q, x) => q + x[1], 0) / a.length) : null);
    res.push({ u10: cnt(last), n10: last.length, a10: avg(last), uM: cnt(all), nM: all.length, aM: avg(all), yM: all.length ? all[0][0] : null });
  }
  return res;
}

function statsFor(closes, y0, y1) {
  const res = [];
  for (let m = 1; m <= 12; m++) {
    const v = [];
    for (let y = y0; y <= y1; y++) {
      const r = monthReturn(closes, y, m);
      if (r != null) v.push(r);
    }
    res.push(summarize(v));
  }
  return res;
}

async function fetchYahoo(symbol, fromYear) {
  const now = Math.floor(Date.now() / 1000);
  const p1 = Math.floor(Date.UTC(fromYear - 1, 10, 1) / 1000);
  // fromYear: первый год окна (для максимальной истории это y1 - 39, то есть до 40 лет)
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (const h of hosts) {
    try {
      const url = `https://${h}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${now}&includeAdjustedClose=true`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e && e.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function loadFallback() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'fallback.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

async function build() {
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const y1 = curYear - 1;
  const y0 = y1 - 19;
  const yMin = y1 - 39; // максимальная история: до 40 лет
  const fb = loadFallback();
  const out = {
    source: 'yahoo',
    updated: now.toISOString(),
    period: [y0, y1],
    prevYear: y1,
    curYear,
    stats: {},
    actual: {},
    parts: {},
    win: {},
    method: {},
    failed: [],
  };
  const results = await pool(INSTRUMENTS, 6, async (ins) => {
    const json = await fetchYahoo(ins.yahoo, yMin);
    return parseDaily(json);
  });
  INSTRUMENTS.forEach((ins, k) => {
    const pd = results[k];
    const closes = pd && !pd.error ? pd.m : null;
    const st = closes ? statsFor(closes, y0, y1) : null;
    // данные годятся, только если в каждом месяце есть хотя бы 15 лет из 20
    const good = st && st.every((m) => m && m.n >= 15);
    if (good) {
      out.stats[ins.id] = st;
      const prev = [], cur = [];
      for (let m = 1; m <= 12; m++) { prev.push(monthReturn(closes, y1, m)); cur.push(monthReturn(closes, curYear, m)); }
      out.actual[ins.id] = { prev, cur };
      out.method[ins.id] = 'close';
      out.win[ins.id] = windowsFor(closes, yMin, y1);
      const pt = partsFor(pd, y0, y1);
      if (pt.every((m) => m.every((x) => x && x.n >= 15))) out.parts[ins.id] = pt;
    } else if (fb && fb.stats[ins.id]) {
      out.stats[ins.id] = fb.stats[ins.id];
      out.actual[ins.id] = fb.actual[ins.id];
      out.method[ins.id] = fb.method[ins.id];
      out.failed.push(ins.id);
    } else {
      out.failed.push(ins.id);
    }
  });
  if (!Object.keys(out.stats).length || out.failed.length === INSTRUMENTS.length) {
    if (fb) return Object.assign({}, fb, { source: 'fallback' });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const data = await build();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // CDN Vercel держит ответ 12 часов и ещё сутки отдаёт старый, пока обновляет в фоне
    res.setHeader('Cache-Control', 'public, s-maxage=43200, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify(data));
  } catch (e) {
    const fb = loadFallback();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600');
    if (fb) res.status(200).send(JSON.stringify(Object.assign({}, fb, { source: 'fallback' })));
    else res.status(500).send(JSON.stringify({ error: String(e && e.message || e) }));
  }
};

module.exports._test = { windowsFor, parseDaily, monthlyCloses, statsFor, partsFor, monthReturn, INSTRUMENTS, build };
