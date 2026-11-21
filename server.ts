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
import type { Contact, GroupMetadata, GroupParticipant, proto, WAMessage, WASocket } from '@whiskeysockets/baileys';
import {
  DEFAULT_FIRST_GREETING,
  DEFAULT_OWNER_BIO,
  DEFAULT_OWNER_BOUNDARIES,
  DEFAULT_STRICT_LOGIC_RULES,
  STARTER_REGIONAL_DICTIONARY,
  findMatchingGroupTarget,
  findRelevantDictionaryEntries,
  generateDirectCommandText,
  generateExecutiveAssistantReply,
  generateGroupCloneAction,
  generateZeroTokenHoldReply,
  parseUploadedDictionary,
  sanitizeId,
  type AssistantTone,
  type ChatMemoryRecord,
  type ChatTurn,
  type ContactPolicyEntry,
  type ContactPolicyMode,
  type DictionaryEntry,
  type GroupAiMode,
  type GroupCloneResult,
  type GroupDirectiveConfig,
  type GroupMemberTargetDirective,
  type InboxNoteRecord,
  type StoryWhitelistContact,
} from './server/assistantEngine.ts';
import {
  redactSecretsInText,
  runZeroTokenSelfChatCopilot,
  type SelfChatPendingDraft,
  type SelfChatTurnItem,
} from './server/selfChatCopilot.ts';
import {
  registerWebOutreachRoutes,
  type WebOutreachController,
} from './server/webResearchOutreach.ts';
import { GeminiKeyPool } from './server/geminiKeyPool.ts';
import { OpenRouterReader } from './server/openRouterReader.ts';
import { TokenTelemetryTracker } from './server/tokenTelemetry.ts';
import { buildZeroTokenMemorySummary } from './server/localMemorySummarizer.ts';
import {
  analyzeSimulatedMediaZeroToken,
  generateZeroTokenMediaReply,
  readMediaMessageZeroToken,
  unwrapBaileysMessageContent,
  type MediaInsight,
  type SimulatedMediaInput,
} from './server/mediaReader.ts';
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
  getFirestoreAdminDiagnostics,
} from './server/firestoreAdmin.ts';
import {
  AutonomousAgentEngine,
  registerAutonomousAgentRoutes,
} from './server/autonomousAgent.ts';
import {
  MobileOffloadQueueManager,
  registerMobileOffloadRoutes,
} from './server/mobileOffloadQueue.ts';
import {
  SelfHealingWatchdog,
  repairCorruptJsonFiles,
} from './server/selfHealingWatchdog.ts';
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
import {
  TelegramBotController,
  getTelegramBotToken,
  registerTelegramRoutes,
} from './server/telegramBot.ts';

const PORT = Number(process.env.PORT || (process.env.SPACE_ID || process.env.SPACE_HOST ? 7860 : 3000));
const PREFIX = '.';
const AUTH_DIR = path.resolve(process.env.AUTH_DIR || './auth_info_baileys');
const CONFIG_FILE = path.resolve('./bot-config.json');
const DICTIONARY_FILE = path.resolve('./bot-dictionary.json');
const MEMORIES_FILE = path.resolve('./bot-memories.json');
const NOTES_FILE = path.resolve('./bot-notes.json');
const GROUP_MEMBERS_FILE = path.resolve('./bot-group-members.json');
const CONTACTS_FILE = path.resolve('./bot-contacts.json');
const STORIES_FILE = path.resolve('./bot-stories.json');
const SELF_CHAT_FILE = path.resolve('./bot-self-chat.json');
const BOT_SOURCE_DIR = path.resolve('./bot');

export const BENGALI_AUTOREPLY_TEXT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';

interface KnownGroupMemberRecord {
  jid: string;
  lid?: string;
  phone: string;
  name: string;
  isAdmin: boolean;
}

interface KnownContactRecord {
  jid?: string;
  lid?: string;
  phone: string;
  name: string;
  updatedAt: string;
}

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
  groupDirectives: Record<string, GroupDirectiveConfig>;
  mediaIntelligenceEnabled: boolean;
  mediaZeroTokenReplyMode: boolean;
  storyAutoReadEnabled: boolean;
  storyAutoReactEnabled: boolean;
  storyAutoReplyEnabled: boolean;
  storyCooldownMs: number;
  storyWhitelistMode: 'all' | 'selected_only';
  storyAllowedContacts: StoryWhitelistContact[];
  selfChatCopilotEnabled: boolean;
  selfChatZeroTokenOnly: boolean;
  contactPolicies: ContactPolicyEntry[];
  configUpdatedAt: string;
}

interface DirectCommandLogItem {
  id: string;
  timestamp: string;
  actionType: 'dm_knock' | 'group_mention';
  targetLabel: string;
  targetJid: string;
  mentionedJids: string[];
  instruction: string;
  messageSent: string;
  deliveredLive: boolean;
  usedAi: boolean;
  providerUsed: string;
}

interface MediaStoryFeedItem {
  id: string;
  timestamp: string;
  source: 'story' | 'dm' | 'group' | 'simulator';
  senderName: string;
  senderJid: string;
  kind: MediaInsight['kind'];
  sentiment: MediaInsight['sentiment'];
  banglaSceneLabel: string;
  compactContextLine: string;
  reactionSent: string;
  replySent: string;
  tokensUsedForRead: 0;
  replyMode: 'zero_token' | 'hybrid_text_ai' | 'read_only';
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
  chatType: 'private' | 'group_bot_admin' | 'group_bot_non_admin' | 'self' | 'story';
  senderIsGroupAdmin?: boolean;
  groupJid?: string;
  contactJid?: string;
  contactName?: string;
  senderJid?: string;
  media?: SimulatedMediaInput;
}

// ----------------------------------------------------------------------------
// Server-Side Dual-AI Engines: 5-Key Gemini Responder + OpenRouter Reader
// ----------------------------------------------------------------------------
const geminiPool = new GeminiKeyPool();
const openRouterReader = new OpenRouterReader();
const tokenTelemetry = new TokenTelemetryTracker('./bot-token-usage.json');

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
    groupDirectives: {},
    mediaIntelligenceEnabled: true,
    mediaZeroTokenReplyMode: true,
    storyAutoReadEnabled: true,
    storyAutoReactEnabled: true,
    storyAutoReplyEnabled: true,
    storyCooldownMs: 15 * 60 * 1000,
    storyWhitelistMode: 'all',
    storyAllowedContacts: [],
    selfChatCopilotEnabled: true,
    selfChatZeroTokenOnly: true,
    contactPolicies: [],
    configUpdatedAt: '',
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

function normalizeGroupDirectives(raw: unknown): Record<string, GroupDirectiveConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, GroupDirectiveConfig> = {};
  for (const [jid, val] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (!jid || !val || typeof val !== 'object') continue;
    const item = val as Partial<GroupDirectiveConfig>;
    const groupPrompt = typeof item.groupPrompt === 'string' ? item.groupPrompt.slice(0, 3000) : '';
    const targetsRaw = Array.isArray(item.targets) ? item.targets : [];
    const targets: GroupMemberTargetDirective[] = [];
    for (const t of targetsRaw.slice(0, 50)) {
      if (!t || typeof t !== 'object') continue;
      const targetObj = t as Partial<GroupMemberTargetDirective>;
      const targetName = String(targetObj.targetName || '').trim().slice(0, 120);
      const targetJid = String(targetObj.targetJid || '').trim().slice(0, 128);
      const targetPhone = String(targetObj.targetPhone || '').replace(/\D/g, '').slice(0, 24);
      const objective = String(targetObj.objective || '').trim().slice(0, 1500);
      if (!objective || (!targetName && !targetJid && !targetPhone)) continue;
      targets.push({
        id:
          typeof targetObj.id === 'string' && targetObj.id.trim()
            ? targetObj.id.trim().slice(0, 64)
            : sanitizeId(`tgt_${Date.now()}_${targets.length}`),
        targetJid,
        targetPhone,
        targetName: targetName || (targetPhone ? `+${targetPhone}` : targetJid.split('@')[0]),
        objective,
        enabled: targetObj.enabled !== false,
      });
    }
    if (groupPrompt.trim() || targets.length > 0) {
      result[jid] = { groupPrompt, targets };
    }
  }
  return result;
}

function normalizePhoneForWa(rawPhone: string | undefined | null): string {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (/^01[3-9]\d{8}$/.test(digits)) {
    return `88${digits}`;
  }
  if (/^1[3-9]\d{8}$/.test(digits)) {
    return `880${digits}`;
  }
  return digits.slice(0, 15);
}

function normalizeStoryAllowedContacts(raw: unknown): StoryWhitelistContact[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryWhitelistContact[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<StoryWhitelistContact>;
    const name = String(obj.name || '').trim().slice(0, 120);
    const phone = normalizePhoneForWa(obj.phone || obj.jid);
    const rawJid = String(obj.jid || '').trim().slice(0, 128);
    const jid = rawJid || (phone ? `${phone}@s.whatsapp.net` : '');
    const customPrompt = typeof obj.customPrompt === 'string' ? obj.customPrompt.trim().slice(0, 500) : '';
    if (!name && !phone && !jid) continue;
    const dedupeKey = phone ? `pn:${phone}` : jid ? `jid:${jid}` : `name:${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      id:
        typeof obj.id === 'string' && obj.id.trim()
          ? obj.id.trim().slice(0, 64)
          : sanitizeId(`story_wl_${Date.now()}_${out.length}`),
      name: name || (phone ? `+${phone}` : jid.split('@')[0]),
      phone,
      jid: jid || undefined,
      customPrompt: customPrompt || undefined,
      enabled: obj.enabled !== false,
    });
  }
  return out;
}

function normalizeContactPolicies(raw: unknown): ContactPolicyEntry[] {
  if (!Array.isArray(raw)) return [];
  const validModes: ContactPolicyMode[] = ['normal', 'long_engage', 'hold_wait', 'mute_ai'];
  const out: ContactPolicyEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Partial<ContactPolicyEntry>;
    const mode: ContactPolicyMode = validModes.includes(obj.mode as ContactPolicyMode)
      ? (obj.mode as ContactPolicyMode)
      : 'normal';
    const name = String(obj.name || '').trim().slice(0, 120);
    const phone = normalizePhoneForWa(obj.phone || obj.jid);
    const rawJid = String(obj.jid || '').trim().slice(0, 128);
    const jid = rawJid || (phone ? `${phone}@s.whatsapp.net` : '');
    const note = typeof obj.note === 'string' ? obj.note.trim().slice(0, 240) : '';
    if (!name && !phone && !jid) continue;
    const dedupeKey = phone ? `pn:${phone}` : jid ? `jid:${jid}` : `name:${name.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      id:
        typeof obj.id === 'string' && obj.id.trim()
          ? obj.id.trim().slice(0, 64)
          : sanitizeId(`cpol_${Date.now()}_${out.length}`),
      name: name || (phone ? `+${phone}` : jid.split('@')[0]),
      phone,
      jid: jid || undefined,
      mode,
      note: note || undefined,
      updatedAt: typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : new Date().toISOString(),
    });
  }
  return out;
}

