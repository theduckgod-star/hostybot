'use strict';

// ============================================================
// MINECRAFT AFK BOT v3.0 - Forge 1.20.1 Optimized Edition
// ============================================================

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');

// ── CONFIG ───────────────────────────────────────────────────
const config = require('./settings.json');

// ── CONSTANTS ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const SELF_PING_INTERVAL = 10 * 60 * 1000;       // 10 minutes
const DISCORD_COOLDOWN = 5000;                     // 5s between webhooks
const MAX_ERRORS = 100;                            // cap error log
const CONNECTION_TIMEOUT = 150000;                 // 150s spawn timeout
const BASE_RECONNECT = config.utils?.['auto-reconnect-delay'] || 3000;
const MAX_RECONNECT = config.utils?.['max-reconnect-delay'] || 30000;

// ── STATE ─────────────────────────────────────────────────────
const state = {
  connected: false,
  startTime: Date.now(),
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  wasThrottled: false,
  errors: [],
  lastDiscordSend: 0,
};

let bot = null;
let activeIntervals = [];
let reconnectTimer = null;
let connectionTimer = null;
let isReconnecting = false;
let spawnHandled = false;

// ── LOGGING ───────────────────────────────────────────────────
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// ── INTERVAL MANAGEMENT ───────────────────────────────────────
function addInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}

function clearIntervals() {
  activeIntervals.forEach(clearInterval);
  activeIntervals = [];
}

function clearTimers() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
}

// ── RECONNECT ─────────────────────────────────────────────────
function getReconnectDelay() {
  if (state.wasThrottled) {
    state.wasThrottled = false;
    return 60000 + Math.random() * 60000;
  }
  const delay = Math.min(BASE_RECONNECT * Math.pow(1.5, state.reconnectAttempts), MAX_RECONNECT);
  return delay + Math.random() * 2000;
}

