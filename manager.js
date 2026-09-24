'use strict';

const fs   = require('fs');
const path = require('path');
const { MinecraftBot, randomUsername, parseProxy } = require('./minecraft');

const MC_HOST     = process.env.MC_HOST    || 'play.applemc.fun';
const MC_PORT     = parseInt(process.env.MC_PORT || '25565');
const MC_VERSION  = process.env.MC_VERSION || '1.20.1';
const MC_PASSWORD = process.env.MC_PASSWORD || '';

const MAX_LOGS      = 500;
const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.txt');

// ── Load accounts from file ───────────────────────────────────────
function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return fs.readFileSync(ACCOUNTS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [username, password] = l.split(':');
      return { username: username.trim(), password: (password || MC_PASSWORD).trim() };
    });
}

// ── Write one account to file ─────────────────────────────────────
function appendAccount(username, password) {
  const line = password ? `${username}:${password}` : username;
  fs.appendFileSync(ACCOUNTS_FILE, `\n${line}`, 'utf8');
}

// ── Remove one account from file ──────────────────────────────────
function removeAccountFromFile(username) {
  if (!fs.existsSync(ACCOUNTS_FILE)) return false;
  const lines = fs.readFileSync(ACCOUNTS_FILE, 'utf8').split('\n');
  const filtered = lines.filter(l => {
    const u = l.trim().split(':')[0].trim();
    return u !== username && l.trim() !== '';
  });
  fs.writeFileSync(ACCOUNTS_FILE, filtered.join('\n') + '\n', 'utf8');
  return true;
}

class Manager {
  constructor() {
    this._bots     = new Map();
    this._accounts = loadAccounts();
    this._accIndex = 0;
    this.onCaptchaImage = null;
    this.onBotEvent     = null;
  }

  // ── Pick next available account ───────────────────────────────
  _nextAccount() {
    if (!this._accounts.length)
      return { username: randomUsername(), password: MC_PASSWORD };

    const total = this._accounts.length;
    for (let i = 0; i < total; i++) {
      const acc = this._accounts[this._accIndex % total];
      this._accIndex++;
      if (!this._bots.has(acc.username)) return acc;
    }
    return { username: randomUsername(), password: MC_PASSWORD };
  }

  // ── Reload accounts from file ─────────────────────────────────
  reloadAccounts() {
    this._accounts = loadAccounts();
    this._accIndex = 0;
    return this._accounts.length;
  }

  // ── Add account to file + live list ──────────────────────────
  addAccount(username, password = '') {
    const exists = this._accounts.find(a => a.username === username);
    if (exists) return { error: `Account "${username}" already exists` };
    appendAccount(username, password || '');
    this._accounts.push({ username, password: password || MC_PASSWORD });
    return { success: true, count: this._accounts.length };
  }

  // ── Remove account from file + live list ─────────────────────
  removeAccount(username) {
    const idx = this._accounts.findIndex(a => a.username === username);
    if (idx === -1) return { error: `Account "${username}" not found` };
    this._accounts.splice(idx, 1);
    removeAccountFromFile(username);
    return { success: true, count: this._accounts.length };
  }

  // ── List all loaded accounts ──────────────────────────────────
  listAccounts() {
    return this._accounts.map(a => ({
      username: a.username,
      hasPassword: !!a.password,
      running: this._bots.has(a.username),
    }));
  }

  // ── Spawn N bots, staggered 3–7s apart ───────────────────────
  spawn(count = 1, proxyStr = null) {
    count = Math.max(1, Math.min(count, 10));
    const proxy   = proxyStr ? parseProxy(proxyStr) : null;
    const created = [];

    for (let i = 0; i < count; i++) {
      const { username, password } = this._nextAccount();
      const entry = { bot: null, logs: [], status: 'queued' };
      this._bots.set(username, entry);

      const delay = i * (3000 + Math.floor(Math.random() * 4000));

      const launch = () => {
        const bot = new MinecraftBot({
          username,
          password,
          host:    MC_HOST,
          port:    MC_PORT,
          version: MC_VERSION,
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
        entry.status = `queued (~${Math.round(delay / 1000)}s)`;
        setTimeout(launch, delay);
      }

      created.push(username);
    }

    return created;
  }

  kill(username) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    entry.bot?.destroy();
    this._bots.delete(username);
    return { success: true };
  }

  killAll() {
    for (const { bot } of this._bots.values()) bot?.destroy();
    this._bots.clear();
  }

  reconnect(username) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    entry.bot?.destroy();
    entry.status = 'reconnecting';
    setTimeout(() => { if (entry.bot) entry.bot.connect(); }, 1000);
    return { success: true };
  }

  chat(username, message) {
    const entry = this._bots.get(username);
    if (!entry)             return { error: `No bot named "${username}"` };
    if (!entry.bot?.online) return { error: `${username} is not online` };
    entry.bot.chat(message);
    return { success: true };
  }

  broadcast(message) {
    let sent = 0;
    for (const [, entry] of this._bots) {
      if (entry.bot?.online) { entry.bot.chat(message); sent++; }
    }
    return sent;
  }

  submitCaptcha(username, answer) {
    const entry = this._bots.get(username);
    if (!entry)     return { error: `No bot named "${username}"` };
    if (!entry.bot) return { error: 'Bot not initialised yet' };
    return entry.bot.submitCaptcha(answer);
  }

  setProxy(username, proxyStr) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    const proxy = parseProxy(proxyStr);
    if (!proxy) return { error: 'Invalid proxy format' };
    entry.bot?.setProxy(proxy);
    return { success: true };
  }

  getLogs(username, tail = 25) {
    const entry = this._bots.get(username);
    if (!entry) return { error: `No bot named "${username}"` };
    return { logs: entry.logs.slice(-tail) };
  }

  list() {
    const out = [];
    for (const [username, entry] of this._bots) {
      out.push({
        username,
        status:     entry.status,
        online:     !!entry.bot?.online,
        reconnects: entry.bot?.reconnects ?? 0,
        captcha:    !!entry.bot?.captchaPending,
        proxy:      entry.bot?.proxy
          ? `${entry.bot.proxy.host}:${entry.bot.proxy.port}`
          : 'direct',
      });
    }
    return out;
  }

  get size() { return this._bots.size; }
}

module.exports = Manager;
