export type NavSection =
  | 'overview'
  | 'assistant'
  | 'inbox'
  | 'simulator'
  | 'rules'
  | 'outreach'
  | 'agent'
  | 'clients'
  | 'security'
  | 'settings'
  | 'source';

export type AssistantTone =
  | 'witty_flirty'
  | 'warm_polite'
  | 'executive_formal'
  | 'sharp_shut_down';

export type GroupAiMode = 'smart_blend' | 'mention_only' | 'active_chat';

export interface KnownGroupMemberItem {
  jid: string;
  lid?: string;
  phone: string;
  name: string;
  isAdmin: boolean;
}

export interface GroupMemberTargetDirective {
  id: string;
  targetJid: string;
  targetPhone: string;
  targetName: string;
  objective: string;
  enabled: boolean;
}

export interface GroupDirectiveConfig {
  groupPrompt: string;
  targets: GroupMemberTargetDirective[];
}

export interface KnownGroupItem {
  jid: string;
  name: string;
  participantCount: number;
  antilinkEnabled: boolean;
  groupAiEnabled: boolean;
  members?: KnownGroupMemberItem[];
}

export interface StoryWhitelistContact {
  id: string;
  name: string;
  phone: string;
  jid?: string;
  customPrompt?: string;
  enabled: boolean;
}

export interface KnownContactItem {
  jid: string;
  lid?: string;
  phone: string;
  name: string;
}

