'use strict';

/**
 * manager.js
 * Registry that holds all MinecraftBot instances.
 * Discord layer talks to this — never to MinecraftBot directly.
 */

const { MinecraftBot, randomUsername, parseProxy } = require('./minecraft');

const MC_HOST     = process.env.MC_HOST     || 'play.applemc.fun';
const MC_PORT     = parseInt(process.env.MC_PORT || '25565');
const MC_VERSION  = process.env.MC_VERSION  || '1.20.1';
const MC_PASSWORD = process.env.MC_PASSWORD || '231182';

const MAX_LOGS = 500;

class Manager {
  constructor() {
    // username → { bot: MinecraftBot, logs: string[], status: string }
    this._bots = new Map();

    // Callbacks injected by Discord layer
    this.onCaptchaImage = null; // (username, pngBuffer) => void
    this.onBotEvent     = null; // (username, event, detail) => void
  }

  // ── Spawn N bots, staggered 3-7s apart ───────────────────────
  spawn(count = 1, proxyStr = null) {
    count = Math.max(1, Math.min(count, 10));
    const proxy   = proxyStr ? parseProxy(proxyStr) : null;
    const created = [];

    for (let i = 0; i < count; i++) {
      let username;
      do { username = randomUsername(); }
      while (this._bots.has(username));

      const entry = { bot: null, logs: [], status: 'queued' };
      this._bots.set(username, entry);

      const delay = i * (3000 + Math.floor(Math.random() * 4000));

      const launch = () => {
        const bot = new MinecraftBot({
          username,
          password: MC_PASSWORD,
          host:     MC_HOST,
          port:     MC_PORT,
          version:  MC_VERSION,
          proxy,
          onLog: (line) => {
            entry.logs.push(line);
            if (entry.logs.length > MAX_LOGS) entry.logs.shift();
          },
          onStatus: (s) => { entry.status = s; },
          onEvent:  (event, detail) => {
            if (this.onBotEvent) this.onBotEvent(username, event, detail);
          },
          onCaptcha: (pngBuffer) => {
            if (this.onCaptchaImage) this.onCaptchaImage(username, pngBuffer);
          },
        });

        entry.bot    = bot;
        entry.status = 'connecting';
        bot.connect();
      };

      if (delay === 0) launch();
      else {
        entry.status = `queued (~${Math.round(delay/1000)}s)`;
        setTimeout(launch, delay);
      }

      created.push(username);
    }

    return created;
  }

  // ── Kill one bot ──────────────────────────────────────────────
  kill(username) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    entry.bot?.destroy();
    this._bots.delete(username);
    return { success: true };
  }

  // ── Kill all bots ─────────────────────────────────────────────
  killAll() {
    for (const { bot } of this._bots.values()) bot?.destroy();
    this._bots.clear();
  }

  // ── Send chat via one bot ─────────────────────────────────────
  chat(username, message) {
    const entry = this._bots.get(username);
    if (!entry)       return { error: `No bot named "${username}"` };
    if (!entry.bot?.online) return { error: `${username} is not online` };
    entry.bot.chat(message);
    return { success: true };
  }

  // ── Broadcast to all online bots ──────────────────────────────
  broadcast(message) {
    let sent = 0;
    for (const [, entry] of this._bots) {
      if (entry.bot?.online) { entry.bot.chat(message); sent++; }
    }
    return sent;
  }

  // ── Submit captcha for one bot ────────────────────────────────
  submitCaptcha(username, answer) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    if (!entry.bot) return { error: 'Bot not initialised yet' };
    return entry.bot.submitCaptcha(answer);
  }

  // ── Hot-swap proxy ────────────────────────────────────────────
  setProxy(username, proxyStr) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    const proxy = parseProxy(proxyStr);
    if (!proxy) return { error: 'Invalid proxy format — use socks5://user:pass@host:port' };
    entry.bot?.setProxy(proxy);
    return { success: true };
  }

  // ── Get logs ──────────────────────────────────────────────────
  getLogs(username, tail = 25) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    return { logs: entry.logs.slice(-tail) };
  }

  // ── List all bots ─────────────────────────────────────────────
  list() {
    const out = [];
    for (const [username, entry] of this._bots) {
      out.push({
        username,
        status:     entry.status,
        online:     !!entry.bot?.online,
        reconnects: entry.bot?.reconnects ?? 0,
        captcha:    !!entry.bot?.captchaPending,
        proxy:      entry.bot?.proxy ? `${entry.bot.proxy.host}:${entry.bot.proxy.port}` : 'direct',
      });
    }
    return out;
  }

  get size() { return this._bots.size; }
}

module.exports = Manager;
