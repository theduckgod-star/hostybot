'use strict';

// ============================================================
// MINECRAFT AFK BOT v3.1 - Forge 1.20.1 FML2 Handshake Fix
// ============================================================

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const express = require('express');
const http = require('http');
const https = require('https');
const readline = require('readline');

const config = require('./settings.json');

// ── CONSTANTS ────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const SELF_PING_INTERVAL = 10 * 60 * 1000;
const DISCORD_COOLDOWN = 5000;
const MAX_ERRORS = 100;
const CONNECTION_TIMEOUT = 150000;
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

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// ── INTERVAL MANAGEMENT ───────────────────────────────────────
function addInterval(fn, ms) {
  const id = setInterval(fn, ms);
  activeIntervals.push(id);
  return id;
}
function clearIntervals() { activeIntervals.forEach(clearInterval); activeIntervals = []; }
function clearTimers() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
}

// ── RECONNECT ─────────────────────────────────────────────────
function getReconnectDelay() {
  if (state.wasThrottled) { state.wasThrottled = false; return 60000 + Math.random() * 60000; }
  return Math.min(BASE_RECONNECT * Math.pow(1.5, state.reconnectAttempts), MAX_RECONNECT) + Math.random() * 2000;
}

function scheduleReconnect() {
  clearTimers();
  if (isReconnecting) return;
  isReconnecting = true;
  state.reconnectAttempts++;
  const delay = getReconnectDelay();
  log('Bot', `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${state.reconnectAttempts})`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; isReconnecting = false; createBot(); }, delay);
}

// ── FML2 HELPERS ─────────────────────────────────────────────
function writeVarInt(value) {
  const bytes = [];
  do {
    let byte = value & 0x7F;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(buf.length), buf]);
}

// All mods on the server — bot echoes these back during FML2 handshake
const SERVER_MODS = [
  { modId: 'minecraft',             version: '1.20.1' },
  { modId: 'forge',                 version: '47.3.0' },
  { modId: 'alexscaves',            version: '2.0.2' },
  { modId: 'alexsmobs',             version: '1.22.9' },
  { modId: 'another_furniture',     version: '3.0.4' },
  { modId: 'architectury',          version: '9.2.14' },
  { modId: 'athena',                version: '3.1.2' },
  { modId: 'attributefix',          version: '21.0.5' },
  { modId: 'balm',                  version: '7.3.38' },
  { modId: 'betterthirdperson',     version: '1.9.0' },
  { modId: 'biomesoplenty',         version: '18.0.0.592' },
  { modId: 'bookshelf',             version: '20.2.15' },
  { modId: 'chatanimation',         version: '1.1.3' },
  { modId: 'chipped',               version: '3.0.7' },
  { modId: 'citadel',               version: '2.6.3' },
  { modId: 'cloth_config',          version: '11.1.136' },
  { modId: 'collective',            version: '8.13' },
  { modId: 'controlling',           version: '12.0.2' },
  { modId: 'copycats',              version: '4.0.3.4' },
  { modId: 'corgilib',              version: '4.0.3.4' },
  { modId: 'coroutil',              version: '1.3.7' },
  { modId: 'create',                version: '6.0.8' },
  { modId: 'createaddition',        version: '1.3.3' },
  { modId: 'createdeco',            version: '2.0.3' },
  { modId: 'cristellib',            version: '1.1.6' },
  { modId: 'dungeonsandtaverns',    version: '3.0.3' },
  { modId: 'dungeonsarise',         version: '2.1.58' },
  { modId: 'entity_model_features', version: '3.0.12' },
  { modId: 'entity_texture_features', version: '7.0.9' },
  { modId: 'entityculling',         version: '1.9.5' },
  { modId: 'farmersdelight',        version: '2.10' },
  { modId: 'ferritecore',           version: '6.0.1' },
  { modId: 'firstperson',           version: '2.6.3' },
  { modId: 'fullbrightnesstoggle',  version: '4.4' },
  { modId: 'geckolib',              version: '4.8.3' },
  { modId: 'handcrafted',           version: '3.0.6' },
  { modId: 'ias',                   version: '9.0.4' },
  { modId: 'immersive_aircraft',    version: '1.4.0' },
  { modId: 'incendium',             version: '5.3.5' },
  { modId: 'interiors',             version: '0.6.0' },
  { modId: 'jei',                   version: '15.20.0.129' },
  { modId: 'modernfix',             version: '5.26.2' },
  { modId: 'oh_the_biomes_weve_gone', version: '2.3.3' },
  { modId: 'oh_the_trees_youll_grow', version: '1.7.5' },
  { modId: 'paraglider',            version: '1.20.1-3' },
  { modId: 'pickupnotifier',        version: '8.0.1' },
  { modId: 'projectile_damage',     version: '3.2.2' },
  { modId: 'puzzleslib',            version: '8.1.33' },
  { modId: 'regionsunexplored',     version: '0.5.6' },
  { modId: 'resourcefullib',        version: '2.1.29' },
  { modId: 'resourcepackoverrides', version: '8.0.3' },
  { modId: 'searchables',           version: '1.0.3' },
  { modId: 'smoothgui',             version: '1.1.1' },
  { modId: 'sophisticatedbackpacks', version: '3.24.27.1580' },
  { modId: 'sophisticatedcore',     version: '1.3.8.1524' },
  { modId: 'soulslike_weaponry',    version: '1.3.1' },
  { modId: 'spartanweaponry',       version: '3.2.1' },
  { modId: 'steam_rails',           version: '1.7.2' },
  { modId: 'terrablender',          version: '3.0.1.10' },
  { modId: 'towns_and_towers',      version: '1.12' },
  { modId: 'watut',                 version: '1.2.3' },
  { modId: 'waystones',             version: '14.1.20' },
  { modId: 'xaerominimap',          version: '25.3.10' },
  { modId: 'yungsapi',              version: '4.0.6' },
  { modId: 'yungscavebiomes',       version: '2.0.5' },
];