function scheduleReconnect() {
  clearTimers();
  if (isReconnecting) return;
  isReconnecting = true;
  state.reconnectAttempts++;
  const delay = getReconnectDelay();
  log('Bot', `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${state.reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ── BOT CREATION ──────────────────────────────────────────────
function createBot() {
  if (isReconnecting && !reconnectTimer) return;

  // Clean up old bot
  if (bot) {
    clearIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  spawnHandled = false;
  log('Bot', `Connecting to ${config.server.ip}:${config.server.port} (Forge 1.20.1)`);

  try {
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type || 'offline',
      host: config.server.ip,
      port: config.server.port,
      version: '1.20.1',
      hideErrors: false,
      checkTimeoutInterval: 60000,
      // FML2 handshake — intercept login packets to fake Forge client
      // This tricks the server into thinking we have all required mods
      plugins: {},
    });

    // ── FML2 FORGE HANDSHAKE BYPASS ──────────────────────────
    // When the server sends the mod list during login, we echo it back
    // so the server thinks we have all required mods installed.
    // This is the only reliable way to join a Forge server without mods.
    bot._client.on('custom_payload', (packet) => {
      try {
        const channel = packet.channel;
        if (!channel) return;

        // FML2 handshake channel
        if (channel === 'fml:handshake' || channel === 'fml2:handshake') {
          log('Forge', `FML handshake on channel: ${channel}`);
          // Send acknowledgement back
          bot._client.write('custom_payload', {
            channel: channel,
            data: packet.data
          });
        }

        // ModList channel — server sends its mod list, we echo it back
        if (channel === 'forge:tier') {
          bot._client.write('custom_payload', {
            channel: 'forge:tier',
            data: packet.data
          });
        }
      } catch (e) {
        log('Forge', `Handshake error: ${e.message}`);
      }
    });

    // Alternative: intercept login_plugin_request (1.20.1 uses this for FML)
    bot._client.on('login_plugin_request', (packet) => {
      try {
        log('Forge', `Login plugin request: ${packet.channel || 'unknown'}`);
        // Respond to ALL plugin requests with empty success response
        // This makes the server think we accepted all mod negotiation
        bot._client.write('login_plugin_response', {
          messageId: packet.messageId,
          successful: true,
          data: packet.data || Buffer.alloc(0)
        });
      } catch (e) {
        log('Forge', `Plugin request error: ${e.message}`);
      }
    });

    bot.loadPlugin(pathfinder);

    // Connection timeout guard
    clearTimers();
    connectionTimer = setTimeout(() => {
      if (!state.connected) {
        log('Bot', 'Connection timeout — no spawn received');
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        scheduleReconnect();
      }
    }, CONNECTION_TIMEOUT);

    // ── EVENTS ──
    bot.once('spawn', onSpawn);
    bot.on('kicked', onKicked);
    bot.on('end', onEnd);
    bot.on('error', onError);

  } catch (err) {
    log('Bot', `Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

// ── BOT EVENT HANDLERS ────────────────────────────────────────
function onSpawn() {
  if (spawnHandled) return;
  spawnHandled = true;
  clearTimers();

  state.connected = true;
  state.lastActivity = Date.now();
  state.reconnectAttempts = 0;
  isReconnecting = false;

  log('Bot', `Spawned! Version: ${bot.version}`);
  discord('🟢 **Connected** to `' + config.server.ip + '`', 0x4ade80);

  // Setup pathfinder movements
  const mcData = require('minecraft-data')(bot.version);
  const moves = new Movements(bot, mcData);
  moves.allowFreeMotion = false;
  moves.canDig = false;
  moves.liquidCost = 1000;
  moves.fallDamageCost = 1000;

  initModules(mcData, moves);

  // Creative mode attempt
  if (config.server?.['try-creative']) {
    setTimeout(() => {
      if (state.connected) bot.chat('/gamemode creative');
    }, 3000);
  }
}

function onKicked(reason) {
  const r = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
  log('Bot', `Kicked: ${r}`);
  state.connected = false;
  pushError('kicked', r);
  clearIntervals();

  if (r.toLowerCase().match(/throttl|wait before|too fast/)) {
    state.wasThrottled = true;
  }

  discord('🔴 **Kicked**: ' + r, 0xf87171);
  // 'end' fires after 'kicked' and handles reconnect
}

function onEnd(reason) {
  log('Bot', `Disconnected: ${reason || 'unknown'}`);
  state.connected = false;
  spawnHandled = false;
  clearIntervals();
  discord('🟡 **Disconnected**: ' + (reason || 'unknown'), 0xfbbf24);
  scheduleReconnect();
}

function onError(err) {
  log('Bot', `Error: ${err.message}`);
  pushError('error', err.message);
  // 'end' handles reconnect
}

// ── MODULE INIT ───────────────────────────────────────────────
function initModules(mcData, moves) {
  log('Modules', 'Initializing...');

  autoAuth();
  chatMessages();
  antiAFK(moves);
  movement(moves);

  if (config.modules?.avoidMobs && !config.modules?.combat) avoidMobs();
  if (config.modules?.combat) combat(mcData);
  if (config.modules?.beds) beds(mcData);
  if (config.modules?.chat) chatModule();

  // Navigate to position (only if circle-walk is off)
  const circleEnabled = config.movement?.['circle-walk']?.enabled;
  if (config.position?.enabled && !circleEnabled) {
    bot.pathfinder.setMovements(moves);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    log('Position', `Navigating to ${config.position.x}, ${config.position.y}, ${config.position.z}`);
  }

  log('Modules', 'All initialized!');
}

// ── AUTO AUTH ─────────────────────────────────────────────────
function autoAuth() {
  const cfg = config.utils?.['auto-auth'];
  if (!cfg?.enabled) return;

  const pw = cfg.password;
  let done = false;

  const auth = (type) => {
    if (done || !state.connected) return;
    done = true;
    bot.chat(type === 'register' ? `/register ${pw} ${pw}` : `/login ${pw}`);
    log('Auth', type === 'register' ? 'Registered' : 'Logged in');
  };

  bot.on('messagestr', (msg) => {
    if (done) return;
    const m = msg.toLowerCase();
    if (m.includes('/register') || m.includes('register ')) auth('register');
    else if (m.includes('/login') || m.includes('login ')) auth('login');
  });

  // Failsafe after 10s
  setTimeout(() => auth('login'), 10000);
}

// ── CHAT MESSAGES ─────────────────────────────────────────────
function chatMessages() {
  const cfg = config.utils?.['chat-messages'];
  if (!cfg?.enabled) return;

  const msgs = cfg.messages;
  if (!cfg.repeat) {
    msgs.forEach((m, i) => setTimeout(() => { if (state.connected) bot.chat(m); }, i * 1000));
    return;
  }

  let i = 0;
  addInterval(() => {
    if (!state.connected) return;
    bot.chat(msgs[i]);
    state.lastActivity = Date.now();
    i = (i + 1) % msgs.length;
  }, (cfg['repeat-delay'] || 60) * 1000);
}

// ── ANTI-AFK ──────────────────────────────────────────────────
function antiAFK(moves) {
  const cfg = config.utils?.['anti-afk'];
  if (!cfg?.enabled) return;

  // Arm swing
  addInterval(() => {
    if (!state.connected) return;
    try { bot.swingArm(); } catch (_) {}
  }, 10000 + Math.random() * 50000);

  // Hotbar cycle
  addInterval(() => {
    if (!state.connected) return;
    try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {}
  }, 30000 + Math.random() * 90000);

  // Sneak toggle
  if (cfg.sneak) {
    try { bot.setControlState('sneak', true); } catch (_) {}
  }

  // Micro-walk (only if circle-walk is off)
  if (!config.movement?.['circle-walk']?.enabled) {
    addInterval(() => {
      if (!state.connected) return;
      try {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => {
          try { bot.setControlState('forward', false); } catch (_) {}
        }, 500 + Math.random() * 1500);
        state.lastActivity = Date.now();
      } catch (e) { log('AntiAFK', e.message); }
    }, 120000 + Math.random() * 360000);
  }
}

// ── MOVEMENT ──────────────────────────────────────────────────
function movement(moves) {
  const cfg = config.movement;
  if (!cfg || cfg.enabled === false) return;

  if (cfg['circle-walk']?.enabled) circleWalk(moves);
  if (cfg['random-jump']?.enabled && !cfg['circle-walk']?.enabled) randomJump();
  if (cfg['look-around']?.enabled) lookAround();
}

function circleWalk(moves) {
  const { radius, speed } = config.movement['circle-walk'];
  let angle = 0;
  let last = 0;
  addInterval(() => {
    if (!state.connected) return;
    const now = Date.now();
    if (now - last < 2000) return;
    last = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(moves);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      state.lastActivity = Date.now();
    } catch (e) { log('CircleWalk', e.message); }
  }, speed || 3000);
}

