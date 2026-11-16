import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
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
  adminDeleteDocument,
  adminLoadCollection,
  adminLoadDocument,
  adminSaveDocument,
} from './firestoreAdmin.ts';
import {
  pgDeleteClientBot,
  pgDeleteSingleSessionBackup,
  pgLoadClientBots,
  pgLoadSessionBackup,
  pgSaveClientBot,
  pgSaveSessionBackup,
} from './postgresStore.ts';

export type ClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaiting_pairing'
  | 'connected'
  | 'suspended';

export interface ClientGroupRule {
  groupJid: string;
  groupName: string;
  enabled: boolean;
  deleteLinks: boolean;
  deleteStickers: boolean;
  deleteMedia: boolean;
  warnEnabled: boolean;
  maxWarnings: number;
  kickOnLimit: boolean;
  warningTemplate: string;
  kickTemplate: string;
  userWarnings: Record<string, number>;
}

export interface ClientKeywordReply {
  id: string;
  keyword: string;
  reply: string;
  enabled: boolean;
}

export interface ClientBotStats {
  deletedCount: number;
  warnedCount: number;
  kickedCount: number;
  savedRepliesSent: number;
  lastActivityAt: string | null;
}

export interface ClientBotRecord {
  botId: string;
  ownerId: string;
  clientName: string;
  phoneNumber: string;
  active: boolean;
  clientAccessKey: string;
  moderateAllGroups: boolean;
  defaultModeration: Omit<ClientGroupRule, 'groupJid' | 'groupName' | 'userWarnings'>;
  groupRules: Record<string, ClientGroupRule>;
  savedReplyEnabled: boolean;
  savedReplyMessage: string;
  savedReplyCooldownMs: number;
  keywordReplies: ClientKeywordReply[];
  stats: ClientBotStats;
  createdAt: string;
  updatedAt: string;
}

export interface ClientBotLogEntry {
  id: string;
  timestamp: string;
  category: 'pairing' | 'moderation' | 'savedreply' | 'command' | 'system';
  actor: string;
  summary: string;
  outcome: 'success' | 'blocked' | 'info' | 'error';
}

export interface ClientKnownGroup {
  jid: string;
  name: string;
  participantCount: number;
  botIsAdmin: boolean;
}

export interface ClientBotRuntimeView extends ClientBotRecord {
  status: ClientConnectionStatus;
  connectedUser: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  sessionExists: boolean;
  lastError: string | null;
  logs: ClientBotLogEntry[];
  knownGroups: ClientKnownGroup[];
}

export interface ClientBotPatchInput {
  clientName?: string;
  active?: boolean;
  moderateAllGroups?: boolean;
  defaultModeration?: Partial<Omit<ClientGroupRule, 'groupJid' | 'groupName' | 'userWarnings'>>;
  groupRules?: Record<string, Partial<ClientGroupRule>>;
  upsertGroupRule?: Partial<ClientGroupRule> & { groupJid: string };
  removeGroupJid?: string;
  savedReplyEnabled?: boolean;
  savedReplyMessage?: string;
  savedReplyCooldownMs?: number;
  keywordReplies?: ClientKeywordReply[];
}

const CLIENT_BOTS_FILE = path.resolve('./client-bots.json');
const CLIENT_SESSIONS_ROOT = path.resolve('./client_sessions');
const baileysLogger = pino({ level: 'silent' });

export const DEFAULT_WARNING_TEMPLATE =
  '⚠️ {user}, অনুগ্রহ করে এই গ্রুপে {reason} পাঠাবেন না! সতর্কতা: {count}/{max}';

export const DEFAULT_KICK_TEMPLATE =
  '🚫 {user} সর্বোচ্চ {max} বার নিয়ম ({reason}) ভঙ্গ করায় গ্রুপ থেকে রিমুভ করা হয়েছে।';

export const DEFAULT_SAVED_REPLY =
  'আসসালামু আলাইকুম! মেসেজের জন্য ধন্যবাদ। আপনার বার্তাটি রিসিভ হয়েছে, একটু পর রিপ্লাই দেওয়া হবে।';

const LINK_PATTERNS: RegExp[] = [
  /(?:https?:\/\/|www\.)[^\s]+/gi,
  /\b(?:t\.me|telegram\.me|wa\.me|chat\.whatsapp\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|fb\.com|instagram\.com|instagr\.am|twitter\.com|x\.com|tiktok\.com|discord\.gg|discord\.com\/invite|bit\.ly|tinyurl\.com|goo\.gl|cutt\.ly|rb\.gy)\b[^\s]*/gi,
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|me|tv|gg|xyz|info|biz|app|dev|ai|ly|link|online|site|store|tech)(?:\/[^\s]*)?\b/gi,
];

function sanitizeBotId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || `client_${Date.now().toString(36)}`).slice(0, 64);
}