function buildModListResponse() {
  const parts = [Buffer.from([2])]; // C2SModListReply discriminator
  parts.push(writeVarInt(SERVER_MODS.length));
  for (const mod of SERVER_MODS) {
    parts.push(writeString(mod.modId));
    parts.push(writeString(mod.version));
  }
  return Buffer.concat(parts);
}

// ── BOT CREATION ──────────────────────────────────────────────
function createBot() {
  if (bot) {
    clearIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  spawnHandled = false;
  log('Bot', `Connecting to ${config.server.ip}:${config.server.port}`);

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
    });

    const client = bot._client;

    // ── FORGE FML2 CHANNEL REGISTRATION ──────────────────────
    // Forge 1.20.1 kicks clients during LOGIN if they haven't
    // registered the FML2 channels during the SET_PROTOCOL handshake.
    // We need to intercept the set_protocol packet and add FML2 channels.
    // These channels tell the server "I am a Forge client".

    // Patch the write method to intercept set_protocol
    const _write = client.write.bind(client);
    let patchedHandshake = false;
    client.write = function(name, params) {
      if (name === 'set_protocol' && !patchedHandshake) {
        patchedHandshake = true;
        log('Forge', `Patching set_protocol to add FML2 channels`);
        // The server address field in handshake can carry FML2 marker
        // Real Forge clients append \0FML2\0 to the server address
        if (params && params.serverHost && !params.serverHost.includes('\0FML3\0')) {
          params = { ...params, serverHost: params.serverHost + '\0FML3\0' };
          log('Forge', `Server host patched: ${params.serverHost}`);
        }
      }
      return _write(name, params);
    };

    // Log ALL packets so we can see what happens
    client.on('packet', (data, meta) => {
      if (['handshaking', 'login'].includes(meta.state)) {
        log('Packet', `[${meta.state}] ${meta.name}`);
      }
    });

    // Handle FML3 login plugin requests
    client.on('login_plugin_request', (packet) => {
      log('FML', `Plugin request: ${packet.channel} (id:${packet.messageId})`);
      try {
        let responseData = Buffer.alloc(0);
        let successful = true;

        if (packet.channel === 'fml:loginwrapper') {
          const data = packet.data;
          if (data && data.length > 0) {
            // Read inner channel string
            let offset = 0;
            let strLen = 0;
            let shift = 0;
            while (offset < data.length) {
              const byte = data[offset++];
              strLen |= (byte & 0x7F) << shift;
              shift += 7;
              if (!(byte & 0x80)) break;
            }
            const innerChannel = data.slice(offset, offset + strLen).toString('utf8');
            const innerData = data.slice(offset + strLen);
            const disc = innerData.length > 0 ? innerData[0] : -1;

            log('FML', `Inner: ${innerChannel} disc:${disc} hex:${data.toString('hex').slice(0,40)}`);

            // FML3: server sends S2CChannelMismatchData packets (4 of them)
            // Client must reply with C2SAcknowledge wrapped in loginwrapper
            // C2SAcknowledge discriminator = 0xFF (255 / -1 signed)
            const channelBuf = writeString(innerChannel);
            const ackBuf = Buffer.from([0xFF]);
            responseData = Buffer.concat([channelBuf, ackBuf]);
            log('FML', `ACK 0xFF for packet id:${packet.messageId}`);
          } else {
            // Empty data — respond with empty success
            responseData = Buffer.alloc(0);
          }
        } else if (packet.channel === 'fml:handshake') {
          // Direct FML2 handshake (older format)
          const disc = packet.data?.[0] ?? -1;
          log('FML', `Direct handshake discriminator: ${disc}`);
          if (disc === 1) {
            responseData = buildModListResponse();
            log('FML', `Sending ${SERVER_MODS.length} mods`);
          } else {
            responseData = Buffer.from([99]);
          }
        } else {
          // Unknown channel — respond with empty success
          successful = true;
          responseData = Buffer.alloc(0);
        }

        client.write('login_plugin_response', {
          messageId: packet.messageId,
          successful,
          data: responseData,
        });
        log('FML', `Responded to id:${packet.messageId}`);
      } catch (e) {
        log('FML', `Error: ${e.message}`);
        try {
          client.write('login_plugin_response', {
            messageId: packet.messageId,
            successful: false,
            data: Buffer.alloc(0),
          });
        } catch (_) {}
      }
    });

    bot.loadPlugin(pathfinder);

    clearTimers();
    connectionTimer = setTimeout(() => {
      if (!state.connected) {
        log('Bot', 'Connection timeout');
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        scheduleReconnect();
      }
    }, CONNECTION_TIMEOUT);

    bot.once('spawn', onSpawn);
    bot.on('kicked', onKicked);
    bot.on('end', onEnd);
    bot.on('error', onError);

  } catch (err) {
    log('Bot', `Failed: ${err.message}`);
    scheduleReconnect();
  }
}

