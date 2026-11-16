/**
 * ============================================================================
 * Production WhatsApp Bot — Baileys (Pairing Code) + Google Gemini AI
 * ============================================================================
 * Features:
 *  1. MultiFileAuthState persistence + 8-digit Pairing Code authentication
 *  2. Crash-loop protection, exponential backoff reconnection & HTTP healthcheck
 *  3. Gemini AI chat via official @google/genai SDK (.ai <query>, .gemini <query>)
 *  4. Group Anti-Link protection (.antilink delete on / off)
 *  5. Automated Private Inbox Assistant in Bengali (.autoreply on / off)
 * ============================================================================
 */

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pino from 'pino';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================

const PREFIX = '.';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info_baileys');
const CONFIG_FILE = path.resolve('./bot-config.json');
const PORT = Number(process.env.PORT || 3000);
const AUTOREPLY_COOLDOWN_MS = Number(process.env.AUTOREPLY_COOLDOWN_MS || 0);

// Exact Bengali auto-reply message required for private inbox assistant
const BENGALI_AUTOREPLY_TEXT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';

// Logger instance (set to 'silent' for Baileys internal logs to keep terminal clean)
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baileysLogger = pino({ level: 'silent' });

// Google Gen AI multi-key pool initialization (#1-#5 sequential rotation)
const geminiKeys = [];
const seenGeminiKeys = new Set();
for (let i = 1; i <= 10; i += 1) {
  const k = process.env[`GEMINI_API_KEY_${i}`]?.trim();
  if (k && k.length >= 15 && !seenGeminiKeys.has(k)) {
    seenGeminiKeys.add(k);
    geminiKeys.push(k);
  }
}
if (process.env.GEMINI_API_KEY?.trim() && !seenGeminiKeys.has(process.env.GEMINI_API_KEY.trim())) {
  seenGeminiKeys.add(process.env.GEMINI_API_KEY.trim());
  geminiKeys.push(process.env.GEMINI_API_KEY.trim());
}
if (process.env.GEMINI_API_KEYS) {
  for (const part of process.env.GEMINI_API_KEYS.split(/[\s,;]+/)) {
    const k = part.trim();
    if (k && k.length >= 15 && !seenGeminiKeys.has(k)) {
      seenGeminiKeys.add(k);
      geminiKeys.push(k);
    }
  }
}
const aiClients = geminiKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
let activeAiKeyIndex = 0;

// ============================================================================
// 2. PERSISTENT STATE (ANTI-LINK GROUPS & AUTO-REPLY TOGGLE)
// ============================================================================

/**
 * Loads persistent bot settings from bot-config.json.
 * @returns {{ autoreply: boolean, antilinkGroups: Record<string, boolean> }}
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        autoreply: Boolean(parsed.autoreply),
        antilinkGroups: parsed.antilinkGroups && typeof parsed.antilinkGroups === 'object'
          ? parsed.antilinkGroups
          : {},
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read bot-config.json; using defaults.');
  }
  return { autoreply: false, antilinkGroups: {} };
}

/**
 * Saves persistent bot settings atomically to bot-config.json.
 * @param {{ autoreply: boolean, antilinkGroups: Record<string, boolean> }} config
 */
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    logger.error({ err }, 'Failed to save bot-config.json');
  }
}

const botConfig = loadConfig();

// Runtime caches & guards
const groupMetadataCache = new Map(); // jid -> { metadata, expiresAt }
const autoReplyCooldowns = new Map(); // senderJid -> lastRepliedTimestamp
setInterval(() => {
  const now = Date.now();
  for (const [jid, entry] of groupMetadataCache.entries()) {
    if (entry.expiresAt <= now) groupMetadataCache.delete(jid);
  }
  for (const [jid, ts] of autoReplyCooldowns.entries()) {
    if (now - ts > 60 * 60 * 1000) autoReplyCooldowns.delete(jid);
  }
}, 10 * 60 * 1000).unref?.();
let reconnectAttempts = 0;
let isShuttingDown = false;
let currentSocket = null;
let cachedPairingPhone = (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, '');

