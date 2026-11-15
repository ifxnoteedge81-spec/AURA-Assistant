import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ThinkingLevel } from '@google/genai';
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
import {
  DEFAULT_FIRST_GREETING,
  DEFAULT_OWNER_BIO,
  DEFAULT_OWNER_BOUNDARIES,
  STARTER_REGIONAL_DICTIONARY,
  generateExecutiveAssistantReply,
  parseUploadedDictionary,
  sanitizeId,
  type AssistantTone,
  type ChatMemoryRecord,
  type DictionaryEntry,
  type InboxNoteRecord,
} from './server/assistantEngine.ts';
import { GeminiKeyPool } from './server/geminiKeyPool.ts';
import {
  adminDeleteDocument,
  adminLoadCollection,
  adminLoadDocument,
  adminSaveDocument,
  getAdminFirestore,
} from './server/firestoreAdmin.ts';
import {
  OWNER_EMAIL,
  checkRateLimit,
  clearCustomDashboardPin,
  clearRateLimit,
  createMathChallenge,
  getClientIp,
  isPinConfigured,
  issuePreAuthToken,
  issueSessionToken,
  pruneExpiredRateLimits,
  recordAuthFailure,
  requireOwnerAuth,
  setCustomDashboardPin,
  verifyConfiguredPin,
  verifyGoogleFirebaseIdToken,
  verifyMathChallenge,
  verifyPreAuthToken,
} from './server/authSecurity.ts';

const PORT = Number(process.env.PORT || 3000);
const PREFIX = '.';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info_baileys');
const CONFIG_FILE = path.resolve('./bot-config.json');
const DICTIONARY_FILE = path.resolve('./bot-dictionary.json');
const MEMORIES_FILE = path.resolve('./bot-memories.json');
const NOTES_FILE = path.resolve('./bot-notes.json');
const BOT_SOURCE_DIR = path.resolve('./bot');

export const BENGALI_AUTOREPLY_TEXT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';

interface BotConfig {
  autoreply: boolean;
  aiAssistantEnabled: boolean;
  autoreplyMessage: string;
  firstGreetingTemplate: string;
  ownerName: string;
  ownerProfession: string;
  ownerLocation: string;
  ownerBio: string;
  ownerBoundaries: string;
  assistantTone: AssistantTone;
  cooldownMs: number;
  takeoverPauseMs: number;
  humanTypingEnabled: boolean;
  dailyReplyLimit: number;
  antilinkGroups: Record<string, boolean>;
}

interface BotLogEntry {
  id: string;
  timestamp: string;
  category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud';
  actor: string;
  summary: string;
  outcome: 'success' | 'blocked' | 'info' | 'error';
}

interface SimulatorRequest {
  text: string;
  chatType: 'private' | 'group_bot_admin' | 'group_bot_non_admin' | 'self';
  senderIsGroupAdmin?: boolean;
  groupJid?: string;
  contactJid?: string;
  contactName?: string;
}

// ----------------------------------------------------------------------------
// Server-Side Google Gen AI Multi-Key Pool Initialization (#1-#5 Rotation)
// ----------------------------------------------------------------------------
const geminiPool = new GeminiKeyPool();

const baileysLogger = pino({ level: 'silent' });

// ----------------------------------------------------------------------------
// Persistent Local + Cloud State Loaders & Savers
// ----------------------------------------------------------------------------
function defaultConfig(): BotConfig {
  return {
    autoreply: false,
    aiAssistantEnabled: true,
    autoreplyMessage: BENGALI_AUTOREPLY_TEXT,
    firstGreetingTemplate: DEFAULT_FIRST_GREETING,
    ownerName: 'Sir',
    ownerProfession: 'Software & Automation Developer',
    ownerLocation: 'Dhaka, Bangladesh',
    ownerBio: DEFAULT_OWNER_BIO,
    ownerBoundaries: DEFAULT_OWNER_BOUNDARIES,
    assistantTone: 'witty_flirty',
    cooldownMs: 0,
    takeoverPauseMs: 30 * 60 * 1000,
    humanTypingEnabled: true,
    dailyReplyLimit: 120,
    antilinkGroups: { '120363041928374655@g.us': true },
  };
}

function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }
  } catch (err) {
    console.warn(`[Storage] Failed reading ${path.basename(filePath)}:`, err);
  }
  return fallback;
}