// ── BOT EVENTS ────────────────────────────────────────────────
function onSpawn() {
  if (spawnHandled) return;
  spawnHandled = true;
  clearTimers();
  state.connected = true;
  state.lastActivity = Date.now();
  state.reconnectAttempts = 0;
  isReconnecting = false;
  log('Bot', `Spawned on server! Version: ${bot.version}`);
  discord('🟢 **Connected** to `' + config.server.ip + '`', 0x4ade80);
  const mcData = require('minecraft-data')(bot.version);
  const moves = new Movements(bot, mcData);
  moves.allowFreeMotion = false;
  moves.canDig = false;
  moves.liquidCost = 1000;
  moves.fallDamageCost = 1000;
  initModules(mcData, moves);
  if (config.server?.['try-creative']) {
    setTimeout(() => { if (state.connected) bot.chat('/gamemode creative'); }, 3000);
  }
}

function onKicked(reason) {
  const r = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
  log('Bot', `Kicked: ${r}`);
  state.connected = false;
  pushError('kicked', r);
  clearIntervals();
  if (r.toLowerCase().match(/throttl|wait before|too fast/)) state.wasThrottled = true;
  discord('🔴 **Kicked**: ' + r, 0xf87171);
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
  if (config.modules?.beds) beds();
  if (config.modules?.chat) chatModule();
  const circleEnabled = config.movement?.['circle-walk']?.enabled;
  if (config.position?.enabled && !circleEnabled) {
    bot.pathfinder.setMovements(moves);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
  }
  log('Modules', 'Done!');
}

function autoAuth() {
  const cfg = config.utils?.['auto-auth'];
  if (!cfg?.enabled) return;
  const pw = cfg.password;
  let done = false;
  const auth = (type) => {
    if (done || !state.connected) return;
    done = true;
    bot.chat(type === 'register' ? `/register ${pw} ${pw}` : `/login ${pw}`);
    log('Auth', type);
  };
  bot.on('messagestr', (msg) => {
    if (done) return;
    const m = msg.toLowerCase();
    if (m.includes('/register') || m.includes('register ')) auth('register');
    else if (m.includes('/login') || m.includes('login ')) auth('login');
  });
  setTimeout(() => auth('login'), 10000);
}

function chatMessages() {
  const cfg = config.utils?.['chat-messages'];
  if (!cfg?.enabled) return;
  const msgs = cfg.messages;
  if (!cfg.repeat) { msgs.forEach((m, i) => setTimeout(() => { if (state.connected) bot.chat(m); }, i * 1000)); return; }
  let i = 0;
  addInterval(() => {
    if (!state.connected) return;
    bot.chat(msgs[i]); state.lastActivity = Date.now(); i = (i + 1) % msgs.length;
  }, (cfg['repeat-delay'] || 60) * 1000);
}