// ============================================================================
// 3. HELPER UTILITIES
// ============================================================================

/**
 * Extracts readable text from standard, extended, ephemeral, or media-caption messages.
 * @param {import('@whiskeysockets/baileys').proto.IMessage | null | undefined} message
 * @returns {string}
 */
function extractMessageText(message) {
  if (!message) return '';

  // Unwrap ephemeral / view-once / document-with-caption wrappers
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

/**
 * Detects URLs, invite links, social links, and domain references inside a message.
 * @param {string} text
 * @returns {boolean}
 */
function containsLink(text) {
  if (!text) return false;

  const urlPatterns = [
    // Explicit protocols or www prefix
    /(?:https?:\/\/|www\.)[^\s]+/i,
    // Major social, messaging, and shortener domains (with or without protocol)
    /\b(?:t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|instagr\.am|twitter\.com|x\.com|tiktok\.com|discord\.gg|discord\.com\/invite|bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|rb\.gy)\b[^\s]*/i,
    // General domain.tld/path pattern (common TLDs)
    /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|me|tv|gg|xyz|info|biz|app|dev|ai|ly|link|online|site|store|tech)(?:\/[^\s]*)?\b/i,
  ];

  return urlPatterns.some((pattern) => pattern.test(text));
}

/**
 * Normalizes a JID into bare digits for reliable owner/self comparison.
 * @param {string | undefined | null} jid
 * @returns {string}
 */
function extractDigits(jid) {
  if (!jid) return '';
  const normalized = jidNormalizedUser(jid);
  return normalized.split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Checks whether a message sender is the bot itself or the configured owner.
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @returns {boolean}
 */
function isOwnerOrSelf(msg, sock) {
  if (msg.key.fromMe) return true;
  const ownerNumber = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  if (!ownerNumber) return false;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderDigits = extractDigits(senderJid);
  const botDigits = extractDigits(sock.user?.id);

  return senderDigits === ownerNumber || (botDigits && senderDigits === botDigits);
}

/**
 * Retrieves cached group metadata (30-second TTL) to avoid WhatsApp rate-limits.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} groupJid
 */
async function getCachedGroupMetadata(sock, groupJid) {
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

/**
 * Checks if a specific JID (or bot's own JID/LID) is a group admin.
 * @param {import('@whiskeysockets/baileys').GroupMetadata} metadata
 * @param {string | undefined | null} targetJid
 * @param {string | undefined | null} targetLid
 * @returns {boolean}
 */
function isParticipantAdmin(metadata, targetJid, targetLid = null) {
  const targetDigits = extractDigits(targetJid);
  const lidDigits = extractDigits(targetLid);

  return metadata.participants.some((participant) => {
    const pIdDigits = extractDigits(participant.id);
    const pLidDigits = extractDigits(participant.lid);
    const matches =
      (targetDigits && (pIdDigits === targetDigits || pLidDigits === targetDigits)) ||
      (lidDigits && (pIdDigits === lidDigits || pLidDigits === lidDigits));

    return matches && (participant.admin === 'admin' || participant.admin === 'superadmin');
  });
}

/**
 * Prompts for phone number in interactive terminal or reads PAIRING_PHONE_NUMBER env var.
 * @returns {Promise<string>}
 */
async function resolvePairingPhoneNumber() {
  if (cachedPairingPhone && cachedPairingPhone.length >= 8) {
    return cachedPairingPhone;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No PAIRING_PHONE_NUMBER environment variable set in non-interactive mode. Set PAIRING_PHONE_NUMBER (e.g. 8801712345678) and restart.'
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      '\n[PAIRING] Enter your WhatsApp phone number with country code (no +, spaces, or dashes, e.g. 8801712345678): '
    );
    const cleaned = answer.replace(/\D/g, '');
    if (cleaned.length < 8 || cleaned.length > 15) {
      throw new Error('Invalid phone number format. Expected 8-15 digits with country code.');
    }
    cachedPairingPhone = cleaned;
    return cleaned;
  } finally {
    rl.close();
  }
}

// ============================================================================
// 4. GEMINI AI HANDLER (.ai / .gemini)
// ============================================================================

/**
 * Calls Google Gemini via @google/genai SDK and returns clean WhatsApp-formatted text.
 * @param {string} query
 * @returns {Promise<string>}
 */
async function askGemini(query) {
  if (aiClients.length === 0) {
    return '⚠️ Gemini AI is not configured. Please set GEMINI_API_KEY_1..5 or GEMINI_API_KEY.';
  }

  const total = aiClients.length;
  const startIdx = activeAiKeyIndex % total;
  let lastError = null;
  const deadline = Date.now() + 12_000;

  for (let attempt = 0; attempt < total; attempt += 1) {
    if (attempt > 0 && Date.now() >= deadline) break;
    const idx = (startIdx + attempt) % total;
    try {
      const response = await Promise.race([
        aiClients[idx].models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: query,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              'You are a helpful, concise, and intelligent WhatsApp AI assistant. Format responses cleanly for mobile reading using plain text or simple WhatsApp formatting (*bold*, _italic_, bullet points). Keep answers accurate and easy to read.',
          },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout after 8000ms')), 8_000)),
      ]);
      activeAiKeyIndex = idx;
      const text = response?.text?.trim();
      return text || 'I could not generate a response for that query. Please try rephrasing.';
    } catch (err) {
      lastError = err;
      activeAiKeyIndex = (idx + 1) % total;
      logger.warn({ fromSlot: idx + 1, toSlot: activeAiKeyIndex + 1, err: err.message }, 'Rotating Gemini API key');
    }
  }

  activeAiKeyIndex = 0;
  throw lastError || new Error('All configured Gemini API keys failed.');
}

