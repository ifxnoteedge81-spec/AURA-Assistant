import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { GoogleGenAI } from '@google/genai';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, proto, WAMessage, WASocket } from '@whiskeysockets/baileys';

const PORT = Number(process.env.PORT || 3000);
const PREFIX = '.';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info_baileys');
const CONFIG_FILE = path.resolve('./bot-config.json');
const BOT_SOURCE_DIR = path.resolve('./bot');

export const BENGALI_AUTOREPLY_TEXT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';

interface BotConfig {
  autoreply: boolean;
  cooldownMs: number;
  antilinkGroups: Record<string, boolean>;
}

interface BotLogEntry {
  id: string;
  timestamp: string;
  category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator';
  actor: string;
  summary: string;
  outcome: 'success' | 'blocked' | 'info' | 'error';
}

interface SimulatorRequest {
  text: string;
  chatType: 'private' | 'group_bot_admin' | 'group_bot_non_admin' | 'self';
  senderIsGroupAdmin?: boolean;
  groupJid?: string;
}

// ----------------------------------------------------------------------------
// Server-Side Google Gen AI Initialization
// ----------------------------------------------------------------------------
const geminiApiKey = process.env.GEMINI_API_KEY;
const ai = geminiApiKey
  ? new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

const baileysLogger = pino({ level: 'silent' });

// ----------------------------------------------------------------------------
// Persistent Configuration & Runtime State
// ----------------------------------------------------------------------------
function loadConfig(): BotConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        autoreply: Boolean(raw.autoreply),
        cooldownMs: typeof raw.cooldownMs === 'number' ? raw.cooldownMs : 60_000,
        antilinkGroups:
          raw.antilinkGroups && typeof raw.antilinkGroups === 'object'
            ? raw.antilinkGroups
            : { '120363041928374655@g.us': true },
      };
    }
  } catch (err) {
    console.warn('[Config] Failed to load bot-config.json, using defaults:', err);
  }
  return {
    autoreply: false,
    cooldownMs: 60_000,
    antilinkGroups: { '120363041928374655@g.us': true },
  };
}

function saveConfig(config: BotConfig) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Config] Failed to persist bot-config.json:', err);
  }
}

let botConfig: BotConfig = loadConfig();
const eventLogs: BotLogEntry[] = [];
const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();
const autoReplyCooldowns = new Map<string, number>();

type ConnectionStatus = 'disconnected' | 'connecting' | 'awaiting_pairing' | 'connected';

let botStatus: ConnectionStatus = 'disconnected';
let currentSocket: WASocket | null = null;
let currentPairingCode: string | null = null;
let currentPairingPhone: string | null = null;
let lastBotError: string | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;

function pushLog(
  category: BotLogEntry['category'],
  actor: string,
  summary: string,
  outcome: BotLogEntry['outcome'] = 'info'
) {
  eventLogs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    category,
    actor,
    summary,
    outcome,
  });
  if (eventLogs.length > 100) {
    eventLogs.length = 100;
  }
}

pushLog('system', 'Control Plane', 'WaNexus bot runtime initialized.', 'info');

// ----------------------------------------------------------------------------
// Shared Bot Logic Helpers (Matches /bot/index.js)
// ----------------------------------------------------------------------------
const LINK_PATTERNS: RegExp[] = [
  /(?:https?:\/\/|www\.)[^\s]+/gi,
  /\b(?:t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|instagr\.am|twitter\.com|x\.com|tiktok\.com|discord\.gg|discord\.com\/invite|bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|rb\.gy)\b[^\s]*/gi,
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|me|tv|gg|xyz|info|biz|app|dev|ai|ly|link|online|site|store|tech)(?:\/[^\s]*)?\b/gi,
];

function findMatchedLinks(text: string): string[] {
  if (!text) return [];
  const matches = new Set<string>();
  for (const pattern of LINK_PATTERNS) {
    const found = text.match(pattern);
    if (found) {
      for (const item of found) {
        matches.add(item);
      }
    }
  }
  return Array.from(matches);
}

function containsLink(text: string): boolean {
  return findMatchedLinks(text).length > 0;
}

function extractMessageText(message: proto.IMessage | null | undefined): string {
  if (!message) return '';
  const unwrapped =
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;

  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.documentMessage?.caption ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    ''
  ).trim();
}

