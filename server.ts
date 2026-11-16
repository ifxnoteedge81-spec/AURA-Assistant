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
  DEFAULT_STRICT_LOGIC_RULES,
  STARTER_REGIONAL_DICTIONARY,
  findRelevantDictionaryEntries,
  generateExecutiveAssistantReply,
  generateGroupCloneAction,
  parseUploadedDictionary,
  sanitizeId,
  type AssistantTone,
  type ChatMemoryRecord,
  type ChatTurn,
  type DictionaryEntry,
  type GroupAiMode,
  type GroupCloneResult,
  type InboxNoteRecord,
} from './server/assistantEngine.ts';
import { GeminiKeyPool } from './server/geminiKeyPool.ts';
import { OpenRouterReader } from './server/openRouterReader.ts';
import { buildZeroTokenMemorySummary } from './server/localMemorySummarizer.ts';
import {
  appendArchiveTurn,
  clearArchiveTurns,
  getArchiveCount,
  getArchiveTurns,
  recallRelevantOlderTurns,
  syncArchiveTurns,
} from './server/memoryArchive.ts';
import {
  adminDeleteDocument,
  adminLoadCollection,
  adminLoadDocument,
  adminSaveDocument,
  adminSaveSubDocument,
  getAdminFirestore,
} from './server/firestoreAdmin.ts';
import {
  getPostgresStatus,
  isPostgresConfigured,
  pgBulkInsertDictionaryEntries,
  pgClearDictionary,
  pgClosePool,
  pgDeleteChatMemory,
  pgDeleteDictionaryEntry,
  pgDeleteNote,
  pgDeleteSessionBackup,
  pgFindRelevantDictionaryEntries,
  pgGetChatArchive,
  pgGetDictionaryCount,
  pgLoadDictionary,
  pgLoadNotes,
  pgLoadRecentMemories,
  pgLoadSessionBackup,
  pgLoadSettings,
  pgLoadSingleContact,
  pgLogAiUsage,
  pgQueryDictionaryPage,
  pgRecallOlderMessages,
  pgSaveChatMemory,
  pgSaveDictionaryEntries,
  pgSaveNote,
  pgSaveSessionBackup,
  pgSaveSettings,
} from './server/postgresStore.ts';
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
import { ClientBotManager, type ClientBotPatchInput } from './server/clientBotManager.ts';

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
  strictLogicRules: string;
  assistantTone: AssistantTone;
  cooldownMs: number;
  takeoverPauseMs: number;
  humanTypingEnabled: boolean;
  dailyReplyLimit: number;
  antilinkGroups: Record<string, boolean>;
  groupAiEnabled: boolean;
  groupAiMode: GroupAiMode;
  groupReactionEnabled: boolean;
  groupCooldownMs: number;
  groupAiGroups: Record<string, boolean>;
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
// Server-Side Dual-AI Engines: 5-Key Gemini Responder + OpenRouter Reader
// ----------------------------------------------------------------------------
const geminiPool = new GeminiKeyPool();
const openRouterReader = new OpenRouterReader();

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
    strictLogicRules: DEFAULT_STRICT_LOGIC_RULES,
    assistantTone: 'witty_flirty',
    cooldownMs: 0,
    takeoverPauseMs: 30 * 60 * 1000,
    humanTypingEnabled: true,
    dailyReplyLimit: 120,
    antilinkGroups: { '120363041928374655@g.us': true },
    groupAiEnabled: false,
    groupAiMode: 'smart_blend',
    groupReactionEnabled: true,
    groupCooldownMs: 6000,
    groupAiGroups: {},
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
    strictLogicRules:
      typeof raw.strictLogicRules === 'string' && raw.strictLogicRules.trim()
        ? raw.strictLogicRules
        : base.strictLogicRules,
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
    groupAiEnabled: typeof raw.groupAiEnabled === 'boolean' ? raw.groupAiEnabled : base.groupAiEnabled,
    groupAiMode:
      raw.groupAiMode === 'smart_blend' ||
      raw.groupAiMode === 'mention_only' ||
      raw.groupAiMode === 'active_chat'
        ? raw.groupAiMode
        : base.groupAiMode,
    groupReactionEnabled:
      typeof raw.groupReactionEnabled === 'boolean'
        ? raw.groupReactionEnabled
        : base.groupReactionEnabled,
    groupCooldownMs:
      typeof raw.groupCooldownMs === 'number' && raw.groupCooldownMs >= 0
        ? Math.min(3_600_000, raw.groupCooldownMs)
        : base.groupCooldownMs,
    groupAiGroups:
      raw.groupAiGroups && typeof raw.groupAiGroups === 'object'
        ? raw.groupAiGroups
        : base.groupAiGroups,
  };
}

const MAX_RAM_DICTIONARY_ITEMS = 500;
let botConfig: BotConfig = normalizeConfig(loadJsonFile<Partial<BotConfig>>(CONFIG_FILE, {}));
let dictionaryEntries: DictionaryEntry[] = loadJsonFile<DictionaryEntry[]>(DICTIONARY_FILE, []).slice(
  0,
  MAX_RAM_DICTIONARY_ITEMS
);
let totalDictionaryCount: number = dictionaryEntries.length;
let chatMemories: Record<string, ChatMemoryRecord> = loadJsonFile<Record<string, ChatMemoryRecord>>(MEMORIES_FILE, {});
let inboxNotes: InboxNoteRecord[] = loadJsonFile<InboxNoteRecord[]>(NOTES_FILE, []);
let activeCloudOwnerId: string = process.env.FIREBASE_OWNER_UID || 'server_admin';

const clientBotManager = new ClientBotManager({
  getOwnerId: () => activeCloudOwnerId,
  onEvent: (summary, outcome) => pushLog('system', 'Client Bots', summary, outcome || 'info'),
});

function persistConfig() {
  saveJsonFile(CONFIG_FILE, botConfig);
  void adminSaveDocument('bot_settings', 'primary', {
    ownerId: activeCloudOwnerId,
    ...botConfig,
  });
  void pgSaveSettings(activeCloudOwnerId, botConfig as unknown as Record<string, unknown>);
}

function persistDictionary() {
  if (dictionaryEntries.length > MAX_RAM_DICTIONARY_ITEMS) {
    dictionaryEntries = dictionaryEntries.slice(0, MAX_RAM_DICTIONARY_ITEMS);
  }
  saveJsonFileAsync(DICTIONARY_FILE, dictionaryEntries);
}

async function resolveRelevantDictionaryForText(incomingText: string): Promise<DictionaryEntry[]> {
  const localMatches = findRelevantDictionaryEntries(incomingText, dictionaryEntries);
  if (!isPostgresConfigured()) {
    return localMatches;
  }

  const pgMatches = await withTimeout(
    pgFindRelevantDictionaryEntries(incomingText, 8),
    350,
    'Postgres dictionary lookup'
  ).catch(() => [] as DictionaryEntry[]);

  if (pgMatches.length === 0) return localMatches;

  const merged: DictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const item of [...pgMatches, ...localMatches]) {
    const key = item.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= 10) break;
  }
  return merged;
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
const summaryRefreshInFlight = new Set<string>();
const lastSummaryRefreshAt = new Map<string, number>();

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
  for (const [chatId, ts] of lastSummaryRefreshAt.entries()) {
    if (now - ts > 60 * 60 * 1000) {
      lastSummaryRefreshAt.delete(chatId);
    }
  }
  pruneExpiredRateLimits();
  clientBotManager.pruneCaches();
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
          model: 'gemini-4-hydrogen',
          contents: query,
          config: {
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction:
              'You are a helpful, concise, and intelligent WhatsApp AI assistant. Format responses cleanly for mobile reading using plain text or simple WhatsApp formatting (*bold*, _italic_, bullet points). Keep answers accurate and easy to read.',
          },
        }),
        8_000,
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
    { maxTotalMs: 12_000 }
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

