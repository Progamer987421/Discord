'use strict';

/**
 * minecraft.js
 * MANUAL MODE — bot connects and sits. Nothing automatic.
 * You control everything via Discord commands.
 */

const mineflayer  = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { SocksClient } = require('socks');

// ── Minecraft map color palette ───────────────────────────────────
const BASE_COLORS = [
  [0,0,0],       [127,178,56],  [247,233,163], [199,199,199],
  [255,0,0],     [160,160,255], [167,167,167], [0,124,0],
  [255,255,255], [164,168,184], [151,109,77],  [112,112,112],
  [64,64,255],   [143,119,72],  [255,252,245], [216,127,51],
  [178,76,216],  [102,127,51],  [229,229,51],  [0,217,58],
  [127,63,178],  [0,187,187],   [0,100,255],   [0,153,0],
  [0,0,0],       [250,238,77],  [92,219,213],  [74,128,255],
  [0,217,58],    [129,86,49],   [112,2,0],     [209,177,161],
  [159,82,36],   [149,87,108],  [112,108,138], [186,133,36],
  [103,117,53],  [160,77,78],   [57,41,35],    [135,107,98],
  [87,92,92],    [122,73,88],   [76,62,92],    [76,50,35],
  [76,82,42],    [142,60,46],   [37,22,16],    [189,48,49],
  [148,63,97],   [92,25,29],    [22,126,134],  [58,142,140],
  [86,44,62],    [20,180,133],  [100,100,100], [216,175,147],
  [127,167,150],
];
const SHADE = [180, 220, 255, 135];
const PALETTE = new Array(256).fill(null).map(() => ({ r:0, g:0, b:0, a:0 }));
for (let i = 0; i < BASE_COLORS.length; i++) {
  for (let s = 0; s < 4; s++) {
    const idx = i * 4 + s;
    if (idx >= 256) break;
    const m = SHADE[s] / 255;
    PALETTE[idx] = {
      r: Math.round(BASE_COLORS[i][0] * m),
      g: Math.round(BASE_COLORS[i][1] * m),
      b: Math.round(BASE_COLORS[i][2] * m),
      a: i === 0 ? 0 : 255,
    };
  }
}

function mapToRgba(mapData) {
  const SRC = 128, SCALE = 4, DST = SRC * SCALE;
  const out = Buffer.alloc(DST * DST * 4, 0);
  for (let y = 0; y < SRC; y++) {
    for (let x = 0; x < SRC; x++) {
      const { r, g, b, a } = PALETTE[mapData[y * SRC + x] & 0xff];
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const px = ((y * SCALE + sy) * DST + (x * SCALE + sx)) * 4;
          out[px]   = r;
          out[px+1] = g;
          out[px+2] = b;
          out[px+3] = a === 0 ? 20 : 255;
        }
      }
    }
  }
  return { width: DST, height: DST, data: out };
}

async function rgbaToPng(rgba) {
  const pureimage = require('pureimage');
  const { PassThrough } = require('stream');
  const img = pureimage.make(rgba.width, rgba.height);
  const src = rgba.data;
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    img.data[i * 4]     = src[i * 4];
    img.data[i * 4 + 1] = src[i * 4 + 1];
    img.data[i * 4 + 2] = src[i * 4 + 2];
    img.data[i * 4 + 3] = src[i * 4 + 3];
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pass   = new PassThrough();
    pass.on('data',  c => chunks.push(c));
    pass.on('end',   () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);
    pureimage.encodePNGToStream(img, pass).catch(reject);
  });
}

// ── Username generator ────────────────────────────────────────────
const ADJ  = ['cool','dark','epic','fast','gold','iron','lost','mega','neon','real','red','sick','slim','wild','blue','cold','dead','free','holy','jade','keen','lazy','loud','mad','nice','odd'];
const NOUN = ['ace','axe','bat','bee','cat','dog','elf','fox','gem','gun','hawk','imp','jay','jet','kid','lion','man','monk','owl','pig','rat','rex','rook','sage','wolf','yak'];