function extractDigits(jid: string | undefined | null): string {
  if (!jid) return '';
  const normalized = jidNormalizedUser(jid);
  return normalized.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isOwnerOrSelf(msg: WAMessage, sock: WASocket): boolean {
  if (msg.key.fromMe) return true;
  const ownerNumber = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  if (!ownerNumber) return false;
  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderDigits = extractDigits(senderJid);
  const botDigits = extractDigits(sock.user?.id);
  return senderDigits === ownerNumber || (Boolean(botDigits) && senderDigits === botDigits);
}

async function getCachedGroupMetadata(sock: WASocket, groupJid: string): Promise<GroupMetadata> {
  const cached = groupMetadataCache.get(groupJid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }
  const metadata = await sock.groupMetadata(groupJid);
  groupMetadataCache.set(groupJid, {
    metadata,
    expiresAt: Date.now() + 30_000,
  });
  return metadata;
}

function isParticipantAdmin(
  metadata: GroupMetadata,
  targetJid: string | undefined | null,
  targetLid: string | undefined | null = null
): boolean {
  const targetDigits = extractDigits(targetJid);
  const lidDigits = extractDigits(targetLid);

  return metadata.participants.some((participant) => {
    const pIdDigits = extractDigits(participant.id);
    const pLidDigits = extractDigits((participant as { lid?: string }).lid);
    const matches =
      (Boolean(targetDigits) && (pIdDigits === targetDigits || pLidDigits === targetDigits)) ||
      (Boolean(lidDigits) && (pIdDigits === lidDigits || pLidDigits === lidDigits));

    return matches && (participant.admin === 'admin' || participant.admin === 'superadmin');
  });
}

async function askGemini(query: string): Promise<string> {
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents: query,
    config: {
      systemInstruction:
        'You are a helpful, concise, and intelligent WhatsApp AI assistant. Format responses cleanly for mobile reading using plain text or simple WhatsApp formatting (*bold*, _italic_, bullet points). Keep answers accurate and easy to read.',
    },
  });

  const text = response?.text?.trim();
  return text || 'I could not generate a response for that query. Please try rephrasing.';
}

