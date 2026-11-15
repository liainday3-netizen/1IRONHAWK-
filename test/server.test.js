const test = require("node:test");
const assert = require("node:assert");
const { scanAsset, regimeOf, buyBlock, swapUrl, _internals: I } = require("../server.js");
const SOL = { id: "solana", symbol: "SOL", chain: "solana", key: "solana:solana" };
function setQuote(usd, ch, age = 0) { I.feed.quotes.solana = { usd, usd_24h_change: ch }; I.feed.fetchedAt = Date.now() - age; }

test("regimes", () => { assert.equal(regimeOf(0.5), "CALM"); assert.equal(regimeOf(9), "EXTREME"); });
test("stale feed fails closed", () => { setQuote(100, 5, 200000); const s = scanAsset(SOL); assert.equal(s.signal, "SYNC_ERROR"); assert.equal(s.confidence, 0); });
test("bull signal", () => { setQuote(100, 2); assert.equal(scanAsset(SOL).signal, "BULL_EXEC"); });
test("extreme vol blocked", () => { setQuote(100, 12); assert.equal(scanAsset(SOL).guard, "EXTREME_VOL_BLOCK"); });
test("buy requires arm", () => {
  I.load(); setQuote(100, 2); const s = scanAsset(SOL);
  I.state.armed = false; assert.match(buyBlock(s), /disarmed/);
  I.state.armed = true; I.state.capital = 100; I.state.sizeUsd = 10; assert.equal(buyBlock(s), null);
  I.state.capital = 1; assert.match(buyBlock(s), /larger/);
});
test("swap urls", () => { assert.equal(swapUrl(SOL, "BUY"), "https://jup.ag/swap/USDC-SOL"); });
