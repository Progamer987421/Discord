'use strict';

/**
 * bot.js
 * Discord bot entry point.
 * All commands live here. Nothing else.
 */

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

const Manager = require('./manager');

// ── Validate required env vars ────────────────────────────────────
['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_CHANNEL_ID'].forEach(k => {
  if (!process.env[k]) {
    console.error(`[ERROR] Missing required env var: ${k}`);
    process.exit(1);
  }
});

const TOKEN      = process.env.DISCORD_TOKEN;
const GUILD_ID   = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const OWNER_ID   = process.env.DISCORD_OWNER_ID || null;

// ── Discord client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ── Bot manager ───────────────────────────────────────────────────
const manager = new Manager();

// captcha reply tracking: Discord message id → Minecraft username
const captchaReplies = new Map();

// ── Wire manager callbacks ────────────────────────────────────────
manager.onCaptchaImage = async (username, pngBuffer) => {
  try {
    const ch   = await client.channels.fetch(CHANNEL_ID);
    const file = new AttachmentBuilder(pngBuffer, { name: 'captcha.png' });
    const embed = new EmbedBuilder()
      .setColor(0xffd740)
      .setTitle(`🔐 Captcha for ${username}`)
      .setDescription(
        `**Reply to this message** with the captcha text shown in the image.\n` +
        `Or use: \`!captcha ${username} <answer>\``
      )
      .setImage('attachment://captcha.png')
      .setTimestamp();

    const sent = await ch.send({ embeds: [embed], files: [file] });
    captchaReplies.set(sent.id, username);
    // Auto-expire after 5 minutes
    setTimeout(() => captchaReplies.delete(sent.id), 300_000);
  } catch (err) {
    console.error('[Discord] Failed to send captcha image:', err.message);
  }
};

manager.onBotEvent = async (username, event, detail) => {
  // Only post important events — skip 'info' spam
  if (event === 'info') return;

  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    const color = {
      online:  0x00e676,
      kicked:  0xff1744,
      captcha: 0xffd740,
      error:   0xff5252,
    }[event] ?? 0x607d8b;

    const icon = {
      online:  '✅',
      kicked:  '💀',
      captcha: '🔐',
      error:   '❌',
    }[event] ?? 'ℹ️';

    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setColor(color)
          .setDescription(`${icon} **${username}** — ${detail}`)
      ],
    });
  } catch (_) {}
};

// ── Auth check ────────────────────────────────────────────────────
function isAllowed(msg) {
  if (msg.author.bot)           return false;
  if (msg.guildId   !== GUILD_ID)   return false;
  if (msg.channelId !== CHANNEL_ID) return false;
  if (OWNER_ID && msg.author.id !== OWNER_ID) return false;
  return true;
}

// ── Embeds ────────────────────────────────────────────────────────
function helpEmbed() {
  return new EmbedBuilder()
    .setColor(0x00e676)
    .setTitle('⛏ AppleMC Bot — Commands')
    .addFields(
      { name: '`!spawn <count>`',                    value: 'Spawn bots (max 10 at once)', inline: false },
      { name: '`!spawn <count> <proxy>`',            value: 'Spawn with proxy — `socks5://user:pass@host:port`', inline: false },
      { name: '`!kill <username>`',                  value: 'Kill and remove a bot', inline: false },
      { name: '`!killall`',                          value: 'Kill every bot', inline: false },
      { name: '`!list`',                             value: 'Show all bots and their status', inline: false },
      { name: '`!chat <username> <message>`',        value: 'Send a message in-game via that bot', inline: false },
      { name: '`!broadcast <message>`',              value: 'Send from ALL online bots at once', inline: false },
      { name: '`!logs <username>`',                  value: 'Show last 25 log lines', inline: false },
      { name: '`!captcha <username> <answer>`',      value: 'Submit captcha answer manually', inline: false },
      { name: '`!proxy <username> <proxy>`',         value: 'Hot-swap proxy and reconnect', inline: false },
      { name: '`!help`',                             value: 'Show this message', inline: false },
    )
    .setFooter({ text: 'Tip: reply directly to a captcha image to solve it' });
}

function statusEmoji(bot) {
  if (bot.status.startsWith('online'))     return '🟢';
  if (bot.status.includes('reconnect') ||
      bot.status.includes('joining')   ||
      bot.status.includes('queued')    ||
      bot.status === 'connecting')         return '🟡';
  if (bot.status === 'kicked')             return '🔴';
  return '⚪';
}

function listEmbed(bots) {
  const online = bots.filter(b => b.status.startsWith('online')).length;
  const lines  = bots.map(b => {
    const em    = statusEmoji(b);
    const proxy = b.proxy !== 'direct' ? ` 🌐${b.proxy}` : '';
    const cap   = b.captcha ? ' 🔐CAPTCHA' : '';
    return `${em} **${b.username}** — ${b.status}${proxy}${cap} | ↻${b.reconnects}`;
  });

  return new EmbedBuilder()
    .setColor(0x00b0ff)
    .setTitle(`🤖 Bots — ${bots.length} total, ${online} online`)
    .setDescription(lines.join('\n') || 'No bots running.');
}