export interface DirectCommandLogItem {
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

export type ContactPolicyMode = 'normal' | 'long_engage' | 'hold_wait' | 'mute_ai';

export interface ContactPolicyEntry {
  id: string;
  name: string;
  phone: string;
  jid?: string;
  mode: ContactPolicyMode;
  note?: string;
  updatedAt: string;
}

export interface SelfChatTurnItem {
  id: string;
  role: 'owner' | 'assistant';
  text: string;
  mediaKind?: string;
  actionSummary?: string;
  timestamp: string;
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
  groupDirectives?: Record<string, GroupDirectiveConfig>;
  mediaIntelligenceEnabled?: boolean;
  mediaZeroTokenReplyMode?: boolean;
  storyAutoReadEnabled?: boolean;
  storyAutoReactEnabled?: boolean;
  storyAutoReplyEnabled?: boolean;
  storyCooldownMs?: number;
  storyWhitelistMode?: 'all' | 'selected_only';
  storyAllowedContacts?: StoryWhitelistContact[];
  selfChatCopilotEnabled?: boolean;
  selfChatZeroTokenOnly?: boolean;
  contactPolicies?: ContactPolicyEntry[];
  configUpdatedAt?: string;
}

export interface MediaStoryFeedItem {
  id: string;
  timestamp: string;
  source: 'story' | 'dm' | 'group' | 'simulator';
  senderName: string;
  senderJid: string;
  kind: 'photo' | 'video' | 'gif' | 'sticker' | 'story_text' | 'audio' | 'reaction' | 'text';
  sentiment:
    | 'praise_portrait'
    | 'good_positive'
    | 'bad_critique'
    | 'funny_laugh'
    | 'logical_debate'
    | 'affection_like'
    | 'greeting_casual';
  banglaSceneLabel: string;
  compactContextLine: string;
  reactionSent: string;
  replySent: string;
  tokensUsedForRead: 0;
  replyMode: 'zero_token' | 'hybrid_text_ai' | 'read_only';
}

export interface ZeroTokenMediaStats {
  totalReadsToday: number;
  photoReads: number;
  videoReads: number;
  stickerReads: number;
  storyReads: number;
  reactionReads: number;
  zeroTokenRepliesToday: number;
  tokensSpentReadingMedia: 0;
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

export interface TokenCategoryStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgTokensPerMsg: number;
}

export interface TokenKeySlotTelemetry {
  slot: number;
  requestsToday: number;
  tokensToday: number;
  primaryCooldownSec: number;
  liteCooldownSec: number;
  dailyExhausted: boolean;
  lastError: string | null;
  status: 'ready' | 'cooldown' | 'daily_exhausted';
}

export interface TokenTelemetrySnapshot {
  date: string;
  todayTotalTokens: number;
  todayPromptTokens: number;
  todayCompletionTokens: number;
  todayTotalCalls: number;
  lifetimeTotalTokens: number;
  lifetimeTotalCalls: number;
  zeroTokenMedia?: ZeroTokenMediaStats;
  byCategory: {
    group: TokenCategoryStats;
    dm: TokenCategoryStats;
    command: TokenCategoryStats;
    summary: TokenCategoryStats;
  };
  avgTokensPerGroupMsg: number | null;
  avgTokensPerDmMsg: number | null;
  avgTokensOverall: number | null;
  whatsappSafeCap: {
    usedToday: number;
    limit: number;
    remaining: number;
  };
  geminiPool: {
    configuredKeysCount: number;
    readyKeysCount: number;
    exhaustedKeysCount: number;
    estimatedRpdPerKey: number;
    totalRpdCapacity: number;
    usedRpdToday: number;
    remainingRpdToday: number;
    estimatedTpdCapacity: number;
    remainingTokensToday: number;
    estimatedGroupMsgsLeft: number;
    estimatedDmMsgsLeft: number;
    slots: TokenKeySlotTelemetry[];
  };
  openRouter: {
    configuredKeysCount: number;
    discoveredFreeModelsCount: number;
    activeFreeModel: string;
    requestsToday: number;
    tokensToday: number;
    keyMeta: {
      checkedAt: string | null;
      limitRemaining: number | null;
      usageDaily: number | null;
      isFreeTier: boolean | null;
    };
  };
  lastCall: {
    at: string;
    provider: 'gemini' | 'openrouter';
    model: string;
    category: 'group' | 'dm' | 'command' | 'summary';
    totalTokens: number;
    keySlot?: number;
  } | null;
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
  tokenTelemetry?: TokenTelemetrySnapshot;
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

export type OutreachEmailProvider = 'gmail_oauth' | 'smtp_profile' | 'resend_http' | 'brevo_http' | 'custom_http';

export interface PublicEmailSenderProfile {
  id: string;
  email: string;
  label: string;
  type: 'smtp_gmail' | 'smtp_custom';
  host: string;
  port: number;
  active: boolean;
  hasSecret: boolean;
  maskedSecret: string;
  createdAt: string;
}

export interface OutreachSafetyPolicy {
  dailyEmailLimit: number;
  dailyWhatsappLimit: number;
  whatsappMinDelayMs: number;
  whatsappMaxDelayMs: number;
  emailDelayMs: number;
  preferredEmailProvider: OutreachEmailProvider;
  zeroTokenDraftDefault: boolean;
  defaultLanguage: 'bn' | 'en';
  defaultOfferPitch: string;
  crawlContactSubpages: boolean;
  maxSitesPerSearch: number;
}

export interface OutreachLeadItem {
  id: string;
  name: string;
  sourceUrl: string;
  domain: string;
  topic: string;
  emails: string[];
  phones: string[];
  whatsappVerifiedPhones: string[];
  whatsappCheckedAt: string | null;
  snippet: string;
  emailSentCount: number;
  lastEmailSentAt: string | null;
  whatsappSentCount: number;
  lastWhatsappSentAt: string | null;
  createdAt: string;
}

export interface WebResearchHistoryItem {
  id: string;
  query: string;
  providerUsed: 'tavily' | 'serper' | 'duckduckgo' | 'gemini_search' | 'direct_url';
  tokensSpent: number;
  summary: string;
  urls: { title: string; url: string; snippet: string }[];
  emailsFound: number;
  phonesFound: number;
  createdAt: string;
}

export interface OutreachDispatchLogItem {
  id: string;
  timestamp: string;
  channel: 'email' | 'whatsapp';
  provider: string;
  recipient: string;
  leadName: string;
  subject?: string;
  messagePreview: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
  tokensSpent: number;
}

export interface OutreachStateResponse {
  memoryRssMb: number;
  policy: OutreachSafetyPolicy;
  stats: {
    date: string;
    emailsSentToday: number;
    whatsappSentToday: number;
    totalLeads: number;
    whatsappVerifiedCount: number;
  };
  capabilities: {
    tavilyConfigured: boolean;
    serperConfigured: boolean;
    geminiSearchConfigured: boolean;
    openRouterConfigured: boolean;
    smtpProfileConfigured?: boolean;
    resendConfigured: boolean;
    brevoConfigured: boolean;
    customEmailWebhookConfigured: boolean;
    whatsappConnected: boolean;
  };
  emailSenders?: PublicEmailSenderProfile[];
  whatsappQueue: {
    active: boolean;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    currentRecipient: string | null;
    nextSendAt: string | null;
  };
  leads: OutreachLeadItem[];
  researchHistory: WebResearchHistoryItem[];
  dispatchLogs: OutreachDispatchLogItem[];
}

export interface AgentExecutionStep {
  stepNumber: number;
  toolName: string;
  argsPreview: string;
  outcome: 'ok' | 'error';
  resultSummary: string;
  timestamp: string;
}

export interface AgentRunRecord {
  id: string;
  source: 'self_chat' | 'dashboard' | 'schedule';
  goal: string;
  status: 'running' | 'completed' | 'failed';
  providerUsed: 'gemini' | 'openrouter' | 'hybrid' | 'zero_token';
  modelUsed: string;
  tokensUsed: number;
  steps: AgentExecutionStep[];
  finalReport: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentScheduleItem {
  id: string;
  title: string;
  goal: string;
  intervalMinutes: number;
  enabled: boolean;
  notifySelfChat: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  lastSummary: string | null;
  createdAt: string;
}

export interface WatchdogHealEvent {
  timestamp: string;
  trigger: string;
  actionsTaken: string[];
  rssBeforeMb: number;
  rssAfterMb: number;
  botStatus: string;
  ok: boolean;
}

export interface WatchdogStatusSnapshot {
  enabled: boolean;
  intervalMs: number;
  cycleCount: number;
  totalHealsApplied: number;
  processErrorsIntercepted: number;
  lastErrorIntercepted: string | null;
  recentEvents: WatchdogHealEvent[];
}

export interface FirestoreAdminDiagnostics {
  configuredProjectId: string;
  configuredDatabaseId: string;
  serviceAccountProjectId: string | null;
  projectMatch: boolean | null;
  mode: string;
  hasServiceAccountEnv: boolean;
  initError: string | null;
}

export interface MobileOffloadWorkerInfo {
  workerId: string;
  deviceLabel: string;
  deviceMemoryGb: number | null;
  networkType: string;
  lastHeartbeatAt: number;
  jobsCompleted: number;
}

export interface MobileOffloadStatusSnapshot {
  activeWorkers: MobileOffloadWorkerInfo[];
  queuedCount: number;
  claimedCount: number;
  completedCount: number;
  recentJobs: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    error?: string;
  }>;
}

export interface TelegramBotStatusSnapshot {
  configured: boolean;
  botUsername: string | null;
  botName: string | null;
  ownerIdsCount: number;
  webhookUrl: string | null;
  pendingUpdates: number;
  lastWebhookError: string | null;
  lastSetupAt: string | null;
  trackedChatsCount: number;
  imageGenerationReady: boolean;
}

export interface SystemEnvStatusResponse {
  runtime: {
    platform: string;
    isTermux: boolean;
    isVercel?: boolean;
    isNetlify?: boolean;
    nodeVersion: string;
    port: number;
    nodeEnv: string;
    memoryMb: number;
    uptimeSec: number;
    selfPingEnabled: boolean;
    ownerEmail: string;
    telegramBotConfigured?: boolean;
  };
  geminiKeysCount: number;
  openRouterKeysCount: number;
  firestore: FirestoreAdminDiagnostics;
  envItems: Array<{
    key: string;
    category: string;
    configured: boolean;
    detail: string;
  }>;
}

