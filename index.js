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
    });

    // ── FML2 FORGE HANDSHAKE WITH FULL MOD LIST ──────────────
    // The server sends its mod list and expects the client to echo
    // back the SAME mods. We hardcode all 63 mods from this server.
    const client = bot._client;

    // All mods from the server's mods folder
    const SERVER_MODS = [
      { modId: 'alexscaves',          version: '2.0.2'   },
      { modId: 'alexsmobs',           version: '1.22.9'  },
      { modId: 'another_furniture',   version: '1.20.1-3.0.4' },
      { modId: 'architectury',        version: '9.2.14'  },
      { modId: 'athena',              version: '1.20.1-3.1.2' },
      { modId: 'attributefix',        version: '1.20.1-21.0.5' },
      { modId: 'balm',                version: '7.3.38'  },
      { modId: 'betterthirdperson',   version: '1.20.1-9.0' },
      { modId: 'biomesoplenty',       version: '1.20.1-18.0.0.592' },
      { modId: 'bookshelf',           version: '1.20.1-20.2.15' },
      { modId: 'chatanimation',       version: '1.20.1-1.1.3' },
      { modId: 'chipped',             version: '1.20.1-3.0.7' },
      { modId: 'citadel',             version: '2.6.3-1.20.1' },
      { modId: 'cloth_config',        version: '11.1.136' },
      { modId: 'collective',          version: '1.20.1-8.13' },
      { modId: 'controlling',         version: '1.20.1-12.0.2' },
      { modId: 'copycats',            version: '3.0.7+mc1.20.1-4.0.3.4' },
      { modId: 'corgilib',            version: '1.20.1-4.0.3.4' },
      { modId: 'coroutil',            version: '1.20.1-1.3.7' },
      { modId: 'create',              version: '1.20.1-6.0.8' },
      { modId: 'createaddition',      version: '1.20.1-1.3.3' },
      { modId: 'createdeco',          version: '2.0.3-1.20.1' },
      { modId: 'cristellib',          version: '1.1.6'   },
      { modId: 'dungeonsandtaverns',  version: '3.0.3'   },
      { modId: 'dungeonsarise',       version: '1.20.x-2.1.58-release' },
      { modId: 'entity_model_features', version: '1.20.1-3.0.12' },
      { modId: 'entity_texture_features', version: '1.20.1-7.0.9' },
      { modId: 'entityculling',       version: '1.9.5-mc1.20.1' },
      { modId: 'farmersdelight',      version: '1.20.1-2.10' },
      { modId: 'ferritecore',         version: '6.0.1'   },
      { modId: 'firstperson',         version: '2.6.3-mc1.20.1' },
      { modId: 'fullbrightnesstoggle', version: '1.20.1-4.4' },
      { modId: 'geckolib',            version: '1.20.1-4.8.3' },
      { modId: 'handcrafted',         version: '1.20.1-3.0.6' },
      { modId: 'ias',                 version: '1.20.1-9.0.4' },
      { modId: 'immersive_aircraft',  version: '1.20.1-1.4.0' },
      { modId: 'incendium',           version: '1.20.x_v5.3.5' },
      { modId: 'interiors',           version: '1.20.1-0.6.0' },
      { modId: 'jei',                 version: '1.20.1-forge-15.20.0.129' },
      { modId: 'modernfix',           version: '5.26.2+mc1.20.1' },
      { modId: 'oh_the_biomes_weve_gone', version: '1.20.1-2.3.3' },
      { modId: 'oh_the_trees_youll_grow', version: '1.20.1-1.7.5' },
      { modId: 'paraglider',          version: '1.20.1-3' },
      { modId: 'pickupnotifier',      version: '1.20.1-8.0.1' },
      { modId: 'projectile_damage',   version: '1.20.1-3.2.2' },
      { modId: 'puzzleslib',          version: '1.20.1-8.1.33' },
      { modId: 'regionsunexplored',   version: '1.20.1-0.5.6' },
      { modId: 'resourcefullib',      version: '1.20.1-2.1.29' },
      { modId: 'resourcepackoverrides', version: '1.20.1-8.0.3' },
      { modId: 'searchables',         version: '1.20.1-1.0.3' },
      { modId: 'smoothgui',           version: '1.20.1-1.1.1' },
      { modId: 'sophisticatedbackpacks', version: '1.20.1-3.24.27.1580' },
      { modId: 'sophisticatedcore',   version: '1.20.1-1.3.8.1524' },
      { modId: 'soulslike_weaponry',  version: '1.3.1-1.20.1' },
      { modId: 'spartanweaponry',     version: '1.20.1-3.2.1' },
      { modId: 'steam_rails',         version: '1.7.2+forge-mc1.20.1' },
      { modId: 'terrablender',        version: '1.20.1-3.0.1.10' },
      { modId: 'towns_and_towers',    version: '1.20.1-1.12-Fabric+Forge' },
      { modId: 'watut',               version: '1.20.1-1.2.3' },
      { modId: 'waystones',           version: '1.20.1-14.1.20' },
      { modId: 'xaerominimap',        version: '1.20.1-25.3.10' },
      { modId: 'yungsapi',            version: '1.20.1-4.0.6' },
      { modId: 'yungscavebiomes',     version: '1.20.1-2.0.5' },
      // Forge itself must be in the list
      { modId: 'forge',               version: '1.20.1-47.3.0' },
      { modId: 'minecraft',           version: '1.20.1' },
    ];

    // Encode a VarInt into a Buffer
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

    // Encode a UTF-8 string prefixed with VarInt length
    function writeString(str) {
      const strBuf = Buffer.from(str, 'utf8');
      return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
    }

    // Build the FML2 ModList response packet
    // Discriminator 2 = C2SModListReply
    function buildModListResponse() {
      const parts = [Buffer.from([2])]; // discriminator
      parts.push(writeVarInt(SERVER_MODS.length));
      for (const mod of SERVER_MODS) {
        parts.push(writeString(mod.modId));
        parts.push(writeString(mod.version));
      }
      return Buffer.concat(parts);
    }

    // Build ACK packet (discriminator 99 = C2SAcknowledge)
    function buildAck() {
      return Buffer.from([99]);
    }

    const onLoginPlugin = (packet) => {
      log('Forge', `Plugin request: ${packet.channel}`);
      try {
        let responseData = Buffer.alloc(0);
        let successful = true;

        if (packet.channel === 'fml:handshake') {
          const discriminator = packet.data?.length > 0 ? packet.data[0] : -1;
          log('Forge', `FML discriminator: ${discriminator}`);

          if (discriminator === 1) {
            // S2CModList — server sends mod list, we reply with our matching mod list
            responseData = buildModListResponse();
            log('Forge', `Sending mod list with ${SERVER_MODS.length} mods`);
          } else if (discriminator === 2) {
            // S2CModListReply or channel registration
            responseData = buildAck();
          } else if (discriminator === 3) {
            // S2CRegistry — server sends registry data, we ACK
            responseData = buildAck();
          } else if (discriminator === 4) {
            // S2CConfigData
            responseData = buildAck();
          } else {
            responseData = buildAck();
          }
        }

        client.write('login_plugin_response', {
          messageId: packet.messageId,
          successful,
          data: responseData,
        });
      } catch (e) {
        log('Forge', `Plugin response error: ${e.message}`);
        try {
          client.write('login_plugin_response', {
            messageId: packet.messageId,
            successful: false,
            data: Buffer.alloc(0),
          });
        } catch (_) {}
      }
    };

    client.on('login_plugin_request', onLoginPlugin);

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