// ── Command handler ───────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (!isAllowed(msg)) return;

  // ── Captcha reply ─────────────────────────────────────────────
  if (msg.reference?.messageId) {
    const username = captchaReplies.get(msg.reference.messageId);
    if (username) {
      const answer = msg.content.trim();
      if (!answer) return;
      const result = manager.submitCaptcha(username, answer);
      captchaReplies.delete(msg.reference.messageId);
      await msg.reply(result.error
        ? `❌ ${result.error}`
        : `✅ Submitted \`${answer}\` for **${username}**`
      );
      return;
    }
  }

  if (!msg.content.startsWith('!')) return;

  const parts = msg.content.slice(1).trim().split(/\s+/);
  const cmd   = parts[0]?.toLowerCase();
  const args  = parts.slice(1);

  // ── !help ─────────────────────────────────────────────────────
  if (cmd === 'help') {
    await msg.reply({ embeds: [helpEmbed()] });
    return;
  }

  // ── !spawn [count] [proxy?] ────────────────────────────────────
  if (cmd === 'spawn') {
    const count    = Math.min(parseInt(args[0]) || 1, 10);
    const proxyStr = args[1] || null;

    if (proxyStr && !/\w+:\d+/.test(proxyStr)) {
      await msg.reply('❌ Invalid proxy. Use `socks5://user:pass@host:port` or `host:port`');
      return;
    }

    const created = manager.spawn(count, proxyStr);
    const lines   = created.map((u, i) =>
      `⏳ **${u}**${proxyStr ? ` via ${proxyStr}` : ''} — starts in ~${i * 5}s`
    );

    await msg.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00e676)
          .setTitle(`🚀 Launching ${count} bot${count > 1 ? 's' : ''}`)
          .setDescription(lines.join('\n'))
      ],
    });
    return;
  }

  // ── !kill <username> ──────────────────────────────────────────
  if (cmd === 'kill') {
    if (!args[0]) { await msg.reply('❌ Usage: `!kill <username>`'); return; }
    const result = manager.kill(args[0]);
    await msg.reply(result.error ? `❌ ${result.error}` : `💀 **${args[0]}** killed.`);
    return;
  }

  // ── !killall ──────────────────────────────────────────────────
  if (cmd === 'killall') {
    const total = manager.size;
    manager.killAll();
    await msg.reply(`💀 Killed **${total}** bot${total !== 1 ? 's' : ''}.`);
    return;
  }

  // ── !list ─────────────────────────────────────────────────────
  if (cmd === 'list') {
    const bots = manager.list();
    if (!bots.length) { await msg.reply('No bots running. Use `!spawn` to launch some.'); return; }
    await msg.reply({ embeds: [listEmbed(bots)] });
    return;
  }

  // ── !chat <username> <message> ────────────────────────────────
  if (cmd === 'chat') {
    const username = args[0];
    const message  = args.slice(1).join(' ');
    if (!username || !message) { await msg.reply('❌ Usage: `!chat <username> <message>`'); return; }
    const result = manager.chat(username, message);
    await msg.reply(result.error ? `❌ ${result.error}` : `✅ Sent via **${username}**`);
    return;
  }

  // ── !broadcast <message> ──────────────────────────────────────
  if (cmd === 'broadcast') {
    const message = args.join(' ');
    if (!message) { await msg.reply('❌ Usage: `!broadcast <message>`'); return; }
    const sent = manager.broadcast(message);
    await msg.reply(sent === 0
      ? '⚠️ No online bots to broadcast to.'
      : `📢 Broadcast to **${sent}** bot${sent !== 1 ? 's' : ''}.`
    );
    return;
  }

  // ── !logs <username> ──────────────────────────────────────────
  if (cmd === 'logs') {
    if (!args[0]) { await msg.reply('❌ Usage: `!logs <username>`'); return; }
    const result = manager.getLogs(args[0], 25);
    if (result.error) { await msg.reply(`❌ ${result.error}`); return; }
    const text = result.logs.join('\n') || 'No logs yet.';
    // Discord has a 2000 char message limit — trim if needed
    const trimmed = text.length > 1800 ? '...\n' + text.slice(-1800) : text;
    await msg.reply(`\`\`\`\n${trimmed}\n\`\`\``);
    return;
  }

  // ── !captcha <username> <answer> ──────────────────────────────
  if (cmd === 'captcha') {
    const username = args[0];
    const answer   = args.slice(1).join(' ').trim();
    if (!username || !answer) { await msg.reply('❌ Usage: `!captcha <username> <answer>`'); return; }
    const result = manager.submitCaptcha(username, answer);
    await msg.reply(result.error
      ? `❌ ${result.error}`
      : `✅ Submitted \`${answer}\` for **${username}**`
    );
    return;
  }

  // ── !proxy <username> <proxy> ─────────────────────────────────
  if (cmd === 'proxy') {
    const username = args[0];
    const proxyStr = args[1];
    if (!username || !proxyStr) { await msg.reply('❌ Usage: `!proxy <username> socks5://user:pass@host:port`'); return; }
    const result = manager.setProxy(username, proxyStr);
    await msg.reply(result.error
      ? `❌ ${result.error}`
      : `🌐 Proxy updated for **${username}** — reconnecting.`
    );
    return;
  }

  // Unknown command
  await msg.reply('❓ Unknown command. Type `!help` for the list.');
});

// ── Ready ─────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Discord] Online as ${client.user.tag}`);
  try {
    const ch = await client.channels.fetch(CHANNEL_ID);
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00e676)
          .setTitle('⛏ AppleMC Bot Manager')
          .setDescription('Online and ready. Type `!help` for all commands.')
          .setTimestamp()
      ],
    });
  } catch (err) {
    console.error('[Discord] Could not post startup message:', err.message);
  }
});

client.on('error', err => console.error('[Discord] Client error:', err.message));

// ── Start ─────────────────────────────────────────────────────────
client.login(TOKEN);
