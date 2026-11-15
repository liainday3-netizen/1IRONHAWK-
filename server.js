// IronHawk Mobile — fullstack server (Node 18+, zero dependencies)
// Paper book, risk gates and price feed live on the server.
// LIVE_INTENT only returns a DEX URL; the server never holds keys or signs.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.IRONHAWK_TOKEN || ""; // if set, required as Bearer token on /api
const DATA_FILE = process.env.IRONHAWK_DATA || path.join(__dirname, "data", "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const FEED_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,bitcoin&vs_currencies=usd&include_24hr_change=true";
const FEED_INTERVAL_MS = 30000;
const STALE_MS = 90000;
const MAX_ORDER = 1000;

const ASSETS = [
  { id: "solana", symbol: "SOL", chain: "solana", dex: "JUPITER", pair: "SOL/USDC", key: "solana:solana" },
  { id: "ethereum", symbol: "ETH", chain: "ethereum", dex: "UNISWAP_V3", pair: "ETH/USDC", key: "ethereum:ethereum" },
  { id: "bitcoin", symbol: "WBTC", chain: "ethereum", dex: "UNISWAP_V3", pair: "WBTC/USDC", key: "ethereum:bitcoin" },
  { id: "ethereum", symbol: "ETH", chain: "base", dex: "UNISWAP_V3", pair: "ETH/USDC", key: "base-eth" }
];

// ---------- persistence ----------
function blank() {
  return { capital: 10, riskPct: 1, mode: "PAPER", armed: false, selected: "solana:solana",
    sizeUsd: 10, positions: [], log: [] };
}
let state = blank();
let feed = { quotes: {}, fetchedAt: 0, status: "FEED_OFF", error: null };

function load() {
  try { state = Object.assign(blank(), JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))); }
  catch { state = blank(); }
  state.armed = false; // always boot disarmed (fail closed)
}
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  state.log = state.log.slice(0, 200);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function addLog(text) { state.log.unshift({ t: new Date().toISOString(), text }); save(); }

// ---------- domain logic ----------
const assetByKey = (k) => ASSETS.find((a) => a.key === k);
const quoteFor = (a) => feed.quotes[a.id] || null;
const money = (n) => Number.isFinite(n) ? "$" + n.toFixed(n < 1 ? 6 : 2) : "—";

function regimeOf(abs) {
  if (abs < 1) return "CALM";
  if (abs < 3) return "NORMAL";
  if (abs < 8) return "VOLATILE";
  return "EXTREME";
}
function scanAsset(a, now = Date.now()) {
  const q = quoteFor(a);
  const age = now - feed.fetchedAt;
  const fresh = feed.fetchedAt > 0 && age >= 0 && age <= STALE_MS && !!q && Number.isFinite(q.usd);
  const ch = q && Number.isFinite(q.usd_24h_change) ? q.usd_24h_change : 0;
  const abs = Math.abs(ch);
  const regime = fresh ? regimeOf(abs) : "UNKNOWN";
  let signal = "WAITING";
  if (!fresh) signal = "SYNC_ERROR";
  else if (regime === "EXTREME") signal = "FILTERED_BIAS";
  else if (ch >= 1.5) signal = "BULL_EXEC";
  else if (ch <= -1.5) signal = "BEAR_EXEC";
  else if (abs >= 0.4) signal = "IN_HTF_POI";
  const guard = !fresh ? "STALE_FEED" : regime === "EXTREME" ? "EXTREME_VOL_BLOCK" : "ADAPTIVE_GUARDS_CLEAR";
  const confidence = !fresh ? 0 : Math.max(8, Math.min(92, 40 + abs * 8));
  return { key: a.key, signal, regime, guard, confidence, fresh, change: ch, price: q ? q.usd : null };
}
const openPositions = () => state.positions.filter((p) => p.status === "OPEN" && p.remainingUsd > 0.01);
const equity = () => state.capital + openPositions().reduce((s, p) => s + p.remainingUsd, 0);
function orderSize() {
  const riskSized = equity() * (state.riskPct / 100);
  return Math.min(MAX_ORDER, Math.max(1, Number(state.sizeUsd) || riskSized));
}
function buyBlock(scan) {
  if (!state.armed) return "Terminal is disarmed.";
  if (!scan.fresh) return "Waiting for a fresh price update.";
  if (scan.guard !== "ADAPTIVE_GUARDS_CLEAR") return scan.guard;
  if (scan.signal !== "BULL_EXEC") return "A fresh BULL_EXEC signal is required to buy.";
  if (state.mode === "PAPER" && orderSize() > state.capital) return "Order is larger than paper cash.";
  return null;
}
function swapUrl(a, side) {
  if (a.chain === "solana") return side === "BUY" ? "https://jup.ag/swap/USDC-SOL" : "https://jup.ag/swap/SOL-USDC";
  const tok = a.symbol === "WBTC" ? "WBTC" : "ETH";
  const [input, output] = side === "BUY" ? ["USDC", tok] : [tok, "USDC"];
  return `https://app.uniswap.org/swap?chain=${a.chain === "base" ? "base" : "ethereum"}&inputCurrency=${input}&outputCurrency=${output}`;
}