function saveJsonFile(filePath: string, data: unknown) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Storage] Failed writing ${path.basename(filePath)}:`, err);
  }
}

function saveJsonFileAsync(filePath: string, data: unknown) {
  void fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8').catch((err) => {
    console.error(`[Storage] Failed async writing ${path.basename(filePath)}:`, err);
  });
}

function normalizeConfig(raw: Partial<BotConfig>): BotConfig {
  const base = defaultConfig();
  const validTones: AssistantTone[] = ['witty_flirty', 'warm_polite', 'executive_formal', 'sharp_shut_down'];
  const rawDailyLimit = typeof raw.dailyReplyLimit === 'number' ? raw.dailyReplyLimit : base.dailyReplyLimit;
  return {
    autoreply: typeof raw.autoreply === 'boolean' ? raw.autoreply : base.autoreply,
    aiAssistantEnabled: typeof raw.aiAssistantEnabled === 'boolean' ? raw.aiAssistantEnabled : base.aiAssistantEnabled,
    autoreplyMessage:
      typeof raw.autoreplyMessage === 'string' && raw.autoreplyMessage.trim()
        ? raw.autoreplyMessage
        : base.autoreplyMessage,
    firstGreetingTemplate:
      typeof raw.firstGreetingTemplate === 'string' && raw.firstGreetingTemplate.trim()
        ? raw.firstGreetingTemplate
        : base.firstGreetingTemplate,
    ownerName: typeof raw.ownerName === 'string' ? raw.ownerName : base.ownerName,
    ownerProfession: typeof raw.ownerProfession === 'string' ? raw.ownerProfession : base.ownerProfession,
    ownerLocation: typeof raw.ownerLocation === 'string' ? raw.ownerLocation : base.ownerLocation,
    ownerBio: typeof raw.ownerBio === 'string' ? raw.ownerBio : base.ownerBio,
    ownerBoundaries: typeof raw.ownerBoundaries === 'string' ? raw.ownerBoundaries : base.ownerBoundaries,
    assistantTone: validTones.includes(raw.assistantTone as AssistantTone)
      ? (raw.assistantTone as AssistantTone)
      : base.assistantTone,
    cooldownMs: typeof raw.cooldownMs === 'number' && raw.cooldownMs >= 0 ? raw.cooldownMs : base.cooldownMs,
    takeoverPauseMs:
      typeof raw.takeoverPauseMs === 'number' && raw.takeoverPauseMs >= 0
        ? raw.takeoverPauseMs
        : base.takeoverPauseMs,
    humanTypingEnabled:
      typeof raw.humanTypingEnabled === 'boolean' ? raw.humanTypingEnabled : base.humanTypingEnabled,
    dailyReplyLimit: Math.max(10, Math.min(500, Math.round(rawDailyLimit))),
    antilinkGroups:
      raw.antilinkGroups && typeof raw.antilinkGroups === 'object'
        ? raw.antilinkGroups
        : base.antilinkGroups,
  };
}

let botConfig: BotConfig = normalizeConfig(loadJsonFile<Partial<BotConfig>>(CONFIG_FILE, {}));
let dictionaryEntries: DictionaryEntry[] = loadJsonFile<DictionaryEntry[]>(DICTIONARY_FILE, []);
let chatMemories: Record<string, ChatMemoryRecord> = loadJsonFile<Record<string, ChatMemoryRecord>>(MEMORIES_FILE, {});
let inboxNotes: InboxNoteRecord[] = loadJsonFile<InboxNoteRecord[]>(NOTES_FILE, []);
let activeCloudOwnerId: string = process.env.FIREBASE_OWNER_UID || 'server_admin';

function persistConfig() {
  saveJsonFile(CONFIG_FILE, botConfig);
  void adminSaveDocument('bot_settings', 'primary', {
    ownerId: activeCloudOwnerId,
    ...botConfig,
  });
}

function persistDictionary() {
  saveJsonFileAsync(DICTIONARY_FILE, dictionaryEntries);
}

function persistMemories() {
  saveJsonFileAsync(MEMORIES_FILE, chatMemories);
}

function persistNotes() {
  saveJsonFileAsync(NOTES_FILE, inboxNotes);
}

const eventLogs: BotLogEntry[] = [];
const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();
const autoReplyCooldowns = new Map<string, number>();
const ownerTakeoverUntil = new Map<string, number>();
const botSentMessageIds = new Set<string>();

const chatReplyQueues = new Map<string, Promise<void>>();
const MAX_CONCURRENT_REPLIES = 8;
let activeReplyWorkers = 0;
const replySlotWaiters: Array<() => void> = [];

let dailyReplyDate = new Date().toISOString().slice(0, 10);
let dailyReplyCount = 0;
let isShuttingDown = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let credsBackupTimer: ReturnType<typeof setTimeout> | null = null;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function acquireReplySlot(): Promise<void> {
  if (activeReplyWorkers < MAX_CONCURRENT_REPLIES) {
    activeReplyWorkers += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    replySlotWaiters.push(resolve);
  });
  activeReplyWorkers += 1;
}

function releaseReplySlot() {
  activeReplyWorkers = Math.max(0, activeReplyWorkers - 1);
  const next = replySlotWaiters.shift();
  if (next) next();
}

function getDailyReplyStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyReplyDate !== today) {
    dailyReplyDate = today;
    dailyReplyCount = 0;
  }
  return {
    date: dailyReplyDate,
    count: dailyReplyCount,
    limit: botConfig.dailyReplyLimit,
  };
}

function getActiveTakeovers() {
  const now = Date.now();
  const active: Array<{ jid: string; phone: string; remainingMs: number; resumeAt: string }> = [];
  for (const [jid, until] of ownerTakeoverUntil.entries()) {
    if (until > now) {
      active.push({
        jid,
        phone: extractDigits(jid) || jid,
        remainingMs: until - now,
        resumeAt: new Date(until).toISOString(),
      });
    } else {
      ownerTakeoverUntil.delete(jid);
    }
  }
  return active;
}

function pruneRuntimeCaches() {
  const now = Date.now();
  for (const [jid, cached] of groupMetadataCache.entries()) {
    if (cached.expiresAt <= now) {
      groupMetadataCache.delete(jid);
    }
  }
  for (const [jid, until] of ownerTakeoverUntil.entries()) {
    if (until <= now) {
      ownerTakeoverUntil.delete(jid);
    }
  }
  for (const [jid, ts] of autoReplyCooldowns.entries()) {
    if (now - ts > 60 * 60 * 1000) {
      autoReplyCooldowns.delete(jid);
    }
  }
  pruneExpiredRateLimits();
}

function enqueuePrivateReply(chatJid: string, task: () => Promise<void>) {
  const prev = chatReplyQueues.get(chatJid) || Promise.resolve();
  const next = prev
    .then(async () => {
      if (isShuttingDown) return;
      await acquireReplySlot();
      try {
        await task();
      } finally {
        releaseReplySlot();
      }
    })
    .catch((err) => {
      pushLog('autoreply', 'Reply Queue', `Queue error: ${(err as Error).message}`, 'error');
    })
    .finally(() => {
      if (chatReplyQueues.get(chatJid) === next) {
        chatReplyQueues.delete(chatJid);
      }
    });

  chatReplyQueues.set(chatJid, next);
}

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
  if (eventLogs.length > 120) {
    eventLogs.length = 120;
  }
}

pushLog('system', 'Control Plane', 'WaNexus AI Executive Assistant runtime initialized.', 'info');

// ----------------------------------------------------------------------------
// Shared Bot Logic Helpers
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
  if (!geminiPool.hasKeys()) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }

  const { value: response } = await geminiPool.executeWithRotation(
    (client) =>
      withTimeout(
        client.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: query,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            systemInstruction:
              'You are a helpful, concise, and intelligent WhatsApp AI assistant. Format responses cleanly for mobile reading using plain text or simple WhatsApp formatting (*bold*, _italic_, bullet points). Keep answers accurate and easy to read.',
          },
        }),
        5_000,
        'Gemini .ai command'
      ),
    (rot) => {
      pushLog(
        'gemini',
        `Key #${rot.fromSlot}->#${rot.toSlot}`,
        `Rotated Gemini key (${rot.fromSlot}/${rot.totalSlots} -> ${rot.toSlot}/${rot.totalSlots}): ${rot.reason.slice(0, 90)}`,
        'info'
      );
    },
    { maxTotalMs: 9_000 }
  );

  const text = response?.text?.trim();
  return text || 'I could not generate a response for that query. Please try rephrasing.';
}