function antiAFK() {
  const cfg = config.utils?.['anti-afk'];
  if (!cfg?.enabled) return;
  addInterval(() => { if (!state.connected) return; try { bot.swingArm(); } catch (_) {} }, 10000 + Math.random() * 50000);
  addInterval(() => { if (!state.connected) return; try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {} }, 30000 + Math.random() * 90000);
  if (cfg.sneak) { try { bot.setControlState('sneak', true); } catch (_) {} }
  if (!config.movement?.['circle-walk']?.enabled) {
    addInterval(() => {
      if (!state.connected) return;
      try {
        bot.look(Math.random() * Math.PI * 2, 0, true);
        bot.setControlState('forward', true);
        setTimeout(() => { try { bot.setControlState('forward', false); } catch (_) {} }, 500 + Math.random() * 1500);
        state.lastActivity = Date.now();
      } catch (e) { log('AntiAFK', e.message); }
    }, 120000 + Math.random() * 360000);
  }
}

function movement(moves) {
  const cfg = config.movement;
  if (!cfg || cfg.enabled === false) return;
  if (cfg['circle-walk']?.enabled) circleWalk(moves);
  if (cfg['random-jump']?.enabled && !cfg['circle-walk']?.enabled) randomJump();
  if (cfg['look-around']?.enabled) lookAround();
}

function circleWalk(moves) {
  const { radius, speed } = config.movement['circle-walk'];
  let angle = 0, last = 0;
  addInterval(() => {
    if (!state.connected) return;
    const now = Date.now(); if (now - last < 2000) return; last = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(moves);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4; state.lastActivity = Date.now();
    } catch (e) { log('CircleWalk', e.message); }
  }, speed || 3000);
}

function randomJump() {
  addInterval(() => {
    if (!state.connected) return;
    try { bot.setControlState('jump', true); setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 300); state.lastActivity = Date.now(); }
    catch (e) { log('RandomJump', e.message); }
  }, config.movement['random-jump'].interval || 30000);
}

function lookAround() {
  addInterval(() => {
    if (!state.connected) return;
    try { bot.look(Math.random() * Math.PI * 2 - Math.PI, Math.random() * Math.PI / 2 - Math.PI / 4, false); state.lastActivity = Date.now(); }
    catch (e) { log('LookAround', e.message); }
  }, config.movement['look-around'].interval || 10000);
}

function avoidMobs() {
  addInterval(() => {
    if (!state.connected) return;
    try {
      const nearby = Object.values(bot.entities).filter(e =>
        (e.type === 'mob' || (e.type === 'player' && e.username !== bot.username)) &&
        e.position && bot.entity.position.distanceTo(e.position) < 5
      );
      if (nearby.length) { bot.setControlState('back', true); setTimeout(() => { try { bot.setControlState('back', false); } catch (_) {} }, 500); }
    } catch (e) { log('AvoidMobs', e.message); }
  }, 2000);
}

function combat(mcData) {
  let lastAttack = 0, target = null, targetExpiry = 0;
  bot.on('physicsTick', () => {
    if (!state.connected || !config.combat?.['attack-mobs']) return;
    const now = Date.now(); if (now - lastAttack < 620) return;
    try {
      if (target && now < targetExpiry && bot.entities[target.id] && target.position && bot.entity.position.distanceTo(target.position) < 4) {
        bot.attack(target); lastAttack = now; return;
      }
      target = null;
      const mob = Object.values(bot.entities).find(e => e.type === 'mob' && e.position && bot.entity.position.distanceTo(e.position) < 4);
      if (mob) { target = mob; targetExpiry = now + 3000; bot.attack(mob); lastAttack = now; }
    } catch (e) { log('Combat', e.message); }
  });
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
      try { await bot.sleep(bed); log('Bed', 'Sleeping'); } catch (_) {}
      finally { sleeping = false; }
    } catch (e) { sleeping = false; log('Bed', e.message); }
  }, 10000);
}

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

// ── DISCORD ───────────────────────────────────────────────────
function discord(content, color = 0x0099ff) {
  const cfg = config.discord;
  if (!cfg?.enabled || !cfg?.webhookUrl || cfg.webhookUrl.includes('YOUR_DISCORD')) return;
  const now = Date.now();
  if (now - state.lastDiscordSend < DISCORD_COOLDOWN) return;
  state.lastDiscordSend = now;
  try {
    const url = new URL(cfg.webhookUrl);
    const payload = JSON.stringify({ username: config.name || 'AFK Bot', embeds: [{ description: content, color, timestamp: new Date().toISOString() }] });
    const req = https.request({ hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload, 'utf8') } });
    req.on('error', () => {}); req.write(payload); req.end();
  } catch (_) {}
}

function pushError(type, msg) {
  state.errors.push({ type, msg, time: Date.now() });
  if (state.errors.length > MAX_ERRORS) state.errors = state.errors.slice(-50);
}