async function ensureChatMemoryHydrated(
  chatId: string,
  contactJid: string,
  contactName: string
): Promise<ChatMemoryRecord | null> {
  const existing = chatMemories[chatId];
  if (existing && existing.turns.length > 0) {
    return existing;
  }

  // 1. Check local unlimited archive first (0ms)
  const localArchive = getArchiveTurns(chatId);
  if (localArchive.length > 0) {
    const hydrated: ChatMemoryRecord = {
      chatId,
      contactJid,
      contactName: existing?.contactName || contactName || 'Contact',
      detectedDistrict: existing?.detectedDistrict || 'Standard',
      lastSummary:
        existing?.lastSummary ||
        buildZeroTokenMemorySummary({
          contactName: existing?.contactName || contactName || 'Contact',
          contactJid,
          isGroup: Boolean(isJidGroup(contactJid)),
          turns: localArchive.slice(-20),
          archiveCount: localArchive.length,
          ownerName: botConfig.ownerName,
        }),
      turns: localArchive.slice(-20),
      updatedAt: localArchive[localArchive.length - 1]?.timestamp || new Date().toISOString(),
    };
    chatMemories[chatId] = hydrated;
    return hydrated;
  }

  // 2. Check Neon PostgreSQL on demand (bounded 450ms so replies never stall)
  if (isPostgresConfigured()) {
    const pgRecord = await withTimeout(pgLoadSingleContact(chatId), 450, 'Postgres contact load').catch(
      () => null
    );
    if (pgRecord && (pgRecord.turns.length > 0 || pgRecord.lastSummary)) {
      const hydrated: ChatMemoryRecord = {
        ...pgRecord,
        contactJid: pgRecord.contactJid || contactJid,
        contactName: pgRecord.contactName || contactName || 'Contact',
        lastSummary:
          pgRecord.lastSummary ||
          buildZeroTokenMemorySummary({
            contactName: pgRecord.contactName || contactName || 'Contact',
            contactJid,
            isGroup: Boolean(isJidGroup(contactJid)),
            turns: pgRecord.turns,
            ownerName: botConfig.ownerName,
          }),
      };
      chatMemories[chatId] = hydrated;
      return hydrated;
    }
  }

  // 3. Check Firestore chat_memories on demand (bounded 450ms)
  const fsDoc = await withTimeout(
    adminLoadDocument<ChatMemoryRecord>('chat_memories', chatId),
    450,
    'Firestore contact load'
  ).catch(() => null);
  if (fsDoc && (Array.isArray(fsDoc.turns) && fsDoc.turns.length > 0 || fsDoc.lastSummary)) {
    const hydrated: ChatMemoryRecord = {
      chatId,
      contactJid: fsDoc.contactJid || contactJid,
      contactName: fsDoc.contactName || contactName || 'Contact',
      detectedDistrict: fsDoc.detectedDistrict || 'Standard',
      lastSummary: fsDoc.lastSummary || '',
      turns: Array.isArray(fsDoc.turns) ? fsDoc.turns.slice(-20) : [],
      updatedAt: fsDoc.updatedAt || new Date().toISOString(),
    };
    chatMemories[chatId] = hydrated;
    return hydrated;
  }

  return existing || null;
}

/**
 * Zero-Token Automatic Memory Summarizer:
 * Summarizes and saves conversation history deterministically with 0 AI API tokens,
 * reserving 100% of Gemini & OpenRouter quota purely for smart replies.
 */
function scheduleBackgroundSummaryRefresh(chatId: string) {
  if (isShuttingDown) return;
  const mem = chatMemories[chatId];
  if (!mem || mem.turns.length === 0) return;

  const now = Date.now();
  const lastRun = lastSummaryRefreshAt.get(chatId) || 0;
  if (summaryRefreshInFlight.has(chatId) || now - lastRun < 4_000) return;

  summaryRefreshInFlight.add(chatId);
  lastSummaryRefreshAt.set(chatId, now);

  try {
    const newSummary = buildZeroTokenMemorySummary({
      contactName: mem.contactName,
      contactJid: mem.contactJid,
      isGroup: Boolean(isJidGroup(mem.contactJid)),
      existingSummary: mem.lastSummary || '',
      turns: mem.turns,
      archiveCount: getArchiveCount(chatId),
      ownerName: botConfig.ownerName,
    });

    if (newSummary && newSummary !== mem.lastSummary) {
      mem.lastSummary = newSummary;
      mem.updatedAt = new Date().toISOString();
      persistMemories();
      void adminSaveDocument('chat_memories', chatId, {
        ownerId: activeCloudOwnerId,
        ...mem,
      });
      void pgSaveChatMemory(activeCloudOwnerId, mem, []);
    }
  } finally {
    summaryRefreshInFlight.delete(chatId);
  }
}

function recordPassiveIncomingTurn(
  remoteJid: string,
  senderOrGroupName: string,
  incomingText: string,
  isGroup: boolean,
  senderNameInGroup?: string
) {
  if (!incomingText || !incomingText.trim()) return;
  const chatId = sanitizeId(remoteJid);
  const existing = chatMemories[chatId];
  const nowIso = new Date().toISOString();
  const turnText = isGroup && senderNameInGroup ? `[${senderNameInGroup}]: ${incomingText}` : incomingText;
  const lastTurn = existing?.turns?.[existing.turns.length - 1];
  if (lastTurn && lastTurn.text === turnText && Date.now() - Date.parse(lastTurn.timestamp) < 5_000) {
    return;
  }

  const incomingTurn: ChatTurn = { role: 'user', text: turnText, timestamp: nowIso };
  const nextTurns = [...(existing?.turns || []), incomingTurn].slice(-20);
  const resolvedName = existing?.contactName || senderOrGroupName || extractDigits(remoteJid) || 'Contact';

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: remoteJid,
    contactName: resolvedName,
    detectedDistrict: existing?.detectedDistrict || 'Standard',
    lastSummary:
      buildZeroTokenMemorySummary({
        contactName: resolvedName,
        contactJid: remoteJid,
        isGroup,
        existingSummary: existing?.lastSummary || '',
        turns: nextTurns,
        archiveCount: getArchiveCount(chatId) + 1,
        ownerName: botConfig.ownerName,
      }) ||
      existing?.lastSummary ||
      '',
    turns: nextTurns,
    updatedAt: nowIso,
  };

  chatMemories[chatId] = updatedMemory;
  persistMemories();
  void adminSaveDocument('chat_memories', chatId, {
    ownerId: activeCloudOwnerId,
    ...updatedMemory,
  });
  void pgSaveChatMemory(activeCloudOwnerId, updatedMemory, [incomingTurn]);
  archiveTurnToCloud(chatId, incomingTurn);
}