// ----------------------------------------------------------------------------
// Live Baileys Message Handler
// ----------------------------------------------------------------------------
async function handleLiveMessage(sock: WASocket, msg: WAMessage) {
  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
    return;
  }

  const isGroup = isJidGroup(remoteJid) ?? false;
  const text = extractMessageText(msg.message);
  const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;

  // 1. Group Anti-Link Protection
  if (isGroup && botConfig.antilinkGroups[remoteJid] === true && text) {
    const isAntiLinkCommand = text.toLowerCase().startsWith(`${PREFIX}antilink`);
    if (!isAntiLinkCommand && !msg.key.fromMe && containsLink(text)) {
      try {
        const metadata = await getCachedGroupMetadata(sock, remoteJid);
        const botIsAdmin = isParticipantAdmin(metadata, sock.user?.id, (sock.user as { lid?: string } | undefined)?.lid);
        const senderIsAdmin = isParticipantAdmin(metadata, senderJid);

        if (botIsAdmin && !senderIsAdmin) {
          await sock.sendMessage(remoteJid, { delete: msg.key });
          const senderTag = senderJid.split('@')[0];
          await sock.sendMessage(remoteJid, {
            text: `🚫 *Anti-Link Protection*\n@${senderTag}, links are not allowed in this group. Your message has been deleted.`,
            mentions: [senderJid],
          });
          pushLog('antilink', senderTag, `Deleted link in ${metadata.subject || remoteJid}`, 'blocked');
          return;
        }
      } catch (err) {
        pushLog('antilink', remoteJid, `Failed anti-link deletion: ${(err as Error).message}`, 'error');
      }
    }
  }

  // 2. Prefix Commands
  if (text.startsWith(PREFIX)) {
    const withoutPrefix = text.slice(PREFIX.length).trim();
    const firstSpace = withoutPrefix.search(/\s+/);
    const command = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)).toLowerCase();
    const argsText = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace).trim();

    if (command === 'ai' || command === 'gemini') {
      if (!argsText) {
        await sock.sendMessage(
          remoteJid,
          { text: `Please provide a prompt.\nExample: *${PREFIX}ai Explain quantum computing*` },
          { quoted: msg }
        );
        return;
      }
      try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        const reply = await askGemini(argsText);
        await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
        pushLog('gemini', extractDigits(senderJid) || remoteJid, `Answered .${command} query`, 'success');
      } catch (err) {
        pushLog('gemini', extractDigits(senderJid) || remoteJid, `Gemini error: ${(err as Error).message}`, 'error');
        await sock.sendMessage(
          remoteJid,
          { text: '❌ Failed to get a response from Gemini AI. Please try again shortly.' },
          { quoted: msg }
        );
      } finally {
        await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
      }
      return;
    }

    if (command === 'antilink') {
      if (!isGroup) {
        await sock.sendMessage(
          remoteJid,
          { text: '⚠️ The *.antilink* command can only be used inside WhatsApp groups.' },
          { quoted: msg }
        );
        return;
      }

      const metadata = await getCachedGroupMetadata(sock, remoteJid);
      const senderIsAdmin = isParticipantAdmin(metadata, senderJid) || isOwnerOrSelf(msg, sock);
      if (!senderIsAdmin) {
        await sock.sendMessage(
          remoteJid,
          { text: '⛔ Only group admins can configure Anti-Link settings.' },
          { quoted: msg }
        );
        return;
      }

      const subArgs = argsText.toLowerCase().split(/\s+/);
      if (subArgs[0] === 'delete' && subArgs[1] === 'on') {
        botConfig.antilinkGroups[remoteJid] = true;
        saveConfig(botConfig);
        pushLog('antilink', metadata.subject || remoteJid, 'Enabled .antilink delete on', 'success');
        await sock.sendMessage(
          remoteJid,
          { text: '✅ *Anti-Link Delete Mode is now ON* for this group.' },
          { quoted: msg }
        );
        return;
      }

      if (subArgs[0] === 'delete' && subArgs[1] === 'off') {
        botConfig.antilinkGroups[remoteJid] = false;
        saveConfig(botConfig);
        pushLog('antilink', metadata.subject || remoteJid, 'Disabled .antilink delete off', 'info');
        await sock.sendMessage(
          remoteJid,
          { text: '🛑 *Anti-Link Delete Mode is now OFF* for this group.' },
          { quoted: msg }
        );
        return;
      }

      await sock.sendMessage(
        remoteJid,
        {
          text: `🛡️ *Anti-Link Status:* ${botConfig.antilinkGroups[remoteJid] ? 'ON' : 'OFF'}\nUsage: *${PREFIX}antilink delete on* | *${PREFIX}antilink delete off*`,
        },
        { quoted: msg }
      );
      return;
    }

    if (command === 'autoreply') {
      if (!isOwnerOrSelf(msg, sock)) {
        await sock.sendMessage(
          remoteJid,
          { text: '⛔ Only the bot owner can toggle private auto-reply mode.' },
          { quoted: msg }
        );
        return;
      }
      const mode = argsText.toLowerCase();
      if (mode === 'on') {
        botConfig.autoreply = true;
        saveConfig(botConfig);
        pushLog('autoreply', 'Owner', 'Enabled .autoreply on', 'success');
        await sock.sendMessage(
          remoteJid,
          { text: '✅ *Private Auto-Reply Assistant is now ON.*' },
          { quoted: msg }
        );
        return;
      }
      if (mode === 'off') {
        botConfig.autoreply = false;
        saveConfig(botConfig);
        pushLog('autoreply', 'Owner', 'Disabled .autoreply off', 'info');
        await sock.sendMessage(
          remoteJid,
          { text: '🛑 *Private Auto-Reply Assistant is now OFF.*' },
          { quoted: msg }
        );
        return;
      }
      return;
    }

    if (command === 'ping') {
      await sock.sendMessage(remoteJid, { text: '🏓 Pong! Bot is online and active.' }, { quoted: msg });
    }
    return;
  }

  // 3. Automated Private Inbox Assistant (Bengali)
  if (botConfig.autoreply) {
    const isPrivateChat =
      !isGroup && (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'));
    if (!isPrivateChat || msg.key.fromMe || !text) return;

    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(remoteJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const lastSent = autoReplyCooldowns.get(remoteJid) || 0;
    if (Date.now() - lastSent < botConfig.cooldownMs) return;

    autoReplyCooldowns.set(remoteJid, Date.now());
    await sock.sendMessage(remoteJid, { text: BENGALI_AUTOREPLY_TEXT }, { quoted: msg });
    pushLog('autoreply', senderDigits || remoteJid, 'Sent Bengali private auto-reply', 'success');
  }
}

// ----------------------------------------------------------------------------
// Baileys Socket Connection & Pairing Code Trigger
// ----------------------------------------------------------------------------
async function startBaileysConnection(phoneNumber?: string): Promise<{ pairingCode: string | null }> {
  manualDisconnect = false;
  lastBotError = null;
  currentPairingCode = null;

  if (currentSocket) {
    try {
      currentSocket.end(undefined);
    } catch {
      // ignore
    }
    currentSocket = null;
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  botStatus = 'connecting';

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  currentSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      botStatus = 'connected';
      reconnectAttempts = 0;
      currentPairingCode = null;
      lastBotError = null;
      pushLog('pairing', sock.user?.id || 'WhatsApp', 'WhatsApp device linked and online.', 'success');
    }

    if (connection === 'close') {
      const errObj = lastDisconnect?.error as { output?: { statusCode?: number }; statusCode?: number; message?: string } | undefined;
      const statusCode = errObj?.output?.statusCode ?? errObj?.statusCode;

      if (manualDisconnect) {
        botStatus = 'disconnected';
        return;
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden || statusCode === DisconnectReason.badSession) {
        botStatus = 'disconnected';
        lastBotError = 'Session logged out or expired. Clear session and pair again.';
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        pushLog('pairing', 'WhatsApp', 'Session logged out; credentials cleared.', 'error');
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        botStatus = 'disconnected';
        lastBotError = 'Session replaced by another WhatsApp Web login.';
        pushLog('pairing', 'WhatsApp', 'Connection replaced by another client.', 'error');
        return;
      }

      reconnectAttempts += 1;
      if (reconnectAttempts > 10) {
        botStatus = 'disconnected';
        lastBotError = 'Stopped reconnecting after 10 consecutive failed attempts.';
        pushLog('system', 'Baileys', 'Reconnect limit reached; waiting for manual retry.', 'error');
        return;
      }

      botStatus = 'connecting';
      const delayMs = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), 30_000);
      setTimeout(() => {
        if (!manualDisconnect) {
          startBaileysConnection(currentPairingPhone || undefined).catch((err) => {
            lastBotError = (err as Error).message;
            botStatus = 'disconnected';
          });
        }
      }, delayMs);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleLiveMessage(sock, msg);
      } catch (err) {
        pushLog('system', 'Message Router', (err as Error).message, 'error');
      }
    }
  });

  if (!sock.authState.creds.registered) {
    const cleanNumber = (phoneNumber || currentPairingPhone || '').replace(/\D/g, '');
    if (!cleanNumber || cleanNumber.length < 8) {
      throw new Error('Enter a valid phone number with country code (e.g. 8801712345678).');
    }
    currentPairingPhone = cleanNumber;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (currentSocket !== sock) {
      throw new Error('Socket superseded before pairing code was issued.');
    }
    const rawCode = await sock.requestPairingCode(cleanNumber);
    const formatted = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    currentPairingCode = formatted;
    botStatus = 'awaiting_pairing';
    pushLog('pairing', `+${cleanNumber}`, `Generated 8-digit pairing code ${formatted}`, 'info');
    return { pairingCode: formatted };
  }

  return { pairingCode: null };
}