function uptime() {
  const s = Math.floor((Date.now() - state.startTime) / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

// ── EXPRESS ───────────────────────────────────────────────────
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
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config['bot-account'].username} AFK Bot</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center}.wrap{width:420px;background:#111827;border-radius:20px;padding:2rem;border:1px solid #1f2937;box-shadow:0 25px 50px rgba(0,0,0,.5)}h1{font-size:1.6rem;font-weight:700;text-align:center;margin-bottom:1.5rem}.card{background:#1f2937;border-radius:12px;padding:1rem 1.25rem;margin-bottom:.75rem;border-left:4px solid #2dd4bf}.label{font-size:.7rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.35rem}.value{font-size:1.1rem;font-weight:700;color:#2dd4bf;display:flex;align-items:center;gap:.5rem}.dot{width:10px;height:10px;border-radius:50%;background:#4ade80;animation:pulse 2s infinite}.dot.off{background:#f87171}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}.footer{text-align:center;color:#4b5563;font-size:.75rem;margin-top:1rem}</style></head>
<body><div class="wrap"><h1>🤖 ${config['bot-account'].username}</h1>
<div class="card"><div class="label">Status</div><div class="value"><span class="dot" id="dot"></span><span id="status">Loading...</span></div></div>
<div class="card"><div class="label">Uptime</div><div class="value" id="uptime">—</div></div>
<div class="card"><div class="label">Position</div><div class="value" id="pos">—</div></div>
<div class="card"><div class="label">Server</div><div class="value" style="color:#5eead4;font-size:1rem">${config.server.ip}:${config.server.port}</div></div>
<div class="card"><div class="label">Memory</div><div class="value" id="mem">—</div></div>
<div class="footer">Auto-refreshing every 5s</div></div>
<script>function fmt(s){return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m '+s%60+'s'}
async function refresh(){try{const d=await(await fetch('/health')).json();
document.getElementById('status').textContent=d.status==='connected'?'Online':'Reconnecting...';
document.getElementById('dot').className='dot'+(d.status==='connected'?'':' off');
document.getElementById('uptime').textContent=fmt(d.uptime);
document.getElementById('pos').textContent=d.coords?Math.floor(d.coords.x)+', '+Math.floor(d.coords.y)+', '+Math.floor(d.coords.z):'Unknown';
document.getElementById('mem').textContent=d.memory;}catch(e){document.getElementById('status').textContent='Offline';}}
setInterval(refresh,5000);refresh();</script></body></html>`));

const server = app.listen(PORT, '0.0.0.0', () => log('Server', `HTTP on port ${server.address().port}`));
server.on('error', (err) => { if (err.code === 'EADDRINUSE') server.listen(PORT + 1, '0.0.0.0'); });

// ── SELF-PING ─────────────────────────────────────────────────
const renderUrl = process.env.RENDER_EXTERNAL_URL;
if (renderUrl) {
  setInterval(() => {
    const mod = renderUrl.startsWith('https') ? https : http;
    mod.get(`${renderUrl}/ping`, () => {}).on('error', () => {});
  }, SELF_PING_INTERVAL);
  log('KeepAlive', 'Self-ping active');
}

setInterval(() => log('Memory', `${(process.memoryUsage().heapUsed/1024/1024).toFixed(1)} MB`), 5 * 60 * 1000);

// ── CONSOLE ───────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!state.connected) return log('Console', 'Not connected');
  const t = line.trim();
  if (t === 'status') return log('Console', `Connected:${state.connected} Uptime:${uptime()}`);
  if (t.startsWith('say ')) return bot.chat(t.slice(4));
  if (t.startsWith('cmd ')) return bot.chat('/' + t.slice(4));
  bot.chat(t);
});

// ── CRASH RECOVERY ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('FATAL', err.message);
  pushError('uncaught', err.message);
  clearIntervals();
  state.connected = false;
  if (isReconnecting) { isReconnecting = false; clearTimers(); }
  setTimeout(scheduleReconnect, err.message.match(/PartialRead|ECONNRESET|EPIPE|ETIMEDOUT/) ? 5000 : 10000);
});
process.on('unhandledRejection', (r) => { log('FATAL', String(r)); pushError('rejection', String(r)); });
process.on('SIGTERM', () => log('System', 'SIGTERM ignored'));
process.on('SIGINT', () => log('System', 'SIGINT ignored'));

// ── START ─────────────────────────────────────────────────────
console.log('='.repeat(55));
console.log(`  AFK Bot — ${config['bot-account'].username} @ ${config.server.ip}`);
console.log('='.repeat(55));
createBot();
