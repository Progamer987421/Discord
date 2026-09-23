'use strict';

/**
 * minecraft.js
 * Handles everything Minecraft-side.
 * One MinecraftBot instance per in-game account.
 * Talks back to the Discord layer via event callbacks only.
 */

const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals: { GoalBlock } } = require('mineflayer-pathfinder');
const { SocksClient } = require('socks');

// ── Minecraft map color palette ───────────────────────────────────
// 58 base colors × 4 brightness shades = 232 used indices (out of 256)
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

/**
 * Convert 128×128 Minecraft map bytes → raw RGBA buffer (512×512 @ 4× scale).
 * Uses no native deps — pure JS, works everywhere.
 * Returns { width, height, data: Buffer } ready for pureimage.
 */
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
          out[px+3] = a === 0 ? 20 : 255; // near-transparent → dark bg
        }
      }
    }
  }
  return { width: DST, height: DST, data: out };
}

/**
 * Encode raw RGBA → PNG Buffer using pureimage (pure-JS, no libcairo needed).
 */
async function rgbaToPng(rgba) {
  const pureimage = require('pureimage');
  const { PassThrough } = require('stream');

  const img = pureimage.make(rgba.width, rgba.height);
  // pureimage stores pixels as premultiplied ARGB in a Uint32Array
  const src = rgba.data;
  for (let i = 0; i < rgba.width * rgba.height; i++) {
    const r = src[i * 4];
    const g = src[i * 4 + 1];
    const b = src[i * 4 + 2];
    const a = src[i * 4 + 3];
    img.data[i * 4]     = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = a;
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
// Accepts: socks5://user:pass@host:port  OR  host:port
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

// ── MinecraftBot ──────────────────────────────────────────────────
class MinecraftBot {
  /**
   * @param {object} opts
   * @param {string}   opts.username
   * @param {string}   opts.password   - /register + /login password
   * @param {string}   opts.host
   * @param {number}   opts.port
   * @param {string}   opts.version
   * @param {object}  [opts.proxy]     - { host, port, userId?, password? }
   * @param {function} opts.onLog      - (msg: string) => void
   * @param {function} opts.onStatus   - (status: string) => void
   * @param {function} opts.onEvent    - (event: string, detail: string) => void
   * @param {function} opts.onCaptcha  - (pngBuffer: Buffer) => void
   */
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

    this._bot          = null;
    this._reconnectTimer = null;
    this._reconnects   = 0;
    this._registered   = false;
    this._inBanana     = false;
    this._spawnTime    = 0;
    this._alive        = true;       // false after destroy()
    this.captchaPending = false;
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
      this._scheduleReconnect();
      return;
    }

    bot.loadPlugin(pathfinder);
    this._bot       = bot;
    this._spawnTime = Date.now();

    this._attachEvents(bot);
    this._attachCaptcha(bot);
  }

  // ── Destroy (permanent kill) ───────────────────────────────────
  destroy() {
    this._alive = false;
    clearTimeout(this._reconnectTimer);
    if (this._bot) { try { this._bot.quit(); } catch (_) {} this._bot = null; }
  }

  // ── Send chat ─────────────────────────────────────────────────
  chat(message) {
    if (!this._bot) return false;
    try { this._bot.chat(message); return true; }
    catch (_) { return false; }
  }

  // ── Submit captcha answer ─────────────────────────────────────
  submitCaptcha(answer) {
    if (!this.captchaPending) return { error: 'No captcha pending' };
    if (!this._bot)           return { error: 'Bot not connected' };
    const sent = this.chat(answer.toLowerCase());
    if (!sent) return { error: 'Failed to send' };
    this._log(`Captcha submitted: "${answer}"`);
    this.captchaPending = false;
    return { success: true };
  }

  // ── Update proxy and reconnect ────────────────────────────────
  setProxy(proxy) {
    this.proxy = proxy;
    this._log(`Proxy updated → ${proxy.host}:${proxy.port} — reconnecting`);
    if (this._bot) { try { this._bot.quit(); } catch (_) {} this._bot = null; }
    clearTimeout(this._reconnectTimer);
    setTimeout(() => this.connect(), 1000);
  }

  // ── Core event wiring ─────────────────────────────────────────
  _attachEvents(bot) {
    // ── spawn ────────────────────────────────────────────────────
    bot.once('spawn', () => {
      this._setStatus('verifying...');
      this._log('Spawned — waiting for bot-check');

      setTimeout(() => {
        if (this._bot !== bot) return;
        this._setStatus('authing');

        if (!this._registered) {
          bot.chat(`/register ${this.password} ${this.password}`);
          this._log('Sent /register');
          this._registered = true;
          setTimeout(() => {
            if (this._bot !== bot) return;
            bot.chat(`/login ${this.password}`);
            this._log('Sent /login');
          }, 1500);
        } else {
          bot.chat(`/login ${this.password}`);
          this._log('Sent /login');
        }
      }, 3000);
    });

    // ── messages ─────────────────────────────────────────────────
    bot.on('message', (json) => {
      const text = json.toString();
      this._log(`[MSG] ${text}`);

      if (/already registered/i.test(text)) this._registered = true;

      // Successful login
      if (/logged in|successfully authenticated|you are now logged/i.test(text)) {
        this._reconnects = 0; // reset backoff on clean login
        this._setStatus('online ✓ lobby');
        this.onEvent('online', 'Authenticated and online');
        this._startAntiAFK(bot);

        if (!this._inBanana) {
          this._inBanana = true;
          setTimeout(() => {
            if (this._bot !== bot) return;
            bot.chat('/server banana');
            this._log('Sent /server banana');
            this._setStatus('online ✓ banana');
          }, 1000);
        }
      }

      if (/wrong password|incorrect password/i.test(text)) {
        this._log('Wrong password — stopping');
        this.destroy();
        this.onEvent('error', 'Wrong password — bot stopped');
      }

      if (/connecting you to|sending you to|transferring/i.test(text)) {
        this._log('Server transfer');
        this._inBanana = false;
      }

      // Captcha text triggers
      if (/captcha|verify|type the word|enter the code|anti.?bot|human check/i.test(text)) {
        this._log(`Captcha prompt: "${text}"`);
        this.captchaPending = true;
        this.onEvent('captcha', 'Captcha detected — check Discord for the image');
      }

      if (this.captchaPending && /correct|verified|passed|welcome|success/i.test(text)) {
        this._log('Captcha passed');
        this.captchaPending = false;
        this.onEvent('info', 'Captcha passed ✅');
      }

      if (this.captchaPending && /wrong|incorrect|try again|failed|invalid/i.test(text)) {
        this._log('Wrong captcha — waiting for new answer from Discord');
        this.onEvent('captcha', '❌ Wrong captcha — please submit again');
      }
    });

    bot.on('chat', (uname, msg) => {
      if (uname === bot.username) return;
      this._log(`<${uname}> ${msg}`);
    });

    // ── kicked ───────────────────────────────────────────────────
    bot.on('kicked', (reason) => {
      const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this._log(`Kicked: ${r}`);
      this.onEvent('kicked', r.slice(0, 100));
      this._bot = null;

      const fast =
        /verify|bot.?check|captcha|not a bot|human|challenge|flying|moving too fast/i.test(r) ||
        Date.now() - this._spawnTime < 6000;

      this._inBanana = false;
      if (!this._alive) return;

      if (fast) {
        const d = this._jitter();
        this._setStatus(`antibot kick — rejoining in ${(d/1000).toFixed(1)}s`);
        this._reconnectTimer = setTimeout(() => this.connect(), d);
      } else {
        this._setStatus('kicked');
        this._scheduleReconnect();
      }
    });

    // ── end ──────────────────────────────────────────────────────
    bot.on('end', (reason) => {
      this._log(`Disconnected: ${reason}`);
      this._bot      = null;
      this._inBanana = false;
      if (!this._alive) return;
      const d = this._jitter();
      this._setStatus(`reconnecting in ${(d/1000).toFixed(1)}s`);
      this._reconnectTimer = setTimeout(() => this.connect(), d);
    });

    bot.on('error', (err) => this._log(`Error: ${err.message}`));

    bot.on('death', () => {
      this._log('Died — respawning');
      try { bot.respawn(); } catch (_) {}
    });
  }

  // ── Captcha map watcher ───────────────────────────────────────
  _attachCaptcha(bot) {
    let rendering = false;

    const tryRender = async () => {
      if (!this.captchaPending || rendering) return;
      const held = bot.heldItem;
      if (!held?.name?.includes('map')) return;

      const mapId  = held.metadata?.[0]?.value ?? held.nbt?.value?.map?.value;
      const mapObj = bot.maps?.[mapId];
      if (!mapObj?.data) return;

      rendering = true;
      this._log('Map captcha detected — rendering PNG');

      try {
        const rgba      = mapToRgba(mapObj.data);
        const pngBuffer = await rgbaToPng(rgba);
        this._log('PNG ready — forwarding to Discord');
        this.onCaptcha(pngBuffer);
      } catch (err) {
        this._log(`PNG render failed: ${err.message} — use !captcha command instead`);
        this.onEvent('captcha', '⚠️ Could not render captcha image — use `!captcha <username> <answer>` to submit manually');
      }

      rendering = false;
    };

    bot.on('heldItemChanged', () => { if (this.captchaPending) setTimeout(tryRender, 300); });
    bot.on('map',             () => { if (this.captchaPending) setTimeout(tryRender, 200); });
    bot.on('spawn',           () => { setTimeout(() => { if (this.captchaPending) tryRender(); }, 1500); });
  }

  // ── Anti-AFK ──────────────────────────────────────────────────
  _startAntiAFK(bot) {
    let tick = 0;
    const iv = setInterval(() => {
      if (this._bot !== bot) { clearInterval(iv); return; }
      tick++;

      // Random look every 30s
      if (tick % 6 === 0) {
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.8, false);
      }

      // Short walk every 2min
      if (tick % 24 === 0) {
        const pos = bot.entity?.position;
        if (pos) {
          try {
            const mcData = require('minecraft-data')(bot.version);
            const moves  = new Movements(bot, mcData);
            bot.pathfinder.setMovements(moves);
            bot.pathfinder.setGoal(new GoalBlock(
              Math.floor(pos.x) + Math.floor((Math.random()-.5)*8),
              Math.floor(pos.y),
              Math.floor(pos.z) + Math.floor((Math.random()-.5)*8),
            ));
          } catch (_) {}
        }
      }

      // Sneak every 5min
      if (tick % 60 === 0) {
        bot.setControlState('sneak', true);
        setTimeout(() => { if (this._bot === bot) bot.setControlState('sneak', false); }, 1500);
      }
    }, 5000);
  }

  // ── Reconnect backoff ─────────────────────────────────────────
  _scheduleReconnect() {
    if (!this._alive) return;
    const delay = Math.min(5000 * Math.pow(1.5, this._reconnects), 60000);
    this._reconnects++;
    this.captchaPending = false;
    this._setStatus(`reconnecting in ${Math.round(delay/1000)}s (attempt ${this._reconnects})`);
    this._log(`Reconnecting in ${Math.round(delay/1000)}s`);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _jitter() { return Math.floor(Math.random() * 5000) + 5000; }

  _setStatus(s) { this.status = s; this.onStatus(s); }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[${this.username}] ${msg}`);
    this.onLog(line);
  }
}

module.exports = { MinecraftBot, randomUsername, parseProxy };