function randomJump() {
  addInterval(() => {
    if (!state.connected) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 300);
      state.lastActivity = Date.now();
    } catch (e) { log('RandomJump', e.message); }
  }, config.movement['random-jump'].interval || 30000);
}

function lookAround() {
  addInterval(() => {
    if (!state.connected) return;
    try {
      bot.look(Math.random() * Math.PI * 2 - Math.PI, Math.random() * Math.PI / 2 - Math.PI / 4, false);
      state.lastActivity = Date.now();
    } catch (e) { log('LookAround', e.message); }
  }, config.movement['look-around'].interval || 10000);
}

// ── AVOID MOBS ────────────────────────────────────────────────
function avoidMobs() {
  addInterval(() => {
    if (!state.connected) return;
    try {
      const nearby = Object.values(bot.entities).filter(e =>
        (e.type === 'mob' || (e.type === 'player' && e.username !== bot.username)) &&
        e.position && bot.entity.position.distanceTo(e.position) < 5
      );
      if (nearby.length) {
        bot.setControlState('back', true);
        setTimeout(() => { try { bot.setControlState('back', false); } catch (_) {} }, 500);
      }
    } catch (e) { log('AvoidMobs', e.message); }
  }, 2000);
}

// ── COMBAT ────────────────────────────────────────────────────
function combat(mcData) {
  let lastAttack = 0;
  let target = null;
  let targetExpiry = 0;

  bot.on('physicsTick', () => {
    if (!state.connected || !config.combat?.['attack-mobs']) return;
    const now = Date.now();
    if (now - lastAttack < 620) return;

    try {
      if (target && now < targetExpiry && bot.entities[target.id] && target.position) {
        if (bot.entity.position.distanceTo(target.position) < 4) {
          bot.attack(target);
          lastAttack = now;
          return;
        }
        target = null;
      }

      const mob = Object.values(bot.entities).find(e =>
        e.type === 'mob' && e.position && bot.entity.position.distanceTo(e.position) < 4
      );
      if (mob) {
        target = mob;
        targetExpiry = now + 3000;
        bot.attack(mob);
        lastAttack = now;
      }
    } catch (e) { log('Combat', e.message); }
  });

  // Auto-eat
  if (config.combat?.['auto-eat']) {
    bot.on('health', () => {
      try {
        if (bot.food >= 14) return;
        const food = bot.inventory.items().find(i => i.foodPoints > 0);
        if (food) bot.equip(food, 'hand').then(() => bot.consume()).catch(() => {});
      } catch (e) { log('AutoEat', e.message); }
    });
  }
}

