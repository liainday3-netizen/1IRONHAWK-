# IronHawk Mobile — fullstack

Fail-closed DEX_MATRIX terminal. Node server (no dependencies) + mobile web client.

    npm start                         # http://localhost:8787
    IRONHAWK_TOKEN=secret npm start   # require a Bearer token on /api
    npm test

Env: `PORT`, `IRONHAWK_TOKEN`, `IRONHAWK_DATA` (default `data/state.json`).

## What moved to the server
- Price feed (CoinGecko, every 30 s); quotes older than 90 s mark the feed stale.
- Signals, guards, sizing and every BUY/SELL gate. The client can't get around them.
- Paper book, cash, risk settings and log are saved to a JSON file.
- The server always starts disarmed. Each fill or intent disarms it again.

## API
GET /api/health · GET /api/state · POST /api/settings · /api/arm · /api/refresh · /api/buy · /api/sell · /api/reset

LIVE_INTENT returns `intentUrl` (Jupiter/Uniswap). You confirm in your wallet. Nothing holds keys or signs.