function randomUsername() {
  const a = ADJ[Math.floor(Math.random()  * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const d = Math.floor(Math.random() * 999);
  const raw = Math.random() > 0.5
    ? `${a}${n}${d}`
    : `${a[0].toUpperCase()+a.slice(1)}${n[0].toUpperCase()+n.slice(1)}${d}`;
  return raw.slice(0, 16);
}

// ── Parse proxy string ────────────────────────────────────────────
function parseProxy(str) {
  if (!str) return null;
  try {
    let s = str.replace(/^socks5?:\/\//i, '');
    let userId, password, host, port;
    if (s.includes('@')) {
      const [auth, addr] = s.split('@');
      [userId, password] = auth.split(':');
      [host, port]       = addr.split(':');
    } else {
      [host, port] = s.split(':');
    }
    port = parseInt(port);
    if (!host || !port || isNaN(port)) return null;
    return { host, port, userId: userId||undefined, password: password||undefined };
  } catch (_) { return null; }
}

// ── Parse kick reason — handles raw JSON objects from the server ──
function parseKickReason(reason) {
  if (typeof reason === 'string') {
    try { reason = JSON.parse(reason); } catch (_) { return reason; }
  }
  function extract(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    let out = node.text || '';
    if (Array.isArray(node.extra)) out += node.extra.map(extract).join('');
    return out;
  }
  const text = extract(reason).trim();
  return text || (() => { try { return JSON.stringify(reason); } catch (_) { return String(reason); } })();
}

// ── MinecraftBot — MANUAL MODE ────────────────────────────────────
class MinecraftBot {
  constructor(opts) {
    this.username  = opts.username;
    this.password  = opts.password;
    this.host      = opts.host;
    this.port      = opts.port;
    this.version   = opts.version;
    this.proxy     = opts.proxy   || null;
    this.onLog     = opts.onLog   || (() => {});
    this.onStatus  = opts.onStatus  || (() => {});
    this.onEvent   = opts.onEvent   || (() => {});
    this.onCaptcha = opts.onCaptcha || (() => {});

    this._bot            = null;
    this._reconnectTimer = null;
    this._reconnects     = 0;
    this._spawnTime      = 0;
    this._alive          = true;
    this.captchaPending  = false;
  }

  get reconnects() { return this._reconnects; }
  get online()     { return !!this._bot; }

  // ── Connect ───────────────────────────────────────────────────
  connect() {
    if (!this._alive) return;
    const label = this.proxy ? `${this.proxy.host}:${this.proxy.port}` : 'direct';
    this._log(`Connecting as ${this.username} via ${label}`);
    this._setStatus('connecting');

    const opts = {
      host:                 this.host,
      port:                 this.port,
      username:             this.username,
      version:              this.version,
      auth:                 'offline',
      checkTimeoutInterval: 30000,
      closeTimeout:         240,
    };

    if (this.proxy) {
      const proxy = this.proxy;
      opts.connect = (client) => {
        SocksClient.createConnection({
          proxy:       { host: proxy.host, port: proxy.port, type: 5, userId: proxy.userId, password: proxy.password },
          command:     'connect',
          destination: { host: this.host, port: this.port },
        }).then(({ socket }) => {
          client.setSocket(socket);
          client.emit('connect');
        }).catch(err => {
          this._log(`Proxy error: ${err.message}`);
          this.onEvent('error', `Proxy failed: ${err.message}`);
          client.emit('error', err);
        });
      };
    }

    let bot;
    try { bot = mineflayer.createBot(opts); }
    catch (err) {
      this._log(`Spawn error: ${err.message}`);
      this._setStatus('spawn error — waiting');
      return;
    }

    bot.loadPlugin(pathfinder);
    this._bot       = bot;
    this._spawnTime = Date.now();

    this._attachEvents(bot);
    this._attachCaptcha(bot);
  }

  // ── Destroy ───────────────────────────────────────────────────
  destroy() {
    this._alive = false;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._jitterTimer);
    clearTimeout(this._swingTimer);
    clearTimeout(this._sneakTimer);
    try { this._bot?.quit(); } catch (_) {}
    this._bot = null;
  }

  // ── Send chat ─────────────────────────────────────────────────
  chat(msg) {
    if (!this._bot) return;
    this._bot.chat(msg);
  }

  // ── Submit captcha ────────────────────────────────────────────
  submitCaptcha(answer) {
    if (!this._bot) return { error: 'Bot not connected' };
    this._bot.chat(answer);
    this.captchaPending = false;
    this._log(`Captcha submitted: ${answer}`);
    return { success: true };
  }

  // ── Hot-swap proxy ────────────────────────────────────────────
  setProxy(proxy) {
    this.proxy = proxy;
    this._log(`Proxy updated to ${proxy.host}:${proxy.port} — reconnecting`);
    try { this._bot?.quit(); } catch (_) {}
    this._bot = null;
    setTimeout(() => this.connect(), 1000);
  }

  // ── Events — MANUAL MODE ──────────────────────────────────────
  // Bot connects and sits. No auto-register, no auto-login,
  // no auto-server switch, no anti-AFK, no auto-reconnect.
  // You control everything via !chat commands in Discord.
  _attachEvents(bot) {

    // Spawned — assume captcha is coming, start watching immediately
    bot.once('spawn', () => {
      this._setStatus('connected — waiting for captcha');
      this._log('Spawned — watching for map captcha.');
      this.captchaPending = true;
      this.onEvent('online', 'Connected — watching for captcha map');

      // ── Spoof client brand to "vanilla" ──
      try {
        bot._client.write('plugin_message', {
          channel: 'minecraft:brand',
          data: Buffer.concat([Buffer.from([7]), Buffer.from('vanilla')]),
        });
      } catch (_) {}

      // ── Send client settings — real clients always send this ──
      try {
        bot._client.write('settings', {
          locale:              'en_US',
          viewDistance:        8,
          chatFlags:           0,
          chatColors:          true,
          skinParts:           127,
          mainHand:            1,
          enableTextFiltering: false,
          enableServerListing: true,
        });
      } catch (_) {}

      // ── Micro-look jitter every 4–9s ──
      const jitter = () => {
        if (!this._bot || !this._alive) return;
        try {
          const yaw   = (bot.entity?.yaw   || 0) + (Math.random() - 0.5) * 0.04;
          const pitch = (bot.entity?.pitch || 0) + (Math.random() - 0.5) * 0.02;
          bot.look(yaw, pitch, false);
        } catch (_) {}
        this._jitterTimer = setTimeout(jitter, 4000 + Math.random() * 5000);
      };
      this._jitterTimer = setTimeout(jitter, 1500 + Math.random() * 1500);

      // ── Arm swing every 15–45s ──
      const swing = () => {
        if (!this._bot || !this._alive) return;
        try { bot.swingArm(); } catch (_) {}
        this._swingTimer = setTimeout(swing, 15000 + Math.random() * 30000);
      };
      this._swingTimer = setTimeout(swing, 8000 + Math.random() * 10000);

      // ── Sneak tap every 45–105s ──
      const sneak = () => {
        if (!this._bot || !this._alive) return;
        try {
          bot.setControlState('sneak', true);
          setTimeout(() => { try { bot.setControlState('sneak', false); } catch (_) {} }, 200 + Math.random() * 300);
        } catch (_) {}
        this._sneakTimer = setTimeout(sneak, 45000 + Math.random() * 60000);
      };
      this._sneakTimer = setTimeout(sneak, 20000 + Math.random() * 20000);
    });

    // Log all incoming messages so you can see what the server says
    bot.on('message', (json) => {
      const text = json.toString();
      this._log(`[MSG] ${text}`);

      // Captcha detection — still alerts you, but YOU submit the answer
      if (/captcha|verify|type the word|enter the code|anti.?bot|human check/i.test(text)) {
        this._log(`Captcha prompt detected: "${text}"`);
        this.captchaPending = true;
        this.onEvent('captcha', 'Captcha detected — submit answer with !captcha or reply to image');
      }

      if (this.captchaPending && /correct|verified|passed|welcome|success/i.test(text)) {
        this._log('Captcha passed');
        this.captchaPending = false;
        this.onEvent('info', 'Captcha passed ✅');
      }

      if (this.captchaPending && /wrong|incorrect|try again|failed|invalid/i.test(text)) {
        this._log('Wrong captcha answer');
        this.onEvent('captcha', '❌ Wrong captcha — submit again with !captcha');
      }
    });

    bot.on('chat', (uname, msg) => {
      if (uname === bot.username) return;
      this._log(`<${uname}> ${msg}`);
    });

    // Kicked — report it, stop. No auto-reconnect.
    bot.on('kicked', (reason) => {
      const r = parseKickReason(reason);
      this._log(`Kicked: ${r}`);
      this.onEvent('kicked', r.slice(0, 200));
      this._bot = null;
      this._setStatus(`kicked — use !spawn to reconnect`);
    });

    // Disconnected — report it, stop. No auto-reconnect.
    bot.on('end', (reason) => {
      const r = parseKickReason(reason);
      this._log(`Disconnected: ${r}`);
      this._bot = null;
      this._setStatus(`disconnected — use !reconnect to rejoin`);
      this.onEvent('kicked', `Disconnected: ${r}`);
    });

    bot.on('error', (err) => {
      this._log(`Error: ${err.message}`);
    });

    // Died — report it. No auto-respawn.
    bot.on('death', () => {
      this._log('Died — use !chat <username> /respawn to respawn manually');
      this._setStatus('dead — respawn manually');
    });
  }

  // ── Captcha image watcher — intercepts raw map packet before kick lands
  _attachCaptcha(bot) {
    let rendered = false;

    const renderFromData = async (data, label) => {
      if (rendered || !data) return;
      rendered = true;
      this._log(`Map captcha intercepted (${label}) — rendering PNG`);
      try {
        const rgba      = mapToRgba(data);
        const pngBuffer = await rgbaToPng(rgba);
        this._log('PNG ready — posting to Discord');
        this.onCaptcha(pngBuffer);
      } catch (err) {
        this._log(`PNG render failed: ${err.message}`);
        this.onEvent('captcha', '⚠️ Could not render captcha image — use `!captcha <username> <answer>`');
      }
    };

    // ── Raw packet intercept — fires before mineflayer processes it ──
    // map_data packet contains the raw pixel bytes directly
    bot._client.on('map', (packet) => {
      if (rendered) return;
      // packet.data is a Buffer of 128*128 palette indices
      if (packet.data && packet.data.length >= 128 * 128) {
        this._log(`Raw map packet received — id=${packet.itemDamage ?? packet.mapId}`);
        renderFromData(packet.data, 'raw packet');
      }
    });

    // ── Fallback: mineflayer's parsed map event ──
    bot.on('map', (map) => {
      if (rendered || !map?.data) return;
      renderFromData(map.data, 'mineflayer map event');
    });

    // ── Fallback: held item is a map, check bot.maps ──
    bot.on('heldItemChanged', () => {
      if (rendered) return;
      const maps = bot.maps || {};
      for (const m of Object.values(maps)) {
        if (m?.data) { renderFromData(m.data, 'heldItemChanged'); return; }
      }
    });
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[${this.username}] ${msg}`);
    this.onLog(line);
  }
}

module.exports = { MinecraftBot, randomUsername, parseProxy };