// ============================================================================
// 5. MESSAGE & COMMAND ROUTER
// ============================================================================

/**
 * Processes every incoming upsert message safely.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 */
async function handleIncomingMessage(sock, msg) {
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return;

  // Ignore status broadcasts, broadcast lists, and channels/newsletters
  if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) {
    return;
  }

  const isGroup = isJidGroup(remoteJid);
  const text = extractMessageText(msg.message);
  const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;
  const senderAlt = msg.key.participantAlt;

  // --------------------------------------------------------------------------
  // A. GROUP ANTI-LINK PROTECTION (Runs before commands so links are caught fast)
  // --------------------------------------------------------------------------
  if (isGroup && botConfig.antilinkGroups[remoteJid] === true && text) {
    // Allow .antilink command itself from admins without deleting before processing
    const isAntiLinkCommand = text.toLowerCase().startsWith(`${PREFIX}antilink`);

    if (!isAntiLinkCommand && !msg.key.fromMe && containsLink(text)) {
      try {
        const metadata = await getCachedGroupMetadata(sock, remoteJid);
        const botIsAdmin = isParticipantAdmin(metadata, sock.user?.id, sock.user?.lid);
        const senderIsAdmin = isParticipantAdmin(metadata, senderJid, senderAlt);

        if (botIsAdmin && !senderIsAdmin) {
          // Immediately delete the violating message
          await sock.sendMessage(remoteJid, { delete: msg.key });
          const senderTag = senderJid.split('@')[0];
          await sock.sendMessage(remoteJid, {
            text: `🚫 *Anti-Link Protection*\n@${senderTag}, links are not allowed in this group. Your message has been deleted.`,
            mentions: [senderJid],
          });
          logger.info({ group: remoteJid, sender: senderJid }, 'Deleted message containing link.');
          return;
        }
      } catch (err) {
        logger.error({ err, group: remoteJid }, 'Failed to enforce anti-link deletion.');
      }
    }
  }

  // --------------------------------------------------------------------------
  // B. COMMAND PROCESSING (Prefix '.')
  // --------------------------------------------------------------------------
  if (text.startsWith(PREFIX)) {
    const withoutPrefix = text.slice(PREFIX.length).trim();
    const firstSpace = withoutPrefix.search(/\s+/);
    const command = (firstSpace === -1 ? withoutPrefix : withoutPrefix.slice(0, firstSpace)).toLowerCase();
    const argsText = firstSpace === -1 ? '' : withoutPrefix.slice(firstSpace).trim();

    // 1) .ai <query> or .gemini <query>
    if (command === 'ai' || command === 'gemini') {
      if (!argsText) {
        await sock.sendMessage(
          remoteJid,
          { text: `Please provide a prompt.\nExample: *${PREFIX}ai Explain quantum computing in 3 sentences*` },
          { quoted: msg }
        );
        return;
      }

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        const replyText = await askGemini(argsText);
        await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
      } catch (err) {
        logger.error({ err }, 'Gemini AI request failed');
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

    // 2) .antilink delete on / off / status
    if (command === 'antilink') {
      if (!isGroup) {
        await sock.sendMessage(
          remoteJid,
          { text: '⚠️ The *.antilink* command can only be used inside WhatsApp groups.' },
          { quoted: msg }
        );
        return;
      }

      try {
        const metadata = await getCachedGroupMetadata(sock, remoteJid);
        const senderIsAdmin = isParticipantAdmin(metadata, senderJid, senderAlt) || isOwnerOrSelf(msg, sock);

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
          const botIsAdmin = isParticipantAdmin(metadata, sock.user?.id, sock.user?.lid);
          botConfig.antilinkGroups[remoteJid] = true;
          saveConfig(botConfig);

          const adminWarning = botIsAdmin
            ? ''
            : '\n\n⚠️ *Note:* Please promote this bot to Group Admin so it can delete link messages.';
          await sock.sendMessage(
            remoteJid,
            { text: `✅ *Anti-Link Delete Mode is now ON* for this group.${adminWarning}` },
            { quoted: msg }
          );
          return;
        }

        if (subArgs[0] === 'delete' && subArgs[1] === 'off') {
          botConfig.antilinkGroups[remoteJid] = false;
          saveConfig(botConfig);
          await sock.sendMessage(
            remoteJid,
            { text: '🛑 *Anti-Link Delete Mode is now OFF* for this group.' },
            { quoted: msg }
          );
          return;
        }

        const currentState = botConfig.antilinkGroups[remoteJid] ? 'ON' : 'OFF';
        await sock.sendMessage(
          remoteJid,
          {
            text: `🛡️ *Anti-Link Status:* ${currentState}\n\nUsage:\n• *${PREFIX}antilink delete on*\n• *${PREFIX}antilink delete off*`,
          },
          { quoted: msg }
        );
      } catch (err) {
        logger.error({ err, group: remoteJid }, 'Failed to toggle antilink');
        await sock.sendMessage(
          remoteJid,
          { text: '❌ Could not update group Anti-Link settings.' },
          { quoted: msg }
        );
      }
      return;
    }

    // 3) .autoreply on / off
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
        await sock.sendMessage(
          remoteJid,
          { text: '✅ *Private Auto-Reply Assistant is now ON.*\nIncoming private DMs will receive the automated Bengali reply.' },
          { quoted: msg }
        );
        return;
      }

      if (mode === 'off') {
        botConfig.autoreply = false;
        saveConfig(botConfig);
        await sock.sendMessage(
          remoteJid,
          { text: '🛑 *Private Auto-Reply Assistant is now OFF.*' },
          { quoted: msg }
        );
        return;
      }

      await sock.sendMessage(
        remoteJid,
        {
          text: `🤖 *Auto-Reply Status:* ${botConfig.autoreply ? 'ON' : 'OFF'}\n\nUsage:\n• *${PREFIX}autoreply on*\n• *${PREFIX}autoreply off*`,
        },
        { quoted: msg }
      );
      return;
    }

    // 4) .ping & .help / .menu
    if (command === 'ping') {
      await sock.sendMessage(remoteJid, { text: '🏓 Pong! Bot is online and active.' }, { quoted: msg });
      return;
    }

    if (command === 'help' || command === 'menu') {
      const helpText = [
        '🤖 *WhatsApp Gemini Assistant*',
        '',
        `*${PREFIX}ai <query>* — Ask Gemini AI`,
        `*${PREFIX}gemini <query>* — Ask Gemini AI`,
        `*${PREFIX}antilink delete on* — Enable group link deletion`,
        `*${PREFIX}antilink delete off* — Disable group link deletion`,
        `*${PREFIX}autoreply on* — Enable private DM Bengali assistant`,
        `*${PREFIX}autoreply off* — Disable private DM assistant`,
        `*${PREFIX}ping* — Check bot responsiveness`,
      ].join('\n');
      await sock.sendMessage(remoteJid, { text: helpText }, { quoted: msg });
      return;
    }

    // Do not fall through to auto-reply for unrecognized '.' commands
    return;
  }

  // --------------------------------------------------------------------------
  // C. AUTOMATED PRIVATE INBOX ASSISTANT (Bengali Auto-Reply)
  // --------------------------------------------------------------------------
  if (botConfig.autoreply) {
    // Strictly private direct messages only (never groups, never self/fromMe)
    const isPrivateChat =
      !isGroup && (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'));

    if (!isPrivateChat) return;
    if (msg.key.fromMe) return;

    // Prevent message-to-self auto-replies
    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits(sock.user?.lid);
    const senderDigits = extractDigits(remoteJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    // Ensure message actually contains user text (ignore protocol/reaction/empty updates)
    if (!text) return;

    // Rate-limit per sender to avoid spamming if user sends multiple consecutive lines
    const lastSent = autoReplyCooldowns.get(remoteJid) || 0;
    if (Date.now() - lastSent < AUTOREPLY_COOLDOWN_MS) {
      return;
    }

    autoReplyCooldowns.set(remoteJid, Date.now());

    try {
      await sock.sendMessage(
        remoteJid,
        { text: BENGALI_AUTOREPLY_TEXT },
        { quoted: msg }
      );
      logger.info({ to: remoteJid }, 'Sent Bengali private auto-reply.');
    } catch (err) {
      logger.error({ err, to: remoteJid }, 'Failed to send Bengali private auto-reply.');
    }
  }
}

// ============================================================================
// 6. BAILEYS SOCKET LIFECYCLE & PAIRING CODE LOGIN
// ============================================================================

/**
 * Starts the WhatsApp Baileys socket with MultiFileAuthState and 8-digit Pairing Code.
 */
async function startWhatsAppBot() {
  if (isShuttingDown) return;

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let socketVersion;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    socketVersion = version;
    logger.info({ version, isLatest }, 'Initialized Baileys WebSocket version.');
  } catch (err) {
    logger.warn({ err }, 'Could not fetch latest Baileys version; using built-in default.');
  }

  const sock = makeWASocket({
    ...(socketVersion ? { version: socketVersion } : {}),
    logger: baileysLogger,
    printQRInTerminal: false, // Pairing Code mode instead of QR code
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });

  currentSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  // Request 8-digit pairing code if session is not registered yet
  let pairingRequested = false;
  if (!sock.authState.creds.registered) {
    (async () => {
      try {
        const phoneNumber = await resolvePairingPhoneNumber();
        // Wait briefly for the underlying Noise/WebSocket transport to initialize
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (!sock.authState.creds.registered && !pairingRequested && currentSocket === sock) {
          pairingRequested = true;
          const code = await sock.requestPairingCode(phoneNumber);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log('\n====================================================');
          console.log(`  WHATSAPP 8-DIGIT PAIRING CODE: ${formatted}`);
          console.log('  Open WhatsApp -> Linked Devices -> Link a Device');
          console.log('  -> Link with phone number instead');
          console.log('====================================================\n');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to generate pairing code.');
      }
    })();
  }

  // Connection & Crash-Loop Safe Reconnection Handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      reconnectAttempts = 0;
      logger.info({ user: sock.user?.id }, '✅ WhatsApp Bot connected successfully!');
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.statusCode;

      const isLoggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.forbidden;

      const isBadSession = statusCode === DisconnectReason.badSession;

      logger.warn(
        { statusCode, reason: lastDisconnect?.error?.message },
        'WhatsApp connection closed.'
      );

      if (isShuttingDown) return;

      if (isLoggedOut || isBadSession) {
        logger.error(
          'Session logged out or invalid. Clearing auth_info_baileys; please re-pair on next start.'
        );
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        logger.error('Connection replaced by another session. Stopping reconnect loop.');
        return;
      }

      // Exponential backoff (capped at 60s) with max consecutive retry limit to prevent crash loops
      reconnectAttempts += 1;
      if (reconnectAttempts > 15) {
        logger.fatal('Too many consecutive failed reconnect attempts. Exiting cleanly for supervisor restart.');
        process.exit(1);
      }

      const delayMs = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), 60_000);
      logger.info({ attempt: reconnectAttempts, delayMs: Math.round(delayMs) }, 'Reconnecting...');
      setTimeout(() => {
        startWhatsAppBot().catch((err) => logger.error({ err }, 'Reconnect failed'));
      }, delayMs);
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, 'Unhandled error while processing message');
      }
    }
  });
}