function parseConfigTimestampMs(raw: unknown): number {
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : 0;
  }
  if (raw && typeof (raw as { toDate?: () => Date }).toDate === 'function') {
    const ms = (raw as { toDate: () => Date }).toDate().getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
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
    groupDirectives: normalizeGroupDirectives(raw.groupDirectives),
    mediaIntelligenceEnabled:
      typeof raw.mediaIntelligenceEnabled === 'boolean'
        ? raw.mediaIntelligenceEnabled
        : base.mediaIntelligenceEnabled,
    mediaZeroTokenReplyMode:
      typeof raw.mediaZeroTokenReplyMode === 'boolean'
        ? raw.mediaZeroTokenReplyMode
        : base.mediaZeroTokenReplyMode,
    storyAutoReadEnabled:
      typeof raw.storyAutoReadEnabled === 'boolean'
        ? raw.storyAutoReadEnabled
        : base.storyAutoReadEnabled,
    storyAutoReactEnabled:
      typeof raw.storyAutoReactEnabled === 'boolean'
        ? raw.storyAutoReactEnabled
        : base.storyAutoReactEnabled,
    storyAutoReplyEnabled:
      typeof raw.storyAutoReplyEnabled === 'boolean'
        ? raw.storyAutoReplyEnabled
        : base.storyAutoReplyEnabled,
    storyCooldownMs:
      typeof raw.storyCooldownMs === 'number' && raw.storyCooldownMs >= 0
        ? Math.min(86_400_000, raw.storyCooldownMs)
        : base.storyCooldownMs,
    storyWhitelistMode: raw.storyWhitelistMode === 'selected_only' ? 'selected_only' : 'all',
    storyAllowedContacts: normalizeStoryAllowedContacts(raw.storyAllowedContacts),
    selfChatCopilotEnabled:
      typeof raw.selfChatCopilotEnabled === 'boolean'
        ? raw.selfChatCopilotEnabled
        : base.selfChatCopilotEnabled,
    selfChatZeroTokenOnly:
      typeof raw.selfChatZeroTokenOnly === 'boolean'
        ? raw.selfChatZeroTokenOnly
        : base.selfChatZeroTokenOnly,
    contactPolicies: normalizeContactPolicies(raw.contactPolicies),
    configUpdatedAt: typeof raw.configUpdatedAt === 'string' ? raw.configUpdatedAt : base.configUpdatedAt,
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
let knownGroupMembers: Record<string, Record<string, KnownGroupMemberRecord>> = loadJsonFile<
  Record<string, Record<string, KnownGroupMemberRecord>>
>(GROUP_MEMBERS_FILE, {});
let knownContacts: Record<string, KnownContactRecord> = loadJsonFile<Record<string, KnownContactRecord>>(
  CONTACTS_FILE,
  {}
);
let recentMediaStories: MediaStoryFeedItem[] = loadJsonFile<MediaStoryFeedItem[]>(
  STORIES_FILE,
  []
).slice(0, 60);
let selfChatHistory: SelfChatTurnItem[] = loadJsonFile<SelfChatTurnItem[]>(
  SELF_CHAT_FILE,
  []
).slice(-25);
let pendingSelfChatDraft: SelfChatPendingDraft | null = null;
let outreachController: WebOutreachController | null = null;
const mobileOffloadQueue = new MobileOffloadQueueManager();
let autonomousAgentEngine: AutonomousAgentEngine | null = null;
let selfHealingWatchdog: SelfHealingWatchdog | null = null;
let getRuntimeSelfPingSnapshot: () => {
  enabled: boolean;
  targetUrl: string;
  lastPingAt: string | null;
  lastPingOk: boolean | null;
} = () => ({ enabled: true, targetUrl: '', lastPingAt: null, lastPingOk: null });
const processedSelfMsgIds = new Map<string, number>();
const recentSelfBotTextCache = new Map<string, number>();
const recentDirectCommands: DirectCommandLogItem[] = [];
const lidToPhoneCache = new Map<string, string>();
const phoneToLidCache = new Map<string, string>();
let activeCloudOwnerId: string = process.env.FIREBASE_OWNER_UID || 'server_admin';

function isPhoneJid(jid: string | undefined | null): boolean {
  if (!jid) return false;
  const lower = jid.toLowerCase();
  return lower.endsWith('@s.whatsapp.net') || lower.endsWith('@c.us');
}

function isLidJid(jid: string | undefined | null): boolean {
  if (!jid) return false;
  return jid.toLowerCase().endsWith('@lid');
}

function extractPhoneDigitsOnly(jidOrPhone: string | undefined | null): string {
  if (!jidOrPhone) return '';
  const trimmed = String(jidOrPhone).trim();
  if (trimmed.includes('@')) {
    if (!isPhoneJid(trimmed)) return '';
    return extractDigits(trimmed);
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return digits;
}

function isDefaultNumericLabel(label: string | undefined | null): boolean {
  if (!label) return true;
  const trimmed = label.trim();
  return !trimmed || /^\+?\d{5,}$/.test(trimmed) || /^Member(?:\s+\(LID|\s+•)/i.test(trimmed);
}

function rebuildContactIndexes() {
  for (const rec of Object.values(knownContacts)) {
    const lidDigits = extractDigits(rec.lid);
    const pnDigits = extractPhoneDigitsOnly(rec.phone || rec.jid);
    if (lidDigits && pnDigits) {
      lidToPhoneCache.set(lidDigits, pnDigits);
      phoneToLidCache.set(pnDigits, lidDigits);
    }
  }
}

function sanitizeKnownGroupMembersOnBoot() {
  let dirty = false;
  for (const [groupJid, bucket] of Object.entries(knownGroupMembers)) {
    if (!bucket || typeof bucket !== 'object') {
      delete knownGroupMembers[groupJid];
      dirty = true;
      continue;
    }
    for (const [key, rec] of Object.entries(bucket)) {
      const cleanJid = (rec.jid || '').split(':')[0];
      const cleanLid = rec.lid ? rec.lid.split(':')[0] : isLidJid(cleanJid) ? cleanJid : undefined;
      const lidDigits = extractDigits(cleanLid);
      const cachedPn = lidDigits ? lidToPhoneCache.get(lidDigits) : undefined;
      const rawPhone = (rec.phone || '').replace(/\D/g, '');

      // Never treat an opaque @lid ID as a real phone number
      const isFakeLidPhone =
        Boolean(rawPhone) &&
        ((lidDigits && rawPhone === lidDigits && !isPhoneJid(cleanJid)) ||
          (isLidJid(cleanJid) && rawPhone === extractDigits(cleanJid)));

      const verifiedPhone = cachedPn || (isFakeLidPhone ? '' : extractPhoneDigitsOnly(isPhoneJid(cleanJid) ? cleanJid : rawPhone));
      const cleanName = (rec.name || '').trim();
      const nameIsFakeLidNumber =
        Boolean(cleanName) &&
        lidDigits &&
        cleanName.replace(/\D/g, '') === lidDigits &&
        !verifiedPhone;

      const nextRec: KnownGroupMemberRecord = {
        jid: verifiedPhone ? `${verifiedPhone}@s.whatsapp.net` : cleanJid,
        lid: cleanLid,
        phone: verifiedPhone,
        name: nameIsFakeLidNumber
          ? `Member • ${lidDigits.slice(-4)}`
          : cleanName || (verifiedPhone ? `+${verifiedPhone}` : lidDigits ? `Member • ${lidDigits.slice(-4)}` : 'Member'),
        isAdmin: Boolean(rec.isAdmin),
      };
      if (
        nextRec.jid !== rec.jid ||
        nextRec.phone !== rec.phone ||
        nextRec.name !== rec.name ||
        nextRec.lid !== rec.lid
      ) {
        bucket[key] = nextRec;
        dirty = true;
      }
    }
  }
  if (dirty) {
    scheduleSaveGroupMembers();
  }
}

rebuildContactIndexes();
sanitizeKnownGroupMembersOnBoot();

const clientBotManager = new ClientBotManager({
  getOwnerId: () => activeCloudOwnerId,
  onEvent: (summary, outcome) => pushLog('system', 'Client Bots', summary, outcome || 'info'),
});

let contactsSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveContacts() {
  if (contactsSaveTimer) return;
  contactsSaveTimer = setTimeout(() => {
    contactsSaveTimer = null;
    saveJsonFileAsync(CONTACTS_FILE, knownContacts);
  }, 1500);
  contactsSaveTimer.unref?.();
}

let groupMembersSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveGroupMembers() {
  if (groupMembersSaveTimer) return;
  groupMembersSaveTimer = setTimeout(() => {
    groupMembersSaveTimer = null;
    saveJsonFileAsync(GROUP_MEMBERS_FILE, knownGroupMembers);
  }, 1500);
  groupMembersSaveTimer.unref?.();
}

function findContactForIdentity(params: { jid?: string; lid?: string; phone?: string }): KnownContactRecord | null {
  const pnDigits =
    extractPhoneDigitsOnly(params.phone) ||
    extractPhoneDigitsOnly(isPhoneJid(params.jid) ? params.jid : '');
  const lidDigits = extractDigits(params.lid || (isLidJid(params.jid) ? params.jid : ''));
  const mappedPn = !pnDigits && lidDigits ? lidToPhoneCache.get(lidDigits) : undefined;
  const resolvedPn = pnDigits || mappedPn || '';

  if (resolvedPn && knownContacts[`pn:${resolvedPn}`]) {
    return knownContacts[`pn:${resolvedPn}`];
  }
  if (lidDigits && knownContacts[`lid:${lidDigits}`]) {
    return knownContacts[`lid:${lidDigits}`];
  }
  return null;
}

function upsertContactRecord(input: {
  id?: string;
  lid?: string;
  phoneNumber?: string;
  pn?: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}): KnownContactRecord | null {
  const rawId = (input.id || '').split(':')[0];
  const rawLid = (input.lid || (isLidJid(rawId) ? rawId : '')).split(':')[0];
  const pnCandidate = input.phoneNumber || input.pn || (isPhoneJid(rawId) ? rawId : '');
  const phone = extractPhoneDigitsOnly(pnCandidate);
  const lidDigits = extractDigits(rawLid);

  if (!phone && !lidDigits) return null;

  if (lidDigits && phone) {
    lidToPhoneCache.set(lidDigits, phone);
    phoneToLidCache.set(phone, lidDigits);
  }

  const resolvedPn = phone || (lidDigits ? lidToPhoneCache.get(lidDigits) || '' : '');
  const primaryKey = resolvedPn ? `pn:${resolvedPn}` : `lid:${lidDigits}`;
  const lidBucketKey = lidDigits ? `lid:${lidDigits}` : '';

  const existingPrimary = knownContacts[primaryKey];
  const existingLidOnly = lidBucketKey && lidBucketKey !== primaryKey ? knownContacts[lidBucketKey] : undefined;
  const existing = existingPrimary || existingLidOnly;

  const candidateNames = [input.name, input.verifiedName, input.notify]
    .map((v) => (v || '').trim())
    .filter((v) => Boolean(v) && !isDefaultNumericLabel(v));
  const bestName =
    candidateNames[0] ||
    (existing?.name && !isDefaultNumericLabel(existing.name) ? existing.name : '') ||
    (resolvedPn ? `+${resolvedPn}` : '');

  const record: KnownContactRecord = {
    jid: resolvedPn ? `${resolvedPn}@s.whatsapp.net` : existing?.jid,
    lid: rawLid || (phone && phoneToLidCache.get(phone) ? `${phoneToLidCache.get(phone)}@lid` : existing?.lid),
    phone: resolvedPn || existing?.phone || '',
    name: bestName || existing?.name || '',
    updatedAt: new Date().toISOString(),
  };

  knownContacts[primaryKey] = record;
  if (existingLidOnly && lidBucketKey !== primaryKey) {
    delete knownContacts[lidBucketKey];
  }

  // Retroactively enrich any cached group member entry matching this contact
  let membersUpdated = false;
  for (const bucket of Object.values(knownGroupMembers)) {
    for (const [mKey, m] of Object.entries(bucket)) {
      const mLidDigits = extractDigits(m.lid || (isLidJid(m.jid) ? m.jid : ''));
      const mPnDigits = extractPhoneDigitsOnly(m.phone || (isPhoneJid(m.jid) ? m.jid : ''));
      const matchesLid = Boolean(lidDigits && mLidDigits && lidDigits === mLidDigits);
      const matchesPn = Boolean(resolvedPn && mPnDigits && resolvedPn === mPnDigits);
      if (matchesLid || matchesPn) {
        const nextPhone = resolvedPn || m.phone;
        const nextName =
          record.name && !isDefaultNumericLabel(record.name)
            ? record.name
            : m.name && !isDefaultNumericLabel(m.name)
              ? m.name
              : nextPhone
                ? `+${nextPhone}`
                : m.name;
        const nextJid = nextPhone ? `${nextPhone}@s.whatsapp.net` : m.jid;
        if (nextPhone !== m.phone || nextName !== m.name || nextJid !== m.jid || (record.lid && record.lid !== m.lid)) {
          bucket[mKey] = {
            ...m,
            jid: nextJid,
            lid: m.lid || record.lid,
            phone: nextPhone,
            name: nextName,
          };
          membersUpdated = true;
        }
      }
    }
  }

  scheduleSaveContacts();
  if (membersUpdated) {
    scheduleSaveGroupMembers();
  }
  return record;
}

function upsertGroupMemberRecord(groupJid: string, member: Partial<KnownGroupMemberRecord> & { jid: string }) {
  if (!groupJid || !member.jid) return;
  const cleanJid = member.jid.split(':')[0];
  const cleanLid = (member.lid || (isLidJid(cleanJid) ? cleanJid : '')).split(':')[0] || undefined;
  const lidDigits = extractDigits(cleanLid);

  let phone = extractPhoneDigitsOnly(member.phone) || extractPhoneDigitsOnly(isPhoneJid(cleanJid) ? cleanJid : '');
  if (!phone && lidDigits) {
    phone = lidToPhoneCache.get(lidDigits) || '';
  }
  if (phone && lidDigits) {
    lidToPhoneCache.set(lidDigits, phone);
    phoneToLidCache.set(phone, lidDigits);
  }

  const contact = findContactForIdentity({ jid: cleanJid, lid: cleanLid, phone });
  if (!phone && contact?.phone) {
    phone = contact.phone;
  }

  const bucket = (knownGroupMembers[groupJid] ||= {});
  const key = phone || (lidDigits ? `lid:${lidDigits}` : cleanJid);
  const lidFallbackKey = lidDigits ? `lid:${lidDigits}` : '';

  const existing =
    bucket[key] ||
    (lidFallbackKey && bucket[lidFallbackKey]) ||
    (lidDigits ? bucket[lidDigits] : undefined);

  // Clean up duplicate old LID-keyed entries once resolved to a real phone key
  if (phone) {
    if (lidFallbackKey && lidFallbackKey !== key && bucket[lidFallbackKey]) delete bucket[lidFallbackKey];
    if (lidDigits && lidDigits !== key && bucket[lidDigits]) delete bucket[lidDigits];
  }

  const incomingName = (member.name || '').trim();
  const contactName = (contact?.name || '').trim();
  const existingName = (existing?.name || '').trim();

  const resolvedName =
    (!isDefaultNumericLabel(contactName) ? contactName : '') ||
    (!isDefaultNumericLabel(incomingName) ? incomingName : '') ||
    (!isDefaultNumericLabel(existingName) ? existingName : '') ||
    (phone ? `+${phone}` : lidDigits ? `Member • ${lidDigits.slice(-4)}` : 'Member');

  const resolvedJid = phone
    ? `${phone}@s.whatsapp.net`
    : existing?.jid && isPhoneJid(existing.jid)
      ? existing.jid
      : cleanJid;

  bucket[key] = {
    jid: resolvedJid,
    lid: cleanLid || existing?.lid || contact?.lid,
    phone: phone || existing?.phone || '',
    name: resolvedName,
    isAdmin: member.isAdmin ?? existing?.isAdmin ?? false,
  };
  scheduleSaveGroupMembers();
}

async function resolveLidToPnDigits(sock: WASocket | null | undefined, lidJid: string): Promise<string> {
  if (!lidJid) return '';
  const lidDigits = extractDigits(lidJid);
  if (!lidDigits) return '';
  const cached = lidToPhoneCache.get(lidDigits);
  if (cached) return cached;

  const lidMapping = (
    sock as unknown as {
      signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } };
    } | null | undefined
  )?.signalRepository?.lidMapping;

  if (lidMapping && typeof lidMapping.getPNForLID === 'function') {
    try {
      const normalizedLid = lidJid.includes('@') ? lidJid.split(':')[0] : `${lidDigits}@lid`;
      const pnRaw = await withTimeout(
        Promise.resolve(lidMapping.getPNForLID(normalizedLid)),
        350,
        'Baileys getPNForLID'
      ).catch(() => null);
      const pnDigits = extractPhoneDigitsOnly(pnRaw);
      if (pnDigits) {
        lidToPhoneCache.set(lidDigits, pnDigits);
        phoneToLidCache.set(pnDigits, lidDigits);
        return pnDigits;
      }
    } catch {
      // ignore mapping miss
    }
  }
  return '';
}

async function recordParticipantsFromMetadataAsync(
  sock: WASocket | null | undefined,
  groupJid: string,
  metadata: GroupMetadata | null | undefined
) {
  if (!groupJid || !metadata || !Array.isArray(metadata.participants)) return;
  for (const p of metadata.participants as Array<
    GroupParticipant & { lid?: string; phoneNumber?: string; notify?: string; name?: string }
  >) {
    const rawId = (p.id || '').split(':')[0];
    const rawLid = (p.lid || (isLidJid(rawId) ? rawId : '')).split(':')[0];
    const rawPhoneJid = p.phoneNumber || (isPhoneJid(rawId) ? rawId : '');
    let phoneDigits = extractPhoneDigitsOnly(rawPhoneJid);
    if (!phoneDigits && rawLid && sock) {
      phoneDigits = await resolveLidToPnDigits(sock, rawLid);
    }

    const primaryJid = phoneDigits ? `${phoneDigits}@s.whatsapp.net` : rawId;
    const rawNotify = (p.notify || p.name || '').trim();

    if (phoneDigits && (rawLid || rawNotify)) {
      upsertContactRecord({
        id: primaryJid,
        lid: rawLid || undefined,
        phoneNumber: primaryJid,
        name: p.name,
        notify: p.notify,
      });
    }

    upsertGroupMemberRecord(groupJid, {
      jid: primaryJid,
      lid: rawLid || undefined,
      phone: phoneDigits,
      name: rawNotify,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
    });
  }
}

async function persistConfigAsync(stampNow = true): Promise<void> {
  if (stampNow || !botConfig.configUpdatedAt) {
    botConfig.configUpdatedAt = new Date().toISOString();
  }
  saveJsonFile(CONFIG_FILE, botConfig);
  await Promise.allSettled([
    withTimeout(
      adminSaveDocument('bot_settings', 'primary', {
        ownerId: activeCloudOwnerId,
        ...botConfig,
      }),
      2_500,
      'Firestore settings write'
    ),
    withTimeout(
      pgSaveSettings(activeCloudOwnerId, botConfig as unknown as Record<string, unknown>),
      2_500,
      'Postgres settings write'
    ),
  ]);
}

function persistConfig(stampNow = true) {
  if (stampNow || !botConfig.configUpdatedAt) {
    botConfig.configUpdatedAt = new Date().toISOString();
  }
  saveJsonFile(CONFIG_FILE, botConfig);
  void adminSaveDocument('bot_settings', 'primary', {
    ownerId: activeCloudOwnerId,
    ...botConfig,
  });
  void pgSaveSettings(activeCloudOwnerId, botConfig as unknown as Record<string, unknown>);
}

function findMatchingStoryWhitelistContact(params: {
  jids?: Array<string | undefined | null>;
  phone?: string;
  names?: Array<string | undefined | null>;
}): StoryWhitelistContact | null {
  const allowed = (botConfig.storyAllowedContacts || []).filter((c) => c.enabled !== false);
  if (allowed.length === 0) return null;

  const candidateJids = new Set(
    (params.jids || [])
      .map((j) => (j || '').split(':')[0].trim().toLowerCase())
      .filter(Boolean)
  );
  const candidatePhone = normalizePhoneForWa(params.phone);
  const candidateNames = (params.names || [])
    .map((n) => (n || '').trim().toLowerCase())
    .filter((n) => n.length >= 2 && !isDefaultNumericLabel(n));

  for (const entry of allowed) {
    const entryJid = (entry.jid || '').split(':')[0].trim().toLowerCase();
    if (entryJid && candidateJids.has(entryJid)) {
      return entry;
    }

    const entryPhone = normalizePhoneForWa(entry.phone || entry.jid);
    if (entryPhone && candidatePhone) {
      if (
        entryPhone === candidatePhone ||
        (entryPhone.length >= 10 && candidatePhone.length >= 10 && entryPhone.slice(-10) === candidatePhone.slice(-10))
      ) {
        return entry;
      }
    }

    const entryName = (entry.name || '').trim().toLowerCase();
    if (entryName.length >= 2 && !isDefaultNumericLabel(entryName)) {
      for (const n of candidateNames) {
        if (
          n === entryName ||
          (entryName.length >= 3 && (n.includes(entryName) || entryName.includes(n)))
        ) {
          return entry;
        }
      }
    }
  }

  return null;
}

function findMatchingContactPolicy(params: {
  jids?: Array<string | undefined | null>;
  phone?: string;
  names?: Array<string | undefined | null>;
}): ContactPolicyEntry | null {
  const list = (botConfig.contactPolicies || []).filter((p) => p.mode && p.mode !== 'normal');
  if (list.length === 0) return null;

  const candidateJids = new Set(
    (params.jids || [])
      .map((j) => (j || '').split(':')[0].trim().toLowerCase())
      .filter(Boolean)
  );
  const candidatePhone = normalizePhoneForWa(params.phone);
  const candidateNames = (params.names || [])
    .map((n) => (n || '').trim().toLowerCase())
    .filter((n) => n.length >= 2 && !isDefaultNumericLabel(n));

  for (const entry of list) {
    const entryJid = (entry.jid || '').split(':')[0].trim().toLowerCase();
    if (entryJid && candidateJids.has(entryJid)) return entry;

    const entryPhone = normalizePhoneForWa(entry.phone || entry.jid);
    if (entryPhone && candidatePhone) {
      if (
        entryPhone === candidatePhone ||
        (entryPhone.length >= 10 && candidatePhone.length >= 10 && entryPhone.slice(-10) === candidatePhone.slice(-10))
      ) {
        return entry;
      }
    }

    const entryName = (entry.name || '').trim().toLowerCase();
    if (entryName.length >= 2 && !isDefaultNumericLabel(entryName)) {
      for (const n of candidateNames) {
        if (n === entryName || (entryName.length >= 3 && (n.includes(entryName) || entryName.includes(n)))) {
          return entry;
        }
      }
    }
  }
  return null;
}

function recordSelfChatTurn(turn: Omit<SelfChatTurnItem, 'id' | 'timestamp'>) {
  selfChatHistory.push({
    id: `sct_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...turn,
    text: redactSecretsInText(turn.text),
  });
  if (selfChatHistory.length > 25) {
    selfChatHistory = selfChatHistory.slice(-25);
  }
  saveJsonFileAsync(SELF_CHAT_FILE, selfChatHistory);
}

function applyCustomPromptHintToInsight(insight: MediaInsight, customPrompt: string): MediaInsight {
  const hint = customPrompt.trim();
  if (!hint) return insight;
  if (/(প্রশংসা|সুন্দর|হ্যান্ডসাম|কিউট|মাশাআল্লাহ|ভালোবাস|লাভ|praise|compliment|cute|love|crush)/iu.test(hint)) {
    return {
      ...insight,
      sentiment: insight.kind === 'photo' || insight.kind === 'video' ? 'praise_portrait' : 'affection_like',
      recommendedReaction: insight.kind === 'photo' ? '😍' : '❤️',
    };
  }
  if (/(ফানি|হাসি|মজা|রোস্ট|funny|roast|joke|meme)/iu.test(hint)) {
    return {
      ...insight,
      sentiment: 'funny_laugh',
      recommendedReaction: '😂',
    };
  }
  if (/(যুক্তি|তর্ক|বুদ্ধি|logic|debate|question)/iu.test(hint)) {
    return {
      ...insight,
      sentiment: 'logical_debate',
      recommendedReaction: '🤔',
    };
  }
  if (/(সমালোচনা|খারাপ|বাজে|critique|roast bad)/iu.test(hint)) {
    return {
      ...insight,
      sentiment: 'bad_critique',
      recommendedReaction: '👀',
    };
  }
  return insight;
}

function collectDirectoryContacts(): Array<{ jid: string; lid?: string; phone: string; name: string }> {
  const byKey = new Map<string, { jid: string; lid?: string; phone: string; name: string }>();

  const upsert = (item: { jid?: string; lid?: string; phone?: string; name?: string }) => {
    const rawJid = (item.jid || '').split(':')[0].trim();
    if (rawJid.endsWith('@g.us') || rawJid.endsWith('@broadcast')) return;
    const phone = normalizePhoneForWa(item.phone || (isPhoneJid(rawJid) ? rawJid : ''));
    const lid = item.lid ? item.lid.split(':')[0] : isLidJid(rawJid) ? rawJid : undefined;
    const jid = phone ? `${phone}@s.whatsapp.net` : rawJid;
    if (!jid) return;

    const key = phone ? `pn:${phone}` : `jid:${jid}`;
    const existing = byKey.get(key);
    const cleanName = (item.name || '').trim();
    const resolvedName =
      cleanName && !isDefaultNumericLabel(cleanName)
        ? cleanName
        : existing?.name && !isDefaultNumericLabel(existing.name)
          ? existing.name
          : phone
            ? `+${phone}`
            : lid
              ? `Member • ${extractDigits(lid).slice(-4)}`
              : jid.split('@')[0];

    byKey.set(key, {
      jid,
      lid: lid || existing?.lid,
      phone: phone || existing?.phone || '',
      name: resolvedName,
    });
  };

  for (const c of Object.values(knownContacts)) {
    upsert(c);
  }
  for (const bucket of Object.values(knownGroupMembers)) {
    for (const m of Object.values(bucket)) {
      upsert(m);
    }
  }
  for (const mem of Object.values(chatMemories)) {
    if (mem.contactJid && !mem.contactJid.endsWith('@g.us') && !mem.contactJid.endsWith('@broadcast')) {
      upsert({
        jid: mem.contactJid,
        phone: extractPhoneDigitsOnly(mem.contactJid),
        name: mem.contactName,
      });
    }
  }

  return Array.from(byKey.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
}

function collectAllKnownGroupSummaries(): Array<{ jid: string; name: string }> {
  const byJid = new Map<string, string>();
  const add = (jid: string, name?: string) => {
    if (!jid || !jid.endsWith('@g.us')) return;
    const memName = chatMemories[sanitizeId(jid)]?.contactName;
    const best = (name && name !== jid ? name : '') || (memName && memName !== jid ? memName : '') || byJid.get(jid) || jid;
    byJid.set(jid, best);
  };
  for (const jid of Object.keys(botConfig.antilinkGroups || {})) add(jid);
  for (const jid of Object.keys(botConfig.groupAiGroups || {})) add(jid);
  for (const jid of Object.keys(botConfig.groupDirectives || {})) add(jid);
  for (const jid of Object.keys(knownGroupMembers || {})) add(jid);
  for (const mem of Object.values(chatMemories)) {
    if (mem.contactJid?.endsWith('@g.us')) add(mem.contactJid, mem.contactName);
  }
  return Array.from(byJid.entries()).map(([jid, name]) => ({ jid, name }));
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
const storyReplyCooldowns = new Map<string, number>();
const processedStoryIds = new Set<string>();
const ownerTakeoverUntil = new Map<string, number>();
const botSentMessageIds = new Set<string>();
const summaryRefreshInFlight = new Set<string>();
const lastSummaryRefreshAt = new Map<string, number>();

function recordMediaStoryFeedItem(entry: Omit<MediaStoryFeedItem, 'id' | 'timestamp' | 'tokensUsedForRead'>) {
  const item: MediaStoryFeedItem = {
    id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    tokensUsedForRead: 0,
    ...entry,
  };
  recentMediaStories.unshift(item);
  if (recentMediaStories.length > 60) {
    recentMediaStories.length = 60;
  }
  saveJsonFileAsync(STORIES_FILE, recentMediaStories);
}

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

async function executeZeroTokenSelfChatTurn(params: {
  incomingText: string;
  mediaInsight?: MediaInsight | null;
}) {
  const incomingText = params.incomingText.trim();
  const mediaInsight = params.mediaInsight || null;
  const memoryRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

  const directoryContacts = collectDirectoryContacts();
  const knownGroups = collectAllKnownGroupSummaries().map((g) => ({
    jid: g.jid,
    name: g.name,
    members: Object.values(knownGroupMembers[g.jid] || {}).map((m) => ({
      jid: m.jid,
      phone: m.phone,
      name: m.name,
    })),
  }));
  const recentMemories = Object.values(chatMemories)
    .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
    .slice(0, 12);
  const unreadNotes = inboxNotes.filter((n) => !n.resolved).slice(0, 12);

  recordSelfChatTurn({
    role: 'owner',
    text: incomingText || mediaInsight?.compactContextLine || '[Media]',
    mediaKind: mediaInsight?.isMedia ? mediaInsight.kind : undefined,
  });

  const fallbackOutreach: WebOutreachController = {
    getSummary: () => ({
      policy: {
        dailyEmailLimit: 30,
        dailyWhatsappLimit: 20,
        whatsappMinDelayMs: 45000,
        whatsappMaxDelayMs: 90000,
        emailDelayMs: 1800,
        preferredEmailProvider: 'gmail_oauth',
        zeroTokenDraftDefault: true,
        defaultLanguage: 'bn',
        defaultOfferPitch: '',
        crawlContactSubpages: true,
        maxSitesPerSearch: 5,
      },
      stats: { date: new Date().toISOString().slice(0, 10), emailsSentToday: 0, whatsappSentToday: 0 },
      totalLeads: 0,
      verifiedLeadsCount: 0,
      senders: [],
      leads: [],
      recentResearch: [],
      capabilities: {},
    }),
    runResearch: async () => ({
      research: {
        id: 'none',
        query: '',
        providerUsed: 'duckduckgo',
        tokensSpent: 0,
        summary: 'Outreach router not initialized.',
        urls: [],
        emailsFound: 0,
        phonesFound: 0,
        createdAt: new Date().toISOString(),
      },
      leads: [],
      fromCache: false,
    }),
    scrapeUrls: async () => ({
      research: {
        id: 'none',
        query: '',
        providerUsed: 'direct_url',
        tokensSpent: 0,
        summary: 'Outreach router not initialized.',
        urls: [],
        emailsFound: 0,
        phonesFound: 0,
        createdAt: new Date().toISOString(),
      },
      leads: [],
      errors: [],
    }),
    verifyWhatsappLeads: async () => ({ checkedCount: 0, activeFound: 0 }),
    draftMessage: async () => ({ subject: '', body: '', tokensSpent: 0, providerUsed: 'zero_token_template' }),
    addAndActivateEmailSender: ({ email }) => ({
      profile: {
        id: 'none',
        email,
        label: email,
        type: 'smtp_gmail',
        host: 'smtp.gmail.com',
        port: 465,
        active: false,
        hasSecret: false,
        maskedSecret: '****',
        createdAt: new Date().toISOString(),
      },
      deletedCount: 0,
      isLikelyAppPassword: false,
    }),
    switchEmailSender: () => null,
    deleteEmailSender: () => ({ removedCount: 0, remaining: [] }),
    listEmailSenders: () => [],
    sendEmailOutreach: async () => ({ sentCount: 0, failedCount: 0, providerUsed: 'none', results: [] }),
    sendWhatsappOutreach: async () => ({ queued: false, sentCount: 0, totalTargets: 0, skippedMuted: 0 }),
    updatePolicy: () => ({
      dailyEmailLimit: 30,
      dailyWhatsappLimit: 20,
      whatsappMinDelayMs: 45000,
      whatsappMaxDelayMs: 90000,
      emailDelayMs: 1800,
      preferredEmailProvider: 'gmail_oauth',
      zeroTokenDraftDefault: true,
      defaultLanguage: 'bn',
      defaultOfferPitch: '',
      crawlContactSubpages: true,
      maxSitesPerSearch: 5,
    }),
    ingestExternalLead: ({ name, sourceUrl, topic, emails, phones, snippet }) => ({
      id: 'none',
      name: name || 'Lead',
      sourceUrl,
      domain: '',
      topic: topic || '',
      emails: emails || [],
      phones: phones || [],
      whatsappVerifiedPhones: [],
      whatsappCheckedAt: null,
      snippet: snippet || '',
      emailSentCount: 0,
      lastEmailSentAt: null,
      whatsappSentCount: 0,
      lastWhatsappSentAt: null,
      createdAt: new Date().toISOString(),
    }),
    clearLeads: () => 0,
  };

  const copilotRes = await runZeroTokenSelfChatCopilot({
    incomingText,
    mediaInsight,
    botConfig,
    botStatus,
    connectedPhone: currentPairingPhone || extractDigits(currentSocket?.user?.id) || '',
    dailyStats: getDailyReplyStats(),
    memoryRssMb,
    directoryContacts,
    knownGroups,
    recentLogs: eventLogs.slice(0, 25),
    recentMemories,
    unreadNotes,
    activeTakeovers: getActiveTakeovers(),
    selfChatHistory,
    pendingDraft: pendingSelfChatDraft,
    outreach: outreachController || fallbackOutreach,
    dispatchDirectDm: async ({ targets, messageText, originalInstruction }) => {
      let deliveredCount = 0;
      let draftCount = 0;
      const targetLabels: string[] = [];

      for (const target of targets.slice(0, 15)) {
        const targetJid = target.jid || `${normalizePhoneForWa(target.phone)}@s.whatsapp.net`;
        if (!targetJid) continue;
        targetLabels.push(target.name || `+${target.phone}`);
        let sentLive = false;
        if (currentSocket && botStatus === 'connected') {
          try {
            if (botConfig.humanTypingEnabled) {
              void currentSocket.sendPresenceUpdate('composing', targetJid).catch(() => {});
              await sleep(450);
            }
            await sendTrackedMessage(currentSocket, targetJid, { text: messageText });
            sentLive = true;
            deliveredCount += 1;
            dailyReplyCount += 1;
          } finally {
            if (botConfig.humanTypingEnabled) {
              void currentSocket.sendPresenceUpdate('paused', targetJid).catch(() => {});
            }
          }
        } else {
          draftCount += 1;
        }

        await recordZeroTokenMediaExchange({
          chatJid: targetJid,
          displayName: target.name || `+${target.phone}`,
          isGroup: false,
          incomingSummary: `[Self-Chat Direct Command]: ${originalInstruction}`,
          replyText: messageText,
        });

        recentDirectCommands.unshift({
          id: `dcmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          actionType: 'dm_knock',
          targetLabel: target.name || `+${target.phone}`,
          targetJid,
          mentionedJids: [],
          instruction: originalInstruction,
          messageSent: messageText,
          deliveredLive: sentLive,
          usedAi: false,
          providerUsed: 'offline_emotion',
        });
      }
      if (recentDirectCommands.length > 30) recentDirectCommands.length = 30;
      return { deliveredCount, draftCount, targetLabels };
    },
    dispatchGroupMention: async ({ groupJid, groupName, members, messageText, originalInstruction }) => {
      const mentionedJids = members.map((m) => m.jid || `${normalizePhoneForWa(m.phone)}@s.whatsapp.net`).filter(Boolean);
      let deliveredLive = false;
      if (currentSocket && botStatus === 'connected') {
        if (botConfig.humanTypingEnabled) {
          void currentSocket.sendPresenceUpdate('composing', groupJid).catch(() => {});
          await sleep(450);
        }
        try {
          await sendTrackedMessage(currentSocket, groupJid, {
            text: messageText,
            ...(mentionedJids.length > 0 ? { mentions: mentionedJids } : {}),
          });
          deliveredLive = true;
          dailyReplyCount += 1;
        } finally {
          if (botConfig.humanTypingEnabled) {
            void currentSocket.sendPresenceUpdate('paused', groupJid).catch(() => {});
          }
        }
      }
      await recordZeroTokenMediaExchange({
        chatJid: groupJid,
        displayName: groupName,
        isGroup: true,
        senderNameInGroup: botConfig.ownerName || 'Sir',
        incomingSummary: `[Self-Chat Group @Mention]: ${originalInstruction}`,
        replyText: messageText,
      });
      recentDirectCommands.unshift({
        id: `dcmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        actionType: 'group_mention',
        targetLabel: groupName,
        targetJid: groupJid,
        mentionedJids,
        instruction: originalInstruction,
        messageSent: messageText,
        deliveredLive,
        usedAi: false,
        providerUsed: 'offline_emotion',
      });
      if (recentDirectCommands.length > 30) recentDirectCommands.length = 30;
      return { deliveredLive, groupName, mentionedCount: mentionedJids.length };
    },
    kickGroupMember: async ({ groupJid, groupName, targetPhoneOrName }) => {
      if (!currentSocket || botStatus !== 'connected') {
        return { ok: false, reason: 'WhatsApp কানেক্টেড নেই। আগে হোয়াটসঅ্যাপ কানেক্ট করুন।' };
      }
      try {
        const meta = await getCachedGroupMetadata(currentSocket, groupJid);
        const botIsAdmin = isParticipantAdmin(
          meta,
          currentSocket.user?.id,
          (currentSocket.user as { lid?: string } | undefined)?.lid
        );
        if (!botIsAdmin) {
          return {
            ok: false,
            reason: `আপনার নাম্বার "${meta.subject || groupName}" গ্রুপে অ্যাডমিন নয়, তাই মেম্বার কিক করা যাবে না।`,
          };
        }

        const qDigits = normalizePhoneForWa(targetPhoneOrName);
        const qSuffix = qDigits.length >= 7 ? qDigits.slice(-10) : '';
        const qLower = targetPhoneOrName.trim().toLowerCase();

        const cachedMembers = Object.values(knownGroupMembers[groupJid] || {});
        const cachedMatch = cachedMembers.find(
          (m) =>
            (qSuffix && normalizePhoneForWa(m.phone || m.jid).slice(-10) === qSuffix) ||
            (qLower.length >= 2 && m.name && m.name.toLowerCase().includes(qLower))
        );

        const participants = meta.participants || [];
        const matchedParticipant = participants.find((p) => {
          const pId = (p.id || '').toLowerCase();
          const pPn = normalizePhoneForWa((p as { phoneNumber?: string }).phoneNumber || p.id);
          const pSfx = pPn.length >= 7 ? pPn.slice(-10) : '';
          if (qSuffix && pSfx && pSfx === qSuffix) return true;
          if (cachedMatch) {
            if (pId === (cachedMatch.jid || '').toLowerCase() || (cachedMatch.lid && pId === cachedMatch.lid.toLowerCase())) {
              return true;
            }
          }
          if (qSuffix && extractDigits(p.id).slice(-10) === qSuffix) return true;
          return false;
        });

        const removeJid = matchedParticipant?.id || cachedMatch?.lid || cachedMatch?.jid || (qDigits ? `${qDigits}@s.whatsapp.net` : '');
        if (!removeJid) {
          return { ok: false, reason: `"${targetPhoneOrName}"-কে গ্রুপের অংশগ্রহণকারীদের মধ্যে খুঁজে পাওয়া যায়নি।` };
        }
        if (matchedParticipant?.admin === 'admin' || matchedParticipant?.admin === 'superadmin') {
          return { ok: false, reason: 'টার্গেট মেম্বার এই গ্রুপের অ্যাডমিন — WhatsApp গ্রুপ অ্যাডমিনকে সরাসরি কিক করা অনুমোদিত নয়।' };
        }

        await currentSocket.groupParticipantsUpdate(groupJid, [removeJid], 'remove');
        const label = cachedMatch?.name || targetPhoneOrName;
        pushLog('antilink', meta.subject || groupName, `Self-Chat Kicked ${label} (${removeJid})`, 'success');
        return { ok: true, kickedLabel: label, reason: 'Kicked cleanly' };
      } catch (err) {
        return { ok: false, reason: `গ্রুপ থেকে কিক করা যায়নি: ${(err as Error).message}` };
      }
    },
    upsertContactPolicies: async (entries) => {
      const current = [...(botConfig.contactPolicies || [])];
      const nowIso = new Date().toISOString();
      for (const item of entries) {
        const pn = normalizePhoneForWa(item.phone || item.jid);
        const idx = current.findIndex(
          (c) =>
            (item.jid && c.jid === item.jid) ||
            (pn && normalizePhoneForWa(c.phone || c.jid).slice(-10) === pn.slice(-10))
        );
        if (item.mode === 'normal') {
          if (idx !== -1) current.splice(idx, 1);
          continue;
        }
        const nextEntry: ContactPolicyEntry = {
          id: idx !== -1 ? current[idx].id : sanitizeId(`cpol_${Date.now()}_${current.length}`),
          name: item.name || (pn ? `+${pn}` : 'Contact'),
          phone: pn,
          jid: item.jid || (pn ? `${pn}@s.whatsapp.net` : undefined),
          mode: item.mode,
          note: item.note || (idx !== -1 ? current[idx].note : undefined),
          updatedAt: nowIso,
        };
        if (idx !== -1) {
          current[idx] = nextEntry;
        } else {
          current.unshift(nextEntry);
        }
      }
      botConfig = normalizeConfig({
        ...botConfig,
        contactPolicies: current.slice(0, 200),
        configUpdatedAt: nowIso,
      });
      persistConfig(true);
      return botConfig.contactPolicies;
    },
    updateSystemSettings: async (patch) => {
      botConfig = normalizeConfig({
        ...botConfig,
        ...(patch as Partial<BotConfig>),
        configUpdatedAt: new Date().toISOString(),
      });
      persistConfig(true);
    },
    clearTakeovers: (targetJid?: string) => {
      if (targetJid) {
        const existed = ownerTakeoverUntil.delete(targetJid);
        return existed ? 1 : 0;
      }
      const count = ownerTakeoverUntil.size;
      ownerTakeoverUntil.clear();
      return count;
    },
    runSelfHealNow: async () => {
      if (!selfHealingWatchdog) {
        pruneRuntimeCaches();
        return {
          rssBeforeMb: memoryRssMb,
          rssAfterMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
          actionsTaken: ['Pruned caches cleanly.'],
          botStatus,
        };
      }
      return selfHealingWatchdog.runHealCycle('manual');
    },
    getSystemDiagnostics: () => ({
      selfPing: getRuntimeSelfPingSnapshot(),
      watchdog: selfHealingWatchdog
        ? (() => {
            const st = selfHealingWatchdog.getStatus();
            return {
              enabled: st.enabled,
              cycleCount: st.cycleCount,
              totalHealsApplied: st.totalHealsApplied,
              processErrorsIntercepted: st.processErrorsIntercepted,
            };
          })()
        : null,
      mobileWorkers: mobileOffloadQueue.getActiveWorkers().map((w) => ({
        deviceLabel: w.deviceLabel,
        deviceMemoryGb: w.deviceMemoryGb,
        networkType: w.networkType,
        jobsCompleted: w.jobsCompleted,
      })),
      firestore: getFirestoreAdminDiagnostics(),
      schedulesCount: autonomousAgentEngine ? autonomousAgentEngine.getSnapshot().schedules.length : 0,
    }),
    runAutonomousMission: async (goal: string) => {
      if (!autonomousAgentEngine) {
        return {
          finalReport: '⚠️ অটোনোমাস এজেন্ট ইঞ্জিন এখনো প্রস্তুত নয়।',
          tokensUsed: 0,
          providerUsed: 'none',
          stepsCount: 0,
        };
      }
      const run = await autonomousAgentEngine.executeMission({ goal, source: 'self_chat' });
      return {
        finalReport: run.finalReport,
        tokensUsed: run.tokensUsed,
        providerUsed: run.providerUsed,
        stepsCount: run.steps.length,
      };
    },
  });

  pendingSelfChatDraft = copilotRes.nextPendingDraft;
  recordSelfChatTurn({
    role: 'assistant',
    text: copilotRes.replyText,
    actionSummary: copilotRes.actionSummary,
  });

  return copilotRes;
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
  for (const [jid, ts] of storyReplyCooldowns.entries()) {
    if (now - ts > 24 * 60 * 60 * 1000) {
      storyReplyCooldowns.delete(jid);
    }
  }
  for (const [chatId, ts] of lastSummaryRefreshAt.entries()) {
    if (now - ts > 60 * 60 * 1000) {
      lastSummaryRefreshAt.delete(chatId);
    }
  }
  for (const [mid, exp] of processedSelfMsgIds.entries()) {
    if (exp <= now) processedSelfMsgIds.delete(mid);
  }
  for (const [fp, exp] of recentSelfBotTextCache.entries()) {
    if (exp <= now) recentSelfBotTextCache.delete(fp);
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
  void recordParticipantsFromMetadataAsync(sock, groupJid, metadata);
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

  const { value: response, keySlot } = await geminiPool.executeWithRotation(
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
      tokenTelemetry.markGeminiSlotError(rot.fromSlot, rot.reason);
      pushLog(
        'gemini',
        `Key #${rot.fromSlot}->#${rot.toSlot}`,
        `Rotated Gemini key (${rot.fromSlot}/${rot.totalSlots} -> ${rot.toSlot}/${rot.totalSlots}): ${rot.reason.slice(0, 90)}`,
        'info'
      );
    },
    { maxTotalMs: 12_000 }
  );

  const um = response?.usageMetadata;
  if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
    tokenTelemetry.recordUsage({
      provider: 'gemini',
      model: 'gemini-4-hydrogen',
      keySlot,
      category: 'command',
      promptTokens: Number(um.promptTokenCount || 0),
      completionTokens: Number(um.candidatesTokenCount || 0),
      totalTokens: Number(
        um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
      ),
    });
  }

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
  contactPolicy?: { mode: ContactPolicyMode; note?: string };
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
        tokenTelemetry.markGeminiSlotError(rot.fromSlot, rot.reason);
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
      contactPolicy: params.contactPolicy,
    });
    replyText = result.replyText;
    detectedDistrict = result.detectedDistrict;
    noteSummary = result.noteSummary;
    noteUrgency = result.noteUrgency;
    usedFallback = Boolean(result.usedFallback);
    providerUsed = result.providerUsed || (usedFallback ? 'offline_emotion' : 'gemini');
    keySlotUsed = result.keySlotUsed;
    if (result.tokenUsage && (providerUsed === 'gemini' || providerUsed === 'openrouter')) {
      tokenTelemetry.recordUsage({
        provider: providerUsed,
        model: result.tokenUsage.model,
        keySlot: keySlotUsed,
        category: 'dm',
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
        totalTokens: result.tokenUsage.totalTokens,
      });
    }
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
      contactPolicy: params.contactPolicy,
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
  senderJid?: string;
  senderAlt?: string;
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
  const groupDirective = botConfig.groupDirectives?.[params.groupJid];

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
        tokenTelemetry.markGeminiSlotError(rot.fromSlot, rot.reason);
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
      senderJid: params.senderJid,
      senderAlt: params.senderAlt,
      groupDirective,
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
      senderJid: params.senderJid,
      senderAlt: params.senderAlt,
      groupDirective,
      incomingText: params.incomingText,
      isDirectlyAddressed: params.isDirectlyAddressed,
      canTextReply: params.canTextReply,
      dictionaryEntries: relevantDictionary,
    });
  }

  if (result.tokenUsage && (result.providerUsed === 'gemini' || result.providerUsed === 'openrouter')) {
    tokenTelemetry.recordUsage({
      provider: result.providerUsed,
      model: result.tokenUsage.model,
      keySlot: result.keySlotUsed,
      category: 'group',
      promptTokens: result.tokenUsage.promptTokens,
      completionTokens: result.tokenUsage.completionTokens,
      totalTokens: result.tokenUsage.totalTokens,
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

async function recordZeroTokenMediaExchange(params: {
  chatJid: string;
  displayName: string;
  isGroup: boolean;
  senderNameInGroup?: string;
  incomingSummary: string;
  replyText?: string;
}) {
  const chatId = sanitizeId(params.chatJid);
  const existing = await ensureChatMemoryHydrated(chatId, params.chatJid, params.displayName);
  const nowIso = new Date().toISOString();
  const userText =
    params.isGroup && params.senderNameInGroup
      ? `[${params.senderNameInGroup}]: ${params.incomingSummary}`
      : params.incomingSummary;

  const userTurn: ChatTurn = { role: 'user', text: userText, timestamp: nowIso };
  const turnsToPersist: Array<ChatTurn & { providerUsed?: string; latencyMs?: number }> = [userTurn];
  const nextTurnsList = [...(existing?.turns || []), userTurn];

  if (params.replyText) {
    const assistantTurn: ChatTurn = { role: 'assistant', text: params.replyText, timestamp: nowIso };
    nextTurnsList.push(assistantTurn);
    turnsToPersist.push({ ...assistantTurn, providerUsed: 'zero_token_media', latencyMs: 1 });
    archiveTurnToCloud(chatId, assistantTurn);
  }

  const updatedMemory: ChatMemoryRecord = {
    chatId,
    contactJid: params.chatJid,
    contactName: existing?.contactName || params.displayName || extractDigits(params.chatJid) || 'Contact',
    detectedDistrict: existing?.detectedDistrict || 'Standard',
    lastSummary: existing?.lastSummary || params.incomingSummary.slice(0, 120),
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
  archiveTurnToCloud(chatId, userTurn);
  scheduleBackgroundSummaryRefresh(chatId);
}

function getPreviousAssistantRepliesForChat(chatJid: string): string[] {
  const chatId = sanitizeId(chatJid);
  const turns = chatMemories[chatId]?.turns || [];
  return turns
    .filter((t) => t.role === 'assistant')
    .slice(-8)
    .map((t) => t.text);
}

function shouldUsePureZeroTokenMediaReply(insight: MediaInsight, isDirectlyAddressed: boolean): boolean {
  if (!insight.isMedia) return false;
  if (!botConfig.aiAssistantEnabled || (!geminiPool.hasKeys() && !openRouterReader.hasKeys())) {
    return true;
  }
  if (!botConfig.mediaZeroTokenReplyMode) {
    // Hybrid mode: Text AI runs when possible, but reading media itself ALWAYS uses 0 tokens
    return insight.kind === 'reaction' && !insight.caption;
  }
  const captionLen = (insight.caption || '').trim().length;
  // Pure Zero-Token mode: stickers, photos, videos, stories & reactions use 0 API tokens unless someone typed a rich multi-word question/argument (>18 chars)
  if (insight.kind === 'sticker' || insight.kind === 'reaction') return true;
  if (captionLen <= 18 && !isDirectlyAddressed) return true;
  if (captionLen <= 10) return true;
  return false;
}

async function processStoryBroadcast(sock: WASocket, msg: WAMessage) {
  if (!msg.message || msg.key.fromMe) return;
  if (!botConfig.mediaIntelligenceEnabled || !botConfig.storyAutoReadEnabled) return;

  const msgId = msg.key.id || '';
  if (msgId) {
    if (processedStoryIds.has(msgId)) return;
    processedStoryIds.add(msgId);
    if (processedStoryIds.size > 500) {
      const oldest = processedStoryIds.values().next().value;
      if (oldest) processedStoryIds.delete(oldest);
    }
  }

  const rawPosterJid = msg.key.participant || (msg.key as { participantAlt?: string }).participantAlt || '';
  if (!rawPosterJid || rawPosterJid === 'status@broadcast') return;

  const posterAlt = (msg.key as { participantAlt?: string }).participantAlt;
  const posterLid = isLidJid(rawPosterJid)
    ? rawPosterJid
    : isLidJid(posterAlt)
      ? posterAlt
      : undefined;
  let posterPnJid = isPhoneJid(rawPosterJid)
    ? rawPosterJid
    : isPhoneJid(posterAlt)
      ? posterAlt
      : undefined;

  if (!posterPnJid && posterLid) {
    const mappedPn = await resolveLidToPnDigits(sock, posterLid);
    if (mappedPn) {
      posterPnJid = `${mappedPn}@s.whatsapp.net`;
    }
  }

  const posterTargetJid = posterPnJid || rawPosterJid;
  const posterPhone = extractPhoneDigitsOnly(posterPnJid);
  const contactInfo = findContactForIdentity({
    jid: posterTargetJid,
    lid: posterLid,
    phone: posterPhone,
  });
  const posterName =
    (msg.pushName && !isDefaultNumericLabel(msg.pushName) ? msg.pushName.trim() : '') ||
    (contactInfo?.name && !isDefaultNumericLabel(contactInfo.name) ? contactInfo.name : '') ||
    (posterPhone ? `+${posterPhone}` : 'Friend');

  const botDigits = extractDigits(sock.user?.id);
  const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
  const posterDigits = extractDigits(posterTargetJid);
  if ((botDigits && posterDigits === botDigits) || (botLidDigits && posterDigits === botLidDigits)) {
    return;
  }

  // Enforce Custom Story Whitelist when selected_only mode is active
  const matchedWhitelist = findMatchingStoryWhitelistContact({
    jids: [posterTargetJid, posterPnJid, posterLid, rawPosterJid],
    phone: posterPhone,
    names: [msg.pushName, contactInfo?.name, posterName],
  });
  if (botConfig.storyWhitelistMode === 'selected_only' && !matchedWhitelist) {
    return;
  }

  const insight = await readMediaMessageZeroToken(msg, sock);

  if (botConfig.humanTypingEnabled) {
    void sock.readMessages([msg.key]).catch(() => {});
  }

  const cooldownKey = `story:${posterTargetJid}`;
  const lastStoryAction = storyReplyCooldowns.get(cooldownKey) || 0;
  const storyCooldownWindow = botConfig.storyCooldownMs ?? 15 * 60 * 1000;
  const isTakeoverPaused = Date.now() < (ownerTakeoverUntil.get(posterTargetJid) || 0);
  const daily = getDailyReplyStats();
  const canEngagePoster =
    !isTakeoverPaused &&
    daily.count < daily.limit &&
    Date.now() - lastStoryAction >= storyCooldownWindow;

  let reactionSent = '';
  let replySent = '';
  let replyMode: MediaStoryFeedItem['replyMode'] = 'read_only';

  if (canEngagePoster && (botConfig.storyAutoReactEnabled || botConfig.storyAutoReplyEnabled)) {
    storyReplyCooldowns.set(cooldownKey, Date.now());

    if (botConfig.storyAutoReactEnabled && insight.recommendedReaction) {
      reactionSent = insight.recommendedReaction;
      await sock
        .sendMessage(
          'status@broadcast',
          { react: { text: reactionSent, key: msg.key } },
          { statusJidList: [posterTargetJid] }
        )
        .catch(() => {});
    }

    if (botConfig.storyAutoReplyEnabled) {
      const customNote = matchedWhitelist?.customPrompt?.trim() || '';
      const useHybridTextAi =
        !botConfig.mediaZeroTokenReplyMode &&
        (insight.caption.trim().length > 14 || customNote.length > 0) &&
        botConfig.aiAssistantEnabled &&
        (geminiPool.hasKeys() || openRouterReader.hasKeys());

      if (useHybridTextAi) {
        const res = await runExecutiveAssistantTurn({
          contactJid: posterTargetJid,
          contactName: posterName,
          incomingText: customNote
            ? `${insight.compactContextLine}\n[Owner Custom Story Instruction for ${posterName}: ${customNote}]`
            : insight.compactContextLine,
        });
        replySent = res.replyText;
        replyMode = res.usedFallback ? 'zero_token' : 'hybrid_text_ai';
      } else {
        const adjustedInsight = applyCustomPromptHintToInsight(insight, customNote);
        const generated = generateZeroTokenMediaReply({
          insight: adjustedInsight,
          context: 'story',
          senderName: posterName,
          tone: botConfig.assistantTone,
          ownerName: botConfig.ownerName,
          previousReplies: getPreviousAssistantRepliesForChat(posterTargetJid),
        });
        replySent = generated.replyText;
        replyMode = 'zero_token';
        await recordZeroTokenMediaExchange({
          chatJid: posterTargetJid,
          displayName: posterName,
          isGroup: false,
          incomingSummary: insight.compactContextLine,
          replyText: replySent,
        });
      }

      if (replySent) {
        if (botConfig.humanTypingEnabled) {
          void sock.sendPresenceUpdate('composing', posterTargetJid).catch(() => {});
        }
        try {
          await sendTrackedMessage(
            sock,
            posterTargetJid,
            { text: replySent },
            { quoted: msg }
          );
          dailyReplyCount += 1;
        } finally {
          if (botConfig.humanTypingEnabled) {
            void sock.sendPresenceUpdate('paused', posterTargetJid).catch(() => {});
          }
        }
      }
    }
  }

  tokenTelemetry.recordZeroTokenMediaRead({
    kind: insight.kind,
    isStory: true,
    repliedWithZeroTokens: replyMode === 'zero_token',
  });

  recordMediaStoryFeedItem({
    source: 'story',
    senderName: posterName,
    senderJid: posterTargetJid,
    kind: insight.kind,
    sentiment: insight.sentiment,
    banglaSceneLabel: insight.banglaSceneLabel,
    compactContextLine: insight.compactContextLine,
    reactionSent,
    replySent,
    replyMode,
  });

  pushLog(
    'autoreply',
    `Story · ${posterName}`,
    `Read Story (${insight.banglaSceneLabel}) [0 Read Tokens]${reactionSent ? ` · React ${reactionSent}` : ''}${replySent ? ` · SMS Replied` : ''}`,
    replySent || reactionSent ? 'success' : 'info'
  );
}

// ----------------------------------------------------------------------------
// Live Baileys Message Handler
// ----------------------------------------------------------------------------
async function handleLiveMessage(sock: WASocket, msg: WAMessage) {
  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith('@newsletter')) {
    return;
  }

  // Handle WhatsApp Stories (status@broadcast) with 0-Token Media Reader
  if (remoteJid === 'status@broadcast') {
    await processStoryBroadcast(sock, msg);
    return;
  }

  if (remoteJid.endsWith('@broadcast')) {
    return;
  }

  const isGroup = isJidGroup(remoteJid) ?? false;
  const text = extractMessageText(msg.message);
  const unwrappedMsg = unwrapBaileysMessageContent(msg.message).unwrapped;
  const isIncomingReaction = Boolean(unwrappedMsg?.reactionMessage);
  const senderJid = isGroup ? msg.key.participant || remoteJid : remoteJid;
  const senderAlt = (msg.key as { participantAlt?: string }).participantAlt;

  const selfBotDigits = extractDigits(sock.user?.id);
  const selfBotLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
  const selfPairingDigits = extractDigits(currentPairingPhone);
  const selfRemoteDigits = extractDigits(remoteJid);
  const selfRemoteAltDigits = extractDigits((msg.key as { remoteJidAlt?: string }).remoteJidAlt);
  const matchesSelfDigits = (candidate: string) =>
    Boolean(candidate) &&
    ((Boolean(selfBotDigits) && candidate === selfBotDigits) ||
      (Boolean(selfBotLidDigits) && candidate === selfBotLidDigits) ||
      (Boolean(selfPairingDigits) && candidate === selfPairingDigits));
  const isSelfChatTarget =
    !isGroup && (matchesSelfDigits(selfRemoteDigits) || matchesSelfDigits(selfRemoteAltDigits));

  // Self-Chat ("Message Yourself") direct Owner Copilot + Zero-Token Video Diagnostics
  if (isSelfChatTarget && msg.key.fromMe) {
    const msgId = msg.key.id || '';
    if ((msgId && botSentMessageIds.has(msgId)) || isIncomingReaction) {
      return;
    }
    const fpKey = `${remoteJid}|${text.slice(0, 80)}`;
    const fpExp = recentSelfBotTextCache.get(fpKey);
    if (fpExp && fpExp > Date.now()) {
      return;
    }
    if (msgId) {
      const prevExp = processedSelfMsgIds.get(msgId);
      if (prevExp && prevExp > Date.now()) {
        return;
      }
      processedSelfMsgIds.set(msgId, Date.now() + 10 * 60_000);
      if (processedSelfMsgIds.size > 200) {
        const firstKey = processedSelfMsgIds.keys().next().value;
        if (firstKey) processedSelfMsgIds.delete(firstKey);
      }
    }

    const hasSelfMedia = Boolean(
      unwrappedMsg?.imageMessage ||
        unwrappedMsg?.videoMessage ||
        unwrappedMsg?.stickerMessage ||
        unwrappedMsg?.audioMessage
    );

    const isExplicitGeminiPrefix =
      text.toLowerCase().startsWith(`${PREFIX}ai `) || text.toLowerCase().startsWith(`${PREFIX}gemini `);

    if (botConfig.selfChatCopilotEnabled !== false && !isExplicitGeminiPrefix && (text || hasSelfMedia)) {
      enqueuePrivateReply(remoteJid, async () => {
        if (currentSocket !== sock || botConfig.selfChatCopilotEnabled === false) return;
        let mediaInsight: MediaInsight | null = null;
        if (hasSelfMedia) {
          mediaInsight = await readMediaMessageZeroToken(msg, sock);
        }
        const effectiveText = text || mediaInsight?.caption || '';
        if (!effectiveText && !mediaInsight?.isMedia) return;

        if (botConfig.humanTypingEnabled) {
          void sock.readMessages([msg.key]).catch(() => {});
          void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        }
        try {
          const copilotRes = await executeZeroTokenSelfChatTurn({
            incomingText: effectiveText,
            mediaInsight,
          });
          // Register text fingerprint BEFORE sending so Baileys echo never loops
          const replyFp = `${remoteJid}|${copilotRes.replyText.slice(0, 80)}`;
          recentSelfBotTextCache.set(replyFp, Date.now() + 25_000);
          if (recentSelfBotTextCache.size > 80) {
            const firstFp = recentSelfBotTextCache.keys().next().value;
            if (firstFp) recentSelfBotTextCache.delete(firstFp);
          }

          await sendTrackedMessage(sock, remoteJid, { text: copilotRes.replyText }, { quoted: msg });
          pushLog(
            'autoreply',
            'Self-Chat Copilot',
            copilotRes.actionSummary,
            'success'
          );
        } finally {
          if (botConfig.humanTypingEnabled) {
            void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
          }
        }
      });
      return;
    }
  }

  // Detect manual human owner reply (in external DM OR Group — never in Self-Chat) -> save to memory & pause AI temporarily
  if (msg.key.fromMe && !isSelfChatTarget) {
    const msgId = msg.key.id;
    const isCommand = text.startsWith(PREFIX);
    if (msgId && !botSentMessageIds.has(msgId) && !isCommand && !isIncomingReaction && text) {
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
  const resolvedSenderLid = isLidJid(senderJid)
    ? senderJid
    : isLidJid(senderAlt)
      ? senderAlt
      : undefined;
  let resolvedSenderPnJid = isPhoneJid(senderJid)
    ? senderJid
    : isPhoneJid(senderAlt)
      ? senderAlt
      : undefined;
  if (!resolvedSenderPnJid && resolvedSenderLid) {
    const mappedPnDigits = await resolveLidToPnDigits(sock, resolvedSenderLid);
    if (mappedPnDigits) {
      resolvedSenderPnJid = `${mappedPnDigits}@s.whatsapp.net`;
    }
  }
  const resolvedSenderPhone = extractPhoneDigitsOnly(resolvedSenderPnJid);

  if (isGroup && !msg.key.fromMe) {
    if (resolvedSenderPnJid || resolvedSenderLid || msg.pushName) {
      upsertContactRecord({
        id: resolvedSenderPnJid || resolvedSenderLid,
        lid: resolvedSenderLid,
        phoneNumber: resolvedSenderPnJid,
        notify: msg.pushName || undefined,
      });
    }
    upsertGroupMemberRecord(remoteJid, {
      jid: resolvedSenderPnJid || senderJid,
      lid: resolvedSenderLid,
      phone: resolvedSenderPhone,
      name: msg.pushName || '',
    });
  }

  const hasNonTextMedia = Boolean(
    unwrappedMsg?.imageMessage ||
      unwrappedMsg?.videoMessage ||
      unwrappedMsg?.stickerMessage ||
      unwrappedMsg?.audioMessage ||
      unwrappedMsg?.reactionMessage
  );

  if (isGroup && botConfig.groupAiEnabled && botConfig.groupAiGroups[remoteJid] === true) {
    if (msg.key.fromMe) return;
    if (!text && (!hasNonTextMedia || !botConfig.mediaIntelligenceEnabled)) return;

    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(senderJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const contactInfo = findContactForIdentity({
      jid: resolvedSenderPnJid || senderJid,
      lid: resolvedSenderLid,
      phone: resolvedSenderPhone,
    });
    const senderName =
      (msg.pushName && !isDefaultNumericLabel(msg.pushName) ? msg.pushName.trim() : '') ||
      (contactInfo?.name && !isDefaultNumericLabel(contactInfo.name) ? contactInfo.name : '') ||
      (resolvedSenderPhone ? `+${resolvedSenderPhone}` : 'Member');

    // Enforce global contactPolicies mute_ai (and exclusion commands) inside Group AI Clone too
    const groupSenderPolicy = findMatchingContactPolicy({
      jids: [resolvedSenderPnJid, senderJid, senderAlt, resolvedSenderLid],
      phone: resolvedSenderPhone,
      names: [senderName],
    });
    if (groupSenderPolicy?.mode === 'mute_ai') {
      pushLog(
        'autoreply',
        `${extractDigits(remoteJid)} · ${senderName}`,
        'Contact Policy (Off/Mute): skipped Group AI reaction & reply [0 Tokens].',
        'blocked'
      );
      return;
    }

    const isDirectlyAddressed = isDirectlyAddressedInGroup(msg, sock, text, botConfig.ownerName);

    enqueuePrivateReply(remoteJid, async () => {
      if (!botConfig.groupAiEnabled || botConfig.groupAiGroups[remoteJid] !== true || currentSocket !== sock) {
        return;
      }

      let mediaInsight: MediaInsight | null = null;
      if (hasNonTextMedia && botConfig.mediaIntelligenceEnabled) {
        mediaInsight = await readMediaMessageZeroToken(msg, sock);
        // Ignore reactions in groups unless the user specifically reacted to our own/owner message
        if (mediaInsight.kind === 'reaction' && !mediaInsight.reactionTargetFromMe) {
          return;
        }
        // Ignore empty/removed reactions (text === '')
        if (mediaInsight.kind === 'reaction' && !mediaInsight.reactionEmojiReceived) {
          return;
        }
      }

      const effectiveIncomingText = mediaInsight?.isMedia
        ? mediaInsight.compactContextLine
        : text;
      if (!effectiveIncomingText) return;

      const metadata = await getCachedGroupMetadata(sock, remoteJid).catch(() => null);
      const groupName = metadata?.subject || extractDigits(remoteJid) || 'Group Chat';

      const pausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
      if (Date.now() < pausedUntil) {
        if (mediaInsight?.isMedia) {
          tokenTelemetry.recordZeroTokenMediaRead({
            kind: mediaInsight.kind,
            isStory: false,
            repliedWithZeroTokens: false,
          });
        }
        await runGroupCloneTurn({
          groupJid: remoteJid,
          groupName,
          senderName,
          senderJid: resolvedSenderPnJid || senderJid,
          senderAlt: resolvedSenderPnJid || senderAlt,
          incomingText: effectiveIncomingText,
          isDirectlyAddressed,
          canTextReply: false,
          observeOnly: true,
        });
        return;
      }

      const daily = getDailyReplyStats();
      if (daily.count >= daily.limit) {
        if (mediaInsight?.isMedia) {
          tokenTelemetry.recordZeroTokenMediaRead({
            kind: mediaInsight.kind,
            isStory: false,
            repliedWithZeroTokens: false,
          });
        }
        await runGroupCloneTurn({
          groupJid: remoteJid,
          groupName,
          senderName,
          senderJid: resolvedSenderPnJid || senderJid,
          senderAlt: resolvedSenderPnJid || senderAlt,
          incomingText: effectiveIncomingText,
          isDirectlyAddressed,
          canTextReply: false,
          observeOnly: true,
        });
        return;
      }

      // Separate cooldown buckets so targeted member missions NEVER starve or block normal members
      const { matchedTarget } = findMatchingGroupTarget(
        botConfig.groupDirectives?.[remoteJid],
        resolvedSenderPnJid || senderJid,
        resolvedSenderPnJid || senderAlt,
        senderName
      );
      const cooldownBucketKey = matchedTarget ? `grp_tgt:${remoteJid}:${matchedTarget.id}` : remoteJid;
      const cooldownWindowMs = matchedTarget
        ? Math.min(botConfig.groupCooldownMs ?? 6000, 3000)
        : (botConfig.groupCooldownMs ?? 6000);
      const lastGroupSent = autoReplyCooldowns.get(cooldownBucketKey) || 0;
      const canTextReply = Date.now() - lastGroupSent >= cooldownWindowMs;

      // Zero-Token Media Path for pure Stickers/Photos/Videos/Reactions in Group
      if (
        mediaInsight?.isMedia &&
        !matchedTarget &&
        shouldUsePureZeroTokenMediaReply(mediaInsight, isDirectlyAddressed)
      ) {
        const mode = botConfig.groupAiMode || 'smart_blend';
        const allowReply =
          (mode !== 'mention_only' || isDirectlyAddressed) &&
          canTextReply &&
          mediaInsight.kind !== 'reaction';
        const reactionEmoji =
          botConfig.groupReactionEnabled !== false && mediaInsight.kind !== 'reaction'
            ? mediaInsight.recommendedReaction
            : '';

        if (reactionEmoji) {
          await sock
            .sendMessage(remoteJid, { react: { text: reactionEmoji, key: msg.key } })
            .catch(() => {});
        }

        let replyText = '';
        if (allowReply) {
          const generated = generateZeroTokenMediaReply({
            insight: mediaInsight,
            context: 'group',
            senderName,
            tone: botConfig.assistantTone,
            ownerName: botConfig.ownerName,
            previousReplies: getPreviousAssistantRepliesForChat(remoteJid),
          });
          replyText = generated.replyText;
        }

        await recordZeroTokenMediaExchange({
          chatJid: remoteJid,
          displayName: groupName,
          isGroup: true,
          senderNameInGroup: senderName,
          incomingSummary: mediaInsight.compactContextLine,
          replyText: replyText || undefined,
        });

        tokenTelemetry.recordZeroTokenMediaRead({
          kind: mediaInsight.kind,
          isStory: false,
          repliedWithZeroTokens: Boolean(replyText),
        });

        recordMediaStoryFeedItem({
          source: 'group',
          senderName: `${groupName} · ${senderName}`,
          senderJid: remoteJid,
          kind: mediaInsight.kind,
          sentiment: mediaInsight.sentiment,
          banglaSceneLabel: mediaInsight.banglaSceneLabel,
          compactContextLine: mediaInsight.compactContextLine,
          reactionSent: reactionEmoji,
          replySent: replyText,
          replyMode: replyText ? 'zero_token' : 'read_only',
        });

        if (replyText) {
          if (botConfig.humanTypingEnabled) {
            void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
          }
          try {
            if (cooldownWindowMs > 0) {
              autoReplyCooldowns.set(cooldownBucketKey, Date.now());
            }
            await sendTrackedMessage(
              sock,
              remoteJid,
              { text: replyText },
              { quoted: msg }
            );
            dailyReplyCount += 1;
            pushLog(
              'autoreply',
              `${groupName} · ${senderName}`,
              `0-Token Media (${mediaInsight.banglaSceneLabel}${reactionEmoji ? ` · ${reactionEmoji}` : ''}) -> Text SMS`,
              'success'
            );
          } finally {
            if (botConfig.humanTypingEnabled) {
              void sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
            }
          }
        } else if (reactionEmoji) {
          pushLog(
            'autoreply',
            `${groupName} · ${senderName}`,
            `0-Token Media React ${reactionEmoji} (${mediaInsight.banglaSceneLabel})`,
            'info'
          );
        }
        return;
      }

      if (mediaInsight?.isMedia) {
        tokenTelemetry.recordZeroTokenMediaRead({
          kind: mediaInsight.kind,
          isStory: false,
          repliedWithZeroTokens: false,
        });
      }

      const startedAt = Date.now();
      const decision = await runGroupCloneTurn({
        groupJid: remoteJid,
        groupName,
        senderName,
        senderJid: resolvedSenderPnJid || senderJid,
        senderAlt: resolvedSenderPnJid || senderAlt,
        incomingText: effectiveIncomingText,
        isDirectlyAddressed,
        canTextReply,
      });

      if (Date.now() < (ownerTakeoverUntil.get(remoteJid) || 0)) return;

      if (mediaInsight?.isMedia) {
        recordMediaStoryFeedItem({
          source: 'group',
          senderName: `${groupName} · ${senderName}`,
          senderJid: remoteJid,
          kind: mediaInsight.kind,
          sentiment: mediaInsight.sentiment,
          banglaSceneLabel: mediaInsight.banglaSceneLabel,
          compactContextLine: mediaInsight.compactContextLine,
          reactionSent: decision.reactionEmoji || mediaInsight.recommendedReaction,
          replySent: decision.replyText || '',
          replyMode: decision.providerUsed === 'offline_emotion' ? 'zero_token' : 'hybrid_text_ai',
        });
      }

      // Send WhatsApp Emoji Reaction if selected
      if (
        (decision.action === 'react' || decision.action === 'reply_and_react') &&
        botConfig.groupReactionEnabled &&
        decision.reactionEmoji &&
        mediaInsight?.kind !== 'reaction'
      ) {
        await sock
          .sendMessage(remoteJid, { react: { text: decision.reactionEmoji, key: msg.key } })
          .catch(() => {});
      }

      // Send Group Clone Reply if selected (always text-only SMS)
      if ((decision.action === 'reply' || decision.action === 'reply_and_react') && decision.replyText) {
        if (botConfig.humanTypingEnabled) {
          void sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
        }
        try {
          if (cooldownWindowMs > 0) {
            autoReplyCooldowns.set(cooldownBucketKey, Date.now());
          }
          const quoteOrMention = decision.shouldQuote && mediaInsight?.kind !== 'reaction' ? { quoted: msg } : undefined;
          await sendTrackedMessage(
            sock,
            remoteJid,
            {
              text: decision.replyText,
              ...(decision.mentionTarget && senderJid ? { mentions: [senderJid] } : {}),
            },
            quoteOrMention
          );
          dailyReplyCount += 1;
          const elapsedMs = Date.now() - startedAt;
          pushLog(
            'autoreply',
            `${groupName} · ${senderName}${decision.matchedTargetName ? ` [Target: ${decision.matchedTargetName}]` : ''}`,
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
    if (!isPrivateChat || msg.key.fromMe) return;
    if (!text && (!hasNonTextMedia || !botConfig.mediaIntelligenceEnabled)) return;

    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    const senderDigits = extractDigits(remoteJid);
    if ((botDigits && senderDigits === botDigits) || (botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const pausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
    const contactName = msg.pushName || senderDigits || 'Contact';
    if (Date.now() < pausedUntil) {
      if (text) recordPassiveIncomingTurn(remoteJid, contactName, text, false);
      return;
    }

    const dmContactPolicy = findMatchingContactPolicy({
      jids: [remoteJid],
      phone: extractPhoneDigitsOnly(remoteJid),
      names: [contactName],
    });

    if (dmContactPolicy?.mode === 'mute_ai') {
      if (text) recordPassiveIncomingTurn(remoteJid, contactName, text, false);
      pushLog('autoreply', contactName, 'Contact Policy (Mute): skipped auto-reply [0 Tokens].', 'blocked');
      return;
    }

    const effectiveCooldown =
      dmContactPolicy?.mode === 'long_engage'
        ? Math.min(botConfig.cooldownMs, 2000)
        : botConfig.cooldownMs;
    const lastSent = autoReplyCooldowns.get(remoteJid) || 0;
    if (Date.now() - lastSent < effectiveCooldown) {
      if (text) recordPassiveIncomingTurn(remoteJid, contactName, text, false);
      return;
    }

    // Instant zero-delay enqueue: start AI/Zero-Token Media generation immediately on message arrival
    enqueuePrivateReply(remoteJid, async () => {
      if (!botConfig.autoreply || currentSocket !== sock) return;

      let mediaInsight: MediaInsight | null = null;
      if (hasNonTextMedia && botConfig.mediaIntelligenceEnabled) {
        mediaInsight = await readMediaMessageZeroToken(msg, sock);
        if (mediaInsight.kind === 'reaction' && (!mediaInsight.reactionTargetFromMe || !mediaInsight.reactionEmojiReceived)) {
          return;
        }
      }

      const effectiveIncomingText = mediaInsight?.isMedia ? mediaInsight.compactContextLine : text;
      if (!effectiveIncomingText) return;

      const latestPausedUntil = ownerTakeoverUntil.get(remoteJid) || 0;
      if (Date.now() < latestPausedUntil) {
        recordPassiveIncomingTurn(remoteJid, contactName, effectiveIncomingText, false);
        return;
      }

      const daily = getDailyReplyStats();
      if (daily.count >= daily.limit) {
        recordPassiveIncomingTurn(remoteJid, contactName, effectiveIncomingText, false);
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
        // Pure Zero-Token DM Media Path
        if (mediaInsight?.isMedia && shouldUsePureZeroTokenMediaReply(mediaInsight, false)) {
          const generated = generateZeroTokenMediaReply({
            insight: mediaInsight,
            context: 'dm',
            senderName: contactName,
            tone: botConfig.assistantTone,
            ownerName: botConfig.ownerName,
            previousReplies: getPreviousAssistantRepliesForChat(remoteJid),
          });
          const reactionEmoji =
            mediaInsight.kind !== 'reaction' && generated.reactionEmoji ? generated.reactionEmoji : '';
          if (reactionEmoji) {
            await sock
              .sendMessage(remoteJid, { react: { text: reactionEmoji, key: msg.key } })
              .catch(() => {});
          }
          await sendTrackedMessage(
            sock,
            remoteJid,
            { text: generated.replyText },
            mediaInsight.kind !== 'reaction' ? { quoted: msg } : undefined
          );
          dailyReplyCount += 1;

          await recordZeroTokenMediaExchange({
            chatJid: remoteJid,
            displayName: contactName,
            isGroup: false,
            incomingSummary: mediaInsight.compactContextLine,
            replyText: generated.replyText,
          });

          tokenTelemetry.recordZeroTokenMediaRead({
            kind: mediaInsight.kind,
            isStory: false,
            repliedWithZeroTokens: true,
          });

          recordMediaStoryFeedItem({
            source: 'dm',
            senderName: contactName,
            senderJid: remoteJid,
            kind: mediaInsight.kind,
            sentiment: mediaInsight.sentiment,
            banglaSceneLabel: mediaInsight.banglaSceneLabel,
            compactContextLine: mediaInsight.compactContextLine,
            reactionSent: reactionEmoji,
            replySent: generated.replyText,
            replyMode: 'zero_token',
          });

          pushLog(
            'autoreply',
            contactName,
            `0-Token Media DM (${mediaInsight.banglaSceneLabel}) -> Text SMS`,
            'success'
          );
          return;
        }

        if (mediaInsight?.isMedia) {
          tokenTelemetry.recordZeroTokenMediaRead({
            kind: mediaInsight.kind,
            isStory: false,
            repliedWithZeroTokens: false,
          });
        }

        // Zero-Token Polite Hold/Wait Policy Path
        if (dmContactPolicy?.mode === 'hold_wait') {
          const holdReply = generateZeroTokenHoldReply({
            contactName,
            note: dmContactPolicy.note,
            previousAssistantReplies: getPreviousAssistantRepliesForChat(remoteJid),
            ownerName: botConfig.ownerName,
          });
          await sendTrackedMessage(sock, remoteJid, { text: holdReply }, { quoted: msg });
          dailyReplyCount += 1;
          await recordZeroTokenMediaExchange({
            chatJid: remoteJid,
            displayName: contactName,
            isGroup: false,
            incomingSummary: effectiveIncomingText,
            replyText: holdReply,
          });
          pushLog('autoreply', contactName, 'Contact Policy (Hold/Wait): 0-Token polite hold sent.', 'info');
          return;
        }

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
          incomingText: effectiveIncomingText,
          contactPolicy: dmContactPolicy ? { mode: dmContactPolicy.mode, note: dmContactPolicy.note } : undefined,
        });

        if (Date.now() < (ownerTakeoverUntil.get(remoteJid) || 0)) return;

        if (mediaInsight?.isMedia) {
          const reactEmoji = mediaInsight.kind !== 'reaction' ? mediaInsight.recommendedReaction : '';
          if (reactEmoji) {
            await sock
              .sendMessage(remoteJid, { react: { text: reactEmoji, key: msg.key } })
              .catch(() => {});
          }
          recordMediaStoryFeedItem({
            source: 'dm',
            senderName: contactName,
            senderJid: remoteJid,
            kind: mediaInsight.kind,
            sentiment: mediaInsight.sentiment,
            banglaSceneLabel: mediaInsight.banglaSceneLabel,
            compactContextLine: mediaInsight.compactContextLine,
            reactionSent: reactEmoji,
            replySent: replyText,
            replyMode: usedFallback ? 'zero_token' : 'hybrid_text_ai',
          });
        }

        const shouldQuote = Math.random() < 0.45 && mediaInsight?.kind !== 'reaction';
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

  sock.ev.on('messaging-history.set', ({ messages, contacts, lidPnMappings }) => {
    if (currentSocket !== sock || isShuttingDown) return;
    try {
      if (Array.isArray(lidPnMappings)) {
        for (const m of lidPnMappings) {
          if (m?.lid && m?.pn) {
            upsertContactRecord({ lid: m.lid, pn: m.pn });
          }
        }
      }
      if (Array.isArray(contacts)) {
        for (const c of contacts as Contact[]) {
          upsertContactRecord({
            id: c.id,
            lid: c.lid,
            phoneNumber: c.phoneNumber,
            name: c.name,
            notify: c.notify,
            verifiedName: c.verifiedName,
          });
        }
      }
      ingestHistoryMessages(messages);
    } catch (err) {
      pushLog('cloud', 'Inbox Sync', `History ingest warning: ${(err as Error).message}`, 'info');
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    if (currentSocket !== sock || isShuttingDown || !Array.isArray(contacts)) return;
    for (const c of contacts) {
      upsertContactRecord({
        id: c.id,
        lid: c.lid,
        phoneNumber: c.phoneNumber,
        name: c.name,
        notify: c.notify,
        verifiedName: c.verifiedName,
      });
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    if (currentSocket !== sock || isShuttingDown || !Array.isArray(updates)) return;
    for (const c of updates) {
      upsertContactRecord({
        id: c.id,
        lid: c.lid,
        phoneNumber: c.phoneNumber,
        name: c.name,
        notify: c.notify,
        verifiedName: c.verifiedName,
      });
    }
  });

  sock.ev.on('lid-mapping.update', (mapping) => {
    if (currentSocket !== sock || isShuttingDown || !mapping) return;
    upsertContactRecord({ lid: mapping.lid, pn: mapping.pn });
  });

  sock.ev.on('groups.upsert', (groups) => {
    if (currentSocket !== sock || isShuttingDown || !Array.isArray(groups)) return;
    for (const meta of groups) {
      if (meta?.id) {
        void recordParticipantsFromMetadataAsync(sock, meta.id, meta);
      }
    }
  });

  sock.ev.on('groups.update', (updates) => {
    if (currentSocket !== sock || isShuttingDown || !Array.isArray(updates)) return;
    for (const upd of updates) {
      if (upd?.id) {
        groupMetadataCache.delete(upd.id);
      }
    }
  });

  sock.ev.on('group-participants.update', async (ev) => {
    if (currentSocket !== sock || isShuttingDown || !ev?.id) return;
    groupMetadataCache.delete(ev.id);
    if (Array.isArray(ev.participants)) {
      for (const p of ev.participants as Array<
        GroupParticipant & { lid?: string; phoneNumber?: string; notify?: string; name?: string }
      >) {
        const rawId = (p?.id || '').split(':')[0];
        if (!rawId) continue;
        const rawLid = (p.lid || (isLidJid(rawId) ? rawId : '')).split(':')[0];
        const rawPhoneJid = p.phoneNumber || (isPhoneJid(rawId) ? rawId : '');
        let phoneDigits = extractPhoneDigitsOnly(rawPhoneJid);
        if (!phoneDigits && rawLid) {
          phoneDigits = await resolveLidToPnDigits(sock, rawLid);
        }
        upsertGroupMemberRecord(ev.id, {
          jid: phoneDigits ? `${phoneDigits}@s.whatsapp.net` : rawId,
          lid: rawLid || undefined,
          phone: phoneDigits,
          name: (p.notify || p.name || '').trim(),
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
        });
      }
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
  let activeConfigTs = parseConfigTimestampMs(botConfig.configUpdatedAt);

  // 1. Hydrate from External PostgreSQL (if DATABASE_URL is configured)
  if (isPostgresConfigured()) {
    try {
      const pgSettings = await pgLoadSettings();
      if (pgSettings?.config) {
        if (pgSettings.ownerId && pgSettings.ownerId !== 'server_admin') {
          activeCloudOwnerId = pgSettings.ownerId;
        }
        const pgTs = parseConfigTimestampMs(pgSettings.config.configUpdatedAt || pgSettings.config.updatedAt);
        if (activeConfigTs === 0 || pgTs >= activeConfigTs) {
          botConfig = normalizeConfig({
            ...(pgSettings.config as Partial<BotConfig>),
            configUpdatedAt:
              typeof pgSettings.config.configUpdatedAt === 'string' && pgSettings.config.configUpdatedAt
                ? pgSettings.config.configUpdatedAt
                : new Date().toISOString(),
          });
          activeConfigTs = parseConfigTimestampMs(botConfig.configUpdatedAt);
          saveJsonFile(CONFIG_FILE, botConfig);
        }
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

  // 2. Hydrate from Server-Side Admin Firestore (if configured) without overwriting newer Postgres/local config
  const { db, mode } = getAdminFirestore();
  if (!db) return;
  try {
    const cloudSettings = await adminLoadDocument<Partial<BotConfig> & { ownerId?: string; updatedAt?: unknown }>(
      'bot_settings',
      'primary'
    );
    if (cloudSettings) {
      if (cloudSettings.ownerId && cloudSettings.ownerId !== 'server_admin') {
        activeCloudOwnerId = cloudSettings.ownerId;
      }
      const fsTs = parseConfigTimestampMs(cloudSettings.configUpdatedAt || cloudSettings.updatedAt);
      if (activeConfigTs === 0 || fsTs > activeConfigTs) {
        botConfig = normalizeConfig({
          ...cloudSettings,
          configUpdatedAt:
            typeof cloudSettings.configUpdatedAt === 'string' && cloudSettings.configUpdatedAt
              ? cloudSettings.configUpdatedAt
              : fsTs > 0
                ? new Date(fsTs).toISOString()
                : new Date().toISOString(),
        });
        saveJsonFile(CONFIG_FILE, botConfig);
      }
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

  const RUNTIME_HOST_FILE = path.resolve('./bot-runtime-host.json');
  let learnedPublicBaseUrl = '';
  try {
    if (fs.existsSync(RUNTIME_HOST_FILE)) {
      const savedHost = JSON.parse(fs.readFileSync(RUNTIME_HOST_FILE, 'utf8'));
      if (typeof savedHost?.baseUrl === 'string' && /^https?:\/\//i.test(savedHost.baseUrl)) {
        learnedPublicBaseUrl = savedHost.baseUrl.replace(/\/+$/, '');
      }
    }
  } catch {
    // ignore
  }

  // Learn live external public URL automatically from incoming requests (so Render works even without RENDER_EXTERNAL_URL env var)
  app.use((req, _res, next) => {
    const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (
      rawHost &&
      !rawHost.startsWith('127.0.0.1') &&
      !rawHost.startsWith('localhost') &&
      !rawHost.startsWith('0.0.0.0')
    ) {
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
      const candidate = `${proto}://${rawHost}`.replace(/\/+$/, '');
      if (candidate !== learnedPublicBaseUrl && /^https?:\/\/[a-z0-9.-]+/i.test(candidate)) {
        learnedPublicBaseUrl = candidate;
        try {
          fs.writeFileSync(RUNTIME_HOST_FILE, JSON.stringify({ baseUrl: candidate, updatedAt: new Date().toISOString() }), 'utf8');
        } catch {
          // ignore
        }
      }
    }
    next();
  });

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
    if (
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/client-portal/') ||
      req.path === '/telegram/webhook'
    ) {
      next();
      return;
    }
    requireOwnerAuth(req, res, next);
  });

  // Web Research, Lead Vault, Gmail OAuth + SMTP Profile + Resend/Brevo Email & Anti-Ban WhatsApp Outreach (Additive Module)
  outreachController = registerWebOutreachRoutes(app, {
    geminiPool,
    openRouterReader,
    tokenTelemetry,
    getBotConfig: () => botConfig,
    getSocket: () => currentSocket,
    getBotStatus: () => botStatus,
    sendTrackedMessage: (sock, jid, content) => sendTrackedMessage(sock, jid, content),
    pushLog,
    onLeadWhatsAppSent: ({ phoneDigits, jid, leadName }) => {
      upsertContactRecord({ id: jid, phoneNumber: phoneDigits, name: leadName });
    },
  });

  // Mobile Browser / PWA Offload Queue (Uses phone RAM & mobile data)
  registerMobileOffloadRoutes(app, mobileOffloadQueue, ({ url, emails, phones, title, snippet }) => {
    outreachController?.ingestExternalLead({
      name: title || url,
      sourceUrl: url,
      topic: 'Mobile PWA Offload',
      emails,
      phones,
      snippet: snippet || '',
    });
  });

  // Autonomous Action Agent Engine ("Brain + Hands & Feet") & 5-Min Self-Healing Watchdog
  autonomousAgentEngine = new AutonomousAgentEngine({
    geminiPool,
    openRouterReader,
    tokenTelemetry,
    outreach: outreachController,
    offloadQueue: mobileOffloadQueue,
    getWatchdog: () => selfHealingWatchdog,
    getBotConfig: () => botConfig,
    getBotStatus: () => botStatus,
    getMemoryRssMb: () => Math.round(process.memoryUsage().rss / (1024 * 1024)),
    getDirectoryContacts: () => collectDirectoryContacts(),
    getKnownGroups: () =>
      collectAllKnownGroupSummaries().map((g) => ({
        jid: g.jid,
        name: g.name,
        members: Object.values(knownGroupMembers[g.jid] || {}).map((m) => ({
          jid: m.jid,
          phone: m.phone,
          name: m.name,
        })),
      })),
    getRecentMemories: () =>
      Object.values(chatMemories)
        .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
        .slice(0, 12),
    getUnreadNotes: () => inboxNotes.filter((n) => !n.resolved).slice(0, 12),
    getSelfPingStats: () => getRuntimeSelfPingSnapshot(),
    dispatchDirectDm: async ({ targets, messageText, originalInstruction }) => {
      let deliveredCount = 0;
      let draftCount = 0;
      const targetLabels: string[] = [];
      for (const target of targets.slice(0, 15)) {
        const targetJid = target.jid || `${normalizePhoneForWa(target.phone)}@s.whatsapp.net`;
        if (!targetJid) continue;
        targetLabels.push(target.name || `+${target.phone}`);
        if (currentSocket && botStatus === 'connected') {
          await sendTrackedMessage(currentSocket, targetJid, { text: messageText });
          deliveredCount += 1;
          dailyReplyCount += 1;
        } else {
          draftCount += 1;
        }
        await recordZeroTokenMediaExchange({
          chatJid: targetJid,
          displayName: target.name || `+${target.phone}`,
          isGroup: false,
          incomingSummary: `[Autonomous Agent]: ${originalInstruction}`,
          replyText: messageText,
        });
      }
      return { deliveredCount, draftCount, targetLabels };
    },
    dispatchGroupMention: async ({ groupJid, groupName, members, messageText }) => {
      let deliveredLive = false;
      const mentionJids = members.map((m) => m.jid).filter(Boolean).slice(0, 20);
      if (currentSocket && botStatus === 'connected') {
        await sendTrackedMessage(currentSocket, groupJid, { text: messageText, mentions: mentionJids });
        deliveredLive = true;
      }
      return { deliveredLive, groupName, mentionedCount: mentionJids.length };
    },
    kickGroupMember: async ({ groupJid, targetPhoneOrName }) => {
      if (!currentSocket || botStatus !== 'connected') {
        return { ok: false, reason: 'WhatsApp সকেট এই মুহূর্তে কানেক্টেড নয়।' };
      }
      try {
        const meta = await currentSocket.groupMetadata(groupJid);
        const targetDigits = normalizePhoneForWa(targetPhoneOrName).slice(-10);
        const participant = meta.participants.find((p) => {
          const d = extractDigits(p.id).slice(-10);
          const phoneD = normalizePhoneForWa(p.phoneNumber).slice(-10);
          return (targetDigits && (d === targetDigits || phoneD === targetDigits)) || (p.name && p.name.toLowerCase().includes(targetPhoneOrName.toLowerCase()));
        });
        if (!participant) return { ok: false, reason: `গ্রুপে "${targetPhoneOrName}" খুঁজে পাওয়া যায়নি।` };
        await currentSocket.groupParticipantsUpdate(groupJid, [participant.id], 'remove');
        return { ok: true, kickedLabel: participant.id, reason: 'Kicked cleanly' };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
    upsertContactPolicies: async (entries) => {
      const current = [...(botConfig.contactPolicies || [])];
      const nowIso = new Date().toISOString();
      for (const item of entries) {
        const pn = normalizePhoneForWa(item.phone || item.jid);
        const idx = current.findIndex(
          (c) => (item.jid && c.jid === item.jid) || (pn && normalizePhoneForWa(c.phone || c.jid).slice(-10) === pn.slice(-10))
        );
        if (item.mode === 'normal') {
          if (idx !== -1) current.splice(idx, 1);
          continue;
        }
        const nextEntry: ContactPolicyEntry = {
          id: idx !== -1 ? current[idx].id : sanitizeId(`cpol_${Date.now()}_${current.length}`),
          name: item.name || (pn ? `+${pn}` : 'Contact'),
          phone: pn,
          jid: item.jid || (pn ? `${pn}@s.whatsapp.net` : undefined),
          mode: item.mode,
          note: item.note || (idx !== -1 ? current[idx].note : undefined),
          updatedAt: nowIso,
        };
        if (idx !== -1) current[idx] = nextEntry;
        else current.unshift(nextEntry);
      }
      botConfig = normalizeConfig({ ...botConfig, contactPolicies: current.slice(0, 200), configUpdatedAt: nowIso });
      persistConfig(true);
      return botConfig.contactPolicies;
    },
    updateSystemSettings: async (patch) => {
      botConfig = normalizeConfig({ ...botConfig, ...(patch as Partial<BotConfig>), configUpdatedAt: new Date().toISOString() });
      persistConfig(true);
    },
    sendOwnerSelfChatReport: async (text: string) => {
      if (!currentSocket || botStatus !== 'connected') return false;
      const myPn = normalizePhoneForWa(currentSocket.user?.id || currentPairingPhone);
      if (!myPn) return false;
      await sendTrackedMessage(currentSocket, `${myPn}@s.whatsapp.net`, { text });
      recordSelfChatTurn({ role: 'assistant', text, actionSummary: 'Scheduled Autonomous Agent Report' });
      return true;
    },
    pushLog,
  });
  autonomousAgentEngine.startScheduler();

  selfHealingWatchdog = new SelfHealingWatchdog({
    getMemoryRssMb: () => Math.round(process.memoryUsage().rss / (1024 * 1024)),
    pruneRuntimeCaches: () => pruneRuntimeCaches(),
    getBotStatus: () => botStatus,
    isManualDisconnect: () => manualDisconnect,
    hasRegisteredCreds: () => {
      try {
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) return false;
        const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        return Boolean(parsed?.registered);
      } catch {
        return false;
      }
    },
    hasPendingReconnectTimer: () => Boolean(reconnectTimer),
    triggerWhatsAppReconnect: async () => {
      await startBaileysConnection(currentPairingPhone || undefined);
    },
    healStuckQueuesAndAgents: () => {
      const actions: string[] = [];
      const offloadHealed = mobileOffloadQueue.pruneStuckJobs();
      if (offloadHealed > 0) actions.push(`Cleaned ${offloadHealed} stale mobile offload job(s)`);
      if (autonomousAgentEngine) {
        actions.push(...autonomousAgentEngine.healStuckRuns());
      }
      return actions;
    },
    verifyAndRepairJsonFiles: (files) => repairCorruptJsonFiles(files),
    pushLog,
  });
  selfHealingWatchdog.start();

  registerAutonomousAgentRoutes(app, autonomousAgentEngine, () => selfHealingWatchdog);

  const telegramBotController = new TelegramBotController({
    geminiPool,
    openRouterReader,
    tokenTelemetry,
    outreach: outreachController,
    getAutonomousAgent: () => autonomousAgentEngine,
    getOwnerName: () => botConfig.ownerName || 'Sir',
    pushLog,
  });
  registerTelegramRoutes(app, telegramBotController, requireOwnerAuth);

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

  app.get('/api/system/env-status', (_req, res) => {
    const isSet = (name: string) => {
      const val = String(process.env[name] || '').trim();
      return Boolean(
        val &&
          val !== 'MY_GEMINI_API_KEY' &&
          val !== 'MY_APP_URL' &&
          !val.startsWith('YOUR_')
      );
    };

    const geminiStats = geminiPool.getStats();
    const openRouterStats = openRouterReader.getStats();

    res.json({
      runtime: {
        platform: process.platform,
        isTermux: Boolean(
          process.env.TERMUX_VERSION || (process.env.PREFIX || '').includes('com.termux')
        ),
        isVercel: Boolean(process.env.VERCEL),
        nodeVersion: process.version,
        port: PORT,
        nodeEnv: process.env.NODE_ENV || 'development',
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        uptimeSec: Math.round(process.uptime()),
        selfPingEnabled: process.env.ENABLE_SELF_PING !== 'false',
        ownerEmail: OWNER_EMAIL,
        telegramBotConfigured: Boolean(getTelegramBotToken()),
      },
      geminiKeysCount: geminiStats.configuredKeysCount,
      openRouterKeysCount: openRouterStats.configuredKeysCount,
      firestore: getFirestoreAdminDiagnostics(),
      envItems: [
        {
          key: 'TELEGRAM_BOT_TOKEN',
          category: 'Telegram 24/7',
          configured: Boolean(getTelegramBotToken()),
          detail: Boolean(getTelegramBotToken()) ? 'Bot token active' : 'Optional (@BotFather token)',
        },
        {
          key: 'GEMINI_API_KEY_1..5',
          category: 'AI Brain',
          configured: geminiStats.configuredKeysCount > 0,
          detail: `${geminiStats.configuredKeysCount} key slot(s) active`,
        },
        {
          key: 'OPENROUTER_API_KEY',
          category: 'AI Brain',
          configured: openRouterStats.configuredKeysCount > 0,
          detail: `${openRouterStats.configuredKeysCount} key(s) active`,
        },
        {
          key: 'TAVILY_API_KEY',
          category: 'Web Search',
          configured: isSet('TAVILY_API_KEY'),
          detail: isSet('TAVILY_API_KEY') ? 'Configured' : 'Optional (DuckDuckGo active)',
        },
        {
          key: 'SERPER_API_KEY',
          category: 'Web Search',
          configured: isSet('SERPER_API_KEY'),
          detail: isSet('SERPER_API_KEY') ? 'Configured' : 'Optional',
        },
        {
          key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
          category: 'Database',
          configured: isSet('FIREBASE_SERVICE_ACCOUNT_JSON'),
          detail: getFirestoreAdminDiagnostics().mode,
        },
        {
          key: 'OWNER_EMAIL',
          category: 'Security',
          configured: isSet('OWNER_EMAIL'),
          detail: OWNER_EMAIL,
        },
        {
          key: 'DASHBOARD_PIN',
          category: 'Security',
          configured: isPinConfigured(),
          detail: isSet('DASHBOARD_PIN')
            ? 'Set via Env'
            : isPinConfigured()
              ? 'Set in Dashboard'
              : 'Not Set',
        },
        {
          key: 'RESEND_API_KEY',
          category: 'Email API',
          configured: isSet('RESEND_API_KEY'),
          detail: isSet('RESEND_API_KEY') ? 'Configured' : 'Optional',
        },
        {
          key: 'BREVO_API_KEY',
          category: 'Email API',
          configured: isSet('BREVO_API_KEY'),
          detail: isSet('BREVO_API_KEY') ? 'Configured' : 'Optional',
        },
        {
          key: 'HF_TOKEN',
          category: 'Image Gen',
          configured: isSet('HF_TOKEN'),
          detail: isSet('HF_TOKEN') ? 'FLUX.1-schnell active' : 'Optional (Pollinations fallback active)',
        },
        {
          key: 'ENABLE_SELF_PING',
          category: 'Uptime',
          configured: process.env.ENABLE_SELF_PING !== 'false',
          detail: process.env.ENABLE_SELF_PING !== 'false' ? 'ON (Every 4m)' : 'Disabled',
        },
      ],
    });
  });

  app.get('/api/bot/status', (_req, res) => {
    const sessionExists = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    const { mode: firestoreAdminMode } = getAdminFirestore();
    const dailyStats = getDailyReplyStats();
    const geminiStats = geminiPool.getStats();
    const openRouterStats = openRouterReader.getStats();
    void tokenTelemetry.maybeRefreshOpenRouterKeyMeta(openRouterReader.getPrimaryKey());
    const tokenTelemetrySnapshot = tokenTelemetry.getSnapshot({
      whatsappUsedToday: dailyStats.count,
      whatsappDailyLimit: dailyStats.limit,
      configuredGeminiKeys: geminiStats.configuredKeysCount,
      geminiSlotCooldowns: geminiPool.getSlotCooldownStats(),
      openRouterConfiguredKeys: openRouterStats.configuredKeysCount,
      openRouterFreeModelsCount: openRouterStats.dynamicPool?.discoveredFreeModelsCount || 0,
      openRouterActiveModel:
        openRouterStats.dynamicPool?.activeFreeModel || openRouterStats.primaryModel,
    });

    res.json({
      status: botStatus,
      connectedUser: currentSocket?.user?.id || null,
      pairingCode: currentPairingCode,
      pairingPhone: currentPairingPhone,
      sessionExists,
      lastError: lastBotError,
      geminiConfigured: geminiPool.hasKeys(),
      geminiKeyPool: geminiStats,
      openRouterConfigured: openRouterReader.hasKeys(),
      openRouterStats,
      tokenTelemetry: tokenTelemetrySnapshot,
      postgres: getPostgresStatus(),
      firestoreAdminMode,
      config: botConfig,
      logs: eventLogs,
      dictionaryCount: totalDictionaryCount,
      memoryCount: Object.keys(chatMemories).length,
      unreadNotesCount: inboxNotes.filter((n) => !n.resolved).length,
      dailyReplyStats: dailyStats,
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

  app.post('/api/bot/config', async (req, res) => {
    const patch = (req.body || {}) as Partial<BotConfig>;
    botConfig = normalizeConfig({
      ...botConfig,
      ...patch,
      configUpdatedAt: new Date().toISOString(),
    });
    await persistConfigAsync(false);
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
        members: KnownGroupMemberRecord[];
      }
    >();

    const getMembersForGroup = (jid: string): KnownGroupMemberRecord[] => {
      const bucket = knownGroupMembers[jid];
      if (!bucket) return [];
      return Object.values(bucket)
        .sort((a, b) => {
          if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 250);
    };

    // 1. Seed from saved configs, group directives & memories
    for (const [jid, enabled] of Object.entries(botConfig.antilinkGroups || {})) {
      map.set(jid, {
        jid,
        name: chatMemories[sanitizeId(jid)]?.contactName || jid,
        participantCount: 0,
        antilinkEnabled: Boolean(enabled),
        groupAiEnabled: Boolean(botConfig.groupAiGroups[jid]),
        members: getMembersForGroup(jid),
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
        members: getMembersForGroup(jid),
      });
    }
    for (const jid of Object.keys(botConfig.groupDirectives || {})) {
      if (!map.has(jid)) {
        map.set(jid, {
          jid,
          name: chatMemories[sanitizeId(jid)]?.contactName || jid,
          participantCount: 0,
          antilinkEnabled: Boolean(botConfig.antilinkGroups[jid]),
          groupAiEnabled: Boolean(botConfig.groupAiGroups[jid]),
          members: getMembersForGroup(jid),
        });
      }
    }
    for (const mem of Object.values(chatMemories)) {
      if (mem.contactJid?.endsWith('@g.us') && !map.has(mem.contactJid)) {
        map.set(mem.contactJid, {
          jid: mem.contactJid,
          name: mem.contactName || mem.contactJid,
          participantCount: 0,
          antilinkEnabled: Boolean(botConfig.antilinkGroups[mem.contactJid]),
          groupAiEnabled: Boolean(botConfig.groupAiGroups[mem.contactJid]),
          members: getMembersForGroup(mem.contactJid),
        });
      }
    }

    // 2. Enrich with live WhatsApp participating groups & resolved participants when connected
    let liveFetchError: string | null = null;
    if (currentSocket && botStatus === 'connected') {
      try {
        const participating = await withTimeout(
          currentSocket.groupFetchAllParticipating(),
          10_000,
          'Fetch participating groups'
        );
        for (const [jid, meta] of Object.entries(participating || {})) {
          await recordParticipantsFromMetadataAsync(currentSocket, jid, meta);
          const existing = map.get(jid);
          const members = getMembersForGroup(jid);
          map.set(jid, {
            jid,
            name: meta.subject || existing?.name || jid,
            participantCount: Array.isArray(meta.participants) ? meta.participants.length : members.length,
            antilinkEnabled: Boolean(botConfig.antilinkGroups[jid]),
            groupAiEnabled: Boolean(botConfig.groupAiGroups[jid]),
            members,
          });
        }
      } catch (err) {
        liveFetchError = (err as Error).message;
      }
    }

    const groups = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      connected: botStatus === 'connected',
      liveFetchError,
      groups,
    });
  });

  // Cloud Sync endpoint used by browser-authenticated Firestore client
  app.post('/api/cloud/sync', async (req, res) => {
    const { ownerId, settings, dictionary, memories, notes } = req.body || {};
    if (typeof ownerId === 'string' && ownerId.trim()) {
      activeCloudOwnerId = ownerId.trim();
    }
    if (settings && typeof settings === 'object') {
      const serverTs = parseConfigTimestampMs(botConfig.configUpdatedAt);
      const incomingObj = settings as Partial<BotConfig> & { updatedAt?: unknown };
      const incomingTs = parseConfigTimestampMs(incomingObj.configUpdatedAt || incomingObj.updatedAt);

      // Apply Firestore settings ONLY when server has never saved a timestamped config OR incoming Firestore settings are strictly newer
      if (serverTs === 0 || incomingTs > serverTs) {
        botConfig = normalizeConfig({
          ...botConfig,
          ...incomingObj,
          configUpdatedAt:
            typeof incomingObj.configUpdatedAt === 'string' && incomingObj.configUpdatedAt
              ? incomingObj.configUpdatedAt
              : incomingTs > 0
                ? new Date(incomingTs).toISOString()
                : new Date().toISOString(),
        });
        saveJsonFile(CONFIG_FILE, botConfig);
        void pgSaveSettings(activeCloudOwnerId, botConfig as unknown as Record<string, unknown>);
      }
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

  app.get('/api/contacts', (_req, res) => {
    const contacts = collectDirectoryContacts();
    res.json({
      connected: botStatus === 'connected',
      contacts,
    });
  });

  app.get('/api/assistant/direct-commands', (_req, res) => {
    res.json({ commands: recentDirectCommands });
  });

  app.post('/api/assistant/direct-command', async (req, res) => {
    try {
      const body = (req.body || {}) as {
        actionType?: 'auto' | 'dm_knock' | 'group_mention';
        targetPhoneOrJid?: string;
        targetContactName?: string;
        groupJid?: string;
        mentionMembers?: Array<{ jid?: string; lid?: string; phone?: string; name?: string }>;
        instruction?: string;
        useAiCraft?: boolean;
        dryRun?: boolean;
      };

      const instruction = String(body.instruction || '').trim();
      if (!instruction) {
        res.status(400).json({ error: 'Command / instruction cannot be empty.' });
        return;
      }

      const useAiCraft = body.useAiCraft !== false;
      const dryRun = Boolean(body.dryRun);
      const directoryContacts = collectDirectoryContacts();

      // Determine Action Type ('dm_knock' vs 'group_mention')
      const requestedType = body.actionType || 'auto';
      const hasGroupCue =
        Boolean(body.groupJid) ||
        (Array.isArray(body.mentionMembers) && body.mentionMembers.length > 0) ||
        /(?:গ্রুপে|গ্রুপ|group|মেনশন|mention|@)/iu.test(instruction);

      let resolvedActionType: 'dm_knock' | 'group_mention' =
        requestedType === 'group_mention'
          ? 'group_mention'
          : requestedType === 'dm_knock'
            ? 'dm_knock'
            : hasGroupCue && !/(?:ইনবক্সে|inbox|dm)/iu.test(instruction)
              ? 'group_mention'
              : 'dm_knock';

      if (resolvedActionType === 'group_mention') {
        // Resolve Group JID & Name
        let resolvedGroupJid = String(body.groupJid || '').trim();
        let resolvedGroupName = '';
        const candidateGroups = collectAllKnownGroupSummaries();

        if (resolvedGroupJid) {
          resolvedGroupName =
            candidateGroups.find((g) => g.jid === resolvedGroupJid)?.name ||
            chatMemories[sanitizeId(resolvedGroupJid)]?.contactName ||
            resolvedGroupJid;
        } else {
          const lowerInst = instruction.toLowerCase();
          const matchedGrp = candidateGroups.find(
            (g) => g.name && g.name.length >= 2 && lowerInst.includes(g.name.toLowerCase())
          );
          if (matchedGrp) {
            resolvedGroupJid = matchedGrp.jid;
            resolvedGroupName = matchedGrp.name;
          }
        }

        if (!resolvedGroupJid) {
          res.status(400).json({
            error: 'কোন গ্রুপে মেনশন দেবেন তা সিলেক্ট করুন অথবা কমান্ডে গ্রুপের নাম লিখুন।',
          });
          return;
        }

        // Resolve Members to @mention
        const groupBucket = Object.values(knownGroupMembers[resolvedGroupJid] || {});
        const mentionTargets: Array<{ mentionJid: string; tagHandle: string; label: string }> = [];
        const addMentionCandidate = (m: { jid?: string; lid?: string; phone?: string; name?: string }) => {
          const normPhone = normalizePhoneForWa(m.phone || (isPhoneJid(m.jid) ? m.jid : ''));
          const matchedCached = groupBucket.find(
            (gm) =>
              (normPhone && normalizePhoneForWa(gm.phone) === normPhone) ||
              (m.jid && gm.jid === m.jid) ||
              (m.lid && gm.lid === m.lid)
          );
          const candidateJid =
            matchedCached?.lid && isLidJid(matchedCached.jid)
              ? matchedCached.lid
              : matchedCached?.jid ||
                m.jid ||
                m.lid ||
                (normPhone ? `${normPhone}@s.whatsapp.net` : '');
          if (!candidateJid) return;
          const tagDigits = candidateJid.split('@')[0].split(':')[0];
          const label = matchedCached?.name || m.name || (normPhone ? `+${normPhone}` : `@${tagDigits}`);
          if (!mentionTargets.some((x) => x.mentionJid === candidateJid)) {
            mentionTargets.push({
              mentionJid: candidateJid,
              tagHandle: `@${tagDigits}`,
              label,
            });
          }
        };

        if (Array.isArray(body.mentionMembers) && body.mentionMembers.length > 0) {
          for (const m of body.mentionMembers) {
            addMentionCandidate(m);
          }
        } else {
          // Auto-extract @mentions or phones or member names from freeform instruction
          const atMatches = [...instruction.matchAll(/@([^\s,!?]+)/g)].map((x) => x[1].toLowerCase());
          const lowerInst = instruction.toLowerCase();
          for (const gm of groupBucket) {
            const nameLower = gm.name.toLowerCase();
            const matchedAt = atMatches.some((tok) => nameLower.includes(tok) || (gm.phone && gm.phone.endsWith(tok)));
            const matchedName = gm.name.length >= 3 && !isDefaultNumericLabel(gm.name) && lowerInst.includes(nameLower);
            const matchedPhone = gm.phone && lowerInst.includes(gm.phone.slice(-10));
            if (matchedAt || matchedName || matchedPhone) {
              addMentionCandidate(gm);
            }
          }
          const phoneInText = instruction.match(/(?:\+?88)?01[3-9]\d{8}/);
          if (mentionTargets.length === 0 && phoneInText) {
            const pn = normalizePhoneForWa(phoneInText[0]);
            addMentionCandidate({ phone: pn, jid: `${pn}@s.whatsapp.net`, name: `+${pn}` });
          }
        }

        // If WhatsApp is live, align each mentionJid to exact group participant JID so WhatsApp blue @tag triggers reliably
        if (currentSocket && botStatus === 'connected' && mentionTargets.length > 0) {
          try {
            const meta = await withTimeout(
              currentSocket.groupMetadata(resolvedGroupJid),
              5_000,
              'Fetch groupMetadata for mention'
            );
            for (const target of mentionTargets) {
              const tPhone = normalizePhoneForWa(target.mentionJid.split('@')[0]);
              const livePart = meta.participants?.find((p) => {
                const pRaw = (p.id || '').split(':')[0];
                const pPn = normalizePhoneForWa((p as { phoneNumber?: string }).phoneNumber || (isPhoneJid(pRaw) ? pRaw : ''));
                return pRaw === target.mentionJid || (tPhone && pPn === tPhone);
              });
              if (livePart?.id) {
                const cleanPartJid = livePart.id.split(':')[0];
                target.mentionJid = cleanPartJid;
                target.tagHandle = `@${cleanPartJid.split('@')[0]}`;
              }
            }
          } catch {
            // proceed with cached JID
          }
        }

        const chatId = sanitizeId(resolvedGroupJid);
        const mem = await ensureChatMemoryHydrated(chatId, resolvedGroupJid, resolvedGroupName);
        const crafted = await generateDirectCommandText({
          keyPool: botConfig.aiAssistantEnabled ? geminiPool : null,
          openRouterReader: botConfig.aiAssistantEnabled ? openRouterReader : null,
          onKeyRotate: (rot) => tokenTelemetry.markGeminiSlotError(rot.fromSlot, rot.reason),
          settings: botConfig,
          actionType: 'group_mention',
          targetName: mentionTargets.map((m) => m.label).join(', ') || resolvedGroupName,
          groupName: resolvedGroupName,
          mentionTags: mentionTargets.map((m) => m.tagHandle),
          instruction,
          memory: mem,
          useAiCraft,
        });

        if (crafted.tokenUsage && (crafted.providerUsed === 'gemini' || crafted.providerUsed === 'openrouter')) {
          tokenTelemetry.recordUsage({
            provider: crafted.providerUsed,
            model: crafted.tokenUsage.model,
            keySlot: crafted.keySlotUsed,
            category: 'command',
            promptTokens: crafted.tokenUsage.promptTokens,
            completionTokens: crafted.tokenUsage.completionTokens,
            totalTokens: crafted.tokenUsage.totalTokens,
          });
        }

        const mentionedJids = mentionTargets.map((m) => m.mentionJid);
        let deliveredLive = false;
        let deliveryNote = dryRun
          ? 'Preview ready (not sent yet).'
          : 'WhatsApp ডিসকানেক্ট অবস্থায় আছে—মেসেজ ড্রাফট তৈরি হয়েছে, কানেক্ট করে পাঠাতে পারবেন।';

        if (!dryRun && currentSocket && botStatus === 'connected') {
          if (botConfig.humanTypingEnabled) {
            void currentSocket.sendPresenceUpdate('composing', resolvedGroupJid).catch(() => {});
            await new Promise((r) => setTimeout(r, 700));
          }
          try {
            await sendTrackedMessage(currentSocket, resolvedGroupJid, {
              text: crafted.messageText,
              ...(mentionedJids.length > 0 ? { mentions: mentionedJids } : {}),
            });
            deliveredLive = true;
            dailyReplyCount += 1;
            deliveryNote = `গ্রুপে সফলভাবে মেনশন সহ মেসেজ পাঠানো হয়েছে (${resolvedGroupName})।`;

            await recordZeroTokenMediaExchange({
              chatJid: resolvedGroupJid,
              displayName: resolvedGroupName,
              isGroup: true,
              senderNameInGroup: botConfig.ownerName || 'Sir',
              incomingSummary: `[Owner Direct Command -> Group Mention]: ${instruction}`,
              replyText: crafted.messageText,
            });
          } finally {
            if (botConfig.humanTypingEnabled) {
              void currentSocket.sendPresenceUpdate('paused', resolvedGroupJid).catch(() => {});
            }
          }
        }

        const cmdRecord: DirectCommandLogItem = {
          id: `dcmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          actionType: 'group_mention',
          targetLabel: `${resolvedGroupName}${mentionTargets.length > 0 ? ` (${mentionTargets.map((m) => m.label).join(', ')})` : ''}`,
          targetJid: resolvedGroupJid,
          mentionedJids,
          instruction,
          messageSent: crafted.messageText,
          deliveredLive,
          usedAi: useAiCraft,
          providerUsed: crafted.providerUsed,
        };
        if (!dryRun) {
          recentDirectCommands.unshift(cmdRecord);
          if (recentDirectCommands.length > 30) recentDirectCommands.length = 30;
          pushLog(
            'autoreply',
            `Command · ${resolvedGroupName}`,
            `Group @Mention (${deliveredLive ? 'Live Sent' : 'Draft'}): ${crafted.messageText.slice(0, 80)}`,
            deliveredLive ? 'success' : 'info'
          );
        }

        res.json({
          ok: true,
          dryRun,
          deliveredLive,
          actionType: 'group_mention',
          targetLabel: cmdRecord.targetLabel,
          targetJid: resolvedGroupJid,
          mentionedJids,
          messageText: crafted.messageText,
          providerUsed: crafted.providerUsed,
          note: deliveryNote,
          commandRecord: cmdRecord,
        });
        return;
      }

      // DM Knock Resolution
      let rawTarget = String(body.targetPhoneOrJid || '').trim();
      let resolvedName = String(body.targetContactName || '').trim();
      let resolvedJid = '';

      if (rawTarget.includes('@')) {
        resolvedJid = rawTarget;
      } else if (rawTarget) {
        const pn = normalizePhoneForWa(rawTarget);
        if (pn.length >= 7) {
          resolvedJid = `${pn}@s.whatsapp.net`;
        } else {
          const matchedByName = directoryContacts.find((c) =>
            c.name.toLowerCase().includes(rawTarget.toLowerCase())
          );
          if (matchedByName) {
            resolvedJid = matchedByName.jid;
            resolvedName = resolvedName || matchedByName.name;
          }
        }
      }

      if (!resolvedJid) {
        const phoneInInst = instruction.match(/(?:\+?88)?01[3-9]\d{8}|\b\d{10,15}\b/);
        if (phoneInInst) {
          const pn = normalizePhoneForWa(phoneInInst[0]);
          resolvedJid = `${pn}@s.whatsapp.net`;
        } else {
          const lowerInst = instruction.toLowerCase();
          const matchedContact = directoryContacts.find(
            (c) => c.name.length >= 3 && !isDefaultNumericLabel(c.name) && lowerInst.includes(c.name.toLowerCase())
          );
          if (matchedContact) {
            resolvedJid = matchedContact.jid;
            resolvedName = resolvedName || matchedContact.name;
          }
        }
      }

      if (!resolvedJid) {
        res.status(400).json({
          error: 'যাকে ইনবক্স করবেন তার হোয়াটসঅ্যাপ নাম্বার সিলেক্ট করুন বা কমান্ডে স্পষ্ট নাম/নাম্বার লিখুন।',
        });
        return;
      }

      const targetDigits = extractPhoneDigitsOnly(resolvedJid);
      const directoryMatch = directoryContacts.find(
        (c) => c.jid === resolvedJid || (targetDigits && normalizePhoneForWa(c.phone) === normalizePhoneForWa(targetDigits))
      );
      if (!resolvedName) {
        resolvedName = directoryMatch?.name || (targetDigits ? `+${targetDigits}` : resolvedJid.split('@')[0]);
      }

      const chatId = sanitizeId(resolvedJid);
      const mem = await ensureChatMemoryHydrated(chatId, resolvedJid, resolvedName);
      const crafted = await generateDirectCommandText({
        keyPool: botConfig.aiAssistantEnabled ? geminiPool : null,
        openRouterReader: botConfig.aiAssistantEnabled ? openRouterReader : null,
        onKeyRotate: (rot) => tokenTelemetry.markGeminiSlotError(rot.fromSlot, rot.reason),
        settings: botConfig,
        actionType: 'dm_knock',
        targetName: resolvedName,
        instruction,
        memory: mem,
        useAiCraft,
      });

      if (crafted.tokenUsage && (crafted.providerUsed === 'gemini' || crafted.providerUsed === 'openrouter')) {
        tokenTelemetry.recordUsage({
          provider: crafted.providerUsed,
          model: crafted.tokenUsage.model,
          keySlot: crafted.keySlotUsed,
          category: 'command',
          promptTokens: crafted.tokenUsage.promptTokens,
          completionTokens: crafted.tokenUsage.completionTokens,
          totalTokens: crafted.tokenUsage.totalTokens,
        });
      }

      let deliveredLive = false;
      let deliveryNote = dryRun
        ? 'Preview ready (not sent yet).'
        : 'WhatsApp ডিসকানেক্ট অবস্থায় আছে—মেসেজ ড্রাফট তৈরি হয়েছে, কানেক্ট করে পাঠাতে পারবেন।';

      if (!dryRun && currentSocket && botStatus === 'connected') {
        if (botConfig.humanTypingEnabled) {
          void currentSocket.sendPresenceUpdate('composing', resolvedJid).catch(() => {});
          await new Promise((r) => setTimeout(r, 700));
        }
        try {
          await sendTrackedMessage(currentSocket, resolvedJid, { text: crafted.messageText });
          deliveredLive = true;
          dailyReplyCount += 1;
          deliveryNote = `${resolvedName}-এর ইনবক্সে সফলভাবে নক করা হয়েছে!`;

          await recordZeroTokenMediaExchange({
            chatJid: resolvedJid,
            displayName: resolvedName,
            isGroup: false,
            incomingSummary: `[Owner Direct Command -> DM Knock]: ${instruction}`,
            replyText: crafted.messageText,
          });
        } finally {
          if (botConfig.humanTypingEnabled) {
            void currentSocket.sendPresenceUpdate('paused', resolvedJid).catch(() => {});
          }
        }
      }

      const cmdRecord: DirectCommandLogItem = {
        id: `dcmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        actionType: 'dm_knock',
        targetLabel: resolvedName,
        targetJid: resolvedJid,
        mentionedJids: [],
        instruction,
        messageSent: crafted.messageText,
        deliveredLive,
        usedAi: useAiCraft,
        providerUsed: crafted.providerUsed,
      };
      if (!dryRun) {
        recentDirectCommands.unshift(cmdRecord);
        if (recentDirectCommands.length > 30) recentDirectCommands.length = 30;
        pushLog(
          'autoreply',
          `Command · ${resolvedName}`,
          `DM Knock (${deliveredLive ? 'Live Sent' : 'Draft'}): ${crafted.messageText.slice(0, 80)}`,
          deliveredLive ? 'success' : 'info'
        );
      }

      res.json({
        ok: true,
        dryRun,
        deliveredLive,
        actionType: 'dm_knock',
        targetLabel: resolvedName,
        targetJid: resolvedJid,
        mentionedJids: [],
        messageText: crafted.messageText,
        providerUsed: crafted.providerUsed,
        note: deliveryNote,
        commandRecord: cmdRecord,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message || 'Direct command execution failed.' });
    }
  });

  app.get('/api/assistant/self-chat', (_req, res) => {
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    res.json({
      enabled: botConfig.selfChatCopilotEnabled !== false,
      zeroTokenOnly: true,
      connectedPhone: currentPairingPhone || extractDigits(currentSocket?.user?.id) || '',
      botStatus,
      memoryRssMb: rssMb,
      history: selfChatHistory.slice(-25),
      contactPolicies: botConfig.contactPolicies || [],
    });
  });

  app.post('/api/assistant/self-chat', async (req, res) => {
    try {
      const body = req.body as {
        text?: string;
        clear?: boolean;
        media?: SimulatedMediaInput;
      };
      if (body?.clear) {
        selfChatHistory = [];
        pendingSelfChatDraft = null;
        saveJsonFileAsync(SELF_CHAT_FILE, []);
        res.json({ ok: true, history: [], memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)) });
        return;
      }
      const incomingText = String(body?.text || '').trim();
      const media = body?.media;
      if (!incomingText && !media) {
        res.status(400).json({ error: 'মেসেজ বা ভিডিও/মিডিয়া স্যাম্পল দিন।' });
        return;
      }

      const mediaInsight = media ? await analyzeSimulatedMediaZeroToken(media) : null;
      const result = await executeZeroTokenSelfChatTurn({
        incomingText: incomingText || mediaInsight?.caption || '',
        mediaInsight,
      });

      res.json({
        ok: true,
        replyText: result.replyText,
        actionSummary: result.actionSummary,
        tokensUsed: 0,
        memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        history: selfChatHistory.slice(-25),
        contactPolicies: botConfig.contactPolicies || [],
        config: botConfig,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message || 'Self-Chat copilot failed.' });
    }
  });

  app.post('/api/assistant/contact-policies', (req, res) => {
    try {
      const body = req.body as { policies?: ContactPolicyEntry[] };
      if (!Array.isArray(body?.policies)) {
        res.status(400).json({ error: 'Invalid contact policies payload.' });
        return;
      }
      botConfig = normalizeConfig({
        ...botConfig,
        contactPolicies: body.policies,
        configUpdatedAt: new Date().toISOString(),
      });
      persistConfig(true);
      res.json({ ok: true, contactPolicies: botConfig.contactPolicies, config: botConfig });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message || 'Failed saving contact policies.' });
    }
  });

  app.get('/api/media/stories', (_req, res) => {
    const dailyStats = getDailyReplyStats();
    const geminiStats = geminiPool.getStats();
    const openRouterStats = openRouterReader.getStats();
    const snap = tokenTelemetry.getSnapshot({
      whatsappUsedToday: dailyStats.count,
      whatsappDailyLimit: dailyStats.limit,
      configuredGeminiKeys: geminiStats.configuredKeysCount,
      geminiSlotCooldowns: geminiPool.getSlotCooldownStats(),
      openRouterConfiguredKeys: openRouterStats.configuredKeysCount,
      openRouterFreeModelsCount: openRouterStats.dynamicPool?.discoveredFreeModelsCount || 0,
      openRouterActiveModel:
        openRouterStats.dynamicPool?.activeFreeModel || openRouterStats.primaryModel,
    });
    res.json({
      stories: recentMediaStories,
      stats: snap.zeroTokenMedia,
    });
  });

  // --------------------------------------------------------------------------
  // Interactive Simulator (Supports Commands + AI Executive Assistant + Takeover + Zero-Token Media)
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
      const simMedia = body?.media;

      if (!text && !simMedia && chatType !== 'story') {
        res.status(400).json({ error: 'Message text or media sample cannot be empty.' });
        return;
      }

      const isGroup = chatType === 'group_bot_admin' || chatType === 'group_bot_non_admin';
      const botIsAdmin = chatType === 'group_bot_admin';
      const isSelf = chatType === 'self';
      const isStorySim = chatType === 'story' || simMedia?.kind?.startsWith('story_');

      // -1. Simulator Owner Self-Chat ("Message Yourself") with 0-Token Copilot & Video Mistake Diagnostics
      if (isSelf && !text.startsWith(PREFIX) && botConfig.selfChatCopilotEnabled !== false) {
        const mediaInsight = simMedia ? await analyzeSimulatedMediaZeroToken(simMedia) : null;
        const result = await executeZeroTokenSelfChatTurn({
          incomingText: text || mediaInsight?.caption || '',
          mediaInsight,
        });
        res.json({
          deleted: false,
          reply: result.replyText,
          note: `${result.actionSummary} · strictly 0 tokens`,
          mediaInsight: mediaInsight || undefined,
          tokensSpent: 0,
          ruleTriggered: 'OWNER_SELF_CHAT_COPILOT',
          config: botConfig,
        });
        return;
      }

      // 0. Zero-Token Story & Media Evaluation (when media preset / image / story mode is provided)
      if (simMedia || isStorySim) {
        const matchedStoryWhitelist = isStorySim
          ? findMatchingStoryWhitelistContact({
              jids: [contactJid, body?.senderJid],
              phone: extractPhoneDigitsOnly(contactJid || body?.senderJid),
              names: [contactName],
            })
          : null;

        if (isStorySim && botConfig.storyWhitelistMode === 'selected_only' && !matchedStoryWhitelist) {
          res.json({
            deleted: false,
            reply: null,
            note: `Story Skipped: "${contactName}" আপনার Custom Story Whitelist-এ যোগ করা নেই। শুধু সিলেক্টেড কন্টাক্টের স্টোরি দেখা ও ইনবক্সে মেসেজ পাঠানো হবে।`,
            ruleTriggered: 'STORY_WHITELIST_SKIPPED',
            tokensSpent: 0,
            config: botConfig,
          });
          return;
        }

        const mediaPayload: SimulatedMediaInput = simMedia
          ? {
              ...simMedia,
              kind:
                isStorySim && simMedia.kind === 'photo'
                  ? 'story_photo'
                  : isStorySim && simMedia.kind === 'video'
                    ? 'story_video'
                    : simMedia.kind,
              caption: simMedia.caption !== undefined ? simMedia.caption : text,
            }
          : {
              kind: 'story_text',
              caption: text,
            };
        const rawInsight = await analyzeSimulatedMediaZeroToken(mediaPayload);
        const insight = applyCustomPromptHintToInsight(rawInsight, matchedStoryWhitelist?.customPrompt || '');
        const simContext: 'dm' | 'group' | 'story' = isStorySim ? 'story' : isGroup ? 'group' : 'dm';
        const effectiveText = insight.compactContextLine;

        const useHybridAi =
          !botConfig.mediaZeroTokenReplyMode &&
          !isStorySim &&
          insight.caption.trim().length > 15 &&
          botConfig.aiAssistantEnabled &&
          (geminiPool.hasKeys() || openRouterReader.hasKeys());

        if (isGroup && useHybridAi && botConfig.groupAiEnabled) {
          tokenTelemetry.recordZeroTokenMediaRead({
            kind: insight.kind,
            isStory: false,
            repliedWithZeroTokens: false,
          });
          const simGroupName = chatMemories[sanitizeId(groupJid)]?.contactName || 'Simulator Group';
          const decision = await runGroupCloneTurn({
            groupJid,
            groupName: simGroupName,
            senderName: contactName || 'Friend',
            senderJid: body?.senderJid || contactJid,
            incomingText: effectiveText,
            isDirectlyAddressed: true,
            canTextReply: true,
          });
          recordMediaStoryFeedItem({
            source: 'simulator',
            senderName: contactName,
            senderJid: groupJid,
            kind: insight.kind,
            sentiment: insight.sentiment,
            banglaSceneLabel: insight.banglaSceneLabel,
            compactContextLine: insight.compactContextLine,
            reactionSent: decision.reactionEmoji || insight.recommendedReaction,
            replySent: decision.replyText || '',
            replyMode: decision.providerUsed === 'offline_emotion' ? 'zero_token' : 'hybrid_text_ai',
          });
          res.json({
            deleted: false,
            reply: decision.replyText || null,
            reactionEmoji: decision.reactionEmoji || insight.recommendedReaction,
            mediaInsight: insight,
            providerUsed: decision.providerUsed,
            ruleTriggered: 'HYBRID_MEDIA_GROUP_CLONE',
            config: botConfig,
          });
          return;
        }

        if (!isGroup && !isStorySim && useHybridAi && botConfig.autoreply) {
          tokenTelemetry.recordZeroTokenMediaRead({
            kind: insight.kind,
            isStory: false,
            repliedWithZeroTokens: false,
          });
          const resTurn = await runExecutiveAssistantTurn({
            contactJid,
            contactName,
            incomingText: effectiveText,
          });
          recordMediaStoryFeedItem({
            source: 'simulator',
            senderName: contactName,
            senderJid: contactJid,
            kind: insight.kind,
            sentiment: insight.sentiment,
            banglaSceneLabel: insight.banglaSceneLabel,
            compactContextLine: insight.compactContextLine,
            reactionSent: insight.recommendedReaction,
            replySent: resTurn.replyText,
            replyMode: resTurn.usedFallback ? 'zero_token' : 'hybrid_text_ai',
          });
          res.json({
            deleted: false,
            reply: resTurn.replyText,
            reactionEmoji: insight.recommendedReaction,
            mediaInsight: insight,
            providerUsed: resTurn.providerUsed,
            ruleTriggered: 'HYBRID_MEDIA_DM_ASSISTANT',
            config: botConfig,
          });
          return;
        }

        // Default 100% Zero-Token Media Read + Zero-Token Text-Only SMS Reply
        const generated = generateZeroTokenMediaReply({
          insight,
          context: simContext,
          senderName: contactName,
          tone: botConfig.assistantTone,
          ownerName: botConfig.ownerName,
          previousReplies: getPreviousAssistantRepliesForChat(isGroup ? groupJid : contactJid),
        });
        tokenTelemetry.recordZeroTokenMediaRead({
          kind: insight.kind,
          isStory: isStorySim,
          repliedWithZeroTokens: true,
        });
        await recordZeroTokenMediaExchange({
          chatJid: isGroup ? groupJid : contactJid,
          displayName: contactName,
          isGroup,
          senderNameInGroup: isGroup ? contactName : undefined,
          incomingSummary: insight.compactContextLine,
          replyText: generated.replyText,
        });
        recordMediaStoryFeedItem({
          source: 'simulator',
          senderName: contactName,
          senderJid: isGroup ? groupJid : contactJid,
          kind: insight.kind,
          sentiment: insight.sentiment,
          banglaSceneLabel: insight.banglaSceneLabel,
          compactContextLine: insight.compactContextLine,
          reactionSent: generated.reactionEmoji,
          replySent: generated.replyText,
          replyMode: 'zero_token',
        });
        pushLog(
          'autoreply',
          `Simulator · ${contactName}`,
          `0-Token Media (${insight.banglaSceneLabel}) -> Text SMS Reply (0 Tokens Spent)`,
          'success'
        );
        res.json({
          deleted: false,
          reply: generated.replyText,
          reactionEmoji: generated.reactionEmoji,
          mediaInsight: insight,
          providerUsed: 'zero_token_media',
          tokensSpent: 0,
          ruleTriggered: 'ZERO_TOKEN_MEDIA_INTELLIGENCE',
          config: botConfig,
        });
        return;
      }

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
        const simSenderJid = body?.senderJid || contactJid;
        const simGroupPolicy = findMatchingContactPolicy({
          jids: [simSenderJid],
          phone: extractPhoneDigitsOnly(simSenderJid),
          names: [contactName],
        });
        if (simGroupPolicy?.mode === 'mute_ai') {
          res.json({
            deleted: false,
            reply: null,
            note: `Group Member Policy Active (Off/Mute): "${contactName}"-কে গ্রুপ AI থেকে মিউট রাখা হয়েছে (০ টোকেন)।`,
            ruleTriggered: 'GROUP_MEMBER_MUTED',
            tokensSpent: 0,
            config: botConfig,
          });
          return;
        }
        const simGroupName = chatMemories[sanitizeId(groupJid)]?.contactName || 'Simulator Group';
        const decision = await runGroupCloneTurn({
          groupJid,
          groupName: simGroupName,
          senderName: contactName || 'Friend',
          senderJid: simSenderJid,
          incomingText: text,
          isDirectlyAddressed: text.includes('@') || text.toLowerCase().includes((botConfig.ownerName || '').toLowerCase()),
          canTextReply: true,
        });
        res.json({
          deleted: false,
          reply: decision.replyText || null,
          reactionEmoji: decision.reactionEmoji || undefined,
          groupAction: decision.action,
          note: `Group Clone Action: ${decision.action}${decision.reactionEmoji ? ` (${decision.reactionEmoji})` : ''}${decision.matchedTargetName ? ` [Target: @${decision.matchedTargetName}]` : ''} — ${decision.reason}`,
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
          const simPolicy = findMatchingContactPolicy({
            jids: [contactJid],
            phone: extractPhoneDigitsOnly(contactJid),
            names: [contactName],
          });

          if (simPolicy?.mode === 'mute_ai') {
            recordPassiveIncomingTurn(contactJid, contactName, text, false);
            res.json({
              deleted: false,
              reply: null,
              note: `Contact Policy Active (Mute/Blocked): "${contactName}"-কে মিউট রাখা হয়েছে (০ টোকেন, কোনো রিপ্লাই পাঠানো হয়নি)।`,
              ruleTriggered: 'CONTACT_POLICY_MUTED',
              tokensSpent: 0,
              config: botConfig,
            });
            return;
          }

          if (simPolicy?.mode === 'hold_wait') {
            const mem = await ensureChatMemoryHydrated(sanitizeId(contactJid), contactJid, contactName);
            const prevReplies = (mem?.turns || []).filter((t) => t.role === 'assistant').slice(-5).map((t) => t.text);
            const holdReply = generateZeroTokenHoldReply({
              contactName,
              note: simPolicy.note,
              previousAssistantReplies: prevReplies,
              ownerName: botConfig.ownerName,
            });
            await recordZeroTokenMediaExchange({
              chatJid: contactJid,
              displayName: contactName,
              isGroup: false,
              incomingSummary: text,
              replyText: holdReply,
            });
            res.json({
              deleted: false,
              reply: holdReply,
              note: `Contact Policy Active (Hold/Wait): "${contactName}"-কে ০ টোকেনে ভদ্রভাবে আটকে/অপেক্ষায় রাখা হয়েছে।`,
              providerUsed: 'offline_emotion',
              ruleTriggered: 'CONTACT_POLICY_HOLD_WAIT',
              tokensSpent: 0,
              config: botConfig,
            });
            return;
          }

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
            contactPolicy: simPolicy ? { mode: simPolicy.mode, note: simPolicy.note } : undefined,
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
            ruleTriggered:
              simPolicy?.mode === 'long_engage'
                ? 'CONTACT_POLICY_LONG_ENGAGE'
                : usedFallback
                  ? 'STATIC_AUTOREPLY'
                  : 'AI_EXECUTIVE_ASSISTANT',
            config: botConfig,
          });
          return;
        }

        if (chatType === 'self') {
          res.json({
            deleted: false,
            reply: null,
            note: 'Self-Chat Copilot is currently disabled in settings.',
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

  // Forever 24/7 Self-Ping Keep-Alive State (prevents Hugging Face Spaces / Cloud instance inactivity sleep)
  const SELF_PING_INTERVAL_MS = 4 * 60 * 1000; // Every 4 minutes

  function resolveSelfPingTargetUrl(): string {
    const explicit = process.env.SELF_PING_URL?.trim();
    if (explicit && /^https?:\/\//i.test(explicit)) return explicit;

    const spaceHost = process.env.SPACE_HOST?.trim();
    if (spaceHost) {
      const normalizedSpace = /^https?:\/\//i.test(spaceHost) ? spaceHost : `https://${spaceHost}`;
      return `${normalizedSpace.replace(/\/+$/, '')}/health`;
    }

    const renderUrl = process.env.RENDER_EXTERNAL_URL?.trim();
    if (renderUrl && /^https?:\/\//i.test(renderUrl)) return `${renderUrl.replace(/\/+$/, '')}/health`;

    const appUrl = process.env.APP_URL?.trim();
    if (appUrl && appUrl !== 'MY_APP_URL' && /^https?:\/\//i.test(appUrl)) {
      return `${appUrl.replace(/\/+$/, '')}/health`;
    }

    if (learnedPublicBaseUrl) {
      return `${learnedPublicBaseUrl}/health`;
    }

    return `http://127.0.0.1:${PORT}/health`;
  }

  // Enabled forever unless explicitly disabled with ENABLE_SELF_PING=false
  const selfPingEnabled = process.env.ENABLE_SELF_PING !== 'false';

  let lastSelfPingAt: string | null = null;
  let lastSelfPingOk: boolean | null = null;
  let lastSelfPingTarget = resolveSelfPingTargetUrl();
  let isSelfPingInFlight = false;
  let selfPingTimer: ReturnType<typeof setInterval> | null = null;
  let selfPingWarmupTimer: ReturnType<typeof setTimeout> | null = null;
  let selfPingRetryTimer: ReturnType<typeof setTimeout> | null = null;

  getRuntimeSelfPingSnapshot = () => ({
    enabled: selfPingEnabled,
    targetUrl: resolveSelfPingTargetUrl(),
    lastPingAt: lastSelfPingAt,
    lastPingOk: lastSelfPingOk,
  });

  async function executeSelfPing(isRetry = false) {
    if (isShuttingDown || isSelfPingInFlight) return;
    isSelfPingInFlight = true;
    const targetUrl = resolveSelfPingTargetUrl();
    lastSelfPingTarget = targetUrl;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12_000);
    try {
      const resp = await fetch(targetUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'WaNexus-ForeverKeepAlive/2.0',
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
      console.warn(`[KeepAlive] Self-ping failed (${targetUrl}): ${(err as Error).message}`);
      // Fallback loopback ping so local event-loop health stays confirmed + quick 15s retry
      if (!targetUrl.includes('127.0.0.1')) {
        void fetch(`http://127.0.0.1:${PORT}/health`).catch(() => {});
      }
      if (!isRetry && !isShuttingDown && !selfPingRetryTimer) {
        selfPingRetryTimer = setTimeout(() => {
          selfPingRetryTimer = null;
          void executeSelfPing(true);
        }, 15_000);
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
      firestore: getFirestoreAdminDiagnostics(),
      clientBots: clientBotManager.getSummaryCounts(),
      watchdog: selfHealingWatchdog ? selfHealingWatchdog.getStatus() : null,
      mobileOffload: mobileOffloadQueue.getStatusSnapshot(),
      selfPing: {
        enabled: selfPingEnabled,
        intervalMs: SELF_PING_INTERVAL_MS,
        targetUrl: lastSelfPingTarget || resolveSelfPingTargetUrl(),
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

    // Start 4-minute Forever Keep-Alive Self-Ping so Render / Cloud instance stays awake 24/7
    if (selfPingEnabled) {
      const targetAtBoot = resolveSelfPingTargetUrl();
      console.log(
        `[KeepAlive] Forever Self-Ping enabled: pinging ${targetAtBoot} every ${SELF_PING_INTERVAL_MS / 60000} minutes.`
      );
      selfPingWarmupTimer = setTimeout(() => {
        selfPingWarmupTimer = null;
        void executeSelfPing();
      }, 15_000);

      selfPingTimer = setInterval(() => {
        void executeSelfPing();
      }, SELF_PING_INTERVAL_MS);
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
    autonomousAgentEngine?.stopScheduler();
    selfHealingWatchdog?.stop();
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