async function sendTrackedMessage(
  sock: WASocket,
  jid: string,
  content: { text: string; mentions?: string[] },
  options?: { quoted?: WAMessage }
) {
  const sent = await sock.sendMessage(jid, content, options);
  const sentId = sent?.key?.id;
  if (sentId) {
    botSentMessageIds.add(sentId);
    if (botSentMessageIds.size > 500) {
      const first = botSentMessageIds.values().next().value;
      if (first) botSentMessageIds.delete(first);
    }
  }
  return sent;
}

async function runExecutiveAssistantTurn(params: {
  contactJid: string;
  contactName: string;
  incomingText: string;
}): Promise<{
  replyText: string;
  detectedDistrict: string;
  noteCreated: InboxNoteRecord | null;
  usedFallback: boolean;
  keySlotUsed?: number;
  fallbackReason?: string;
}> {
  const chatId = sanitizeId(params.contactJid);
  const memory = chatMemories[chatId] || null;
  const nowIso = new Date().toISOString();

  let replyText = botConfig.autoreplyMessage || BENGALI_AUTOREPLY_TEXT;
  let detectedDistrict = memory?.detectedDistrict || 'Standard';
  let noteSummary = '';
  let noteUrgency: 'normal' | 'important' = 'normal';
  let noteCreated: InboxNoteRecord | null = null;
  let usedFallback = !botConfig.aiAssistantEnabled || !geminiPool.hasKeys();
  let keySlotUsed: number | undefined;
  let fallbackReason: string | undefined = !botConfig.aiAssistantEnabled
    ? 'AI Brain OFF'
    : !geminiPool.hasKeys()
      ? 'No API key'
      : undefined;

  try {
    const result = await generateExecutiveAssistantReply({
      keyPool: botConfig.aiAssistantEnabled ? geminiPool : null,
      onKeyRotate: (rot) => {
        pushLog(
          'gemini',
          `Key #${rot.fromSlot}->#${rot.toSlot}`,
          `Auto-rotated Gemini key (${rot.fromSlot}/${rot.totalSlots} -> ${rot.toSlot}/${rot.totalSlots}): ${rot.reason.slice(0, 90)}`,
          'info'
        );
      },
      settings: botConfig,
      memory,
      incomingText: params.incomingText,
      contactName: params.contactName,
      dictionaryEntries,
    });
    replyText = result.replyText;
    detectedDistrict = result.detectedDistrict;
    noteSummary = result.noteSummary;
    noteUrgency = result.noteUrgency;
    usedFallback = Boolean(result.usedFallback);
    keySlotUsed = result.keySlotUsed;
  } catch (err) {
    const errMsg = (err as Error).message;
    usedFallback = true;
    fallbackReason = errMsg.slice(0, 120);
    pushLog(
      'autoreply',
      params.contactName || params.contactJid,
      `AI fallback triggered: ${errMsg}`,
      'error'
    );
    const fallbackResult = await generateExecutiveAssistantReply({
      keyPool: null,
      settings: botConfig,
      memory,
      incomingText: params.incomingText,
      contactName: params.contactName,
      dictionaryEntries,
    });
    replyText = fallbackResult.replyText;
  }

  const nextTurns = [
    ...(memory?.turns || []),
    { role: 'user' as const, text: params.incomingText, timestamp: nowIso },
    { role: 'assistant' as const, text: replyText, timestamp: nowIso },
  ].slice(-16);

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: params.contactJid,
    contactName: params.contactName,
    detectedDistrict,
    lastSummary: noteSummary || memory?.lastSummary || params.incomingText.slice(0, 120),
    turns: nextTurns,
    updatedAt: nowIso,
  };
  chatMemories[chatId] = updatedMemory;
  persistMemories();
  void adminSaveDocument('chat_memories', chatId, {
    ownerId: activeCloudOwnerId,
    ...updatedMemory,
  });

  if (noteSummary) {
    const noteId = sanitizeId(`note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    noteCreated = {
      id: noteId,
      contactJid: params.contactJid,
      contactName: params.contactName,
      summary: noteSummary,
      urgency: noteUrgency,
      resolved: false,
      createdAt: nowIso,
    };
    inboxNotes.unshift(noteCreated);
    if (inboxNotes.length > 200) inboxNotes.length = 200;
    persistNotes();
    void adminSaveDocument('inbox_notes', noteId, {
      ownerId: activeCloudOwnerId,
      ...noteCreated,
    });
  }

  return { replyText, detectedDistrict, noteCreated, usedFallback, keySlotUsed, fallbackReason };
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

  // Detect manual human owner reply in a private chat -> pause AI assistant temporarily
  if (!isGroup && !remoteJid.endsWith('@g.us') && msg.key.fromMe) {
    const msgId = msg.key.id;
    const isCommand = text.startsWith(PREFIX);
    if (msgId && !botSentMessageIds.has(msgId) && !isCommand && text) {
      if (botConfig.takeoverPauseMs > 0) {
        ownerTakeoverUntil.set(remoteJid, Date.now() + botConfig.takeoverPauseMs);
        pushLog(
          'autoreply',
          extractDigits(remoteJid) || remoteJid,
          `Owner typed manually; AI paused for ${Math.round(botConfig.takeoverPauseMs / 60000)}m.`,
          'info'
        );
      }
    }
  }

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
          await sendTrackedMessage(sock, remoteJid, {
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
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: `Please provide a prompt.\nExample: *${PREFIX}ai Explain quantum computing*` },
          { quoted: msg }
        );
        return;
      }
      try {
        await sock.sendPresenceUpdate('composing', remoteJid);
        const reply = await askGemini(argsText);
        await sendTrackedMessage(sock, remoteJid, { text: reply }, { quoted: msg });
        pushLog('gemini', extractDigits(senderJid) || remoteJid, `Answered .${command} query`, 'success');
      } catch (err) {
        pushLog('gemini', extractDigits(senderJid) || remoteJid, `Gemini error: ${(err as Error).message}`, 'error');
        await sendTrackedMessage(
          sock,
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
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '⚠️ The *.antilink* command can only be used inside WhatsApp groups.' },
          { quoted: msg }
        );
        return;
      }

      const metadata = await getCachedGroupMetadata(sock, remoteJid);
      const senderIsAdmin = isParticipantAdmin(metadata, senderJid) || isOwnerOrSelf(msg, sock);
      if (!senderIsAdmin) {
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '⛔ Only group admins can configure Anti-Link settings.' },
          { quoted: msg }
        );
        return;
      }

      const subArgs = argsText.toLowerCase().split(/\s+/);
      if (subArgs[0] === 'delete' && subArgs[1] === 'on') {
        botConfig.antilinkGroups[remoteJid] = true;
        persistConfig();
        pushLog('antilink', metadata.subject || remoteJid, 'Enabled .antilink delete on', 'success');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '✅ *Anti-Link Delete Mode is now ON* for this group.' },
          { quoted: msg }
        );
        return;
      }

      if (subArgs[0] === 'delete' && subArgs[1] === 'off') {
        botConfig.antilinkGroups[remoteJid] = false;
        persistConfig();
        pushLog('antilink', metadata.subject || remoteJid, 'Disabled .antilink delete off', 'info');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '🛑 *Anti-Link Delete Mode is now OFF* for this group.' },
          { quoted: msg }
        );
        return;
      }

      await sendTrackedMessage(
        sock,
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
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '⛔ Only the bot owner can toggle private auto-reply mode.' },
          { quoted: msg }
        );
        return;
      }
      const mode = argsText.toLowerCase();
      if (mode === 'on') {
        botConfig.autoreply = true;
        persistConfig();
        pushLog('autoreply', 'Owner', 'Enabled .autoreply on', 'success');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '✅ *Private Auto-Reply Assistant is now ON.*' },
          { quoted: msg }
        );
        return;
      }
      if (mode === 'off') {
        botConfig.autoreply = false;
        persistConfig();
        pushLog('autoreply', 'Owner', 'Disabled .autoreply off', 'info');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '🛑 *Private Auto-Reply Assistant is now OFF.*' },
          { quoted: msg }
        );
        return;
      }
      await sendTrackedMessage(
        sock,
        remoteJid,
        {
          text: `🤖 *Private Auto-Reply Status:* ${botConfig.autoreply ? 'ON' : 'OFF'}\nUsage: *${PREFIX}autoreply on* | *${PREFIX}autoreply off*`,
        },
        { quoted: msg }
      );
      return;
    }

    if (command === 'ping') {
      await sendTrackedMessage(sock, remoteJid, { text: '🏓 Pong! Bot is online and active.' }, { quoted: msg });
    }
    return;
  }

  // 3. Automated Private Inbox Assistant (STRICTLY Private DMs Only — NEVER Groups)
  if (botConfig.autoreply) {
    const isPrivateChat =
      !isGroup &&
      !remoteJid.endsWith('@g.us') &&
      (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'));
    if (!isPrivateChat || msg.key.fromMe || !text) return;

    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(remoteJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const pausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
    if (Date.now() < pausedUntil) {
      return;
    }

    const lastSent = autoReplyCooldowns.get(remoteJid) || 0;
    if (Date.now() - lastSent < botConfig.cooldownMs) return;

    const contactName = msg.pushName || senderDigits || 'Contact';

    // Instant zero-delay enqueue: start AI generation immediately on message arrival
    enqueuePrivateReply(remoteJid, async () => {
      if (!botConfig.autoreply || currentSocket !== sock) return;

      const latestPausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
      if (Date.now() < latestPausedUntil) return;

      const daily = getDailyReplyStats();
      if (daily.count >= daily.limit) {
        pushLog(
          'autoreply',
          contactName,
          `Daily safety cap (${daily.limit} replies/day) reached; auto-reply skipped.`,
          'blocked'
        );
        return;
      }

      if (botConfig.cooldownMs > 0) {
        autoReplyCooldowns.set(remoteJid, Date.now());
      }

      // Fire read receipt & typing indicator in parallel so they add 0ms to reply latency
      if (botConfig.humanTypingEnabled) {
        void sock.readMessages([msg.key]).catch(() => {});
        void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
      }

      try {
        const startedAt = Date.now();
        const { replyText, detectedDistrict, usedFallback, keySlotUsed, fallbackReason } =
          await runExecutiveAssistantTurn({
            contactJid: remoteJid,
            contactName,
            incomingText: text,
          });

        if (Date.now() < (ownerTakeoverUntil.get(remoteJid) || 0)) return;

        const shouldQuote = Math.random() < 0.45;
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: replyText },
          shouldQuote ? { quoted: msg } : undefined
        );

        const elapsedMs = Date.now() - startedAt;
        dailyReplyCount += 1;
        pushLog(
          'autoreply',
          contactName,
          usedFallback
            ? `Static Fallback (${fallbackReason || 'Static Mode'} · ${elapsedMs}ms)`
            : `Instant AI Key #${keySlotUsed || 1} (${detectedDistrict} · ${elapsedMs}ms)`,
          usedFallback ? 'info' : 'success'
        );
      } finally {
        if (botConfig.humanTypingEnabled) {
          void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
      }
    });
  }
}