function archiveTurnToCloud(chatId: string, turn: ChatTurn) {
  const added = appendArchiveTurn(chatId, turn);
  if (!added) return;
  const msgId = sanitizeId(`msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  void adminSaveSubDocument('chat_memories', chatId, 'messages', msgId, {
    ownerId: activeCloudOwnerId,
    chatId,
    role: turn.role,
    text: turn.text.slice(0, 4000),
    timestamp: turn.timestamp,
  });
}

function recordOwnerManualTurn(remoteJid: string, text: string, pushName?: string | null) {
  const chatId = sanitizeId(remoteJid);
  const existing = chatMemories[chatId];
  const nowIso = new Date().toISOString();
  const taggedText = `[Sir (নিজে)]: ${text}`;
  const lastTurn = existing?.turns?.[existing.turns.length - 1];
  if (lastTurn && lastTurn.text === taggedText && Date.now() - Date.parse(lastTurn.timestamp) < 10_000) {
    return;
  }

  const ownerTurn: ChatTurn = { role: 'assistant', text: taggedText, timestamp: nowIso };
  const nextTurns = [...(existing?.turns || []), ownerTurn].slice(-20);

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: remoteJid,
    contactName: existing?.contactName || pushName || extractDigits(remoteJid) || 'Contact',
    detectedDistrict: existing?.detectedDistrict || 'Standard',
    lastSummary: existing?.lastSummary || '',
    turns: nextTurns,
    updatedAt: nowIso,
  };
  chatMemories[chatId] = updatedMemory;
  persistMemories();
  void adminSaveDocument('chat_memories', chatId, {
    ownerId: activeCloudOwnerId,
    ...updatedMemory,
  });
  void pgSaveChatMemory(activeCloudOwnerId, updatedMemory, [ownerTurn]);
  archiveTurnToCloud(chatId, ownerTurn);
  scheduleBackgroundSummaryRefresh(chatId);
}

function toTimestampIso(rawTs: unknown): string {
  if (typeof rawTs === 'number' && rawTs > 0) {
    const ms = rawTs < 1_000_000_000_000 ? rawTs * 1000 : rawTs;
    return new Date(ms).toISOString();
  }
  if (rawTs && typeof (rawTs as { toNumber?: () => number }).toNumber === 'function') {
    const num = (rawTs as { toNumber: () => number }).toNumber();
    if (num > 0) return new Date(num < 1_000_000_000_000 ? num * 1000 : num).toISOString();
  }
  return new Date().toISOString();
}

function ingestHistoryMessages(messages: WAMessage[]) {
  if (!Array.isArray(messages) || messages.length === 0) return;

  const grouped = new Map<
    string,
    { contactJid: string; contactName: string; items: Array<{ role: 'user' | 'assistant'; text: string; timestamp: string }> }
  >();

  for (const msg of messages) {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
      continue;
    }
    const isGroup = isJidGroup(remoteJid) ?? false;
    const isPrivate = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
    if (!isPrivate && !isGroup) continue;

    const text = extractMessageText(msg.message);
    if (!text || text.startsWith(PREFIX)) continue;

    const chatId = sanitizeId(remoteJid);
    const bucket = grouped.get(chatId) || {
      contactJid: remoteJid,
      contactName: isGroup
        ? chatMemories[chatId]?.contactName || extractDigits(remoteJid) || 'WhatsApp Group'
        : msg.pushName || extractDigits(remoteJid) || 'Contact',
      items: [],
    };
    if (!isGroup && msg.pushName && !msg.key.fromMe) {
      bucket.contactName = msg.pushName;
    }
    const senderLabel = msg.pushName || extractDigits(msg.key?.participant) || 'Member';
    bucket.items.push({
      role: msg.key.fromMe ? 'assistant' : 'user',
      text: msg.key.fromMe ? `[Sir (নিজে)]: ${text}` : isGroup ? `[${senderLabel}]: ${text}` : text,
      timestamp: toTimestampIso(msg.messageTimestamp),
    });
    grouped.set(chatId, bucket);
  }

  if (grouped.size === 0) return;

  let changedCount = 0;
  const touchedChatIds: string[] = [];

  for (const [chatId, bucket] of grouped.entries()) {
    const existing = chatMemories[chatId];
    const combined = [...(existing?.turns || []), ...bucket.items];
    const seen = new Set<string>();
    const deduped = combined
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .filter((t) => {
        const key = `${t.role}|${t.text.trim()}|${t.timestamp.slice(0, 16)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(-20);

    if (deduped.length === 0) continue;

    const latestTs = deduped[deduped.length - 1].timestamp;
    const newlyArchived = syncArchiveTurns(chatId, combined);
    chatMemories[chatId] = {
      chatId,
      contactJid: bucket.contactJid,
      contactName: existing?.contactName || bucket.contactName,
      detectedDistrict: existing?.detectedDistrict || 'Standard',
      lastSummary: existing?.lastSummary || '',
      turns: deduped,
      updatedAt: latestTs,
    };
    for (const item of newlyArchived.slice(-20)) {
      const msgId = sanitizeId(`hist_${Date.parse(item.timestamp) || Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      void adminSaveSubDocument('chat_memories', chatId, 'messages', msgId, {
        ownerId: activeCloudOwnerId,
        chatId,
        role: item.role,
        text: item.text.slice(0, 4000),
        timestamp: item.timestamp,
      });
    }
    if (newlyArchived.length > 0) {
      void pgSaveChatMemory(activeCloudOwnerId, chatMemories[chatId], newlyArchived);
    }
    changedCount += 1;
    touchedChatIds.push(chatId);
  }

  if (changedCount > 0) {
    persistMemories();
    pushLog('cloud', 'Inbox Sync', `Synced recent inbox history for ${changedCount} private chat(s).`, 'success');
    for (const chatId of touchedChatIds.slice(0, 5)) {
      scheduleBackgroundSummaryRefresh(chatId);
    }
  }
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
  providerUsed: 'gemini' | 'openrouter' | 'offline_emotion';
  keySlotUsed?: number;
  fallbackReason?: string;
}> {
  const chatId = sanitizeId(params.contactJid);
  const memory = await ensureChatMemoryHydrated(chatId, params.contactJid, params.contactName);
  const nowIso = new Date().toISOString();

  let replyText = botConfig.autoreplyMessage || BENGALI_AUTOREPLY_TEXT;
  let detectedDistrict = memory?.detectedDistrict || 'Standard';
  let noteSummary = '';
  let noteUrgency: 'normal' | 'important' = 'normal';
  let noteCreated: InboxNoteRecord | null = null;
  let usedFallback =
    !botConfig.aiAssistantEnabled || (!geminiPool.hasKeys() && !openRouterReader.hasKeys());
  let providerUsed: 'gemini' | 'openrouter' | 'offline_emotion' = 'gemini';
  let keySlotUsed: number | undefined;
  let fallbackReason: string | undefined = !botConfig.aiAssistantEnabled
    ? 'AI Brain OFF'
    : !geminiPool.hasKeys() && !openRouterReader.hasKeys()
      ? 'No API key'
      : undefined;

  const turnStartedAt = Date.now();
  let archivedMatches = recallRelevantOlderTurns(chatId, params.incomingText, memory?.turns || []);
  if (archivedMatches.length === 0 && isPostgresConfigured()) {
    archivedMatches = await withTimeout(
      pgRecallOlderMessages(chatId, params.incomingText, memory?.turns || []),
      500,
      'Postgres archive recall'
    ).catch(() => []);
  }

  const relevantDictionary = await resolveRelevantDictionaryForText(params.incomingText);

  try {
    const result = await generateExecutiveAssistantReply({
      keyPool: botConfig.aiAssistantEnabled ? geminiPool : null,
      openRouterReader: botConfig.aiAssistantEnabled ? openRouterReader : null,
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
      archivedMatches,
      incomingText: params.incomingText,
      contactName: params.contactName,
      dictionaryEntries: relevantDictionary,
    });
    replyText = result.replyText;
    detectedDistrict = result.detectedDistrict;
    noteSummary = result.noteSummary;
    noteUrgency = result.noteUrgency;
    usedFallback = Boolean(result.usedFallback);
    providerUsed = result.providerUsed || (usedFallback ? 'offline_emotion' : 'gemini');
    keySlotUsed = result.keySlotUsed;
  } catch (err) {
    const errMsg = (err as Error).message;
    usedFallback = true;
    providerUsed = 'offline_emotion';
    fallbackReason = errMsg.slice(0, 120);
    pushLog(
      'autoreply',
      params.contactName || params.contactJid,
      `AI fallback triggered: ${errMsg}`,
      'error'
    );
    const fallbackResult = await generateExecutiveAssistantReply({
      keyPool: null,
      openRouterReader: null,
      settings: botConfig,
      memory,
      archivedMatches,
      incomingText: params.incomingText,
      contactName: params.contactName,
      dictionaryEntries: relevantDictionary,
    });
    replyText = fallbackResult.replyText;
    providerUsed = fallbackResult.providerUsed || 'offline_emotion';
  }

  const turnLatencyMs = Date.now() - turnStartedAt;
  const userTurn: ChatTurn = { role: 'user', text: params.incomingText, timestamp: nowIso };
  const assistantTurn: ChatTurn = { role: 'assistant', text: replyText, timestamp: nowIso };
  const nextTurns = [...(memory?.turns || []), userTurn, assistantTurn].slice(-20);

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: params.contactJid,
    contactName: params.contactName,
    detectedDistrict,
    lastSummary: memory?.lastSummary || noteSummary || params.incomingText.slice(0, 120),
    turns: nextTurns,
    updatedAt: nowIso,
  };
  chatMemories[chatId] = updatedMemory;
  persistMemories();
  void adminSaveDocument('chat_memories', chatId, {
    ownerId: activeCloudOwnerId,
    ...updatedMemory,
  });
  void pgSaveChatMemory(activeCloudOwnerId, updatedMemory, [
    userTurn,
    { ...assistantTurn, providerUsed, latencyMs: turnLatencyMs },
  ]);
  void pgLogAiUsage({
    chatId,
    providerUsed,
    keySlot: keySlotUsed,
    latencyMs: turnLatencyMs,
  });

  // Archive unlimited turns locally + to Firestore sub-collection for long-term recall
  archiveTurnToCloud(chatId, userTurn);
  archiveTurnToCloud(chatId, assistantTurn);

  // Trigger OpenRouter silent background inbox reader without adding any latency to reply
  scheduleBackgroundSummaryRefresh(chatId);

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
    void pgSaveNote(activeCloudOwnerId, noteCreated);
  }

  return {
    replyText,
    detectedDistrict,
    noteCreated,
    usedFallback,
    providerUsed,
    keySlotUsed,
    fallbackReason,
  };
}

function isDirectlyAddressedInGroup(
  msg: WAMessage,
  sock: WASocket,
  text: string,
  ownerName: string
): boolean {
  const botDigits = extractDigits(sock.user?.id);
  const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
  const unwrapped =
    msg.message?.ephemeralMessage?.message ||
    msg.message?.viewOnceMessage?.message ||
    msg.message?.viewOnceMessageV2?.message ||
    msg.message;
  const ctx = unwrapped?.extendedTextMessage?.contextInfo;

  if (ctx?.mentionedJid && Array.isArray(ctx.mentionedJid)) {
    for (const jid of ctx.mentionedJid) {
      const d = extractDigits(jid);
      if (d && (d === botDigits || d === botLidDigits)) {
        return true;
      }
    }
  }

  if (ctx?.quotedMessage && ctx?.participant) {
    const quotedParticipantDigits = extractDigits(ctx.participant);
    if (
      quotedParticipantDigits &&
      (quotedParticipantDigits === botDigits || quotedParticipantDigits === botLidDigits)
    ) {
      return true;
    }
  }

  const lower = text.toLowerCase();
  if (botDigits && lower.includes(`@${botDigits}`)) return true;

  const cleanOwner = ownerName.trim().toLowerCase();
  if (cleanOwner.length >= 3 && cleanOwner !== 'sir') {
    const escaped = cleanOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\s|@)${escaped}(\\s|[?!.,]|$)`, 'i').test(text)) {
      return true;
    }
  }

  return false;
}

async function runGroupCloneTurn(params: {
  groupJid: string;
  groupName: string;
  senderName: string;
  incomingText: string;
  isDirectlyAddressed: boolean;
  canTextReply: boolean;
  observeOnly?: boolean;
}): Promise<GroupCloneResult> {
  const chatId = sanitizeId(params.groupJid);
  const memory = await ensureChatMemoryHydrated(chatId, params.groupJid, params.groupName);
  const nowIso = new Date().toISOString();
  const speakerText = `[${params.senderName}]: ${params.incomingText}`;
  const incomingTurn: ChatTurn = { role: 'user', text: speakerText, timestamp: nowIso };

  if (params.observeOnly) {
    const nextTurns = [...(memory?.turns || []), incomingTurn].slice(-20);
    const updatedMemory: ChatMemoryRecord = {
      chatId,
      contactJid: params.groupJid,
      contactName: params.groupName || memory?.contactName || 'WhatsApp Group',
      detectedDistrict: memory?.detectedDistrict || 'Standard',
      lastSummary: memory?.lastSummary || '',
      turns: nextTurns,
      updatedAt: nowIso,
    };
    chatMemories[chatId] = updatedMemory;
    persistMemories();
    void adminSaveDocument('chat_memories', chatId, {
      ownerId: activeCloudOwnerId,
      ...updatedMemory,
    });
    void pgSaveChatMemory(activeCloudOwnerId, updatedMemory, [incomingTurn]);
    archiveTurnToCloud(chatId, incomingTurn);
    scheduleBackgroundSummaryRefresh(chatId);
    return {
      action: 'silent',
      replyText: '',
      reactionEmoji: '',
      shouldQuote: false,
      detectedDistrict: updatedMemory.detectedDistrict,
      reason: 'Observed silently',
      providerUsed: 'offline_emotion',
    };
  }

  const turnStartedAt = Date.now();
  let archivedMatches = recallRelevantOlderTurns(chatId, params.incomingText, memory?.turns || []);
  if (archivedMatches.length === 0 && isPostgresConfigured()) {
    archivedMatches = await withTimeout(
      pgRecallOlderMessages(chatId, params.incomingText, memory?.turns || []),
      500,
      'Postgres group recall'
    ).catch(() => []);
  }

  const relevantDictionary = await resolveRelevantDictionaryForText(params.incomingText);

  let result: GroupCloneResult;
  try {
    result = await generateGroupCloneAction({
      keyPool: botConfig.aiAssistantEnabled ? geminiPool : null,
      openRouterReader: botConfig.aiAssistantEnabled ? openRouterReader : null,
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
      archivedMatches,
      groupName: params.groupName,
      senderName: params.senderName,
      incomingText: params.incomingText,
      isDirectlyAddressed: params.isDirectlyAddressed,
      canTextReply: params.canTextReply,
      dictionaryEntries: relevantDictionary,
    });
  } catch (err) {
    pushLog('autoreply', params.groupName, `Group clone fallback: ${(err as Error).message}`, 'error');
    result = await generateGroupCloneAction({
      keyPool: null,
      openRouterReader: null,
      settings: botConfig,
      memory,
      archivedMatches,
      groupName: params.groupName,
      senderName: params.senderName,
      incomingText: params.incomingText,
      isDirectlyAddressed: params.isDirectlyAddressed,
      canTextReply: params.canTextReply,
      dictionaryEntries: relevantDictionary,
    });
  }

  const turnLatencyMs = Date.now() - turnStartedAt;
  const didSendText =
    (result.action === 'reply' || result.action === 'reply_and_react') && Boolean(result.replyText);

  const turnsToPersist: Array<ChatTurn & { providerUsed?: string; latencyMs?: number }> = [incomingTurn];
  const nextTurnsList = [...(memory?.turns || []), incomingTurn];

  if (didSendText) {
    const replyTurn: ChatTurn = {
      role: 'assistant',
      text: result.replyText,
      timestamp: new Date().toISOString(),
    };
    nextTurnsList.push(replyTurn);
    turnsToPersist.push({
      ...replyTurn,
      providerUsed: result.providerUsed || 'gemini',
      latencyMs: turnLatencyMs,
    });
    archiveTurnToCloud(chatId, replyTurn);
    void pgLogAiUsage({
      chatId,
      providerUsed: result.providerUsed || 'gemini',
      keySlot: result.keySlotUsed,
      latencyMs: turnLatencyMs,
    });
  }

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: params.groupJid,
    contactName: params.groupName || memory?.contactName || 'WhatsApp Group',
    detectedDistrict: result.detectedDistrict || memory?.detectedDistrict || 'Standard',
    lastSummary: memory?.lastSummary || `${params.senderName}: ${params.incomingText.slice(0, 100)}`,
    turns: nextTurnsList.slice(-20),
    updatedAt: nowIso,
  };
  chatMemories[chatId] = updatedMemory;
  persistMemories();
  void adminSaveDocument('chat_memories', chatId, {
    ownerId: activeCloudOwnerId,
    ...updatedMemory,
  });
  void pgSaveChatMemory(activeCloudOwnerId, updatedMemory, turnsToPersist);
  archiveTurnToCloud(chatId, incomingTurn);
  scheduleBackgroundSummaryRefresh(chatId);

  return result;
}