// ── BEDS ──────────────────────────────────────────────────────
function beds() {
  if (!config.beds?.['place-night']) return;
  let sleeping = false;

  addInterval(async () => {
    if (!state.connected || sleeping) return;
    try {
      const { timeOfDay } = bot.time;
      if (timeOfDay < 12500 || timeOfDay > 23500) return;
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 8 });
      if (!bed) return;
      sleeping = true;
      try { await bot.sleep(bed); log('Bed', 'Sleeping...'); }
      catch (_) {}
      finally { sleeping = false; }
    } catch (e) { sleeping = false; log('Bed', e.message); }
  }, 10000);
}

// ── CHAT MODULE ───────────────────────────────────────────────
function chatModule() {
  bot.on('chat', (username, message) => {
    if (!state.connected || username === bot.username) return;
    try {
      if (config.discord?.events?.chat) discord(`💬 **${username}**: ${message}`, 0x7289da);
      if (!config.chat?.respond) return;
      const m = message.toLowerCase();
      if (m.includes('hello') || m.includes('hi')) bot.chat(`Hello, ${username}!`);
      if (message.startsWith('!tp ')) bot.chat(`/tp ${message.split(' ')[1]}`);
    } catch (e) { log('Chat', e.message); }
  });
}

// ── DISCORD WEBHOOK ───────────────────────────────────────────
function discord(content, color = 0x0099ff) {
  const cfg = config.discord;
  if (!cfg?.enabled || !cfg?.webhookUrl || cfg.webhookUrl.includes('YOUR_DISCORD')) return;

  const now = Date.now();
  if (now - state.lastDiscordSend < DISCORD_COOLDOWN) return;
  state.lastDiscordSend = now;

  try {
    const url = new URL(cfg.webhookUrl);
    const payload = JSON.stringify({
      username: config.name || 'AFK Bot',
      embeds: [{ description: content, color, timestamp: new Date().toISOString() }]
    });
    const req = https.request({
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload, 'utf8')
      }
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

// ── HELPERS ───────────────────────────────────────────────────
function pushError(type, msg) {
  state.errors.push({ type, msg, time: Date.now() });
  if (state.errors.length > MAX_ERRORS) state.errors = state.errors.slice(-50);
}

function uptime() {
  const s = Math.floor((Date.now() - state.startTime) / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// ── EXPRESS SERVER ────────────────────────────────────────────
const app = express();

app.get('/health', (_, res) => res.json({
  status: state.connected ? 'connected' : 'disconnected',
  uptime: Math.floor((Date.now() - state.startTime) / 1000),
  coords: bot?.entity?.position ?? null,
  reconnectAttempts: state.reconnectAttempts,
  memory: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + ' MB',
}));

app.get('/ping', (_, res) => res.send('pong'));

app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.name || 'AFK Bot'} Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .wrap{width:420px;background:#111827;border-radius:20px;padding:2rem;border:1px solid #1f2937;box-shadow:0 25px 50px rgba(0,0,0,.5)}
  h1{font-size:1.6rem;font-weight:700;text-align:center;margin-bottom:1.5rem;color:#f1f5f9}
  .card{background:#1f2937;border-radius:12px;padding:1rem 1.25rem;margin-bottom:.75rem;border-left:4px solid #2dd4bf}
  .label{font-size:.7rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.35rem}
  .value{font-size:1.1rem;font-weight:700;color:#2dd4bf;display:flex;align-items:center;gap:.5rem}
  .dot{width:10px;height:10px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite}
  .dot.off{background:#f87171}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .footer{text-align:center;color:#4b5563;font-size:.75rem;margin-top:1rem}
</style>
</head>
<body>
<div class="wrap">
  <h1>🤖 ${config.name || 'AFK Bot'}</h1>
  <div class="card"><div class="label">Status</div><div class="value"><span class="dot" id="dot"></span><span id="status">Loading...</span></div></div>
  <div class="card"><div class="label">Uptime</div><div class="value" id="uptime">—</div></div>
  <div class="card"><div class="label">Position</div><div class="value" id="pos">—</div></div>
  <div class="card"><div class="label">Server</div><div class="value" style="color:#5eead4;font-size:1rem">${config.server.ip}:${config.server.port}</div></div>
  <div class="card"><div class="label">Memory</div><div class="value" id="mem">—</div></div>
  <div class="footer">Auto-refreshing every 5s</div>
</div>
<script>
  function fmt(s){return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m '+s%60+'s'}
  async function refresh(){
    try{
      const d=await(await fetch('/health')).json();
      document.getElementById('status').textContent=d.status==='connected'?'Online':'Reconnecting...';
      document.getElementById('dot').className='dot'+(d.status==='connected'?'':' off');
      document.getElementById('uptime').textContent=fmt(d.uptime);
      document.getElementById('pos').textContent=d.coords?Math.floor(d.coords.x)+', '+Math.floor(d.coords.y)+', '+Math.floor(d.coords.z):'Unknown';
      document.getElementById('mem').textContent=d.memory;
    }catch(e){document.getElementById('status').textContent='Offline';}
  }
  setInterval(refresh,5000);refresh();
</script>
</body></html>`));

const server = app.listen(PORT, '0.0.0.0', () => log('Server', `HTTP started on port ${server.address().port}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') server.listen(PORT + 1, '0.0.0.0');
});

// ── SELF-PING ─────────────────────────────────────────────────
const renderUrl = process.env.RENDER_EXTERNAL_URL;
if (renderUrl) {
  setInterval(() => {
    const mod = renderUrl.startsWith('https') ? https : http;
    mod.get(`${renderUrl}/ping`, () => {}).on('error', () => {});
  }, SELF_PING_INTERVAL);
  log('KeepAlive', 'Self-ping active (every 10 min)');
}

// ── MEMORY MONITOR ────────────────────────────────────────────
setInterval(() => {
  log('Memory', `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`);
}, 5 * 60 * 1000);

// ── CONSOLE INPUT ─────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!state.connected) return log('Console', 'Bot not connected');
  const t = line.trim();
  if (t === 'status') return log('Console', `Connected: ${state.connected} | Uptime: ${uptime()} | Attempts: ${state.reconnectAttempts}`);
  if (t.startsWith('say ')) return bot.chat(t.slice(4));
  if (t.startsWith('cmd ')) return bot.chat('/' + t.slice(4));
  bot.chat(t);
});

// ── CRASH RECOVERY ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught: ${err.message}`);
  pushError('uncaught', err.message);
  clearIntervals();
  state.connected = false;
  if (isReconnecting) { isReconnecting = false; clearTimers(); }
  const delay = err.message.match(/PartialRead|ECONNRESET|EPIPE|ETIMEDOUT|write after end/) ? 5000 : 10000;
  setTimeout(scheduleReconnect, delay);
});

process.on('unhandledRejection', (reason) => {
  log('FATAL', `Unhandled rejection: ${reason}`);
  pushError('rejection', String(reason));
});

// Ignore signals — bot stays alive
process.on('SIGTERM', () => log('System', 'SIGTERM ignored'));
process.on('SIGINT', () => log('System', 'SIGINT ignored'));

// ── START ─────────────────────────────────────────────────────
console.log('='.repeat(55));
console.log('  Minecraft AFK Bot v3.0 — Forge 1.20.1 Edition');
console.log('='.repeat(55));
log('Config', `Server: ${config.server.ip}:${config.server.port}`);
log('Config', `Account: ${config['bot-account'].username} (${config['bot-account'].type})`);
log('Config', `Forge mode: enabled`);
console.log('='.repeat(55));

createBot();