// ----------------------------------------------------------------------------
// Express Server & API Routes
// ----------------------------------------------------------------------------
async function bootstrap() {
  const app = express();
  app.use(express.json());

  app.get('/api/bot/status', (_req, res) => {
    const sessionExists = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    res.json({
      status: botStatus,
      connectedUser: currentSocket?.user?.id || null,
      pairingCode: currentPairingCode,
      pairingPhone: currentPairingPhone,
      sessionExists,
      lastError: lastBotError,
      geminiConfigured: Boolean(geminiApiKey),
      config: botConfig,
      logs: eventLogs,
    });
  });

  app.post('/api/bot/pair', async (req, res) => {
    try {
      const rawPhone = String(req.body?.phoneNumber || '');
      const cleanPhone = rawPhone.replace(/\D/g, '');
      if (cleanPhone.length < 8 || cleanPhone.length > 15) {
        res.status(400).json({ error: 'Phone number must be 8–15 digits including country code (e.g. 8801712345678).' });
        return;
      }
      const result = await startBaileysConnection(cleanPhone);
      res.json({
        status: botStatus,
        pairingCode: result.pairingCode,
        phoneNumber: cleanPhone,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Failed to initiate WhatsApp pairing.';
      lastBotError = message;
      botStatus = 'disconnected';
      pushLog('pairing', 'Baileys', `Pairing failed: ${message}`, 'error');
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/bot/disconnect', (_req, res) => {
    manualDisconnect = true;
    currentPairingCode = null;
    if (currentSocket) {
      try {
        currentSocket.end(undefined);
      } catch {
        // ignore
      }
      currentSocket = null;
    }
    botStatus = 'disconnected';
    pushLog('system', 'Operator', 'Bot socket disconnected manually.', 'info');
    res.json({ status: botStatus });
  });

  app.post('/api/bot/reset-session', (_req, res) => {
    manualDisconnect = true;
    currentPairingCode = null;
    currentPairingPhone = null;
    lastBotError = null;
    if (currentSocket) {
      try {
        currentSocket.end(undefined);
      } catch {
        // ignore
      }
      currentSocket = null;
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    botStatus = 'disconnected';
    pushLog('pairing', 'Operator', 'Cleared MultiFileAuthState credentials.', 'info');
    res.json({ status: botStatus, sessionExists: false });
  });

  app.post('/api/bot/config', (req, res) => {
    const { autoreply, cooldownMs, antilinkGroups } = req.body || {};
    if (typeof autoreply === 'boolean') {
      botConfig.autoreply = autoreply;
      pushLog('autoreply', 'Dashboard', `Private auto-reply set to ${autoreply ? 'ON' : 'OFF'}`, 'info');
    }
    if (typeof cooldownMs === 'number' && cooldownMs >= 0) {
      botConfig.cooldownMs = cooldownMs;
    }
    if (antilinkGroups && typeof antilinkGroups === 'object') {
      botConfig.antilinkGroups = antilinkGroups;
      pushLog('antilink', 'Dashboard', 'Updated group anti-link rule table.', 'info');
    }
    saveConfig(botConfig);
    res.json({ config: botConfig });
  });

  app.post('/api/antilink/test', (req, res) => {
    const text = String(req.body?.text || '');
    const matches = findMatchedLinks(text);
    res.json({
      hasLink: matches.length > 0,
      matches,
    });
  });

  app.post('/api/simulator/message', async (req, res) => {
    try {
      const body = req.body as SimulatorRequest;
      const text = String(body?.text || '').trim();
      const chatType = body?.chatType || 'private';
      const senderIsGroupAdmin = Boolean(body?.senderIsGroupAdmin);
      const groupJid = body?.groupJid || '120363041928374655@g.us';

      if (!text) {
        res.status(400).json({ error: 'Message text cannot be empty.' });
        return;
      }

      const isGroup = chatType === 'group_bot_admin' || chatType === 'group_bot_non_admin';
      const botIsAdmin = chatType === 'group_bot_admin';
      const isSelf = chatType === 'self';

      // 1. Group Anti-Link Evaluation
      if (isGroup && botConfig.antilinkGroups[groupJid] === true) {
        const isAntiLinkCmd = text.toLowerCase().startsWith(`${PREFIX}antilink`);
        if (!isAntiLinkCmd && containsLink(text)) {
          const matches = findMatchedLinks(text);
          if (botIsAdmin && !senderIsGroupAdmin) {
            pushLog('antilink', 'Simulator Group', `Deleted link (${matches[0]})`, 'blocked');
            res.json({
              deleted: true,
              matchedLinks: matches,
              reply: '🚫 *Anti-Link Protection*\n@member, links are not allowed in this group. Your message has been deleted.',
              ruleTriggered: 'ANTILINK_DELETE',
              config: botConfig,
            });
            return;
          }
          if (!botIsAdmin) {
            pushLog('antilink', 'Simulator Group', `Link detected (${matches[0]}), skipped because bot is not admin`, 'info');
            res.json({
              deleted: false,
              matchedLinks: matches,
              reply: null,
              note: 'Link detected, but bot is NOT a group admin so WhatsApp prevents deletion.',
              ruleTriggered: 'ANTILINK_BOT_NOT_ADMIN',
              config: botConfig,
            });
            return;
          }
          if (senderIsGroupAdmin) {
            res.json({
              deleted: false,
              matchedLinks: matches,
              reply: null,
              note: 'Link detected, exempt because sender is a group admin.',
              ruleTriggered: 'ANTILINK_ADMIN_EXEMPT',
              config: botConfig,
            });
            return;
          }
        }
      }

      // 2. Prefix Commands
      if (text.startsWith(PREFIX)) {
        const withoutPrefix = text.slice(PREFIX.length).trim();
        const firstSpace = withoutPrefix.search(/\s+/);
        const command = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)).toLowerCase();
        const argsText = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace).trim();

        if (command === 'ai' || command === 'gemini') {
          if (!argsText) {
            res.json({
              deleted: false,
              reply: `Please provide a prompt.\nExample: *${PREFIX}ai Explain quantum computing in 3 sentences*`,
              ruleTriggered: 'GEMINI_EMPTY_QUERY',
              config: botConfig,
            });
            return;
          }

          const aiReply = await askGemini(argsText);
          pushLog('gemini', 'Simulator', `Executed .${command} "${argsText.slice(0, 40)}"`, 'success');
          res.json({
            deleted: false,
            reply: aiReply,
            ruleTriggered: 'GEMINI_AI',
            config: botConfig,
          });
          return;
        }

        if (command === 'antilink') {
          if (!isGroup) {
            res.json({
              deleted: false,
              reply: '⚠️ The *.antilink* command can only be used inside WhatsApp groups.',
              ruleTriggered: 'ANTILINK_PRIVATE_REJECTED',
              config: botConfig,
            });
            return;
          }

          if (!senderIsGroupAdmin && !isSelf) {
            res.json({
              deleted: false,
              reply: '⛔ Only group admins can configure Anti-Link settings.',
              ruleTriggered: 'ANTILINK_UNAUTHORIZED',
              config: botConfig,
            });
            return;
          }

          const subArgs = argsText.toLowerCase().split(/\s+/);
          if (subArgs[0] === 'delete' && subArgs[1] === 'on') {
            botConfig.antilinkGroups[groupJid] = true;
            saveConfig(botConfig);
            pushLog('antilink', groupJid, 'Simulator: .antilink delete on', 'success');
            const adminNote = botIsAdmin
              ? ''
              : '\n\n⚠️ *Note:* Please promote this bot to Group Admin so it can delete link messages.';
            res.json({
              deleted: false,
              reply: `✅ *Anti-Link Delete Mode is now ON* for this group.${adminNote}`,
              ruleTriggered: 'ANTILINK_ENABLED',
              config: botConfig,
            });
            return;
          }

          if (subArgs[0] === 'delete' && subArgs[1] === 'off') {
            botConfig.antilinkGroups[groupJid] = false;
            saveConfig(botConfig);
            pushLog('antilink', groupJid, 'Simulator: .antilink delete off', 'info');
            res.json({
              deleted: false,
              reply: '🛑 *Anti-Link Delete Mode is now OFF* for this group.',
              ruleTriggered: 'ANTILINK_DISABLED',
              config: botConfig,
            });
            return;
          }

          res.json({
            deleted: false,
            reply: `🛡️ *Anti-Link Status:* ${botConfig.antilinkGroups[groupJid] ? 'ON' : 'OFF'}\nUsage: *${PREFIX}antilink delete on* | *${PREFIX}antilink delete off*`,
            ruleTriggered: 'ANTILINK_STATUS',
            config: botConfig,
          });
          return;
        }

        if (command === 'autoreply') {
          const mode = argsText.toLowerCase();
          if (mode === 'on') {
            botConfig.autoreply = true;
            saveConfig(botConfig);
            pushLog('autoreply', 'Simulator', 'Executed .autoreply on', 'success');
            res.json({
              deleted: false,
              reply:
                '✅ *Private Auto-Reply Assistant is now ON.*\nIncoming private DMs will receive the automated Bengali reply.',
              ruleTriggered: 'AUTOREPLY_ENABLED',
              config: botConfig,
            });
            return;
          }
          if (mode === 'off') {
            botConfig.autoreply = false;
            saveConfig(botConfig);
            pushLog('autoreply', 'Simulator', 'Executed .autoreply off', 'info');
            res.json({
              deleted: false,
              reply: '🛑 *Private Auto-Reply Assistant is now OFF.*',
              ruleTriggered: 'AUTOREPLY_DISABLED',
              config: botConfig,
            });
            return;
          }
          res.json({
            deleted: false,
            reply: `🤖 *Auto-Reply Status:* ${botConfig.autoreply ? 'ON' : 'OFF'}\nUsage: *${PREFIX}autoreply on* | *${PREFIX}autoreply off*`,
            ruleTriggered: 'AUTOREPLY_STATUS',
            config: botConfig,
          });
          return;
        }

        if (command === 'ping') {
          res.json({
            deleted: false,
            reply: '🏓 Pong! Bot is online and active.',
            ruleTriggered: 'PING',
            config: botConfig,
          });
          return;
        }

        if (command === 'help' || command === 'menu') {
          res.json({
            deleted: false,
            reply: [
              '🤖 *WhatsApp Gemini Assistant*',
              '',
              `*${PREFIX}ai <query>* — Ask Gemini AI`,
              `*${PREFIX}gemini <query>* — Ask Gemini AI`,
              `*${PREFIX}antilink delete on* — Enable group link deletion`,
              `*${PREFIX}antilink delete off* — Disable group link deletion`,
              `*${PREFIX}autoreply on* — Enable private DM Bengali assistant`,
              `*${PREFIX}autoreply off* — Disable private DM assistant`,
              `*${PREFIX}ping* — Check bot responsiveness`,
            ].join('\n'),
            ruleTriggered: 'HELP',
            config: botConfig,
          });
          return;
        }

        res.json({
          deleted: false,
          reply: null,
          note: `Unrecognized command ".${command}". Ignored without triggering auto-reply.`,
          ruleTriggered: 'COMMAND_IGNORED',
          config: botConfig,
        });
        return;
      }

      // 3. Automated Private Inbox Assistant (Bengali)
      if (botConfig.autoreply) {
        if (chatType === 'private') {
          pushLog('autoreply', 'Simulator DM', 'Triggered Bengali private auto-reply', 'success');
          res.json({
            deleted: false,
            reply: BENGALI_AUTOREPLY_TEXT,
            ruleTriggered: 'BENGALI_AUTOREPLY',
            config: botConfig,
          });
          return;
        }

        if (chatType === 'self') {
          res.json({
            deleted: false,
            reply: null,
            note: 'Auto-reply skipped: Message-to-self / fromMe messages are excluded.',
            ruleTriggered: 'AUTOREPLY_SKIPPED_SELF',
            config: botConfig,
          });
          return;
        }

        if (isGroup) {
          res.json({
            deleted: false,
            reply: null,
            note: 'Auto-reply skipped: Group chats never trigger private inbox auto-reply.',
            ruleTriggered: 'AUTOREPLY_SKIPPED_GROUP',
            config: botConfig,
          });
          return;
        }
      }

      res.json({
        deleted: false,
        reply: null,
        note: 'No command, link violation, or active auto-reply rule matched.',
        ruleTriggered: 'NO_OP',
        config: botConfig,
      });
    } catch (err) {
      const message = (err as Error)?.message || 'Simulator error';
      pushLog('simulator', 'Gemini/Router', message, 'error');
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/source-files', (_req, res) => {
    const fileList = ['index.js', 'package.json', 'render.yaml', '.env.example', '.gitignore', 'README.md'];
    const files = fileList
      .filter((name) => fs.existsSync(path.join(BOT_SOURCE_DIR, name)))
      .map((name) => ({
        name,
        content: fs.readFileSync(path.join(BOT_SOURCE_DIR, name), 'utf8'),
      }));
    res.json({ files });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', botStatus, connectedUser: currentSocket?.user?.id || null });
  });

  const distDir = path.resolve('./dist');
  const hasBuiltDist = fs.existsSync(path.join(distDir, 'index.html'));

  if (process.env.NODE_ENV === 'production' && hasBuiltDist) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WaNexus] Control Plane & Bot Studio running on http://0.0.0.0:${PORT}`);

    // Automatically resume an already-paired WhatsApp session on startup
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (creds?.registered) {
          pushLog('pairing', 'Baileys', 'Resuming existing WhatsApp session...', 'info');
          startBaileysConnection().catch((err) => {
            lastBotError = (err as Error).message;
            botStatus = 'disconnected';
            pushLog('pairing', 'Baileys', `Auto-resume failed: ${lastBotError}`, 'error');
          });
        }
      } catch {
        // ignore malformed creds.json
      }
    }
  });
}

bootstrap().catch((err) => {
  console.error('[WaNexus] Fatal server startup error:', err);
  process.exit(1);
});
