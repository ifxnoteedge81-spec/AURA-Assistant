export type NavSection =
  | 'overview'
  | 'assistant'
  | 'inbox'
  | 'simulator'
  | 'rules'
  | 'security'
  | 'source';

export type AssistantTone =
  | 'witty_flirty'
  | 'warm_polite'
  | 'executive_formal'
  | 'sharp_shut_down';

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
  assistantTone: AssistantTone;
  cooldownMs: number;
  takeoverPauseMs: number;
  humanTypingEnabled: boolean;
  dailyReplyLimit: number;
  antilinkGroups: Record<string, boolean>;
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

export const BENGALI_AUTOREPLY_EXACT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';