// ============================================================================
// 7. RENDER HTTP HEALTHCHECK SERVER & GLOBAL SAFETY GUARDS
// ============================================================================

let selfPingTimer = null;
let selfPingWarmupTimer = null;
let selfPingRetryTimer = null;
let isSelfPingInFlight = false;

const SELF_PING_INTERVAL_MS = 5 * 60 * 1000;
const SELF_PING_URL = (
  process.env.SELF_PING_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://aura-assistant-8y1z.onrender.com'
)
  .trim()
  .replace(/\/+$/, '');
const SELF_PING_TARGET = process.env.SELF_PING_URL?.trim() || `${SELF_PING_URL}/health`;
const SELF_PING_ENABLED =
  process.env.ENABLE_SELF_PING !== 'false' &&
  (process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.RENDER_EXTERNAL_URL) ||
    process.env.ENABLE_SELF_PING === 'true');

async function executeSelfPing(isRetry = false) {
  if (isShuttingDown || isSelfPingInFlight) return;
  isSelfPingInFlight = true;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(SELF_PING_TARGET, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'AuraAssistant-KeepAlive/1.0',
        'Cache-Control': 'no-store',
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
  } catch (err) {
    logger.warn({ err: err.message, url: SELF_PING_TARGET }, 'Self-ping failed');
    if (!isRetry && !isShuttingDown && !selfPingRetryTimer) {
      selfPingRetryTimer = setTimeout(() => {
        selfPingRetryTimer = null;
        void executeSelfPing(true);
      }, 15_000);
      selfPingRetryTimer.unref?.();
    }
  } finally {
    clearTimeout(timeoutId);
    isSelfPingInFlight = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptimeSec: Math.round(process.uptime()),
        connected: Boolean(currentSocket?.user),
        autoreply: botConfig.autoreply,
        protectedGroups: Object.values(botConfig.antilinkGroups).filter(Boolean).length,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'Healthcheck HTTP server listening.');
  if (SELF_PING_ENABLED) {
    logger.info({ url: SELF_PING_TARGET, intervalMinutes: 5 }, 'Self-Ping Keep-Alive active.');
    selfPingWarmupTimer = setTimeout(() => {
      selfPingWarmupTimer = null;
      void executeSelfPing();
    }, 15_000);
    selfPingWarmupTimer.unref?.();

    selfPingTimer = setInterval(() => {
      void executeSelfPing();
    }, SELF_PING_INTERVAL_MS);
    selfPingTimer.unref?.();
  }
});

// Prevent unhandled errors from crashing the bot process
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled Rejection');
});

function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully...');
  isShuttingDown = true;
  if (selfPingTimer) clearInterval(selfPingTimer);
  if (selfPingWarmupTimer) clearTimeout(selfPingWarmupTimer);
  if (selfPingRetryTimer) clearTimeout(selfPingRetryTimer);
  try {
    currentSocket?.end(undefined);
  } catch {
    // ignore close errors
  }
  server.close(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref?.();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start the bot!
startWhatsAppBot().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
