export type NavSection = 'overview' | 'simulator' | 'rules' | 'source';

export interface BotConfig {
  autoreply: boolean;
  cooldownMs: number;
  antilinkGroups: Record<string, boolean>;
}

export interface BotLogEntry {
  id: string;
  timestamp: string;
  category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator';
  actor: string;
  summary: string;
  outcome: 'success' | 'blocked' | 'info' | 'error';
}

export interface BotStatusResponse {
  status: 'disconnected' | 'connecting' | 'awaiting_pairing' | 'connected';
  connectedUser: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  sessionExists: boolean;
  lastError: string | null;
  geminiConfigured: boolean;
  config: BotConfig;
  logs: BotLogEntry[];
}

export interface SourceFileItem {
  name: string;
  content: string;
}

export const BENGALI_AUTOREPLY_EXACT =
  'ওয়ালাইকুমুস সালাম! আমি ওনার অ্যাসিস্ট্যান্ট বলছিলাম। স্যার তো এই মুহূর্তে ব্যস্ত আছেন বা স্যার এই মুহূর্তে অফলাইনে আছেন বা স্যার এই মুহূর্তে নেই। স্যার আসলে আপনাকে নক করবেন।';
