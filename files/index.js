// index.js — SlitherCash multiplayer server entry point.
//
// Run: node index.js
// Env: PORT (default 8787)
//
// Protocol (JSON text frames over WebSocket):
//
//   Client -> Server
//     { t:"join",   name, buyin, skinIndex }   // must be sent first
//     { t:"input",  angle, boosting }          // steering, send ~20x/sec
//     { t:"cashout" }
//     { t:"ping",   ts }
//
//   Server -> Client
//     { t:"welcome",        id, cfg:{WORLD_RADIUS, LEN_PER_DOLLAR, TICK_RATE} }
//     { t:"snapshot",       youId, snakes:[...], orbs:[...], elapsed }
//     { t:"death",          killerName, buyin, bestRank, coinsEaten }
//     { t:"cashout_result", amount, buyin, bestRank, coinsEaten }
//     { t:"pong",           ts }
//     { t:"error",          message }

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { attachWebSocketServer } = require('./wsProtocol');
const { GameWorld, CFG } = require('./gameServer');
const SolanaWallet = require('./solanaWallet');

const PORT = process.env.PORT || 8787;
const TICK_MS = 1000 / CFG.TICK_RATE;
const MAX_NAME_LEN = 16;

// Initialize Solana wallet
const solana = new SolanaWallet();
console.log('Game wallet address:', solana.getDepositAddress());

// Flat layout — every file lives together in one folder, no subfolders:
//   slithercash/
//     slithercash.html
//     index.js   <- this file
//     gameServer.js
//     wsProtocol.js
//     package.json
const CLIENT_HTML_PATH = path.join(__dirname, 'slithercash.html');

const world = new GameWorld();

/** connId -> { conn: WSConnection, playerId: string|null } */
const sessions = new Map();
let connCounter = 1;

const httpServer = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Simple healthcheck endpoint — useful for Railway/Render/Fly health probes.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: countPlayers(), bots: countBots() }));
    return;
  }

  // ==================== SOLANA API ENDPOINTS (AUTOMATIC) ====================

  // Get or create player's unique deposit address
  if (req.url.startsWith('/api/player-deposit-address') && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const playerId = url.searchParams.get('playerId') || 'guest';
    const address = solana.getPlayerDepositAddress(playerId);
    const balance = solana.getPlayerBalance(playerId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      address: address,
      balance: balance.credits,
      solBalance: balance.sol,
      rate: '1 SOL = 100 credits'
    }));
    return;
  }

  // Get player balance (poll this from game)
  if (req.url.startsWith('/api/player-balance') && req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const playerId = url.searchParams.get('playerId') || 'guest';
    const balance = solana.getPlayerBalance(playerId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      balance: {
        sol: balance.sol,
        credits: balance.credits,
        address: balance.address
      }
    }));
    return;
  }

  // Process withdrawal
  if (req.url === '/api/withdraw' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const playerBalance = solana.getPlayerBalance(data.playerId);
        
        // Check if player has enough SOL
        if (playerBalance.sol < data.solAmount) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Insufficient SOL balance' }));
          return;
        }
        
        // Process withdrawal
        const result = await solana.withdraw(data.playerAddress, data.solAmount);
        
        if (result.success) {
          // Deduct from player
          solana.deductPlayerBalance(data.playerId, data.solAmount);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            signature: result.signature,
            solAmount: result.solAmount,
            message: `Withdrew ${result.solAmount} SOL`
          }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;

    return;
  }

  // ==================== END SOLANA ENDPOINTS ====================

  if (req.url === '/' || req.url === '/index.html' || req.url === '/slithercash.html') {
    fs.readFile(CLIENT_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(
          'Could not find slithercash.html.\n\n' +
          'Expected it right next to this server, at:\n' + CLIENT_HTML_PATH + '\n\n' +
          'Make sure every file sits in the SAME folder, no subfolders:\n' +
          '  slithercash/\n' +
          '    slithercash.html\n' +
          '    index.js   <- you are running this one\n' +
          '    gameServer.js\n' +
          '    wsProtocol.js\n' +
          '    package.json\n'
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found.');
});

function countPlayers() {
  let n = 0;
  for (const s of world.snakes.values()) if (s.isPlayer) n++;
  return n;
}
function countBots() {
  let n = 0;
  for (const s of world.snakes.values()) if (!s.isPlayer) n++;
  return n;
}

attachWebSocketServer(httpServer, (conn, req) => {
  const connId = 'c' + (connCounter++);
  sessions.set(connId, { conn, playerId: null });

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    handleMessage(connId, msg);
  });

  conn.on('close', () => {
    const session = sessions.get(connId);
    if (session && session.playerId) {
      world.removePlayer(session.playerId);
    }
    sessions.delete(connId);
  });

  conn.on('error', () => {
    // 'close' will also fire; nothing extra needed here.
  });
});

