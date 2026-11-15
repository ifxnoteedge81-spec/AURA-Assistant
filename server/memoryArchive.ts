import fs from 'node:fs';
import path from 'node:path';
import type { ChatTurn } from './assistantEngine.ts';

const ARCHIVE_FILE = path.resolve('./bot-archive.json');
const MAX_ARCHIVE_TURNS_PER_CHAT = 2000;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'that', 'this', 'with', 'have', 'was', 'not', 'but',
  'what', 'when', 'how', 'why', 'can', 'will', 'sir', 'bhai', 'bro', 'apu',
  'কি', 'কী', 'না', 'হ্যাঁ', 'তো', 'আর', 'এই', 'সেই', 'আমি', 'তুমি', 'আপনি', 'আমার', 'তোমার', 'আপনার',
  'কেমন', 'আছো', 'আছেন', 'আছি', 'ভালো', 'নাই', 'নেই', 'হয়', 'করে', 'করো', 'বলেন', 'বলো',
]);

let archiveStore: Record<string, ChatTurn[]> = loadArchiveFile();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadArchiveFile(): Record<string, ChatTurn[]> {
  try {
    if (fs.existsSync(ARCHIVE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8')) as Record<string, ChatTurn[]>;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[MemoryArchive] Failed reading archive file:', (err as Error).message);
  }
  return {};
}

function scheduleSaveArchive() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fs.promises.writeFile(ARCHIVE_FILE, JSON.stringify(archiveStore), 'utf8').catch((err) => {
      console.error('[MemoryArchive] Failed saving archive file:', (err as Error).message);
    });
  }, 600);
  saveTimer.unref?.();
}

function turnKey(turn: Pick<ChatTurn, 'role' | 'text' | 'timestamp'>): string {
  return `${turn.role}|${turn.text.trim()}|${(turn.timestamp || '').slice(0, 16)}`;
}

export function syncArchiveTurns(chatId: string, turns: ChatTurn[]): ChatTurn[] {
  if (!chatId || !Array.isArray(turns) || turns.length === 0) {
    return archiveStore[chatId] || [];
  }
  const existing = archiveStore[chatId] || [];
  const seen = new Set(existing.map(turnKey));
  const newlyAdded: ChatTurn[] = [];

  for (const turn of turns) {
    if (!turn || !turn.text || !turn.text.trim()) continue;
    const key = turnKey(turn);
    if (!seen.has(key)) {
      seen.add(key);
      const cleanTurn: ChatTurn = {
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        text: turn.text.trim().slice(0, 4000),
        timestamp: turn.timestamp || new Date().toISOString(),
      };
      existing.push(cleanTurn);
      newlyAdded.push(cleanTurn);
    }
  }

  if (newlyAdded.length > 0) {
    existing.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (existing.length > MAX_ARCHIVE_TURNS_PER_CHAT) {
      existing.splice(0, existing.length - MAX_ARCHIVE_TURNS_PER_CHAT);
    }
    archiveStore[chatId] = existing;
    scheduleSaveArchive();
  }

  return newlyAdded;
}

export function appendArchiveTurn(chatId: string, turn: ChatTurn): boolean {
  const added = syncArchiveTurns(chatId, [turn]);
  return added.length > 0;
}

export function getArchiveTurns(chatId: string): ChatTurn[] {
  return archiveStore[chatId] || [];
}

export function getArchiveCount(chatId: string): number {
  return (archiveStore[chatId] || []).length;
}

export function clearArchiveTurns(chatId: string) {
  if (archiveStore[chatId]) {
    delete archiveStore[chatId];
    scheduleSaveArchive();
  }
}

function tokenizeQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.!?;:'"()[\]{}<>\/\\|@#$%^&*+=~`-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function recallRelevantOlderTurns(
  chatId: string,
  incomingText: string,
  recentTurns: ChatTurn[],
  maxResults = 5
): ChatTurn[] {
  const full = archiveStore[chatId];
  if (!full || full.length <= recentTurns.length) return [];

  const tokens = tokenizeQuery(incomingText);
  if (tokens.length === 0) return [];

  const recentSet = new Set(recentTurns.map(turnKey));
  const scored: Array<{ turn: ChatTurn; score: number; idx: number }> = [];

  for (let i = 0; i < full.length; i += 1) {
    const turn = full[i];
    if (recentSet.has(turnKey(turn))) continue;

    const lower = turn.text.toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (lower.includes(token)) {
        hits += token.length >= 5 ? 2 : 1;
      }
    }
    if (hits > 0) {
      scored.push({ turn, score: hits, idx: i });
    }
  }

  if (scored.length === 0) return [];

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.idx - a.idx));
  return scored
    .slice(0, maxResults)
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.turn);
}
