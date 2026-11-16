export type NavSection =
  | 'overview'
  | 'assistant'
  | 'inbox'
  | 'simulator'
  | 'rules'
  | 'clients'
  | 'security'
  | 'source';

export type AssistantTone =
  | 'witty_flirty'
  | 'warm_polite'
  | 'executive_formal'
  | 'sharp_shut_down';

export type GroupAiMode = 'smart_blend' | 'mention_only' | 'active_chat';

export interface KnownGroupItem {
  jid: string;
  name: string;
  participantCount: number;
  antilinkEnabled: boolean;
  groupAiEnabled: boolean;
}

export interface BotConfig {
  autoreply: boolean;
  aiAssistantEnabled: boolean;
  autoreplyMessage: string;
  firstGreetingTemplate: string;
  ownerName: string;
  ownerProfession: string;
  ownerLocation: string;
  ownerBio: string;
  ownerBoundaries: string;
  strictLogicRules?: string;
  assistantTone: AssistantTone;
  cooldownMs: number;
  takeoverPauseMs: number;
  humanTypingEnabled: boolean;
  dailyReplyLimit: number;
  antilinkGroups: Record<string, boolean>;
  groupAiEnabled?: boolean;
  groupAiMode?: GroupAiMode;
  groupReactionEnabled?: boolean;
  groupCooldownMs?: number;
  groupAiGroups?: Record<string, boolean>;
}

export interface DictionaryEntry {
  id: string;
  term: string;
  meaning: string;
  district: string;
  language: 'bn_dialect' | 'bn_en' | 'en_slang';
  replyStyleHint?: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface ChatMemoryRecord {
  chatId: string;
  contactJid: string;
  contactName: string;
  detectedDistrict: string;
  lastSummary: string;
  turns: ChatTurn[];
  archiveCount?: number;
  updatedAt: string;
}

export interface InboxNoteRecord {
  id: string;
  contactJid: string;
  contactName: string;
  summary: string;
  urgency: 'normal' | 'important';
  resolved: boolean;
  createdAt: string;
}

export interface BotLogEntry {
  id: string;
  timestamp: string;
  category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud';
  actor: string;
  summary: string;
  outcome: 'success' | 'blocked' | 'info' | 'error';
}

export interface DailyReplyStats {
  date: string;
  count: number;
  limit: number;
}

export interface ActiveTakeoverItem {
  jid: string;
  phone: string;
  remainingMs: number;
  resumeAt: string;
}

export interface BotStatusResponse {
  status: 'disconnected' | 'connecting' | 'awaiting_pairing' | 'connected';
  connectedUser: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  sessionExists: boolean;
  lastError: string | null;
  geminiConfigured: boolean;
  openRouterConfigured?: boolean;
  openRouterStats?: {
    configuredKeysCount: number;
    primaryModel: string;
    lastSummaryAt: string | null;
    lastFallbackAt: string | null;
    lastError: string | null;
    dynamicPool?: {
      discoveredFreeModelsCount: number;
      activeFreeModel: string;
      lastModelsSyncAt: string | null;
      lastModelRotationReason: string | null;
      freeModelsSample: string[];
    };
  };
  firestoreAdminMode?: string;
  config: BotConfig;
  logs: BotLogEntry[];
  dictionaryCount?: number;
  memoryCount?: number;
  unreadNotesCount?: number;
  dailyReplyStats?: DailyReplyStats;
  activeTakeoversCount?: number;
}

export interface SourceFileItem {
  name: string;
  content: string;
}

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

export interface ClientBotItem {
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
  status: ClientConnectionStatus;
  connectedUser: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  sessionExists: boolean;
  lastError: string | null;
  logs: ClientBotLogEntry[];
  knownGroups: ClientKnownGroup[];
}

export const BENGALI_AUTOREPLY_EXACT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';