function handleMessage(connId, msg) {
  const session = sessions.get(connId);
  if (!session || !msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'join': {
      if (session.playerId) return; // already joined
      const name = typeof msg.name === 'string' ? msg.name.slice(0, MAX_NAME_LEN) : 'Player';
      const buyin = clampNum(msg.buyin, CFG.MIN_BUYIN, CFG.MAX_BUYIN, CFG.DEFAULT_BUYIN);
      const skinIndex = Number.isInteger(msg.skinIndex) ? msg.skinIndex : 0;
      const playerId = connId; // reuse the connection id as the snake id — simple and unique
      world.addPlayer({ id: playerId, name, buyin, skinIndex });
      session.playerId = playerId;
      
      session.conn.send({
        t: 'welcome',
        id: playerId,
        cfg: { WORLD_RADIUS: CFG.WORLD_RADIUS, LEN_PER_DOLLAR: CFG.TICK_RATE, TICK_RATE: CFG.TICK_RATE },
      });
      break;
    }
    case 'input': {
      if (!session.playerId) return;
      world.setInput(session.playerId, Number(msg.angle), !!msg.boosting);
      break;
    }
    case 'cashout': {
      if (!session.playerId) return;
      world.requestCashout(session.playerId);
      // NOTE: don't clear session.playerId here — drainEvents() still needs
      // to look this session up by playerId to deliver the cashout_result
      // message on the next tick. It clears playerId itself once sent.
      break;
    }
    case 'ping': {
      session.conn.send({ t: 'pong', ts: msg.ts });
      break;
    }
    default:
      break;
  }
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Route per-player events (death/cashout results) generated during tick(). */
function drainEvents() {
  if (world.events.length === 0) return;
  for (const evt of world.events) {
    const session = findSessionByPlayerId(evt.targetId);
    if (!session) continue;
    if (evt.type === 'death') {
      session.conn.send({ t: 'death', ...evt.data });
      session.playerId = null;
    } else if (evt.type === 'cashout_result') {
      session.conn.send({ t: 'cashout_result', ...evt.data });
      session.playerId = null;
    }
  }
  world.events.length = 0;
}

function findSessionByPlayerId(playerId) {
  for (const session of sessions.values()) {
    if (session.playerId === playerId) return session;
  }
  return null;
}

function broadcastSnapshot() {
  const snap = world.snapshot();
  const base = JSON.stringify({ t: 'snapshot', snakes: snap.snakes, orbs: snap.orbs, elapsed: snap.elapsed });
  for (const session of sessions.values()) {
    if (!session.playerId) continue; // don't spam data to un-joined sockets
    // youId differs per client, so we can't reuse the exact same string for everyone.
    session.conn.send(insertYouId(base, session.playerId));
  }
}

// Cheap way to personalize the youId field without re-serializing the whole
// (potentially large) snapshot per connection.
function insertYouId(baseJson, youId) {
  return baseJson.replace('{"t":"snapshot",', `{"t":"snapshot","youId":${JSON.stringify(youId)},`);
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  world.tick(dt);
  drainEvents();
  broadcastSnapshot();
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`SlitherCash multiplayer server listening on :${PORT}`);
  console.log(`Healthcheck: http://localhost:${PORT}/health`);
  console.log(`Game wallet: ${solana.getDepositAddress()}`);
});

process.on('SIGINT', () => { world.stop(); process.exit(0); });
process.on('SIGTERM', () => { world.stop(); process.exit(0); });
