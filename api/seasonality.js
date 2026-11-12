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

// Yahoo chart JSON (дневные свечи) -> { 'YYYY-MM': последнее закрытие месяца }
// Месяц определяется по дате в часовом поясе биржи, поэтому переход на летнее время
// и разные часовые пояса бирж не сдвигают месяцы.
function monthlyCloses(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('no data');
  const meta = r.meta || {};
  const tz = meta.gmtoffset || 0;
  let fmt = null;
  try {
    if (meta.exchangeTimezoneName) fmt = new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit' });
  } catch (e) { fmt = null; }
  const adj = r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  const close = r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close;
  const vals = adj && adj.some((v) => v != null) ? adj : close;
  const out = {};
  r.timestamp.forEach((t, i) => {
    const v = vals[i];
    if (v == null || !isFinite(v) || v <= 0) return;
    let key;
    if (fmt) {
      const p = fmt.formatToParts(new Date(t * 1000));
      key = p.find((x) => x.type === 'year').value + '-' + p.find((x) => x.type === 'month').value;
    } else {
      const d = new Date((t + tz + 43200) * 1000);
      key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    }
    out[key] = v; // свечи идут по порядку, остаётся последнее закрытие месяца
  });
  return out;
}

function monthReturn(closes, y, m) {
  const k = y + '-' + String(m).padStart(2, '0');
  const pk = m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  if (closes[k] == null || closes[pk] == null) return null;
  return round((closes[k] / closes[pk] - 1) * 100);
}

function statsFor(closes, y0, y1) {
  const res = [];
  for (let m = 1; m <= 12; m++) {
    const v = [];
    for (let y = y0; y <= y1; y++) {
      const r = monthReturn(closes, y, m);
      if (r != null) v.push(r);
    }
    if (!v.length) { res.push(null); continue; }
    const s = v.slice().sort((a, b) => a - b);
    const pos = v.filter((x) => x > 0), neg = v.filter((x) => x < 0);
    const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    res.push({
      avg: round(v.reduce((a, b) => a + b, 0) / v.length),
      med: round(med),
      up: Math.round((100 * v.filter((x) => x > 0).length) / v.length),
      abs: round(v.reduce((a, b) => a + Math.abs(b), 0) / v.length),
      n: v.length,
      avgUp: pos.length ? round(pos.reduce((a, b) => a + b, 0) / pos.length) : null,
      avgDn: neg.length ? round(neg.reduce((a, b) => a + b, 0) / neg.length) : null,
    });
  }
  return res;
}

async function fetchYahoo(symbol, fromYear) {
  const now = Math.floor(Date.now() / 1000);
  const p1 = Math.floor(Date.UTC(fromYear - 1, 10, 1) / 1000);
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
  const fb = loadFallback();
  const out = {
    source: 'yahoo',
    updated: now.toISOString(),
    period: [y0, y1],
    prevYear: y1,
    curYear,
    stats: {},
    actual: {},
    method: {},
    failed: [],
  };
  const results = await pool(INSTRUMENTS, 6, async (ins) => {
    const json = await fetchYahoo(ins.yahoo, y0);
    return monthlyCloses(json);
  });
  INSTRUMENTS.forEach((ins, k) => {
    const closes = results[k];
    const st = closes && !closes.error ? statsFor(closes, y0, y1) : null;
    // данные годятся, только если в каждом месяце есть хотя бы 15 лет из 20
    const good = st && st.every((m) => m && m.n >= 15);
    if (good) {
      out.stats[ins.id] = st;
      const prev = [], cur = [];
      for (let m = 1; m <= 12; m++) { prev.push(monthReturn(closes, y1, m)); cur.push(monthReturn(closes, curYear, m)); }
      out.actual[ins.id] = { prev, cur };
      out.method[ins.id] = 'close';
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

module.exports._test = { monthlyCloses, statsFor, monthReturn, INSTRUMENTS, build };