function generateAccessKey(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function extractDigits(jid: string | undefined | null): string {
  if (!jid) return '';
  const normalized = jidNormalizedUser(jid);
  return normalized.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function containsLink(text: string): boolean {
  if (!text) return false;
  for (const pattern of LINK_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

function unwrapMessage(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message
  );
}

export function extractClientMessageText(message: proto.IMessage | null | undefined): string {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return '';
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

export function detectViolationReason(
  message: proto.IMessage | null | undefined,
  text: string,
  rule: Pick<ClientGroupRule, 'deleteLinks' | 'deleteStickers' | 'deleteMedia'>
): string | null {
  const unwrapped = unwrapMessage(message);
  if (rule.deleteLinks && containsLink(text)) {
    return 'লিংক শেয়ার';
  }
  if (rule.deleteStickers && Boolean(unwrapped?.stickerMessage)) {
    return 'স্টিকার';
  }
  if (
    rule.deleteMedia &&
    Boolean(
      unwrapped?.imageMessage ||
        unwrapped?.videoMessage ||
        unwrapped?.documentMessage ||
        unwrapped?.ptvMessage ||
        unwrapped?.audioMessage
    )
  ) {
    return 'মিডিয়া/ছবি/ভিডিও';
  }
  return null;
}

export function formatModerationTemplate(
  template: string,
  vars: { userTag: string; reason: string; count: number; max: number }
): string {
  return (template || DEFAULT_WARNING_TEMPLATE)
    .replace(/\{user\}/gi, vars.userTag)
    .replace(/\{reason\}/gi, vars.reason)
    .replace(/\{count\}/gi, String(vars.count))
    .replace(/\{max\}/gi, String(vars.max));
}

export function defaultGroupRule(groupJid = 'default', groupName = 'Group'): ClientGroupRule {
  return {
    groupJid,
    groupName,
    enabled: true,
    deleteLinks: true,
    deleteStickers: false,
    deleteMedia: false,
    warnEnabled: true,
    maxWarnings: 3,
    kickOnLimit: false,
    warningTemplate: DEFAULT_WARNING_TEMPLATE,
    kickTemplate: DEFAULT_KICK_TEMPLATE,
    userWarnings: {},
  };
}

function normalizeGroupRule(
  groupJid: string,
  raw: Partial<ClientGroupRule> | undefined,
  fallbackDefault?: Omit<ClientGroupRule, 'groupJid' | 'groupName' | 'userWarnings'>
): ClientGroupRule {
  const base = fallbackDefault
    ? { ...fallbackDefault, groupJid, groupName: groupJid, userWarnings: {} }
    : defaultGroupRule(groupJid, groupJid);
  const rawMax = typeof raw?.maxWarnings === 'number' ? raw.maxWarnings : base.maxWarnings;
  const userWarnings: Record<string, number> = {};
  if (raw?.userWarnings && typeof raw.userWarnings === 'object') {
    for (const [k, v] of Object.entries(raw.userWarnings)) {
      if (typeof v === 'number' && v > 0 && Number.isFinite(v)) {
        userWarnings[k] = Math.min(100, Math.round(v));
      }
    }
  }
  return {
    groupJid,
    groupName:
      typeof raw?.groupName === 'string' && raw.groupName.trim()
        ? raw.groupName.trim().slice(0, 120)
        : base.groupName,
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : base.enabled,
    deleteLinks: typeof raw?.deleteLinks === 'boolean' ? raw.deleteLinks : base.deleteLinks,
    deleteStickers: typeof raw?.deleteStickers === 'boolean' ? raw.deleteStickers : base.deleteStickers,
    deleteMedia: typeof raw?.deleteMedia === 'boolean' ? raw.deleteMedia : base.deleteMedia,
    warnEnabled: typeof raw?.warnEnabled === 'boolean' ? raw.warnEnabled : base.warnEnabled,
    maxWarnings: Math.max(1, Math.min(20, Math.round(rawMax))),
    kickOnLimit: typeof raw?.kickOnLimit === 'boolean' ? raw.kickOnLimit : base.kickOnLimit,
    warningTemplate:
      typeof raw?.warningTemplate === 'string' && raw.warningTemplate.trim()
        ? raw.warningTemplate.trim().slice(0, 500)
        : base.warningTemplate,
    kickTemplate:
      typeof raw?.kickTemplate === 'string' && raw.kickTemplate.trim()
        ? raw.kickTemplate.trim().slice(0, 500)
        : base.kickTemplate,
    userWarnings,
  };
}

function normalizeClientBot(raw: Partial<ClientBotRecord>, fallbackOwnerId: string): ClientBotRecord {
  const nowIso = new Date().toISOString();
  const botId = sanitizeBotId(raw.botId || `client_${Date.now().toString(36)}`);
  const defaultModerationRule = normalizeGroupRule('default', raw.defaultModeration);
  const defaultModeration: Omit<ClientGroupRule, 'groupJid' | 'groupName' | 'userWarnings'> = {
    enabled: defaultModerationRule.enabled,
    deleteLinks: defaultModerationRule.deleteLinks,
    deleteStickers: defaultModerationRule.deleteStickers,
    deleteMedia: defaultModerationRule.deleteMedia,
    warnEnabled: defaultModerationRule.warnEnabled,
    maxWarnings: defaultModerationRule.maxWarnings,
    kickOnLimit: defaultModerationRule.kickOnLimit,
    warningTemplate: defaultModerationRule.warningTemplate,
    kickTemplate: defaultModerationRule.kickTemplate,
  };

  const groupRules: Record<string, ClientGroupRule> = {};
  if (raw.groupRules && typeof raw.groupRules === 'object') {
    for (const [jid, rule] of Object.entries(raw.groupRules)) {
      if (!jid || typeof rule !== 'object' || !rule) continue;
      groupRules[jid] = normalizeGroupRule(jid, rule, defaultModeration);
    }
  }

  const keywordReplies: ClientKeywordReply[] = Array.isArray(raw.keywordReplies)
    ? raw.keywordReplies
        .filter((item) => item && typeof item.keyword === 'string' && typeof item.reply === 'string')
        .slice(0, 50)
        .map((item, idx) => ({
          id: typeof item.id === 'string' && item.id ? item.id : `kw_${idx}_${Date.now()}`,
          keyword: item.keyword.trim().slice(0, 100),
          reply: item.reply.trim().slice(0, 1500),
          enabled: item.enabled !== false,
        }))
        .filter((item) => item.keyword.length > 0 && item.reply.length > 0)
    : [];

  return {
    botId,
    ownerId: typeof raw.ownerId === 'string' && raw.ownerId ? raw.ownerId : fallbackOwnerId,
    clientName:
      typeof raw.clientName === 'string' && raw.clientName.trim()
        ? raw.clientName.trim().slice(0, 120)
        : `Client ${botId}`,
    phoneNumber: typeof raw.phoneNumber === 'string' ? raw.phoneNumber.replace(/\D/g, '').slice(0, 20) : '',
    active: typeof raw.active === 'boolean' ? raw.active : true,
    clientAccessKey:
      typeof raw.clientAccessKey === 'string' && raw.clientAccessKey.length >= 16
        ? raw.clientAccessKey
        : generateAccessKey(),
    moderateAllGroups: typeof raw.moderateAllGroups === 'boolean' ? raw.moderateAllGroups : true,
    defaultModeration,
    groupRules,
    savedReplyEnabled: typeof raw.savedReplyEnabled === 'boolean' ? raw.savedReplyEnabled : false,
    savedReplyMessage:
      typeof raw.savedReplyMessage === 'string' && raw.savedReplyMessage.trim()
        ? raw.savedReplyMessage.trim().slice(0, 2000)
        : DEFAULT_SAVED_REPLY,
    savedReplyCooldownMs:
      typeof raw.savedReplyCooldownMs === 'number' && raw.savedReplyCooldownMs >= 0
        ? Math.min(86_400_000, Math.round(raw.savedReplyCooldownMs))
        : 60_000,
    keywordReplies,
    stats: {
      deletedCount: Number(raw.stats?.deletedCount || 0),
      warnedCount: Number(raw.stats?.warnedCount || 0),
      kickedCount: Number(raw.stats?.kickedCount || 0),
      savedRepliesSent: Number(raw.stats?.savedRepliesSent || 0),
      lastActivityAt: typeof raw.stats?.lastActivityAt === 'string' ? raw.stats.lastActivityAt : null,
    },
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowIso,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : nowIso,
  };
}

interface ClientRuntimeState {
  status: ClientConnectionStatus;
  socket: WASocket | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  lastError: string | null;
  reconnectAttempts: number;
  manualDisconnect: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  credsBackupTimer: ReturnType<typeof setTimeout> | null;
  logs: ClientBotLogEntry[];
  groupMetadataCache: Map<string, { metadata: GroupMetadata; expiresAt: number }>;
  savedReplyCooldowns: Map<string, number>;
  sentMessageIds: Set<string>;
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

export class ClientBotManager {
  private bots = new Map<string, ClientBotRecord>();
  private runtimes = new Map<string, ClientRuntimeState>();
  private ownerIdGetter: () => string;
  private onEventHook?: (summary: string, outcome?: 'success' | 'blocked' | 'info' | 'error') => void;
  private isShuttingDown = false;
  private persistLocalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    getOwnerId: () => string;
    onEvent?: (summary: string, outcome?: 'success' | 'blocked' | 'info' | 'error') => void;
  }) {
    this.ownerIdGetter = options.getOwnerId;
    this.onEventHook = options.onEvent;
    this.loadFromLocalDisk();
  }

  private getSessionDir(botId: string): string {
    return path.join(CLIENT_SESSIONS_ROOT, sanitizeBotId(botId));
  }

  private getRuntime(botId: string): ClientRuntimeState {
    let rt = this.runtimes.get(botId);
    if (!rt) {
      rt = {
        status: 'disconnected',
        socket: null,
        pairingCode: null,
        pairingPhone: null,
        lastError: null,
        reconnectAttempts: 0,
        manualDisconnect: false,
        reconnectTimer: null,
        credsBackupTimer: null,
        logs: [],
        groupMetadataCache: new Map(),
        savedReplyCooldowns: new Map(),
        sentMessageIds: new Set(),
      };
      this.runtimes.set(botId, rt);
    }
    return rt;
  }

  private pushBotLog(
    botId: string,
    category: ClientBotLogEntry['category'],
    actor: string,
    summary: string,
    outcome: ClientBotLogEntry['outcome'] = 'info'
  ) {
    const rt = this.getRuntime(botId);
    rt.logs.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      category,
      actor,
      summary,
      outcome,
    });
    if (rt.logs.length > 60) {
      rt.logs.length = 60;
    }
  }

  private loadFromLocalDisk() {
    try {
      if (fs.existsSync(CLIENT_BOTS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(CLIENT_BOTS_FILE, 'utf8'));
        if (Array.isArray(parsed)) {
          for (const raw of parsed) {
            const normalized = normalizeClientBot(raw, this.ownerIdGetter());
            this.bots.set(normalized.botId, normalized);
          }
        }
      }
    } catch (err) {
      console.warn('[ClientBotManager] Failed reading local client-bots.json:', (err as Error).message);
    }
  }

  private persistLocalAll() {
    if (this.persistLocalTimer) clearTimeout(this.persistLocalTimer);
    this.persistLocalTimer = setTimeout(() => {
      this.persistLocalTimer = null;
      const list = Array.from(this.bots.values());
      void fs.promises
        .writeFile(CLIENT_BOTS_FILE, JSON.stringify(list, null, 2), 'utf8')
        .catch(() => {});
    }, 150);
  }

  private persistBot(record: ClientBotRecord, syncCloud = true) {
    this.persistLocalAll();
    if (!syncCloud) return;
    const ownerId = record.ownerId || this.ownerIdGetter();
    void pgSaveClientBot(record.botId, ownerId, record as unknown as Record<string, unknown>);
    void adminSaveDocument('client_bots', record.botId, {
      ...record,
      ownerId,
    });
  }

  async init(): Promise<void> {
    if (!fs.existsSync(CLIENT_SESSIONS_ROOT)) {
      fs.mkdirSync(CLIENT_SESSIONS_ROOT, { recursive: true });
    }

    // Hydrate from Postgres & Firestore
    try {
      const [pgBots, fsBots] = await Promise.all([
        pgLoadClientBots<Partial<ClientBotRecord>>().catch(() => []),
        adminLoadCollection<Partial<ClientBotRecord>>('client_bots').catch(() => []),
      ]);

      for (const raw of [...pgBots, ...fsBots]) {
        if (!raw || typeof raw !== 'object' || !raw.botId) continue;
        const normalized = normalizeClientBot(raw, this.ownerIdGetter());
        const existing = this.bots.get(normalized.botId);
        if (!existing || Date.parse(normalized.updatedAt) > Date.parse(existing.updatedAt)) {
          this.bots.set(normalized.botId, normalized);
        }
      }
      this.persistLocalAll();
    } catch (err) {
      console.warn('[ClientBotManager] Cloud hydration warning:', (err as Error).message);
    }

    // Staggered auto-resume for active client bots that already have registered sessions
    let delayMs = 1500;
    for (const bot of this.bots.values()) {
      if (!bot.active) {
        const rt = this.getRuntime(bot.botId);
        rt.status = 'suspended';
        continue;
      }
      const botId = bot.botId;
      setTimeout(() => {
        if (this.isShuttingDown) return;
        void this.tryAutoResumeBot(botId);
      }, delayMs);
      delayMs += 900;
    }
  }

  private async tryAutoResumeBot(botId: string) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.active || this.isShuttingDown) return;

    await this.restoreCredsIfMissing(botId);
    const credsPath = path.join(this.getSessionDir(botId), 'creds.json');
    if (!fs.existsSync(credsPath)) return;

    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (creds?.registered) {
        this.pushBotLog(botId, 'pairing', 'System', 'Resuming existing WhatsApp session...', 'info');
        await this.startSocket(botId);
      }
    } catch {
      // ignore malformed creds
    }
  }

  private async restoreCredsIfMissing(botId: string) {
    const sessDir = this.getSessionDir(botId);
    const credsPath = path.join(sessDir, 'creds.json');
    if (fs.existsSync(credsPath)) return;

    const sessionKey = `client_sess_${botId}`;
    let backup = await pgLoadSessionBackup(sessionKey).catch(() => null);
    if (!backup) {
      const fsDoc = await adminLoadDocument<{ credsData?: Record<string, unknown> }>(
        'bot_sessions',
        sessionKey
      ).catch(() => null);
      if (fsDoc?.credsData) backup = fsDoc.credsData;
    }

    if (backup && Object.keys(backup).length > 0) {
      if (!fs.existsSync(sessDir)) {
        fs.mkdirSync(sessDir, { recursive: true });
      }
      if (backup['creds.json'] && typeof backup['creds.json'] === 'object') {
        for (const [fileName, parsedVal] of Object.entries(backup)) {
          if (!fileName.endsWith('.json') || fileName.includes('/') || fileName.includes('..')) continue;
          fs.writeFileSync(path.join(sessDir, fileName), JSON.stringify(parsedVal), 'utf8');
        }
      } else {
        fs.writeFileSync(credsPath, JSON.stringify(backup), 'utf8');
      }
      this.pushBotLog(botId, 'pairing', 'Backup', 'Restored client WhatsApp session from backup.', 'info');
    }
  }

  private scheduleCredsBackup(botId: string) {
    const rt = this.getRuntime(botId);
    if (rt.credsBackupTimer) clearTimeout(rt.credsBackupTimer);
    rt.credsBackupTimer = setTimeout(() => {
      rt.credsBackupTimer = null;
      const bot = this.bots.get(botId);
      const sessDir = this.getSessionDir(botId);
      const credsPath = path.join(sessDir, 'creds.json');
      if (!bot || !fs.existsSync(credsPath)) return;

      try {
        const files = fs
          .readdirSync(sessDir)
          .filter(
            (name) =>
              name === 'creds.json' ||
              name.startsWith('app-state-sync-key-') ||
              name.startsWith('pre-key-') ||
              name.startsWith('sender-key-') ||
              name.startsWith('session-')
          )
          .slice(0, 60);

        const bundle: Record<string, unknown> = {};
        for (const f of files) {
          try {
            bundle[f] = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
          } catch {
            // skip unreadable file
          }
        }
        if (!bundle['creds.json']) return;

        const sessionKey = `client_sess_${botId}`;
        const ownerId = bot.ownerId || this.ownerIdGetter();
        void pgSaveSessionBackup(sessionKey, ownerId, bot.phoneNumber || '', bundle);
        void adminSaveDocument('bot_sessions', sessionKey, {
          ownerId,
          phoneNumber: bot.phoneNumber || '',
          credsData: bundle,
        });
      } catch {
        // ignore transient errors
      }
    }, 3000);
  }

  private cancelReconnect(botId: string) {
    const rt = this.getRuntime(botId);
    if (rt.reconnectTimer) {
      clearTimeout(rt.reconnectTimer);
      rt.reconnectTimer = null;
    }
  }

  private closeSocket(botId: string) {
    const rt = this.getRuntime(botId);
    this.cancelReconnect(botId);
    if (rt.socket) {
      const sock = rt.socket;
      rt.socket = null;
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
    }
  }

  listBots(): ClientBotRuntimeView[] {
    return Array.from(this.bots.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((bot) => this.buildRuntimeView(bot));
  }

  getBotView(botId: string): ClientBotRuntimeView | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    return this.buildRuntimeView(bot);
  }

  getSummaryCounts() {
    let activeCount = 0;
    let connectedCount = 0;
    for (const bot of this.bots.values()) {
      if (bot.active) activeCount += 1;
      if (this.runtimes.get(bot.botId)?.status === 'connected') connectedCount += 1;
    }
    return {
      total: this.bots.size,
      active: activeCount,
      connected: connectedCount,
    };
  }

  pruneCaches() {
    const now = Date.now();
    for (const rt of this.runtimes.values()) {
      for (const [jid, entry] of rt.groupMetadataCache.entries()) {
        if (entry.expiresAt <= now) {
          rt.groupMetadataCache.delete(jid);
        }
      }
      for (const [jid, ts] of rt.savedReplyCooldowns.entries()) {
        if (now - ts > 86_400_000) {
          rt.savedReplyCooldowns.delete(jid);
        }
      }
    }
  }

  private buildRuntimeView(bot: ClientBotRecord): ClientBotRuntimeView {
    const rt = this.getRuntime(bot.botId);
    const credsPath = path.join(this.getSessionDir(bot.botId), 'creds.json');
    const knownGroups: ClientKnownGroup[] = [];
    const botJid = rt.socket?.user?.id;
    const botLid = (rt.socket?.user as { lid?: string } | undefined)?.lid;
    for (const [jid, entry] of rt.groupMetadataCache.entries()) {
      knownGroups.push({
        jid,
        name: entry.metadata.subject || jid,
        participantCount: entry.metadata.participants?.length || 0,
        botIsAdmin: botJid ? isParticipantAdmin(entry.metadata, botJid, botLid) : false,
      });
    }
    return {
      ...bot,
      status: !bot.active ? 'suspended' : rt.status,
      connectedUser: rt.socket?.user?.id || null,
      pairingCode: rt.pairingCode,
      pairingPhone: rt.pairingPhone,
      sessionExists: fs.existsSync(credsPath),
      lastError: rt.lastError,
      logs: rt.logs,
      knownGroups,
    };
  }

  createBot(input: {
    clientName: string;
    phoneNumber?: string;
    moderateAllGroups?: boolean;
    savedReplyEnabled?: boolean;
    savedReplyMessage?: string;
  }): ClientBotRuntimeView {
    const nowIso = new Date().toISOString();
    const rawId = `cb_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const record = normalizeClientBot(
      {
        botId: rawId,
        ownerId: this.ownerIdGetter(),
        clientName: input.clientName || 'New Client Bot',
        phoneNumber: input.phoneNumber || '',
        active: true,
        clientAccessKey: generateAccessKey(),
        moderateAllGroups: input.moderateAllGroups !== false,
        savedReplyEnabled: Boolean(input.savedReplyEnabled),
        savedReplyMessage: input.savedReplyMessage || DEFAULT_SAVED_REPLY,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      this.ownerIdGetter()
    );

    this.bots.set(record.botId, record);
    this.persistBot(record);
    this.pushBotLog(record.botId, 'system', 'Owner', `Created client bot slot "${record.clientName}".`, 'success');
    this.onEventHook?.(`Created client bot slot: ${record.clientName}`, 'info');
    return this.buildRuntimeView(record);
  }

  verifyClientAccessKey(botId: string, candidateKey: string): {
    ok: boolean;
    reason?: 'NOT_FOUND' | 'INVALID_KEY' | 'SUSPENDED';
    bot?: ClientBotRecord;
  } {
    const bot = this.bots.get(botId);
    if (!bot) return { ok: false, reason: 'NOT_FOUND' };
    if (!candidateKey || typeof candidateKey !== 'string') {
      return { ok: false, reason: 'INVALID_KEY' };
    }
    const a = Buffer.from(bot.clientAccessKey, 'utf8');
    const b = Buffer.from(candidateKey.trim(), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'INVALID_KEY' };
    }
    if (!bot.active) {
      return { ok: false, reason: 'SUSPENDED', bot };
    }
    return { ok: true, bot };
  }

  rotateAccessKey(botId: string): ClientBotRuntimeView | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    bot.clientAccessKey = generateAccessKey();
    bot.updatedAt = new Date().toISOString();
    this.persistBot(bot);
    this.pushBotLog(botId, 'system', 'Owner', 'Rotated client portal access key.', 'info');
    return this.buildRuntimeView(bot);
  }

  updateBot(botId: string, patch: ClientBotPatchInput, actor = 'Owner'): ClientBotRuntimeView | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;

    if (typeof patch.clientName === 'string' && patch.clientName.trim()) {
      bot.clientName = patch.clientName.trim().slice(0, 120);
    }
    if (typeof patch.moderateAllGroups === 'boolean') {
      bot.moderateAllGroups = patch.moderateAllGroups;
    }
    if (patch.defaultModeration && typeof patch.defaultModeration === 'object') {
      const merged = normalizeGroupRule('default', {
        ...bot.defaultModeration,
        ...patch.defaultModeration,
      });
      bot.defaultModeration = {
        enabled: merged.enabled,
        deleteLinks: merged.deleteLinks,
        deleteStickers: merged.deleteStickers,
        deleteMedia: merged.deleteMedia,
        warnEnabled: merged.warnEnabled,
        maxWarnings: merged.maxWarnings,
        kickOnLimit: merged.kickOnLimit,
        warningTemplate: merged.warningTemplate,
        kickTemplate: merged.kickTemplate,
      };
    }

    if (patch.groupRules && typeof patch.groupRules === 'object') {
      for (const [jid, partialRule] of Object.entries(patch.groupRules)) {
        if (!jid || !partialRule) continue;
        const current = bot.groupRules[jid];
        bot.groupRules[jid] = normalizeGroupRule(jid, { ...current, ...partialRule }, bot.defaultModeration);
      }
    }

    if (patch.upsertGroupRule && patch.upsertGroupRule.groupJid) {
      const jid = patch.upsertGroupRule.groupJid.trim();
      const current = bot.groupRules[jid];
      bot.groupRules[jid] = normalizeGroupRule(
        jid,
        { ...current, ...patch.upsertGroupRule },
        bot.defaultModeration
      );
    }

    if (typeof patch.removeGroupJid === 'string' && patch.removeGroupJid) {
      delete bot.groupRules[patch.removeGroupJid];
    }

    if (typeof patch.savedReplyEnabled === 'boolean') {
      bot.savedReplyEnabled = patch.savedReplyEnabled;
    }
    if (typeof patch.savedReplyMessage === 'string') {
      bot.savedReplyMessage = patch.savedReplyMessage.trim().slice(0, 2000) || DEFAULT_SAVED_REPLY;
    }
    if (typeof patch.savedReplyCooldownMs === 'number' && patch.savedReplyCooldownMs >= 0) {
      bot.savedReplyCooldownMs = Math.min(86_400_000, Math.round(patch.savedReplyCooldownMs));
    }
    if (Array.isArray(patch.keywordReplies)) {
      bot.keywordReplies = patch.keywordReplies
        .filter((item) => item && typeof item.keyword === 'string' && typeof item.reply === 'string')
        .slice(0, 50)
        .map((item, idx) => ({
          id: item.id || `kw_${idx}_${Date.now()}`,
          keyword: item.keyword.trim().slice(0, 100),
          reply: item.reply.trim().slice(0, 1500),
          enabled: item.enabled !== false,
        }))
        .filter((item) => item.keyword.length > 0 && item.reply.length > 0);
    }

    if (typeof patch.active === 'boolean' && patch.active !== bot.active) {
      bot.active = patch.active;
      const rt = this.getRuntime(botId);
      if (!bot.active) {
        rt.manualDisconnect = true;
        rt.pairingCode = null;
        this.closeSocket(botId);
        rt.status = 'suspended';
        this.pushBotLog(botId, 'system', actor, 'Suspended client bot (Active Kill-Switch OFF).', 'blocked');
      } else {
        rt.manualDisconnect = false;
        rt.status = 'disconnected';
        this.pushBotLog(botId, 'system', actor, 'Activated client bot.', 'success');
        void this.tryAutoResumeBot(botId);
      }
    } else {
      this.pushBotLog(botId, 'system', actor, 'Updated client bot rules & saved SMS settings.', 'info');
    }

    bot.updatedAt = new Date().toISOString();
    this.persistBot(bot);
    return this.buildRuntimeView(bot);
  }

  resetGroupWarnings(botId: string, groupJid: string, targetUserKey?: string): ClientBotRuntimeView | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    const rule = bot.groupRules[groupJid];
    if (rule) {
      if (targetUserKey) {
        delete rule.userWarnings[targetUserKey];
      } else {
        rule.userWarnings = {};
      }
      bot.updatedAt = new Date().toISOString();
      this.persistBot(bot);
      this.pushBotLog(botId, 'moderation', 'Control Panel', `Reset warnings for ${groupJid}.`, 'info');
    }
    return this.buildRuntimeView(bot);
  }

  async pairBot(botId: string, rawPhone: string): Promise<ClientBotRuntimeView> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error('Client bot slot not found.');
    if (!bot.active) throw new Error('This bot is currently suspended by the administrator.');

    const cleanPhone = rawPhone.replace(/\D/g, '');
    if (cleanPhone.length < 8 || cleanPhone.length > 15) {
      throw new Error('Phone number must be 8–15 digits including country code (e.g. 8801712345678).');
    }

    bot.phoneNumber = cleanPhone;
    bot.updatedAt = new Date().toISOString();
    this.persistBot(bot);

    await this.startSocket(botId, cleanPhone);
    return this.buildRuntimeView(bot);
  }

  disconnectBot(botId: string): ClientBotRuntimeView | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    const rt = this.getRuntime(botId);
    rt.manualDisconnect = true;
    rt.pairingCode = null;
    this.closeSocket(botId);
    rt.status = bot.active ? 'disconnected' : 'suspended';
    this.pushBotLog(botId, 'pairing', 'Control Panel', 'Disconnected client WhatsApp socket.', 'info');
    return this.buildRuntimeView(bot);
  }

  async resetBotSession(botId: string): Promise<ClientBotRuntimeView | null> {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    const rt = this.getRuntime(botId);
    rt.manualDisconnect = true;
    rt.pairingCode = null;
    rt.lastError = null;
    this.closeSocket(botId);
    const sessDir = this.getSessionDir(botId);
    if (fs.existsSync(sessDir)) {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
    const sessionKey = `client_sess_${botId}`;
    await pgDeleteSingleSessionBackup(sessionKey);
    await adminDeleteDocument('bot_sessions', sessionKey).catch(() => false);
    rt.status = bot.active ? 'disconnected' : 'suspended';
    this.pushBotLog(botId, 'pairing', 'Control Panel', 'Cleared client session credentials.', 'info');
    return this.buildRuntimeView(bot);
  }

  async deleteBot(botId: string): Promise<boolean> {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    this.closeSocket(botId);
    this.bots.delete(botId);
    this.runtimes.delete(botId);
    const sessDir = this.getSessionDir(botId);
    if (fs.existsSync(sessDir)) {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
    this.persistLocalAll();
    await Promise.all([
      pgDeleteClientBot(botId).catch(() => {}),
      adminDeleteDocument('client_bots', botId).catch(() => false),
      adminDeleteDocument('bot_sessions', `client_sess_${botId}`).catch(() => false),
    ]);
    this.onEventHook?.(`Deleted client bot slot: ${bot.clientName}`, 'info');
    return true;
  }

  async fetchLiveGroups(botId: string): Promise<ClientKnownGroup[]> {
    const bot = this.bots.get(botId);
    const rt = this.runtimes.get(botId);
    if (!bot || !rt?.socket) return [];

    try {
      const participating = await rt.socket.groupFetchAllParticipating();
      const now = Date.now();
      const botJid = rt.socket.user?.id;
      const botLid = (rt.socket.user as { lid?: string } | undefined)?.lid;
      const list: ClientKnownGroup[] = [];
      let changed = false;

      for (const [jid, meta] of Object.entries(participating)) {
        rt.groupMetadataCache.set(jid, { metadata: meta, expiresAt: now + 60_000 });
        const botIsAdmin = botJid ? isParticipantAdmin(meta, botJid, botLid) : false;
        list.push({
          jid,
          name: meta.subject || jid,
          participantCount: meta.participants?.length || 0,
          botIsAdmin,
        });
        if (bot.groupRules[jid] && meta.subject && bot.groupRules[jid].groupName !== meta.subject) {
          bot.groupRules[jid].groupName = meta.subject;
          changed = true;
        }
      }
      if (changed) {
        bot.updatedAt = new Date().toISOString();
        this.persistBot(bot);
      }
      return list;
    } catch {
      return this.buildRuntimeView(bot).knownGroups;
    }
  }

  private async getCachedGroupMeta(botId: string, sock: WASocket, groupJid: string): Promise<GroupMetadata> {
    const rt = this.getRuntime(botId);
    const cached = rt.groupMetadataCache.get(groupJid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }
    const metadata = await sock.groupMetadata(groupJid);
    rt.groupMetadataCache.set(groupJid, {
      metadata,
      expiresAt: Date.now() + 30_000,
    });
    return metadata;
  }

  private async sendTracked(
    botId: string,
    sock: WASocket,
    jid: string,
    content: { text: string; mentions?: string[] },
    options?: { quoted?: WAMessage }
  ) {
    const rt = this.getRuntime(botId);
    const sent = await sock.sendMessage(jid, content, options);
    const id = sent?.key?.id;
    if (id) {
      rt.sentMessageIds.add(id);
      if (rt.sentMessageIds.size > 300) {
        const first = rt.sentMessageIds.values().next().value;
        if (first) rt.sentMessageIds.delete(first);
      }
    }
    return sent;
  }

  private async startSocket(botId: string, pairingPhoneNumber?: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot || !bot.active || this.isShuttingDown) return;

    const rt = this.getRuntime(botId);
    rt.manualDisconnect = false;
    rt.lastError = null;
    this.closeSocket(botId);

    const sessDir = this.getSessionDir(botId);
    if (!fs.existsSync(sessDir)) {
      fs.mkdirSync(sessDir, { recursive: true });
    }

    if (pairingPhoneNumber) {
      // Fresh pairing attempt: clear half-registered state
      for (const f of fs.readdirSync(sessDir)) {
        fs.rmSync(path.join(sessDir, f), { recursive: true, force: true });
      }
      rt.pairingPhone = pairingPhoneNumber;
      rt.pairingCode = null;
    }

    rt.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(sessDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    rt.socket = sock;

    if (pairingPhoneNumber && !state.creds.registered) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const code = await sock.requestPairingCode(pairingPhoneNumber);
        rt.pairingCode = code;
        rt.status = 'awaiting_pairing';
        this.pushBotLog(
          botId,
          'pairing',
          bot.clientName,
          `Generated 8-digit pairing code for +${pairingPhoneNumber}.`,
          'success'
        );
      } catch (err) {
        rt.lastError = (err as Error).message;
        rt.status = 'disconnected';
        this.pushBotLog(botId, 'pairing', bot.clientName, `Pairing failed: ${rt.lastError}`, 'error');
        throw err;
      }
    }

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      this.scheduleCredsBackup(botId);
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        rt.status = 'connected';
        rt.pairingCode = null;
        rt.lastError = null;
        rt.reconnectAttempts = 0;
        const connectedDigits = extractDigits(sock.user?.id);
        if (connectedDigits && bot.phoneNumber !== connectedDigits) {
          bot.phoneNumber = connectedDigits;
          bot.updatedAt = new Date().toISOString();
          this.persistBot(bot);
        }
        this.scheduleCredsBackup(botId);
        this.pushBotLog(botId, 'pairing', bot.clientName, `Connected as ${sock.user?.id || 'WhatsApp'}.`, 'success');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
          ?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (rt.socket === sock) {
          rt.socket = null;
        }

        if (rt.manualDisconnect || !bot.active || this.isShuttingDown) {
          rt.status = !bot.active ? 'suspended' : 'disconnected';
          return;
        }

        if (isLoggedOut) {
          rt.status = 'disconnected';
          rt.lastError = 'WhatsApp logged out / unlinked from phone.';
          this.pushBotLog(botId, 'pairing', bot.clientName, rt.lastError, 'error');
          return;
        }

        rt.status = 'connecting';
        const delayMs = Math.min(30_000, 3000 * Math.pow(1.6, rt.reconnectAttempts));
        rt.reconnectAttempts = Math.min(8, rt.reconnectAttempts + 1);
        rt.lastError = `Disconnected (code ${statusCode ?? 'unknown'}). Reconnecting in ${Math.round(delayMs / 1000)}s...`;
        this.cancelReconnect(botId);
        rt.reconnectTimer = setTimeout(() => {
          rt.reconnectTimer = null;
          if (!this.isShuttingDown && bot.active && !rt.manualDisconnect) {
            void this.startSocket(botId).catch((err) => {
              rt.lastError = (err as Error).message;
              rt.status = 'disconnected';
            });
          }
        }, delayMs);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (this.isShuttingDown) return;
      const nowSec = Math.floor(Date.now() / 1000);
      for (const msg of messages) {
        const rawTs = Number(msg.messageTimestamp || 0);
        const isFreshOwnEcho = type === 'append' && msg.key.fromMe && (rawTs === 0 || nowSec - rawTs < 25);
        if (type !== 'notify' && !isFreshOwnEcho) continue;
        try {
          await this.handleIncomingMessage(botId, sock, msg);
        } catch (err) {
          this.pushBotLog(botId, 'system', bot.clientName, `Message handler error: ${(err as Error).message}`, 'error');
        }
      }
    });
  }

  private async handleIncomingMessage(botId: string, sock: WASocket, msg: WAMessage) {
    const bot = this.bots.get(botId);
    if (!bot || !bot.active) return;

    const rt = this.getRuntime(botId);
    if (!msg.message) return;
    if (msg.key.id && rt.sentMessageIds.has(msg.key.id)) return;

    const remoteJid = msg.key.remoteJid;
    if (
      !remoteJid ||
      remoteJid === 'status@broadcast' ||
      remoteJid.endsWith('@broadcast') ||
      remoteJid.endsWith('@newsletter')
    ) {
      return;
    }

    const text = extractClientMessageText(msg.message);
    const isGroup = Boolean(isJidGroup(remoteJid));

    if (isGroup) {
      await this.handleGroupMessage(botId, bot, sock, msg, remoteJid, text);
      return;
    }

    const isPrivateChat = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
    if (!isPrivateChat) return;

    // Private DM handling (Zero-AI Saved Auto-Reply + .savedreply commands)
    if (msg.key.fromMe) {
      if (text.toLowerCase().startsWith('.savedreply')) {
        await this.handleSavedReplyCommand(botId, bot, sock, remoteJid, text, msg);
      }
      return;
    }

    if (!bot.savedReplyEnabled) return;

    const senderDigits = extractDigits(remoteJid);
    const botDigits = extractDigits(sock.user?.id);
    const botLidDigits = extractDigits((sock.user as { lid?: string } | undefined)?.lid);
    if ((senderDigits && botDigits && senderDigits === botDigits) || (senderDigits && botLidDigits && senderDigits === botLidDigits)) {
      return;
    }

    const now = Date.now();
    const lastRepliedAt = rt.savedReplyCooldowns.get(remoteJid) || 0;
    if (now - lastRepliedAt < bot.savedReplyCooldownMs) return;

    // Match custom keyword reply first, then fallback to default saved SMS
    const lowerText = text.toLowerCase();
    let replyToSend = bot.savedReplyMessage;
    let matchedKeyword = '';
    if (lowerText && bot.keywordReplies.length > 0) {
      for (const item of bot.keywordReplies) {
        if (!item.enabled) continue;
        if (lowerText.includes(item.keyword.toLowerCase())) {
          replyToSend = item.reply;
          matchedKeyword = item.keyword;
          break;
        }
      }
    }

    if (!replyToSend || !replyToSend.trim()) return;

    rt.savedReplyCooldowns.set(remoteJid, now);
    await this.sendTracked(botId, sock, remoteJid, { text: replyToSend }, { quoted: msg });
    bot.stats.savedRepliesSent += 1;
    bot.stats.lastActivityAt = new Date().toISOString();
    bot.updatedAt = bot.stats.lastActivityAt;
    this.persistBot(bot);
    this.pushBotLog(
      botId,
      'savedreply',
      senderDigits || remoteJid,
      matchedKeyword ? `Sent keyword saved SMS (${matchedKeyword}).` : 'Sent default saved DM SMS.',
      'success'
    );
  }

  private async handleSavedReplyCommand(
    botId: string,
    bot: ClientBotRecord,
    sock: WASocket,
    remoteJid: string,
    text: string,
    msg: WAMessage
  ) {
    const arg = text.slice('.savedreply'.length).trim();
    const lower = arg.toLowerCase();

    if (!arg || lower === 'status') {
      await this.sendTracked(
        botId,
        sock,
        remoteJid,
        {
          text:
            `*Saved Auto-Reply Status*\n` +
            `• State: ${bot.savedReplyEnabled ? 'ON' : 'OFF'}\n` +
            `• Cooldown: ${Math.round(bot.savedReplyCooldownMs / 1000)}s\n` +
            `• Keyword rules: ${bot.keywordReplies.filter((k) => k.enabled).length}\n` +
            `• Default SMS: ${bot.savedReplyMessage}\n\n` +
            `Commands: _.savedreply on_, _.savedreply off_, _.savedreply set <text>_`,
        },
        { quoted: msg }
      );
      return;
    }

    if (lower === 'on') {
      bot.savedReplyEnabled = true;
      bot.updatedAt = new Date().toISOString();
      this.persistBot(bot);
      await this.sendTracked(botId, sock, remoteJid, { text: '✅ Saved DM auto-reply চালু করা হয়েছে।' }, { quoted: msg });
      return;
    }

    if (lower === 'off') {
      bot.savedReplyEnabled = false;
      bot.updatedAt = new Date().toISOString();
      this.persistBot(bot);
      await this.sendTracked(botId, sock, remoteJid, { text: '⏸️ Saved DM auto-reply বন্ধ করা হয়েছে।' }, { quoted: msg });
      return;
    }

    if (lower.startsWith('set ')) {
      const nextMsg = arg.slice(4).trim();
      if (nextMsg) {
        bot.savedReplyMessage = nextMsg.slice(0, 2000);
        bot.updatedAt = new Date().toISOString();
        this.persistBot(bot);
        await this.sendTracked(
          botId,
          sock,
          remoteJid,
          { text: `✅ নতুন Saved Auto-Reply SMS সেট হয়েছে:\n${bot.savedReplyMessage}` },
          { quoted: msg }
        );
      }
    }
  }

  private async handleGroupMessage(
    botId: string,
    bot: ClientBotRecord,
    sock: WASocket,
    msg: WAMessage,
    groupJid: string,
    text: string
  ) {
    const metadata = await this.getCachedGroupMeta(botId, sock, groupJid).catch(() => null);
    const senderJid = msg.key.participant || remoteParticipantFallback(msg);
    const senderAlt = (msg.key as { participantAlt?: string }).participantAlt;
    const senderDigits = extractDigits(senderJid) || extractDigits(senderAlt) || 'member';

    const botJid = sock.user?.id;
    const botLid = (sock.user as { lid?: string } | undefined)?.lid;
    const botIsAdmin = metadata ? isParticipantAdmin(metadata, botJid, botLid) : false;
    const senderIsAdmin = metadata ? isParticipantAdmin(metadata, senderJid, senderAlt) : false;

    // 1. Admin / Client-Owner WhatsApp `.mod` command processor
    if (text.toLowerCase().startsWith('.mod')) {
      if (!msg.key.fromMe && !senderIsAdmin) {
        return; // strictly ignore non-admin members trying to alter rules
      }
      await this.handleModCommand(botId, bot, sock, msg, groupJid, metadata?.subject || groupJid, text);
      return;
    }

    // Never moderate messages sent by the client owner or group admins
    if (msg.key.fromMe || senderIsAdmin) return;

    // Determine effective rule for this group
    const existingRule = bot.groupRules[groupJid];
    if (!existingRule && !bot.moderateAllGroups) return;

    const effectiveRule: ClientGroupRule = existingRule
      ? existingRule
      : normalizeGroupRule(groupJid, { groupName: metadata?.subject || groupJid }, bot.defaultModeration);

    if (!effectiveRule.enabled) return;

    // Ensure groupName stays fresh
    if (metadata?.subject && existingRule && existingRule.groupName !== metadata.subject) {
      existingRule.groupName = metadata.subject;
    }

    const reason = detectViolationReason(msg.message, text, effectiveRule);
    if (!reason) return;

    if (!botIsAdmin) {
      this.pushBotLog(
        botId,
        'moderation',
        metadata?.subject || groupJid,
        `Detected ${reason} from +${senderDigits}, but bot is not group admin.`,
        'blocked'
      );
      return;
    }

    // Persist group rule into map so warning counts survive restarts
    if (!bot.groupRules[groupJid]) {
      bot.groupRules[groupJid] = effectiveRule;
    }
    const storedRule = bot.groupRules[groupJid];

    // 2. Delete offending message
    try {
      await sock.sendMessage(groupJid, { delete: msg.key });
      bot.stats.deletedCount += 1;
    } catch (err) {
      this.pushBotLog(botId, 'moderation', metadata?.subject || groupJid, `Delete failed: ${(err as Error).message}`, 'error');
      return;
    }

    const userTag = `@${senderDigits}`;
    const mentionList = senderJid ? [senderJid] : [];

    // 3. Warn & Auto-Kick Counter
    if (storedRule.warnEnabled) {
      const nextCount = (storedRule.userWarnings[senderDigits] || 0) + 1;
      storedRule.userWarnings[senderDigits] = nextCount;
      bot.stats.warnedCount += 1;

      if (storedRule.kickOnLimit && nextCount >= storedRule.maxWarnings) {
        if (senderJid) {
          try {
            await sock.groupParticipantsUpdate(groupJid, [senderJid], 'remove');
            bot.stats.kickedCount += 1;
            delete storedRule.userWarnings[senderDigits];
            const kickText = formatModerationTemplate(storedRule.kickTemplate, {
              userTag,
              reason,
              count: nextCount,
              max: storedRule.maxWarnings,
            });
            await this.sendTracked(botId, sock, groupJid, { text: kickText, mentions: mentionList });
            this.pushBotLog(
              botId,
              'moderation',
              metadata?.subject || groupJid,
              `Auto-kicked +${senderDigits} after ${nextCount}/${storedRule.maxWarnings} (${reason}).`,
              'success'
            );
          } catch (err) {
            this.pushBotLog(
              botId,
              'moderation',
              metadata?.subject || groupJid,
              `Kick failed for +${senderDigits}: ${(err as Error).message}`,
              'error'
            );
          }
        }
      } else {
        const warnText = formatModerationTemplate(storedRule.warningTemplate, {
          userTag,
          reason,
          count: nextCount,
          max: storedRule.maxWarnings,
        });
        await this.sendTracked(botId, sock, groupJid, { text: warnText, mentions: mentionList });
        this.pushBotLog(
          botId,
          'moderation',
          metadata?.subject || groupJid,
          `Deleted ${reason} & warned +${senderDigits} (${nextCount}/${storedRule.maxWarnings}).`,
          'success'
        );
      }
    } else {
      this.pushBotLog(
        botId,
        'moderation',
        metadata?.subject || groupJid,
        `Deleted ${reason} from +${senderDigits} (warn disabled).`,
        'success'
      );
    }

    bot.stats.lastActivityAt = new Date().toISOString();
    bot.updatedAt = bot.stats.lastActivityAt;
    this.persistBot(bot);
  }

  private async handleModCommand(
    botId: string,
    bot: ClientBotRecord,
    sock: WASocket,
    msg: WAMessage,
    groupJid: string,
    groupName: string,
    text: string
  ) {
    const rawArg = text.slice('.mod'.length).trim();
    const parts = rawArg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();
    const val = (parts[1] || '').toLowerCase();

    if (!bot.groupRules[groupJid]) {
      bot.groupRules[groupJid] = normalizeGroupRule(groupJid, { groupName }, bot.defaultModeration);
    }
    const rule = bot.groupRules[groupJid];
    rule.groupName = groupName || rule.groupName;

    let replyText = '';

    if (sub === 'help' || sub === 'status') {
      replyText =
        `*Group Moderation (${rule.groupName})*\n` +
        `• Status: ${rule.enabled ? 'ON' : 'OFF'}\n` +
        `• Delete Links: ${rule.deleteLinks ? 'ON' : 'OFF'}\n` +
        `• Delete Stickers: ${rule.deleteStickers ? 'ON' : 'OFF'}\n` +
        `• Delete Media: ${rule.deleteMedia ? 'ON' : 'OFF'}\n` +
        `• Warnings: ${rule.warnEnabled ? `ON (Max ${rule.maxWarnings})` : 'OFF'}\n` +
        `• Auto-Kick: ${rule.kickOnLimit ? 'ON' : 'OFF'}\n\n` +
        `*Admin Commands:*\n` +
        `• .mod on / off\n` +
        `• .mod link on / off\n` +
        `• .mod sticker on / off\n` +
        `• .mod media on / off\n` +
        `• .mod warn 3 / off\n` +
        `• .mod kick on / off\n` +
        `• .mod setwarn <text with {user} {reason} {count} {max}>\n` +
        `• .mod reset all`;
    } else if (sub === 'on' || sub === 'off') {
      rule.enabled = sub === 'on';
      replyText = `✅ এই গ্রুপের মডারেশন ${rule.enabled ? 'চালু' : 'বন্ধ'} করা হয়েছে।`;
    } else if (sub === 'link' || sub === 'links') {
      rule.deleteLinks = val !== 'off';
      replyText = `✅ Anti-Link ${rule.deleteLinks ? 'ON' : 'OFF'} করা হয়েছে।`;
    } else if (sub === 'sticker' || sub === 'stickers') {
      rule.deleteStickers = val !== 'off';
      replyText = `✅ Anti-Sticker ${rule.deleteStickers ? 'ON' : 'OFF'} করা হয়েছে।`;
    } else if (sub === 'media') {
      rule.deleteMedia = val !== 'off';
      replyText = `✅ Anti-Media ${rule.deleteMedia ? 'ON' : 'OFF'} করা হয়েছে।`;
    } else if (sub === 'kick') {
      rule.kickOnLimit = val !== 'off';
      replyText = `✅ Auto-Kick on limit ${rule.kickOnLimit ? 'ON' : 'OFF'} করা হয়েছে (Max: ${rule.maxWarnings})।`;
    } else if (sub === 'warn') {
      if (val === 'off') {
        rule.warnEnabled = false;
        replyText = '⏸️ Warning মেসেজ বন্ধ করা হয়েছে।';
      } else if (val === 'on') {
        rule.warnEnabled = true;
        replyText = `✅ Warning চালু আছে (Max: ${rule.maxWarnings})।`;
      } else {
        const parsedMax = Number(val);
        if (Number.isFinite(parsedMax) && parsedMax >= 1 && parsedMax <= 20) {
          rule.warnEnabled = true;
          rule.maxWarnings = Math.round(parsedMax);
          replyText = `✅ এই গ্রুপের সর্বোচ্চ Warning সীমা ${rule.maxWarnings} সেট করা হয়েছে।`;
        } else {
          replyText = '⚠️ ব্যবহার করুন: .mod warn 3 অথবা .mod warn off';
        }
      }
    } else if (sub === 'setwarn') {
      const customTpl = rawArg.slice(sub.length).trim();
      if (customTpl) {
        rule.warningTemplate = customTpl.slice(0, 500);
        replyText = `✅ কাস্টম Warning মেসেজ আপডেট হয়েছে:\n${rule.warningTemplate}`;
      } else {
        replyText = '⚠️ ব্যবহার করুন: .mod setwarn {user} গ্রুপে {reason} নিষেধ ({count}/{max})';
      }
    } else if (sub === 'setkick') {
      const customKick = rawArg.slice(sub.length).trim();
      if (customKick) {
        rule.kickTemplate = customKick.slice(0, 500);
        replyText = `✅ কাস্টম Kick মেসেজ আপডেট হয়েছে:\n${rule.kickTemplate}`;
      }
    } else if (sub === 'reset') {
      if (val === 'all') {
        rule.userWarnings = {};
        replyText = '✅ এই গ্রুপের সব সদস্যের Warning কাউন্টার রিসেট করা হয়েছে।';
      } else {
        const targetDigits = val.replace(/\D/g, '');
        if (targetDigits) {
          delete rule.userWarnings[targetDigits];
          replyText = `✅ +${targetDigits} এর Warning রিসেট করা হয়েছে।`;
        } else {
          rule.userWarnings = {};
          replyText = '✅ Warning কাউন্টার রিসেট করা হয়েছে।';
        }
      }
    } else {
      replyText = 'ℹ️ কমান্ড দেখতে .mod help পাঠান।';
    }

    bot.updatedAt = new Date().toISOString();
    this.persistBot(bot);
    this.pushBotLog(botId, 'command', groupName, `Admin executed ".mod ${rawArg || 'status'}"`, 'info');
    if (replyText) {
      await this.sendTracked(botId, sock, groupJid, { text: replyText }, { quoted: msg });
    }
  }

  shutdown() {
    this.isShuttingDown = true;
    if (this.persistLocalTimer) {
      clearTimeout(this.persistLocalTimer);
      this.persistLocalTimer = null;
    }
    for (const botId of this.bots.keys()) {
      const rt = this.runtimes.get(botId);
      if (rt?.credsBackupTimer) clearTimeout(rt.credsBackupTimer);
      this.closeSocket(botId);
    }
  }
}

function remoteParticipantFallback(msg: WAMessage): string | undefined {
  return (msg as { participant?: string }).participant;
}