// ---------- price feed ----------
async function refreshQuotes() {
  feed.status = "FEED_SYNC";
  try {
    const ctl = AbortSignal.timeout(10000);
    const res = await fetch(FEED_URL, { signal: ctl, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    for (const id of ["bitcoin", "ethereum", "solana"]) if (data[id]) feed.quotes[id] = data[id];
    feed.fetchedAt = Date.now();
    feed.status = "LIVE_FEED";
    feed.error = null;
  } catch (err) {
    feed.status = "FEED_BLOCKED";
    feed.error = err && err.message ? err.message : "network";
    addLog("Price feed failed: " + feed.error);
  }
}

// ---------- snapshot ----------
function snapshot() {
  const now = Date.now();
  return {
    serverTime: now, maxOrder: MAX_ORDER,
    feed: { status: feed.status, fetchedAt: feed.fetchedAt, error: feed.error },
    assets: ASSETS.map((a) => ({ ...a, scan: scanAsset(a, now) })),
    settings: { capital: state.capital, riskPct: state.riskPct, mode: state.mode, armed: state.armed,
      selected: state.selected, sizeUsd: state.sizeUsd },
    account: { cash: state.capital, equity: equity(), open: openPositions().length, orderSize: orderSize(),
      riskSize: equity() * state.riskPct / 100 },
    positions: state.positions.slice().reverse().map((p) => {
      const a = assetByKey(p.key); const q = a && quoteFor(a);
      const mark = q && p.status === "OPEN" ? p.tokens * q.usd : null;
      return { ...p, mark, pnl: mark == null ? 0 : mark - p.remainingUsd };
    }),
    log: state.log.slice(0, 40),
    buyBlock: buyBlock(scanAsset(assetByKey(state.selected) || ASSETS[0], now))
  };
}

// ---------- actions ----------
class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const actions = {
  "POST /api/settings"(b) {
    if (b.selected !== undefined) { if (!assetByKey(b.selected)) throw new ApiError(400, "Unknown asset."); state.selected = b.selected; }
    if (b.sizeUsd !== undefined) state.sizeUsd = Math.min(MAX_ORDER, Math.max(1, num(b.sizeUsd, 1)));
    if (b.mode !== undefined) {
      if (!["PAPER", "LIVE_INTENT"].includes(b.mode)) throw new ApiError(400, "Bad mode.");
      if (b.mode !== state.mode) { state.mode = b.mode; state.armed = false; addLog("Mode set to " + state.mode + ". Terminal disarmed."); }
    }
    if (b.capital !== undefined || b.riskPct !== undefined) {
      if (b.capital !== undefined) state.capital = Math.max(0, num(b.capital, 0));
      if (b.riskPct !== undefined) state.riskPct = Math.min(5, Math.max(0.1, num(b.riskPct, 1)));
      addLog("Risk saved. Cash " + money(state.capital) + " risk " + state.riskPct + "%");
    }
    save();
  },
  "POST /api/arm"(b) {
    state.armed = !!b.armed;
    addLog(state.armed ? "Terminal armed." : "Kill switch: disarmed.");
  },
  async "POST /api/refresh"() { await refreshQuotes(); },
  "POST /api/buy"(b) {
    const a = assetByKey(b.key || state.selected);
    if (!a) throw new ApiError(400, "Unknown asset.");
    const scan = scanAsset(a);
    const block = buyBlock(scan);
    if (block) throw new ApiError(409, block);
    const usd = orderSize();
    state.armed = false; // one shot per arm
    if (state.mode === "LIVE_INTENT") {
      const url = swapUrl(a, "BUY");
      addLog("LIVE_INTENT BUY " + a.symbol + " " + money(usd) + " → " + url);
      return { intentUrl: url };
    }
    state.capital -= usd;
    state.positions.push({ id: Date.now() * 1000 + crypto.randomInt(1000), symbol: a.symbol, chain: a.chain, key: a.key,
      entry: scan.price, remainingUsd: usd, tokens: usd / scan.price, status: "OPEN", openedAt: new Date().toISOString() });
    addLog("PAPER BUY " + a.symbol + " " + money(usd) + " @ " + money(scan.price));
  },
  "POST /api/sell"(b) {
    const pct = num(b.pct, 0);
    if (![25, 50, 100].includes(pct)) throw new ApiError(400, "pct must be 25, 50 or 100.");
    const p = state.positions.find((x) => x.id === Number(b.id) && x.status === "OPEN");
    if (!p) throw new ApiError(404, "Open position not found.");
    const a = assetByKey(p.key);
    const scan = scanAsset(a);
    if (!scan.fresh) throw new ApiError(409, "No fresh price. Refresh the feed before closing.");
    if (!state.armed) throw new ApiError(409, "Arm the terminal before a close.");
    state.armed = false;
    if (state.mode === "LIVE_INTENT") {
      const url = swapUrl(a, "SELL");
      addLog("LIVE_INTENT SELL " + pct + "% " + p.symbol + " → " + url);
      return { intentUrl: url };
    }
    const f = pct / 100;
    const slice = p.remainingUsd * f, tokens = p.tokens * f, proceeds = tokens * scan.price;
    p.remainingUsd -= slice; p.tokens -= tokens; state.capital += proceeds;
    if (pct === 100 || p.remainingUsd < 0.01) { p.status = "CLOSED"; p.remainingUsd = 0; p.tokens = 0; p.closedAt = new Date().toISOString(); }
    addLog("PAPER SELL " + pct + "% " + p.symbol + " proceeds " + money(proceeds));
  },
  "POST /api/reset"() {
    state.positions = []; state.log = []; state.armed = false; save();
  }
};

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };
const SEC_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...SEC_HEADERS });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e5) { reject(new ApiError(413, "Body too large.")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new ApiError(400, "Invalid JSON.")); } });
  });
}
function authorized(req) {
  if (!TOKEN) return true;
  const h = Buffer.from(req.headers.authorization || "");
  const want = Buffer.from("Bearer " + TOKEN);
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (url.pathname === "/api/health") return send(res, 200, { ok: true, feed: feed.status });
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized." });
    try {
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, snapshot());
      const fn = actions[req.method + " " + url.pathname];
      if (!fn) return send(res, 404, { error: "Not found." });
      const body = await readBody(req);
      const extra = (await fn(body)) || {};
      save();
      return send(res, 200, { ...snapshot(), ...extra });
    } catch (e) {
      return send(res, e.code || 500, { error: e.message || "Server error." });
    }
  }
  // static
  let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", ...SEC_HEADERS });
    res.end(buf);
  });
});

if (require.main === module) {
  load();
  refreshQuotes();
  setInterval(refreshQuotes, FEED_INTERVAL_MS).unref();
  server.listen(PORT, () => console.log(`IronHawk listening on http://localhost:${PORT}` + (TOKEN ? " (token required)" : "")));
}

module.exports = { server, scanAsset, regimeOf, buyBlock, swapUrl, _internals: { get state() { return state; }, set state(s) { state = s; }, feed, load } };