// ----------------------------------------------------------------------------
// Live Baileys Message Handler
// ----------------------------------------------------------------------------
async function handleLiveMessage(sock: WASocket, msg: WAMessage) {
  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid;
  if (
    !remoteJid ||
    remoteJid === 'status@broadcast' ||
    remoteJid.endsWith('@broadcast') ||
    remoteJid.endsWith('@newsletter')
  ) {
    return;
  }

  const isGroup = isJidGroup(remoteJid) ?? false;
  const text = extractMessageText(msg.message);
  const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;
  const senderAlt = (msg.key as { participantAlt?: string }).participantAlt;

  // Detect manual human owner reply (in DM OR Group) -> save to memory & pause AI temporarily
  if (msg.key.fromMe) {
    const msgId = msg.key.id;
    const isCommand = text.startsWith(PREFIX);
    if (msgId && !botSentMessageIds.has(msgId) && !isCommand && text) {
      let chatDisplayName = msg.pushName;
      if (isGroup) {
        const meta = await getCachedGroupMetadata(sock, remoteJid).catch(() => null);
        if (meta?.subject) chatDisplayName = meta.subject;
      }
      recordOwnerManualTurn(remoteJid, text, chatDisplayName);
      if (botConfig.takeoverPauseMs > 0) {
        ownerTakeoverUntil.set(remoteJid, Date.now() + botConfig.takeoverPauseMs);
        pushLog(
          'autoreply',
          chatDisplayName || extractDigits(remoteJid) || remoteJid,
          `Owner typed manually${isGroup ? ' in group' : ''}; AI paused for ${Math.round(botConfig.takeoverPauseMs / 60000)}m.`,
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
        const senderIsAdmin = isParticipantAdmin(metadata, senderJid, senderAlt);

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
      const senderIsAdmin = isParticipantAdmin(metadata, senderJid, senderAlt) || isOwnerOrSelf(msg, sock);
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

    if (command === 'groupai') {
      if (!isGroup) {
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '⚠️ The *.groupai* command can only be used inside WhatsApp groups.' },
          { quoted: msg }
        );
        return;
      }

      const metadata = await getCachedGroupMetadata(sock, remoteJid);
      const senderIsAdmin = isParticipantAdmin(metadata, senderJid, senderAlt) || isOwnerOrSelf(msg, sock);
      if (!senderIsAdmin) {
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '⛔ Only the bot owner or group admins can configure Group AI Clone.' },
          { quoted: msg }
        );
        return;
      }

      const sub = argsText.toLowerCase().trim();
      if (sub === 'on') {
        botConfig.groupAiEnabled = true;
        botConfig.groupAiGroups[remoteJid] = true;
        persistConfig();
        pushLog('autoreply', metadata.subject || remoteJid, 'Enabled .groupai on', 'success');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: `✅ *Group AI Clone is now ON* for *${metadata.subject || 'this group'}* (${botConfig.groupAiMode}).` },
          { quoted: msg }
        );
        return;
      }
      if (sub === 'off') {
        botConfig.groupAiGroups[remoteJid] = false;
        persistConfig();
        pushLog('autoreply', metadata.subject || remoteJid, 'Disabled .groupai off', 'info');
        await sendTrackedMessage(
          sock,
          remoteJid,
          { text: '🛑 *Group AI Clone is now OFF* for this group.' },
          { quoted: msg }
        );
        return;
      }
      if (sub === 'mode smart' || sub === 'smart') {
        botConfig.groupAiMode = 'smart_blend';
        persistConfig();
        await sendTrackedMessage(sock, remoteJid, { text: '🎭 Group AI mode set to *smart_blend* (observe, react, banter, debate & flirt naturally).' }, { quoted: msg });
        return;
      }
      if (sub === 'mode mention' || sub === 'mention') {
        botConfig.groupAiMode = 'mention_only';
        persistConfig();
        await sendTrackedMessage(sock, remoteJid, { text: '🏷️ Group AI mode set to *mention_only* (observes all messages, replies when tagged/replied).' }, { quoted: msg });
        return;
      }
      if (sub === 'mode active' || sub === 'active') {
        botConfig.groupAiMode = 'active_chat';
        persistConfig();
        await sendTrackedMessage(sock, remoteJid, { text: '⚡ Group AI mode set to *active_chat* (lively participation).' }, { quoted: msg });
        return;
      }

      const isEnabledHere = botConfig.groupAiEnabled && botConfig.groupAiGroups[remoteJid] === true;
      await sendTrackedMessage(
        sock,
        remoteJid,
        {
          text: `🎭 *Group AI Clone Status:* ${isEnabledHere ? 'ON' : 'OFF'} (Mode: *${botConfig.groupAiMode}*)\nUsage: *${PREFIX}groupai on* | *${PREFIX}groupai off* | *${PREFIX}groupai mode smart|mention|active*`,
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

  // 3A. Smart Group AI Clone ("আমার কপি" — Observe, React, Debate, Roast, Flirt in Enabled Groups)
  if (isGroup && botConfig.groupAiEnabled && botConfig.groupAiGroups[remoteJid] === true) {
    if (msg.key.fromMe || !text) return;

    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(senderJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const senderName = msg.pushName || senderDigits || 'Member';
    const isDirectlyAddressed = isDirectlyAddressedInGroup(msg, sock, text, botConfig.ownerName);

    enqueuePrivateReply(remoteJid, async () => {
      if (!botConfig.groupAiEnabled || botConfig.groupAiGroups[remoteJid] !== true || currentSocket !== sock) {
        return;
      }

      const metadata = await getCachedGroupMetadata(sock, remoteJid).catch(() => null);
      const groupName = metadata?.subject || extractDigits(remoteJid) || 'Group Chat';

      const pausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
      if (Date.now() < pausedUntil) {
        await runGroupCloneTurn({
          groupJid: remoteJid,
          groupName,
          senderName,
          incomingText: text,
          isDirectlyAddressed,
          canTextReply: false,
          observeOnly: true,
        });
        return;
      }

      const daily = getDailyReplyStats();
      if (daily.count >= daily.limit) {
        await runGroupCloneTurn({
          groupJid: remoteJid,
          groupName,
          senderName,
          incomingText: text,
          isDirectlyAddressed,
          canTextReply: false,
          observeOnly: true,
        });
        return;
      }

      const lastGroupSent = autoReplyCooldowns.get(remoteJid) || 0;
      const canTextReply = Date.now() - lastGroupSent >= (botConfig.groupCooldownMs ?? 6000);

      const startedAt = Date.now();
      const decision = await runGroupCloneTurn({
        groupJid: remoteJid,
        groupName,
        senderName,
        incomingText: text,
        isDirectlyAddressed,
        canTextReply,
      });

      if (Date.now() < (ownerTakeoverUntil.get(remoteJid) || 0)) return;

      // Send WhatsApp Emoji Reaction if selected
      if (
        (decision.action === 'react' || decision.action === 'reply_and_react') &&
        botConfig.groupReactionEnabled &&
        decision.reactionEmoji
      ) {
        await sock
          .sendMessage(remoteJid, { react: { text: decision.reactionEmoji, key: msg.key } })
          .catch(() => {});
      }

      // Send Group Clone Reply if selected
      if ((decision.action === 'reply' || decision.action === 'reply_and_react') && decision.replyText) {
        if (botConfig.humanTypingEnabled) {
          void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        }
        try {
          if (botConfig.groupCooldownMs > 0) {
            autoReplyCooldowns.set(remoteJid, Date.now());
          }
          const quoteOrMention = decision.shouldQuote ? { quoted: msg } : undefined;
          await sendTrackedMessage(
            sock,
            remoteJid,
            { text: decision.replyText },
            quoteOrMention
          );
          dailyReplyCount += 1;
          const elapsedMs = Date.now() - startedAt;
          pushLog(
            'autoreply',
            `${groupName} · ${senderName}`,
            `Group Clone (${decision.action}${decision.reactionEmoji ? ` ${decision.reactionEmoji}` : ''} · ${decision.providerUsed || 'gemini'} · ${elapsedMs}ms)`,
            'success'
          );
        } finally {
          if (botConfig.humanTypingEnabled) {
            void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
          }
        }
      } else if (decision.action === 'react' && decision.reactionEmoji) {
        pushLog(
          'autoreply',
          `${groupName} · ${senderName}`,
          `Group Reaction ${decision.reactionEmoji} (${decision.reason})`,
          'info'
        );
      } else {
        pushLog(
          'autoreply',
          `${groupName} · ${senderName}`,
          `Group Observed Silently (${decision.reason})`,
          'info'
        );
      }
    });
    return;
  }

  // 3B. Automated Private Inbox Assistant (Private DMs Only)
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
    const contactName = msg.pushName || senderDigits || 'Contact';
    if (Date.now() < pausedUntil) {
      recordPassiveIncomingTurn(remoteJid, contactName, text, false);
      return;
    }

    const lastSent = autoReplyCooldowns.get(remoteJid) || 0;
    if (Date.now() - lastSent < botConfig.cooldownMs) {
      recordPassiveIncomingTurn(remoteJid, contactName, text, false);
      return;
    }

    // Instant zero-delay enqueue: start AI generation immediately on message arrival
    enqueuePrivateReply(remoteJid, async () => {
      if (!botConfig.autoreply || currentSocket !== sock) return;

      const latestPausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
      if (Date.now() < latestPausedUntil) {
        recordPassiveIncomingTurn(remoteJid, contactName, text, false);
        return;
      }

      const daily = getDailyReplyStats();
      if (daily.count >= daily.limit) {
        recordPassiveIncomingTurn(remoteJid, contactName, text, false);
        pushLog(
          'autoreply',
          contactName,
          `Daily safety cap (${daily.limit} replies/day) reached; auto-reply skipped (saved passively).`,
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
        const {
          replyText,
          detectedDistrict,
          usedFallback,
          providerUsed,
          keySlotUsed,
          fallbackReason,
        } = await runExecutiveAssistantTurn({
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
        const summaryLabel =
          providerUsed === 'openrouter'
            ? `OpenRouter Failover (${detectedDistrict} · ${elapsedMs}ms)`
            : usedFallback || providerUsed === 'offline_emotion'
              ? `Offline Emotion Engine (${fallbackReason || 'Static/Offline'} · ${elapsedMs}ms)`
              : `Gemini Key #${keySlotUsed || 1} (${detectedDistrict} · ${elapsedMs}ms)`;
        pushLog('autoreply', contactName, summaryLabel, usedFallback ? 'info' : 'success');
      } finally {
        if (botConfig.humanTypingEnabled) {
          void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        }
      }
    });
    return;
  }

  // 3C. Passive Zero-Token Conversation Archival (all non-AI groups & DMs when autoreply is off)
  if (!msg.key.fromMe && text && !text.startsWith(PREFIX)) {
    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(senderJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    if (isGroup) {
      const meta = await getCachedGroupMetadata(sock, remoteJid).catch(() => null);
      const groupName = meta?.subject || extractDigits(remoteJid) || 'WhatsApp Group';
      const senderName = msg.pushName || senderDigits || 'Member';
      recordPassiveIncomingTurn(remoteJid, groupName, text, true, senderName);
    } else if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
      const contactName = msg.pushName || senderDigits || 'Contact';
      recordPassiveIncomingTurn(remoteJid, contactName, text, false);
    }
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
    await pgSaveSessionBackup('primary', activeCloudOwnerId, currentPairingPhone || '', credsData);

    // Also back up essential Signal / app-state sync keys (bounded safely under 450KB)
    const files = fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.json') && f !== 'creds.json');
    const keyBundle: Record<string, unknown> = {};
    let totalBytes = 0;
    for (const fileName of files) {
      if (
        !fileName.startsWith('app-state-sync-') &&
        !fileName.startsWith('session-') &&
        !fileName.startsWith('sender-key-')
      ) {
        continue;
      }
      const raw = fs.readFileSync(path.join(AUTH_DIR, fileName), 'utf8');
      if (totalBytes + raw.length > 420_000) break;
      try {
        keyBundle[fileName] = JSON.parse(raw);
        totalBytes += raw.length;
      } catch {
        // ignore malformed file
      }
    }
    if (Object.keys(keyBundle).length > 0) {
      await adminSaveDocument('bot_sessions', 'keys_backup', {
        ownerId: activeCloudOwnerId,
        phoneNumber: currentPairingPhone || '',
        credsData: keyBundle,
      });
      await pgSaveSessionBackup('keys_backup', activeCloudOwnerId, currentPairingPhone || '', keyBundle);
    }
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
  const firestoreDoc = await adminLoadDocument<{ credsData?: Record<string, unknown> }>('bot_sessions', 'primary');
  const credsData = firestoreDoc?.credsData || (await pgLoadSessionBackup('primary'));
  if (credsData) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify(credsData, null, 2), 'utf8');

    const keysDoc = await adminLoadDocument<{ credsData?: Record<string, unknown> }>('bot_sessions', 'keys_backup');
    const keysBundle = keysDoc?.credsData || (await pgLoadSessionBackup('keys_backup'));
    if (keysBundle && typeof keysBundle === 'object') {
      for (const [fileName, content] of Object.entries(keysBundle)) {
        if (!fileName.endsWith('.json') || fileName.includes('/') || fileName.includes('..')) continue;
        fs.writeFileSync(path.join(AUTH_DIR, fileName), JSON.stringify(content), 'utf8');
      }
    }
    pushLog('cloud', 'Cloud/PG', 'Restored WhatsApp session credentials & sync keys from database backup.', 'success');
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

  sock.ev.on('messaging-history.set', ({ messages }) => {
    if (currentSocket !== sock || isShuttingDown) return;
    try {
      ingestHistoryMessages(messages);
    } catch (err) {
      pushLog('cloud', 'Inbox Sync', `History ingest warning: ${(err as Error).message}`, 'info');
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
  // 1. Hydrate from External PostgreSQL (if DATABASE_URL is configured)
  if (isPostgresConfigured()) {
    try {
      const pgSettings = await pgLoadSettings();
      if (pgSettings?.config) {
        if (pgSettings.ownerId && pgSettings.ownerId !== 'server_admin') {
          activeCloudOwnerId = pgSettings.ownerId;
        }
        botConfig = normalizeConfig(pgSettings.config as Partial<BotConfig>);
        saveJsonFile(CONFIG_FILE, botConfig);
      }

      const pgDict = await pgLoadDictionary(MAX_RAM_DICTIONARY_ITEMS);
      if (pgDict.length > 0) {
        dictionaryEntries = pgDict;
        persistDictionary();
      }
      totalDictionaryCount = Math.max(dictionaryEntries.length, await pgGetDictionaryCount());

      const pgMems = await pgLoadRecentMemories();
      if (pgMems.length > 0) {
        for (const mem of pgMems) {
          chatMemories[mem.chatId] = mem;
          syncArchiveTurns(mem.chatId, mem.turns);
        }
        persistMemories();
      }

      const pgNotes = await pgLoadNotes();
      if (pgNotes.length > 0) {
        inboxNotes = pgNotes;
        persistNotes();
      }
      pushLog('cloud', 'PostgreSQL', 'Hydrated persistent state from PostgreSQL.', 'success');
    } catch (err) {
      pushLog('cloud', 'PostgreSQL', `Hydration warning: ${(err as Error).message}`, 'error');
    }
  }

  // 2. Hydrate from Server-Side Admin Firestore (if configured)
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
    if (cloudDict.length > 0 && (!isPostgresConfigured() || dictionaryEntries.length === 0)) {
      dictionaryEntries = cloudDict.slice(0, MAX_RAM_DICTIONARY_ITEMS);
      if (!isPostgresConfigured()) {
        totalDictionaryCount = cloudDict.length;
      }
      persistDictionary();
    }

    const cloudMemories = await adminLoadCollection<ChatMemoryRecord>('chat_memories');
    if (cloudMemories.length > 0) {
      for (const mem of cloudMemories) {
        if (!chatMemories[mem.id] || Date.parse(mem.updatedAt) > Date.parse(chatMemories[mem.id].updatedAt)) {
          chatMemories[mem.id] = { ...mem, chatId: mem.id };
        }
        syncArchiveTurns(mem.id, mem.turns || []);
      }
      persistMemories();
    }

    const cloudNotes = await adminLoadCollection<InboxNoteRecord>('inbox_notes');
    if (cloudNotes.length > 0) {
      const notesById = new Map<string, InboxNoteRecord>();
      for (const existingNote of inboxNotes) {
        if (existingNote?.id) notesById.set(existingNote.id, existingNote);
      }
      for (const cloudNote of cloudNotes) {
        if (cloudNote?.id && !notesById.has(cloudNote.id)) {
          notesById.set(cloudNote.id, cloudNote);
        }
      }
      inboxNotes = Array.from(notesById.values())
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 200);
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

  // Scoped Client Portal Middleware (strictly isolated to a single botId + valid clientAccessKey + active === true)
  const requireClientPortalAccess = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    const botId = String(req.params.botId || '').trim();
    const key =
      String(req.headers['x-client-access-key'] || '').trim() ||
      String(req.query.access || '').trim();
    const check = clientBotManager.verifyClientAccessKey(botId, key);
    if (!check.ok) {
      if (check.reason === 'NOT_FOUND') {
        res.status(404).json({ error: 'Client bot portal not found.', code: 'NOT_FOUND' });
        return;
      }
      if (check.reason === 'SUSPENDED') {
        res.status(403).json({
          error: 'This bot service has been paused/suspended by the administrator.',
          code: 'SUSPENDED',
          clientName: check.bot?.clientName || botId,
        });
        return;
      }
      res.status(401).json({ error: 'Invalid or missing client portal access key.', code: 'INVALID_KEY' });
      return;
    }
    next();
  };

  app.get('/api/client-portal/:botId', requireClientPortalAccess, (req, res) => {
    const view = clientBotManager.getBotView(String(req.params.botId));
    if (!view) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot: view });
  });

  app.patch('/api/client-portal/:botId', requireClientPortalAccess, (req, res) => {
    const body = (req.body || {}) as ClientBotPatchInput;
    const updated = clientBotManager.updateBot(
      String(req.params.botId),
      {
        moderateAllGroups: body.moderateAllGroups,
        defaultModeration: body.defaultModeration,
        groupRules: body.groupRules,
        upsertGroupRule: body.upsertGroupRule,
        removeGroupJid: body.removeGroupJid,
        savedReplyEnabled: body.savedReplyEnabled,
        savedReplyMessage: body.savedReplyMessage,
        savedReplyCooldownMs: body.savedReplyCooldownMs,
        keywordReplies: body.keywordReplies,
      },
      'Client Portal'
    );
    if (!updated) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot: updated });
  });

  app.post('/api/client-portal/:botId/pair', requireClientPortalAccess, async (req, res) => {
    try {
      const bot = await clientBotManager.pairBot(
        String(req.params.botId),
        String(req.body?.phoneNumber || '')
      );
      res.json({ bot });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/client-portal/:botId/disconnect', requireClientPortalAccess, (req, res) => {
    const bot = clientBotManager.disconnectBot(String(req.params.botId));
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.post('/api/client-portal/:botId/reset-session', requireClientPortalAccess, async (req, res) => {
    const bot = await clientBotManager.resetBotSession(String(req.params.botId));
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.get('/api/client-portal/:botId/groups', requireClientPortalAccess, async (req, res) => {
    const groups = await clientBotManager.fetchLiveGroups(String(req.params.botId));
    res.json({ groups });
  });

  app.post(
    '/api/client-portal/:botId/groups/:groupJid/reset-warnings',
    requireClientPortalAccess,
    (req, res) => {
      const bot = clientBotManager.resetGroupWarnings(
        String(req.params.botId),
        decodeURIComponent(String(req.params.groupJid)),
        req.body?.userKey ? String(req.body.userKey) : undefined
      );
      if (!bot) {
        res.status(404).json({ error: 'Client bot not found.' });
        return;
      }
      res.json({ bot });
    }
  );

  // Protect ALL other /api/* routes behind authenticated owner session token
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path.startsWith('/client-portal/')) {
      next();
      return;
    }
    requireOwnerAuth(req, res, next);
  });

  // Owner Multi-Number Client Bot Management Endpoints (Unlimited Zero-AI Client Slots)
  app.get('/api/client-bots', (_req, res) => {
    res.json({
      bots: clientBotManager.listBots(),
      summary: clientBotManager.getSummaryCounts(),
    });
  });

  app.post('/api/client-bots', (req, res) => {
    const clientName = String(req.body?.clientName || '').trim();
    if (!clientName) {
      res.status(400).json({ error: 'Client bot name is required.' });
      return;
    }
    const bot = clientBotManager.createBot({
      clientName,
      phoneNumber: req.body?.phoneNumber ? String(req.body.phoneNumber) : '',
      moderateAllGroups: req.body?.moderateAllGroups !== false,
      savedReplyEnabled: Boolean(req.body?.savedReplyEnabled),
      savedReplyMessage: req.body?.savedReplyMessage ? String(req.body.savedReplyMessage) : undefined,
    });
    res.status(201).json({ bot });
  });

  app.patch('/api/client-bots/:botId', (req, res) => {
    const bot = clientBotManager.updateBot(
      String(req.params.botId),
      (req.body || {}) as ClientBotPatchInput,
      'Owner'
    );
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.post('/api/client-bots/:botId/pair', async (req, res) => {
    try {
      const bot = await clientBotManager.pairBot(
        String(req.params.botId),
        String(req.body?.phoneNumber || '')
      );
      res.json({ bot });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/client-bots/:botId/disconnect', (req, res) => {
    const bot = clientBotManager.disconnectBot(String(req.params.botId));
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.post('/api/client-bots/:botId/reset-session', async (req, res) => {
    const bot = await clientBotManager.resetBotSession(String(req.params.botId));
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.post('/api/client-bots/:botId/rotate-key', (req, res) => {
    const bot = clientBotManager.rotateAccessKey(String(req.params.botId));
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
  });

  app.delete('/api/client-bots/:botId', async (req, res) => {
    const deleted = await clientBotManager.deleteBot(String(req.params.botId));
    if (!deleted) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/client-bots/:botId/groups', async (req, res) => {
    const groups = await clientBotManager.fetchLiveGroups(String(req.params.botId));
    res.json({ groups });
  });

  app.post('/api/client-bots/:botId/groups/:groupJid/reset-warnings', (req, res) => {
    const bot = clientBotManager.resetGroupWarnings(
      String(req.params.botId),
      decodeURIComponent(String(req.params.groupJid)),
      req.body?.userKey ? String(req.body.userKey) : undefined
    );
    if (!bot) {
      res.status(404).json({ error: 'Client bot not found.' });
      return;
    }
    res.json({ bot });
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
      openRouterConfigured: openRouterReader.hasKeys(),
      openRouterStats: openRouterReader.getStats(),
      postgres: getPostgresStatus(),
      firestoreAdminMode,
      config: botConfig,
      logs: eventLogs,
      dictionaryCount: totalDictionaryCount,
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
    void adminDeleteDocument('bot_sessions', 'keys_backup');
    void pgDeleteSessionBackup();
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

  app.get('/api/groups', async (_req, res) => {
    const map = new Map<
      string,
      {
        jid: string;
        name: string;
        participantCount: number;
        antilinkEnabled: boolean;
        groupAiEnabled: boolean;
      }
    >();

    // 1. Seed from saved configs & memories
    for (const [jid, enabled] of Object.entries(botConfig.antilinkGroups || {})) {
      map.set(jid, {
        jid,
        name: chatMemories[sanitizeId(jid)]?.contactName || jid,
        participantCount: 0,
        antilinkEnabled: Boolean(enabled),
        groupAiEnabled: Boolean(botConfig.groupAiGroups[jid]),
      });
    }
    for (const [jid, enabled] of Object.entries(botConfig.groupAiGroups || {})) {
      const existing = map.get(jid);
      map.set(jid, {
        jid,
        name: existing?.name || chatMemories[sanitizeId(jid)]?.contactName || jid,
        participantCount: existing?.participantCount || 0,
        antilinkEnabled: existing?.antilinkEnabled ?? false,
        groupAiEnabled: Boolean(enabled),
      });
    }
    for (const mem of Object.values(chatMemories)) {
      if (mem.contactJid?.endsWith('@g.us') && !map.has(mem.contactJid)) {
        map.set(mem.contactJid, {
          jid: mem.contactJid,
          name: mem.contactName || mem.contactJid,
          participantCount: 0,
          antilinkEnabled: Boolean(botConfig.antilinkGroups[mem.contactJid]),
          groupAiEnabled: Boolean(botConfig.groupAiGroups[mem.contactJid]),
        });
      }
    }

    // 2. Enrich with live WhatsApp participating groups when connected
    if (currentSocket && botStatus === 'connected') {
      try {
        const participating = await withTimeout(
          currentSocket.groupFetchAllParticipating(),
          4_000,
          'Fetch participating groups'
        );
        for (const [jid, meta] of Object.entries(participating || {})) {
          const existing = map.get(jid);
          map.set(jid, {
            jid,
            name: meta.subject || existing?.name || jid,
            participantCount: Array.isArray(meta.participants) ? meta.participants.length : 0,
            antilinkEnabled: Boolean(botConfig.antilinkGroups[jid]),
            groupAiEnabled: Boolean(botConfig.groupAiGroups[jid]),
          });
        }
      } catch {
        // Return cached/known groups safely
      }
    }

    const groups = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      connected: botStatus === 'connected',
      groups,
    });
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
      if (!isPostgresConfigured() || dictionaryEntries.length === 0) {
        dictionaryEntries = dictionary.slice(0, MAX_RAM_DICTIONARY_ITEMS);
        persistDictionary();
      }
      if (!isPostgresConfigured()) {
        totalDictionaryCount = dictionaryEntries.length;
      }
    }
    if (Array.isArray(memories) && memories.length > 0) {
      for (const mem of memories) {
        if (!mem?.chatId) continue;
        const existing = chatMemories[mem.chatId];
        if (!existing || Date.parse(mem.updatedAt || '') > Date.parse(existing.updatedAt || '')) {
          chatMemories[mem.chatId] = mem;
        }
      }
      persistMemories();
    }
    if (Array.isArray(notes) && notes.length > 0) {
      const notesById = new Map<string, InboxNoteRecord>();
      for (const existingNote of inboxNotes) {
        if (existingNote?.id) notesById.set(existingNote.id, existingNote);
      }
      for (const incomingNote of notes) {
        if (incomingNote?.id && !notesById.has(incomingNote.id)) {
          notesById.set(incomingNote.id, incomingNote);
        }
      }
      inboxNotes = Array.from(notesById.values())
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 200);
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
  // 64-District Bangla & English Dictionary Endpoints (Zero-RAM Chunked & Paginated)
  // --------------------------------------------------------------------------
  app.get('/api/dictionary', async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const limit = Math.max(10, Math.min(100, Number(req.query.limit || 50) || 50));
    const search = String(req.query.search || '').trim();
    const district = String(req.query.district || 'ALL').trim();

    if (isPostgresConfigured()) {
      const result = await pgQueryDictionaryPage({ page, limit, search, district });
      totalDictionaryCount = Math.max(totalDictionaryCount, result.totalCount);
      res.json({
        ...result,
        storageMode: 'postgres',
      });
      return;
    }

    const qLower = search.toLowerCase();
    const filtered = dictionaryEntries.filter((entry) => {
      const matchesDistrict = !district || district === 'ALL' || entry.district === district;
      const matchesSearch =
        !qLower ||
        entry.term.toLowerCase().includes(qLower) ||
        entry.meaning.toLowerCase().includes(qLower) ||
        entry.district.toLowerCase().includes(qLower);
      return matchesDistrict && matchesSearch;
    });
    const totalCount = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const districts = Array.from(new Set(dictionaryEntries.map((d) => d.district))).sort();
    totalDictionaryCount = dictionaryEntries.length;

    res.json({
      entries: filtered.slice(offset, offset + limit),
      totalCount,
      page: safePage,
      totalPages,
      districts,
      storageMode: 'local',
    });
  });

  app.post('/api/dictionary', async (req, res) => {
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
    dictionaryEntries = [entry, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
    persistDictionary();
    void adminSaveDocument('dictionary_entries', entry.id, {
      ownerId: activeCloudOwnerId,
      ...entry,
    });
    if (isPostgresConfigured()) {
      await pgSaveDictionaryEntries(activeCloudOwnerId, [entry]);
      totalDictionaryCount = await pgGetDictionaryCount();
    } else {
      totalDictionaryCount = dictionaryEntries.length;
    }
    pushLog('system', 'Dictionary', `Added term "${entry.term}" (${entry.district})`, 'success');
    res.json({ entry, entries: dictionaryEntries.slice(0, 50), totalCount: totalDictionaryCount });
  });

  app.post('/api/dictionary/import-chunk', async (req, res) => {
    try {
      const content = String(req.body?.content || '');
      const fileName = String(req.body?.fileName || 'dictionary.txt');
      const chunkIndex = Number(req.body?.chunkIndex || 0);
      const totalChunks = Number(req.body?.totalChunks || 1);

      const parsed = parseUploadedDictionary(content, fileName);
      let insertedCount = 0;

      if (parsed.length > 0) {
        if (isPostgresConfigured()) {
          insertedCount = await pgBulkInsertDictionaryEntries(activeCloudOwnerId, parsed);
          if (dictionaryEntries.length < MAX_RAM_DICTIONARY_ITEMS && chunkIndex === 0) {
            const sample = parsed.slice(0, 50).map((item, idx) => ({
              ...item,
              id: sanitizeId(`dict_${Date.now()}_${idx}`),
            }));
            dictionaryEntries = [...sample, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
            persistDictionary();
          }
          totalDictionaryCount = await pgGetDictionaryCount();
        } else {
          // Local fallback when DATABASE_URL is unavailable: keep safe RAM limit
          const batch: DictionaryEntry[] = parsed.map((item, idx) => ({
            ...item,
            id: sanitizeId(`dict_${Date.now()}_${chunkIndex}_${idx}`),
          }));
          dictionaryEntries = [...batch, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
          persistDictionary();
          insertedCount = batch.length;
          totalDictionaryCount = dictionaryEntries.length;
        }
      }

      if (chunkIndex === totalChunks - 1) {
        pushLog(
          'system',
          'Dictionary Upload',
          `Completed streaming upload (${fileName}, ${totalChunks} chunks). Total entries: ${totalDictionaryCount}.`,
          'success'
        );
      }

      res.json({
        parsedCount: parsed.length,
        insertedCount,
        totalCount: totalDictionaryCount,
        storageMode: isPostgresConfigured() ? 'postgres' : 'local',
      });
    } catch (err) {
      res.status(400).json({ error: `Chunk import failed: ${(err as Error).message}` });
    }
  });

  app.post('/api/dictionary/import', async (req, res) => {
    try {
      const content = String(req.body?.content || '');
      const fileName = String(req.body?.fileName || 'dictionary.txt');
      const parsed = parseUploadedDictionary(content, fileName);

      if (parsed.length === 0) {
        res.status(400).json({
          error:
            'No valid dictionary entries found. Supported formats: JSON, JSONL, CSV, TSV, Pipe (|), Dash (-), Colon (:), Equals (=), or Word + Meaning lines.',
        });
        return;
      }

      let importedCount = 0;
      if (isPostgresConfigured()) {
        importedCount = await pgBulkInsertDictionaryEntries(activeCloudOwnerId, parsed);
        const sample = parsed.slice(0, 50).map((item, idx) => ({
          ...item,
          id: sanitizeId(`dict_${Date.now()}_${idx}`),
        }));
        dictionaryEntries = [...sample, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
        persistDictionary();
        totalDictionaryCount = await pgGetDictionaryCount();
      } else {
        const added: DictionaryEntry[] = parsed.map((item, idx) => ({
          ...item,
          id: sanitizeId(`dict_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`),
        }));
        dictionaryEntries = [...added, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
        persistDictionary();
        importedCount = added.length;
        totalDictionaryCount = dictionaryEntries.length;
      }

      pushLog('system', 'Dictionary Upload', `Imported ${importedCount} entries from ${fileName}`, 'success');
      res.json({
        importedCount,
        totalCount: totalDictionaryCount,
        entries: dictionaryEntries.slice(0, 50),
      });
    } catch (err) {
      res.status(400).json({ error: `Failed to parse file: ${(err as Error).message}` });
    }
  });

  app.post('/api/dictionary/starter', async (_req, res) => {
    const existingTerms = new Set(dictionaryEntries.map((d) => d.term.toLowerCase()));
    const fresh = STARTER_REGIONAL_DICTIONARY.filter((d) => !existingTerms.has(d.term.toLowerCase())).map(
      (item, idx) => ({
        ...item,
        id: sanitizeId(`starter_${Date.now()}_${idx}`),
      })
    );
    dictionaryEntries = [...fresh, ...dictionaryEntries].slice(0, MAX_RAM_DICTIONARY_ITEMS);
    persistDictionary();
    for (const entry of fresh) {
      void adminSaveDocument('dictionary_entries', entry.id, {
        ownerId: activeCloudOwnerId,
        ...entry,
      });
    }
    if (isPostgresConfigured()) {
      await pgSaveDictionaryEntries(activeCloudOwnerId, fresh);
      totalDictionaryCount = await pgGetDictionaryCount();
    } else {
      totalDictionaryCount = dictionaryEntries.length;
    }
    pushLog('system', 'Dictionary', `Loaded ${fresh.length} starter 64-district entries.`, 'success');
    res.json({
      importedCount: fresh.length,
      added: fresh,
      entries: dictionaryEntries.slice(0, 50),
      totalCount: totalDictionaryCount,
    });
  });

  app.delete('/api/dictionary/:id', async (req, res) => {
    const id = req.params.id;
    dictionaryEntries = dictionaryEntries.filter((d) => d.id !== id);
    persistDictionary();
    void adminDeleteDocument('dictionary_entries', id);
    await pgDeleteDictionaryEntry(id);
    if (isPostgresConfigured()) {
      totalDictionaryCount = await pgGetDictionaryCount();
    } else {
      totalDictionaryCount = dictionaryEntries.length;
    }
    res.json({ entries: dictionaryEntries.slice(0, 50), totalCount: totalDictionaryCount });
  });

  app.delete('/api/dictionary', async (_req, res) => {
    dictionaryEntries = [];
    persistDictionary();
    await pgClearDictionary();
    totalDictionaryCount = 0;
    pushLog('system', 'Dictionary', 'Cleared all dictionary entries.', 'info');
    res.json({ ok: true, totalCount: 0 });
  });

  // --------------------------------------------------------------------------
  // Chat Memories & Notes for Sir Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/assistant/inbox', (_req, res) => {
    const enrichedMemories = Object.values(chatMemories)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((m) => ({
        ...m,
        archiveCount: Math.max(m.turns.length, getArchiveCount(m.chatId), (m as ChatMemoryRecord & { archiveCount?: number }).archiveCount || 0),
      }));
    res.json({
      memories: enrichedMemories,
      notes: inboxNotes,
    });
  });

  app.get('/api/memories/:chatId/archive', async (req, res) => {
    const chatId = req.params.chatId;
    const localTurns = getArchiveTurns(chatId);
    const pgTurns = isPostgresConfigured() ? await pgGetChatArchive(chatId) : [];
    const fallbackTurns = chatMemories[chatId]?.turns || [];
    const combined = [...pgTurns, ...localTurns, ...fallbackTurns];
    const seen = new Set<string>();
    const merged = combined
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .filter((t) => {
        const key = `${t.role}|${t.text.trim()}|${(t.timestamp || '').slice(0, 16)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    res.json({
      chatId,
      totalArchived: merged.length,
      turns: merged,
    });
  });

  app.delete('/api/memories/:chatId', (req, res) => {
    const chatId = req.params.chatId;
    delete chatMemories[chatId];
    clearArchiveTurns(chatId);
    persistMemories();
    void adminDeleteDocument('chat_memories', chatId);
    void pgDeleteChatMemory(chatId);
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
      void pgSaveNote(activeCloudOwnerId, updated);
    }
    res.json({ notes: inboxNotes });
  });

  app.delete('/api/notes/:id', (req, res) => {
    const id = req.params.id;
    inboxNotes = inboxNotes.filter((n) => n.id !== id);
    persistNotes();
    void adminDeleteDocument('inbox_notes', id);
    void pgDeleteNote(id);
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

        if (command === 'groupai') {
          if (!isGroup) {
            res.json({
              deleted: false,
              reply: '⚠️ The *.groupai* command can only be used inside WhatsApp groups.',
              ruleTriggered: 'GROUP_AI_PRIVATE_REJECTED',
              config: botConfig,
            });
            return;
          }
          const sub = argsText.toLowerCase().trim();
          if (sub === 'on') {
            botConfig.groupAiEnabled = true;
            botConfig.groupAiGroups[groupJid] = true;
            persistConfig();
            res.json({
              deleted: false,
              reply: `✅ *Group AI Clone is now ON* for this group (${botConfig.groupAiMode}).`,
              ruleTriggered: 'GROUP_AI_ENABLED',
              config: botConfig,
            });
            return;
          }
          if (sub === 'off') {
            botConfig.groupAiGroups[groupJid] = false;
            persistConfig();
            res.json({
              deleted: false,
              reply: '🛑 *Group AI Clone is now OFF* for this group.',
              ruleTriggered: 'GROUP_AI_DISABLED',
              config: botConfig,
            });
            return;
          }
          res.json({
            deleted: false,
            reply: `🎭 *Group AI Clone Status:* ${botConfig.groupAiEnabled && botConfig.groupAiGroups[groupJid] ? 'ON' : 'OFF'} (Mode: ${botConfig.groupAiMode})`,
            ruleTriggered: 'GROUP_AI_STATUS',
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
              `*${PREFIX}groupai on/off* — Enable Group AI Clone`,
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

      // 3A. Group AI Clone Simulator Evaluation
      if (isGroup && botConfig.groupAiEnabled && botConfig.groupAiGroups[groupJid] === true) {
        const decision = await runGroupCloneTurn({
          groupJid,
          groupName: 'Simulator Group',
          senderName: contactName || 'Friend',
          incomingText: text,
          isDirectlyAddressed: text.includes('@') || text.toLowerCase().includes((botConfig.ownerName || '').toLowerCase()),
          canTextReply: true,
        });
        res.json({
          deleted: false,
          reply: decision.replyText || null,
          reactionEmoji: decision.reactionEmoji || undefined,
          groupAction: decision.action,
          note: `Group Clone Action: ${decision.action}${decision.reactionEmoji ? ` (${decision.reactionEmoji})` : ''} — ${decision.reason}`,
          detectedDistrict: decision.detectedDistrict,
          providerUsed: decision.providerUsed,
          ruleTriggered: `GROUP_CLONE_${decision.action.toUpperCase()}`,
          config: botConfig,
        });
        return;
      }

      // 3B. Automated Private Inbox Assistant
      if (botConfig.autoreply) {
        if (chatType === 'private') {
          const {
            replyText,
            detectedDistrict,
            noteCreated,
            usedFallback,
            providerUsed,
            keySlotUsed,
            fallbackReason,
          } = await runExecutiveAssistantTurn({
            contactJid,
            contactName,
            incomingText: text,
          });
          const simSummary =
            providerUsed === 'openrouter'
              ? `OpenRouter Failover (${detectedDistrict})`
              : usedFallback || providerUsed === 'offline_emotion'
                ? `Offline Emotion Engine (${fallbackReason || 'Fallback'})`
                : `Replied (Gemini Key #${keySlotUsed || 1} · ${detectedDistrict})`;
          pushLog('autoreply', 'Simulator DM', simSummary, usedFallback ? 'info' : 'success');
          res.json({
            deleted: false,
            reply: replyText,
            detectedDistrict,
            noteCreated,
            usedFallback,
            providerUsed,
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
            note: 'Private auto-reply skipped in group. Enable Group AI Clone for this Group JID or run .groupai on to test Group Clone behavior.',
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
      openRouter: openRouterReader.getStats(),
      postgres: getPostgresStatus(),
      clientBots: clientBotManager.getSummaryCounts(),
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

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

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

    // Initialize Zero-AI Multi-Number Client Bots independently after primary boot
    void clientBotManager.init();
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

    clientBotManager.shutdown();
    void pgClosePool();
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