// ----------------------------------------------------------------------------
// Baileys Session Cloud Backup & Socket Connection
// ----------------------------------------------------------------------------
async function backupCredsToCloud() {
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    await adminSaveDocument('bot_sessions', 'primary', {
      ownerId: activeCloudOwnerId,
      phoneNumber: currentPairingPhone || '',
      credsData,
    });
  } catch {
    // ignore backup failures
  }
}

function scheduleCloudCredsBackup() {
  if (credsBackupTimer) clearTimeout(credsBackupTimer);
  credsBackupTimer = setTimeout(() => {
    credsBackupTimer = null;
    void backupCredsToCloud();
  }, 6000);
}

function cancelReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function restoreCredsFromCloudIfMissing() {
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (fs.existsSync(credsPath)) return;
  const docData = await adminLoadDocument<{ credsData?: Record<string, unknown> }>('bot_sessions', 'primary');
  if (docData?.credsData) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify(docData.credsData, null, 2), 'utf8');
    pushLog('cloud', 'Firestore', 'Restored WhatsApp session credentials from Firestore backup.', 'success');
  }
}

async function startBaileysConnection(phoneNumber?: string): Promise<{ pairingCode: string | null }> {
  if (isShuttingDown) {
    throw new Error('Server is shutting down.');
  }

  manualDisconnect = false;
  lastBotError = null;
  currentPairingCode = null;
  cancelReconnectTimer();

  if (currentSocket) {
    const staleSocket = currentSocket;
    currentSocket = null;
    try {
      staleSocket.end(undefined);
    } catch {
      // ignore
    }
  }

  await restoreCredsFromCloudIfMissing();
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let socketVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    socketVersion = version;
  } catch {
    // fall back to built-in version
  }

  botStatus = 'connecting';

  const sock = makeWASocket({
    ...(socketVersion ? { version: socketVersion } : {}),
    logger: baileysLogger,
    printQRInTerminal: false,
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
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleCloudCredsBackup();
  });

  sock.ev.on('connection.update', async (update) => {
    if (currentSocket !== sock || isShuttingDown) return;
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      botStatus = 'connected';
      reconnectAttempts = 0;
      currentPairingCode = null;
      lastBotError = null;
      await backupCredsToCloud();
      pushLog('pairing', sock.user?.id || 'WhatsApp', 'WhatsApp device linked and online.', 'success');
    }

    if (connection === 'close') {
      const errObj = lastDisconnect?.error as
        | { output?: { statusCode?: number }; statusCode?: number; message?: string }
        | undefined;
      const statusCode = errObj?.output?.statusCode ?? errObj?.statusCode;

      if (manualDisconnect || isShuttingDown) {
        botStatus = 'disconnected';
        return;
      }

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.forbidden ||
        statusCode === DisconnectReason.badSession
      ) {
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
      cancelReconnectTimer();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!manualDisconnect && !isShuttingDown) {
          startBaileysConnection(currentPairingPhone || undefined).catch((err) => {
            lastBotError = (err as Error).message;
            botStatus = 'disconnected';
          });
        }
      }, delayMs);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (currentSocket !== sock || isShuttingDown) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const msg of messages) {
      const rawTs = Number(msg.messageTimestamp || 0);
      const isFreshOwnEcho = type === 'append' && msg.key.fromMe && (rawTs === 0 || nowSec - rawTs < 25);
      if (type !== 'notify' && !isFreshOwnEcho) continue;
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
    if (currentSocket !== sock || isShuttingDown) {
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
// Hydrate from Server-Side Admin Firestore on Boot (if configured)
// ----------------------------------------------------------------------------
async function hydrateFromCloudAdmin() {
  const { db, mode } = getAdminFirestore();
  if (!db) return;
  try {
    const cloudSettings = await adminLoadDocument<Partial<BotConfig> & { ownerId?: string }>('bot_settings', 'primary');
    if (cloudSettings) {
      if (cloudSettings.ownerId && cloudSettings.ownerId !== 'server_admin') {
        activeCloudOwnerId = cloudSettings.ownerId;
      }
      botConfig = normalizeConfig(cloudSettings);
      saveJsonFile(CONFIG_FILE, botConfig);
    }

    const cloudDict = await adminLoadCollection<DictionaryEntry>('dictionary_entries');
    if (cloudDict.length > 0) {
      dictionaryEntries = cloudDict;
      persistDictionary();
    }

    const cloudMemories = await adminLoadCollection<ChatMemoryRecord>('chat_memories');
    if (cloudMemories.length > 0) {
      for (const mem of cloudMemories) {
        chatMemories[mem.id] = { ...mem, chatId: mem.id };
      }
      persistMemories();
    }

    const cloudNotes = await adminLoadCollection<InboxNoteRecord>('inbox_notes');
    if (cloudNotes.length > 0) {
      inboxNotes = cloudNotes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      persistNotes();
    }

    pushLog('cloud', 'Firestore Admin', `Hydrated state from Firestore (${mode}).`, 'success');
  } catch (err) {
    pushLog('cloud', 'Firestore Admin', `Hydration warning: ${(err as Error).message}`, 'error');
  }
}

// ----------------------------------------------------------------------------
// Express Server & API Routes
// ----------------------------------------------------------------------------
async function bootstrap() {
  // Start cloud hydration immediately without blocking HTTP server port binding
  const hydrationPromise = hydrateFromCloudAdmin();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // --------------------------------------------------------------------------
  // Public Owner Authentication & Anti-Bot Challenge Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/auth/status', (_req, res) => {
    res.json({
      ownerEmail: OWNER_EMAIL,
      pinConfigured: isPinConfigured(),
    });
  });

  app.get('/api/auth/challenge', (_req, res) => {
    res.json(createMathChallenge());
  });

  app.post('/api/auth/google', async (req, res) => {
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many failed attempts. Try again in ${limit.retryAfterSec}s.`,
      });
      return;
    }

    try {
      const idToken = String(req.body?.idToken || '');
      const challengeToken = String(req.body?.challengeToken || '');
      const challengeAnswer = String(req.body?.challengeAnswer ?? '');

      if (!verifyMathChallenge(challengeToken, challengeAnswer)) {
        recordAuthFailure(ip);
        res.status(400).json({ error: 'Verification answer was incorrect or expired. Try the new math check.' });
        return;
      }

      const identity = await verifyGoogleFirebaseIdToken(idToken);
      if (!identity.emailVerified || identity.email !== OWNER_EMAIL) {
        recordAuthFailure(ip);
        pushLog('system', identity.email || ip, 'Blocked unauthorized dashboard Google login attempt.', 'blocked');
        res.status(403).json({
          error: `Access denied. Only authorized owner (${OWNER_EMAIL}) can unlock this dashboard.`,
        });
        return;
      }

      clearRateLimit(ip);

      if (isPinConfigured()) {
        res.json({
          requiresPin: true,
          preAuthToken: issuePreAuthToken(identity.email),
          email: identity.email,
        });
        return;
      }

      const sessionToken = issueSessionToken(identity.email);
      pushLog('system', identity.email, 'Owner unlocked dashboard via Google Auth.', 'success');
      res.json({
        requiresPin: false,
        sessionToken,
        email: identity.email,
        pinConfigured: false,
      });
    } catch (err) {
      recordAuthFailure(ip);
      res.status(401).json({ error: (err as Error).message || 'Google sign-in verification failed.' });
    }
  });

  app.post('/api/auth/verify-pin', (req, res) => {
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      res.status(429).json({ error: `Locked due to failed attempts. Try again in ${limit.retryAfterSec}s.` });
      return;
    }

    const preAuthToken = String(req.body?.preAuthToken || '');
    const pin = String(req.body?.pin || '');
    const email = verifyPreAuthToken(preAuthToken);

    if (!email) {
      res.status(401).json({ error: 'Pre-auth session expired. Sign in with Google again.' });
      return;
    }

    if (!verifyConfiguredPin(pin)) {
      const failure = recordAuthFailure(ip);
      res.status(401).json({
        error: failure.locked
          ? 'Too many incorrect PIN attempts. Temporarily locked for 5 minutes.'
          : `Incorrect 2FA Security PIN (${failure.attemptsLeft} attempts remaining).`,
      });
      return;
    }

    clearRateLimit(ip);
    const sessionToken = issueSessionToken(email);
    pushLog('system', email, 'Owner verified 2FA Security PIN.', 'success');
    res.json({
      sessionToken,
      email,
      pinConfigured: true,
    });
  });

  app.post('/api/auth/pin-unlock', (req, res) => {
    const ip = getClientIp(req);
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      res.status(429).json({ error: `Locked due to failed attempts. Try again in ${limit.retryAfterSec}s.` });
      return;
    }

    if (!isPinConfigured()) {
      res.status(400).json({ error: 'No Security PIN is set yet. Unlock using Google Sign-In first.' });
      return;
    }

    const pin = String(req.body?.pin || '');
    const challengeToken = String(req.body?.challengeToken || '');
    const challengeAnswer = String(req.body?.challengeAnswer ?? '');

    if (!verifyMathChallenge(challengeToken, challengeAnswer)) {
      recordAuthFailure(ip);
      res.status(400).json({ error: 'Verification math answer was incorrect or expired.' });
      return;
    }

    if (!verifyConfiguredPin(pin)) {
      const failure = recordAuthFailure(ip);
      pushLog('system', ip, 'Failed PIN unlock attempt.', 'blocked');
      res.status(401).json({
        error: failure.locked
          ? 'Too many incorrect PIN attempts. Temporarily locked for 5 minutes.'
          : `Incorrect Security PIN (${failure.attemptsLeft} attempts remaining).`,
      });
      return;
    }

    clearRateLimit(ip);
    const sessionToken = issueSessionToken(OWNER_EMAIL);
    pushLog('system', OWNER_EMAIL, 'Owner unlocked dashboard via 2FA PIN.', 'success');
    res.json({
      sessionToken,
      email: OWNER_EMAIL,
      pinConfigured: true,
    });
  });

  // Protect ALL other /api/* routes behind authenticated owner session token
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
      next();
      return;
    }
    requireOwnerAuth(req, res, next);
  });

  app.get('/api/security/stats', (_req, res) => {
    res.json({
      ownerEmail: OWNER_EMAIL,
      pinConfigured: isPinConfigured(),
      envPinActive: Boolean(process.env.DASHBOARD_PIN?.trim()),
      dailyReplyStats: getDailyReplyStats(),
      activeTakeovers: getActiveTakeovers(),
      humanTypingEnabled: botConfig.humanTypingEnabled,
      dailyReplyLimit: botConfig.dailyReplyLimit,
      markOnlineOnConnect: false,
    });
  });

  app.post('/api/security/pin', (req, res) => {
    try {
      const action = String(req.body?.action || 'set');
      if (action === 'clear') {
        clearCustomDashboardPin();
        pushLog('system', OWNER_EMAIL, 'Removed custom 2FA dashboard PIN.', 'info');
        res.json({ pinConfigured: isPinConfigured() });
        return;
      }
      const newPin = String(req.body?.pin || '');
      setCustomDashboardPin(newPin);
      pushLog('system', OWNER_EMAIL, 'Updated dashboard 2FA Security PIN.', 'success');
      res.json({ pinConfigured: isPinConfigured() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/security/resume-takeover', (req, res) => {
    const jid = String(req.body?.jid || '');
    if (jid) {
      ownerTakeoverUntil.delete(jid);
      pushLog('autoreply', extractDigits(jid) || jid, 'Owner manually resumed AI auto-reply.', 'info');
    } else {
      ownerTakeoverUntil.clear();
      pushLog('autoreply', 'Owner', 'Resumed AI auto-reply across all paused chats.', 'info');
    }
    res.json({ activeTakeovers: getActiveTakeovers() });
  });

  app.get('/api/bot/status', (_req, res) => {
    const sessionExists = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    const { mode: firestoreAdminMode } = getAdminFirestore();
    res.json({
      status: botStatus,
      connectedUser: currentSocket?.user?.id || null,
      pairingCode: currentPairingCode,
      pairingPhone: currentPairingPhone,
      sessionExists,
      lastError: lastBotError,
      geminiConfigured: geminiPool.hasKeys(),
      geminiKeyPool: geminiPool.getStats(),
      firestoreAdminMode,
      config: botConfig,
      logs: eventLogs,
      dictionaryCount: dictionaryEntries.length,
      memoryCount: Object.keys(chatMemories).length,
      unreadNotesCount: inboxNotes.filter((n) => !n.resolved).length,
      dailyReplyStats: getDailyReplyStats(),
      activeTakeoversCount: getActiveTakeovers().length,
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
    cancelReconnectTimer();
    if (currentSocket) {
      const sockToClose = currentSocket;
      currentSocket = null;
      try {
        sockToClose.end(undefined);
      } catch {
        // ignore
      }
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
    cancelReconnectTimer();
    if (currentSocket) {
      const sockToClose = currentSocket;
      currentSocket = null;
      try {
        sockToClose.end(undefined);
      } catch {
        // ignore
      }
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    void adminDeleteDocument('bot_sessions', 'primary');
    botStatus = 'disconnected';
    pushLog('pairing', 'Operator', 'Cleared MultiFileAuthState credentials.', 'info');
    res.json({ status: botStatus, sessionExists: false });
  });

  app.post('/api/bot/config', (req, res) => {
    const patch = req.body || {};
    botConfig = normalizeConfig({ ...botConfig, ...patch });
    persistConfig();
    pushLog('autoreply', 'Dashboard', 'Saved assistant & moderation configuration.', 'info');
    res.json({ config: botConfig });
  });

  // Cloud Sync endpoint used by browser-authenticated Firestore client
  app.post('/api/cloud/sync', (req, res) => {
    const { ownerId, settings, dictionary, memories, notes } = req.body || {};
    if (typeof ownerId === 'string' && ownerId.trim()) {
      activeCloudOwnerId = ownerId.trim();
    }
    if (settings && typeof settings === 'object') {
      botConfig = normalizeConfig({ ...botConfig, ...settings });
      saveJsonFile(CONFIG_FILE, botConfig);
    }
    if (Array.isArray(dictionary) && dictionary.length > 0) {
      dictionaryEntries = dictionary;
      persistDictionary();
    }
    if (Array.isArray(memories) && memories.length > 0) {
      for (const mem of memories) {
        if (mem?.chatId) chatMemories[mem.chatId] = mem;
      }
      persistMemories();
    }
    if (Array.isArray(notes) && notes.length > 0) {
      inboxNotes = notes;
      persistNotes();
    }
    pushLog('cloud', 'Browser Sync', 'Synced dashboard & Firestore cloud data with bot server.', 'success');
    res.json({
      config: botConfig,
      dictionary: dictionaryEntries,
      memories: Object.values(chatMemories),
      notes: inboxNotes,
    });
  });

  // --------------------------------------------------------------------------
  // 64-District Bangla & English Dictionary Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/dictionary', (_req, res) => {
    res.json({ entries: dictionaryEntries });
  });

  app.post('/api/dictionary', (req, res) => {
    const term = String(req.body?.term || '').trim();
    const meaning = String(req.body?.meaning || '').trim();
    const district = String(req.body?.district || 'All Districts').trim();
    const language = (req.body?.language || 'bn_dialect') as DictionaryEntry['language'];
    const replyStyleHint = String(req.body?.replyStyleHint || '').trim();

    if (!term || !meaning) {
      res.status(400).json({ error: 'Term and meaning are required.' });
      return;
    }

    const entry: DictionaryEntry = {
      id: sanitizeId(`dict_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
      term: term.slice(0, 200),
      meaning: meaning.slice(0, 500),
      district: district.slice(0, 100),
      language,
      replyStyleHint: replyStyleHint.slice(0, 300),
    };
    dictionaryEntries.unshift(entry);
    persistDictionary();
    void adminSaveDocument('dictionary_entries', entry.id, {
      ownerId: activeCloudOwnerId,
      ...entry,
    });
    pushLog('system', 'Dictionary', `Added term "${entry.term}" (${entry.district})`, 'success');
    res.json({ entry, entries: dictionaryEntries });
  });

  app.post('/api/dictionary/import', (req, res) => {
    try {
      const content = String(req.body?.content || '');
      const fileName = String(req.body?.fileName || 'dictionary.txt');
      const parsed = parseUploadedDictionary(content, fileName);

      if (parsed.length === 0) {
        res.status(400).json({
          error:
            'No valid dictionary entries found. Use JSON array [{term, meaning, district, replyStyleHint}] or CSV/TXT lines: term | meaning | district | hint',
        });
        return;
      }

      const added: DictionaryEntry[] = parsed.map((item, idx) => ({
        ...item,
        id: sanitizeId(`dict_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`),
      }));

      dictionaryEntries = [...added, ...dictionaryEntries].slice(0, 2000);
      persistDictionary();
      for (const entry of added.slice(0, 50)) {
        void adminSaveDocument('dictionary_entries', entry.id, {
          ownerId: activeCloudOwnerId,
          ...entry,
        });
      }
      pushLog('system', 'Dictionary Upload', `Imported ${added.length} entries from ${fileName}`, 'success');
      res.json({ importedCount: added.length, added, entries: dictionaryEntries });
    } catch (err) {
      res.status(400).json({ error: `Failed to parse file: ${(err as Error).message}` });
    }
  });

  app.post('/api/dictionary/starter', (_req, res) => {
    const existingTerms = new Set(dictionaryEntries.map((d) => d.term.toLowerCase()));
    const fresh = STARTER_REGIONAL_DICTIONARY.filter((d) => !existingTerms.has(d.term.toLowerCase())).map(
      (item, idx) => ({
        ...item,
        id: sanitizeId(`starter_${Date.now()}_${idx}`),
      })
    );
    dictionaryEntries = [...fresh, ...dictionaryEntries];
    persistDictionary();
    for (const entry of fresh) {
      void adminSaveDocument('dictionary_entries', entry.id, {
        ownerId: activeCloudOwnerId,
        ...entry,
      });
    }
    pushLog('system', 'Dictionary', `Loaded ${fresh.length} starter 64-district entries.`, 'success');
    res.json({ importedCount: fresh.length, added: fresh, entries: dictionaryEntries });
  });

  app.delete('/api/dictionary/:id', (req, res) => {
    const id = req.params.id;
    dictionaryEntries = dictionaryEntries.filter((d) => d.id !== id);
    persistDictionary();
    void adminDeleteDocument('dictionary_entries', id);
    res.json({ entries: dictionaryEntries });
  });

  // --------------------------------------------------------------------------
  // Chat Memories & Notes for Sir Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/assistant/inbox', (_req, res) => {
    res.json({
      memories: Object.values(chatMemories).sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
      ),
      notes: inboxNotes,
    });
  });

  app.delete('/api/memories/:chatId', (req, res) => {
    const chatId = req.params.chatId;
    delete chatMemories[chatId];
    persistMemories();
    void adminDeleteDocument('chat_memories', chatId);
    res.json({ ok: true });
  });

  app.post('/api/notes/:id/toggle', (req, res) => {
    const id = req.params.id;
    inboxNotes = inboxNotes.map((n) => (n.id === id ? { ...n, resolved: !n.resolved } : n));
    persistNotes();
    const updated = inboxNotes.find((n) => n.id === id);
    if (updated) {
      void adminSaveDocument('inbox_notes', id, {
        ownerId: activeCloudOwnerId,
        ...updated,
      });
    }
    res.json({ notes: inboxNotes });
  });

  app.delete('/api/notes/:id', (req, res) => {
    const id = req.params.id;
    inboxNotes = inboxNotes.filter((n) => n.id !== id);
    persistNotes();
    void adminDeleteDocument('inbox_notes', id);
    res.json({ notes: inboxNotes });
  });

  app.post('/api/antilink/test', (req, res) => {
    const text = String(req.body?.text || '');
    const matches = findMatchedLinks(text);
    res.json({
      hasLink: matches.length > 0,
      matches,
    });
  });

  // --------------------------------------------------------------------------
  // Interactive Simulator (Supports Commands + AI Executive Assistant + Takeover)
  // --------------------------------------------------------------------------
  app.post('/api/simulator/message', async (req, res) => {
    try {
      const body = req.body as SimulatorRequest;
      const text = String(body?.text || '').trim();
      const chatType = body?.chatType || 'private';
      const senderIsGroupAdmin = Boolean(body?.senderIsGroupAdmin);
      const groupJid = body?.groupJid || '120363041928374655@g.us';
      const contactJid = body?.contactJid || '8801700000000@s.whatsapp.net';
      const contactName = body?.contactName || 'Simulator Contact';

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
            persistConfig();
            res.json({
              deleted: false,
              reply: '✅ *Anti-Link Delete Mode is now ON* for this group.',
              ruleTriggered: 'ANTILINK_ENABLED',
              config: botConfig,
            });
            return;
          }
          if (subArgs[0] === 'delete' && subArgs[1] === 'off') {
            botConfig.antilinkGroups[groupJid] = false;
            persistConfig();
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
            reply: `🛡️ *Anti-Link Status:* ${botConfig.antilinkGroups[groupJid] ? 'ON' : 'OFF'}`,
            ruleTriggered: 'ANTILINK_STATUS',
            config: botConfig,
          });
          return;
        }

        if (command === 'autoreply') {
          const mode = argsText.toLowerCase();
          if (mode === 'on') {
            botConfig.autoreply = true;
            persistConfig();
            pushLog('autoreply', 'Simulator', 'Executed .autoreply on', 'success');
            res.json({
              deleted: false,
              reply: '✅ *Private Auto-Reply Assistant is now ON.*',
              ruleTriggered: 'AUTOREPLY_ENABLED',
              config: botConfig,
            });
            return;
          }
          if (mode === 'off') {
            botConfig.autoreply = false;
            persistConfig();
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
            reply: `🤖 *Private Auto-Reply Status:* ${botConfig.autoreply ? 'ON' : 'OFF'}\nUsage: *${PREFIX}autoreply on* | *${PREFIX}autoreply off*`,
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
              `*${PREFIX}autoreply on* — Enable private AI assistant`,
              `*${PREFIX}autoreply off* — Disable private AI assistant`,
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

      // 3. Automated Private Inbox Assistant
      if (botConfig.autoreply) {
        if (chatType === 'private') {
          const { replyText, detectedDistrict, noteCreated, usedFallback, keySlotUsed, fallbackReason } =
            await runExecutiveAssistantTurn({
              contactJid,
              contactName,
              incomingText: text,
            });
          pushLog(
            'autoreply',
            'Simulator DM',
            usedFallback
              ? `Static Fallback (${fallbackReason || 'Static Mode'})`
              : `Replied (AI Key #${keySlotUsed || 1} · ${detectedDistrict})`,
            usedFallback ? 'info' : 'success'
          );
          res.json({
            deleted: false,
            reply: replyText,
            detectedDistrict,
            noteCreated,
            usedFallback,
            keySlotUsed,
            ruleTriggered: usedFallback ? 'STATIC_AUTOREPLY' : 'AI_EXECUTIVE_ASSISTANT',
            config: botConfig,
          });
          return;
        }

        if (chatType === 'self') {
          res.json({
            deleted: false,
            reply: null,
            note: 'Auto-reply skipped: Message-to-self / fromMe messages are excluded (triggers human takeover pause in live chats).',
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
        note: 'No command, link violation, or active auto-reply rule matched. Enable .autoreply on to test the AI assistant.',
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

  // Self-Ping Keep-Alive State (prevents Render Free tier 15m inactivity sleep)
  const SELF_PING_INTERVAL_MS = 5 * 60 * 1000; // Exactly 5 minutes
  const selfPingExplicitUrl = process.env.SELF_PING_URL?.trim();
  const selfPingBaseUrl = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    'https://aura-assistant-8y1z.onrender.com'
  )
    .trim()
    .replace(/\/+$/, '');
  const selfPingTargetUrl = selfPingExplicitUrl || `${selfPingBaseUrl}/health`;
  const selfPingEnabled =
    process.env.ENABLE_SELF_PING !== 'false' &&
    (process.env.NODE_ENV === 'production' ||
      Boolean(process.env.RENDER) ||
      Boolean(process.env.RENDER_EXTERNAL_URL) ||
      process.env.ENABLE_SELF_PING === 'true');

  let lastSelfPingAt: string | null = null;
  let lastSelfPingOk: boolean | null = null;
  let isSelfPingInFlight = false;
  let selfPingTimer: ReturnType<typeof setInterval> | null = null;
  let selfPingWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  let selfPingRetryTimer: ReturnType<typeof setTimeout> | null = null;

  async function executeSelfPing(isRetry = false) {
    if (isShuttingDown || isSelfPingInFlight) return;
    isSelfPingInFlight = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);
    try {
      const resp = await fetch(selfPingTargetUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'AuraAssistant-KeepAlive/1.0',
          'Cache-Control': 'no-store',
        },
      });
      lastSelfPingAt = new Date().toISOString();
      lastSelfPingOk = resp.ok;
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      lastSelfPingAt = new Date().toISOString();
      lastSelfPingOk = false;
      console.warn(`[KeepAlive] Self-ping failed (${selfPingTargetUrl}): ${(err as Error).message}`);
      // Schedule one quick retry after 15s so a transient hiccup never leaves a 10m gap
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

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      botStatus,
      connectedUser: currentSocket?.user?.id || null,
      geminiKeyPool: geminiPool.getStats(),
      selfPing: {
        enabled: selfPingEnabled,
        intervalMs: SELF_PING_INTERVAL_MS,
        targetUrl: selfPingTargetUrl,
        lastPingAt: lastSelfPingAt,
        lastPingOk: lastSelfPingOk,
      },
    });
  });

  app.head('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end();
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

  const cleanupTimer = setInterval(pruneRuntimeCaches, 10 * 60 * 1000);
  cleanupTimer.unref?.();

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WaNexus] Control Plane & Bot Studio running on http://0.0.0.0:${PORT}`);

    // Start 5-minute Keep-Alive Self-Ping on Render / Production so instance stays awake 24/7
    if (selfPingEnabled) {
      console.log(
        `[KeepAlive] Self-Ping enabled: pinging ${selfPingTargetUrl} every ${SELF_PING_INTERVAL_MS / 60000} minutes.`
      );
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

    // Wait briefly for cloud hydration without blocking HTTP server startup, then auto-resume WhatsApp
    Promise.race([hydrationPromise, sleep(4000)])
      .then(() => restoreCredsFromCloudIfMissing())
      .then(() => {
        if (isShuttingDown) return;
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
      })
      .catch(() => {});
  });

  function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[WaNexus] Received ${signal}, shutting down cleanly...`);

    cancelReconnectTimer();
    if (credsBackupTimer) clearTimeout(credsBackupTimer);
    if (selfPingTimer) clearInterval(selfPingTimer);
    if (selfPingWarmupTimer) clearTimeout(selfPingWarmupTimer);
    if (selfPingRetryTimer) clearTimeout(selfPingRetryTimer);
    clearInterval(cleanupTimer);

    if (currentSocket) {
      try {
        currentSocket.end(undefined);
      } catch {
        // ignore close errors
      }
      currentSocket = null;
    }

    httpServer.close(() => process.exit(0));
    const forceExit = setTimeout(() => process.exit(0), 3000);
    forceExit.unref?.();
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[WaNexus] Fatal server startup error:', err);
  process.exit(1);
});
