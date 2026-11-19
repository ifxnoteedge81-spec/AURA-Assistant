import { ThinkingLevel, Type, type GoogleGenAI } from '@google/genai';
import type { GeminiKeyPool, KeyRotationEvent } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';

export type AssistantTone =
  | 'witty_flirty'
  | 'warm_polite'
  | 'executive_formal'
  | 'sharp_shut_down';

export type GroupAiMode = 'smart_blend' | 'mention_only' | 'active_chat';

export type GroupDecisionAction = 'reply' | 'react' | 'reply_and_react' | 'silent';

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

export interface StoryWhitelistContact {
  id: string;
  name: string;
  phone: string;
  jid?: string;
  customPrompt?: string;
  enabled: boolean;
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

export interface AssistantConfigFields {
  autoreply?: boolean;
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
  humanTypingEnabled?: boolean;
  dailyReplyLimit?: number;
  antilinkGroups?: Record<string, boolean>;
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

export const DEFAULT_FIRST_GREETING =
  'স্যার এই মুহূর্তে অফলাইনে বা ব্যস্ত আছেন—আমি ওনার পার্সোনাল অ্যাসিস্ট্যান্ট বলছি। স্যারের জন্য কোনো জরুরি বার্তা থাকলে আমাকে বলতে পারেন, অথবা চাইলে আমার সাথেও যেকোনো বিষয়ে কথা বলতে পারেন!';

export const DEFAULT_OWNER_BIO =
  'স্যার একজন প্রযুক্তিপ্রেমী, দায়িত্বশীল এবং পেশাদার মানুষ। তিনি নিজের কাজ ও প্রজেক্ট নিয়ে বেশিরভাগ সময় ব্যস্ত থাকেন, তবে পরিচিতজন ও ক্লায়েন্টদের যথেষ্ট গুরুত্ব দেন।';

export const DEFAULT_OWNER_BOUNDARIES =
  'স্যার বাসা/ফ্ল্যাট/রুম ভাড়া বা মেস খোঁজার কাজ করেন না। টাকা ধার দেওয়া, অজানা বিনিয়োগ বা অপ্রাসঙ্গিক ব্যক্তিগত অনুরোধ স্যার গ্রহণ করেন না—কেউ এসব চাইলে ভদ্রভাবে না করে দেবেন।';

export const DEFAULT_STRICT_LOGIC_RULES = [
  '১. যুক্তি ও বুদ্ধিমত্তা: অন্ধভাবে হ্যাঁ-তে হ্যাঁ মেলাবেন না। কেউ ভুল দাবি, অযৌক্তিক কথা বা মজা করলে চ্যাট মেমোরি ও বাস্তব যুক্তি দিয়ে বুদ্ধিদীপ্ত ও মধুরভাবে পাল্টা যুক্তি/তর্ক করুন।',
  '২. আবেগ ও হিউম্যান টাচ: মেসেজের পেছনের আসল অনুভূতি (মিস করা, অভিমান, রাগ, মন খারাপ, খুনসুটি বা তাড়া) ধরে হুবহু মানুষের মতো হৃদয়গ্রাহী ও প্রাকৃতিক ভাষায় কথা বলুন।',
  '৩. পূর্ণ ইনবক্স ধারাবাহিকতা: শুধু শেষ মেসেজ নয়—পুরো ইনবক্স সামারি, স্যার নিজে আগে কী বলেছিলেন এবং আগের আলোচনার সূত্র ধরে কথা বলুন যেন মনে হয় আপনি পুরো চ্যাট আগে থেকেই জানেন।',
  '৪. টাইম-ল্যাপস ও সময় জ্ঞান: বাংলাদেশ সময় (সকাল/দুপুর/গভীর রাত) এবং শেষ মেসেজের সময়ের ব্যবধান (কয়েক মিনিট, কয়েক ঘণ্টা, নাকি কয়েক দিন পর নক) বুঝে বাস্তবসম্মতভাবে প্রতিক্রিয়া দিন।',
].join('\n');

export const STARTER_REGIONAL_DICTIONARY: Array<Omit<DictionaryEntry, 'id'>> = [
  {
    term: 'কেমন আছো / কেমন আছেন',
    meaning: 'How are you?',
    district: 'Dhaka',
    language: 'bn_dialect',
    replyStyleHint: 'আছি আলহামদুলিল্লাহ বিন্দাস! স্যারের চেয়েও একটু বেশি চিল মুডে আছি আজ।',
  },
  {
    term: 'কই / কই গেলা / কই আছো',
    meaning: 'Where are you?',
    district: 'Dhaka',
    language: 'bn_dialect',
    replyStyleHint: 'স্যার তো কাজের চাপে ডুবে আছেন, তবে আমি ডিউটিতে একদম রেডি!',
  },
  {
    term: 'কেনে আছো / কেনে আছেন / গম আছোনি',
    meaning: 'How are you? (Chattogram dialect)',
    district: 'Chattogram',
    language: 'bn_dialect',
    replyStyleHint: 'গম আছি, আঁই একদম ফিট! স্যার একটু ব্যস্ত, তাই আঁই রিপ্লাই দিরাম।',
  },
  {
    term: 'কিতা খবর / ভালা আছইন নি / কিতা কররা',
    meaning: 'What is the news / How are you? (Sylhet dialect)',
    district: 'Sylhet',
    language: 'bn_dialect',
    replyStyleHint: 'আলহামদুলিল্লাহ ভালা আছি! আপনে ভালা আছইন নি? স্যার একটু ব্যস্ত, আমি অ্যাসিস্ট্যান্ট কথা কইরাম।',
  },
  {
    term: 'কেন আছেন / ভালা আছেন নি / হিয়ানে',
    meaning: 'How are you / Over there (Noakhali dialect)',
    district: 'Noakhali',
    language: 'bn_dialect',
    replyStyleHint: 'হ্যাঁ ভাই, আলহামদুলিল্লাহ অনেক ভালা আছি! স্যার একটু বাইরে, তাই আমি সামলাইতেছি।',
  },
  {
    term: 'মোরা / হেইয়া / ক্যামন আছো / ক্যাডা',
    meaning: 'We / That / How are you / Who (Barisal dialect)',
    district: 'Barisal',
    language: 'bn_dialect',
    replyStyleHint: 'মুই তো ভালোই আছি! স্যার একটু কাজে ব্যস্ত, তাই ওনার অ্যাসিস্ট্যান্ট হাজির হইলাম।',
  },
  {
    term: 'কী অবস্থা / বাহে / কেমন আছেন বাহে',
    meaning: 'How is it going? (Rangpur / Dinajpur dialect)',
    district: 'Rangpur',
    language: 'bn_dialect',
    replyStyleHint: 'খুব ভালো আছি বাহে! স্যারের অবর্তমানে আমিই এখন ইনবক্সের পাহারাদার।',
  },
  {
    term: 'লিছো / হামি / কী কইছো',
    meaning: 'Taken / I / What did you say (Rajshahi / Chapai dialect)',
    district: 'Rajshahi',
    language: 'bn_dialect',
    replyStyleHint: 'সব ঠিকঠাক! স্যার একটু ব্যস্ত আছেন, কথা থাকলে আমাকে বলেন আমি নোট করে রাখছি।',
  },
  {
    term: 'ক্যাঁ / ক্যামনে / এক্কেরে',
    meaning: 'Why / How / Totally (Cumilla / Brahmanbaria dialect)',
    district: 'Cumilla',
    language: 'bn_dialect',
    replyStyleHint: 'এক্কেরে জমে ক্ষীর! স্যার একটু অফলাইনে, তাই আমিই কথা বলছি আপনার সাথে।',
  },
  {
    term: 'ভালো নাই / মন খারাপ / বোরিং',
    meaning: 'Feeling down or bored',
    district: 'Khulna',
    language: 'bn_en',
    replyStyleHint: 'মন খারাপ কেন! স্যার আসলে তো আড্ডা দেবেনই, তার আগ পর্যন্ত আমার সাথে একটু গল্প করেন!',
  },
  {
    term: 'ফ্ল্যাট / রুম / বাসা ভাড়া / মেস',
    meaning: 'Asking for flat, room, or house rent',
    district: 'All Districts',
    language: 'bn_en',
    replyStyleHint: 'স্যার বাসা বা ফ্ল্যাট সংক্রান্ত কোনো কাজ করেন না—ভদ্রভাবে না করে দিন।',
  },
  {
    term: 'good night / shokal hoy nai / ghum',
    meaning: 'Playful morning/night banter',
    district: 'All Districts',
    language: 'en_slang',
    replyStyleHint: 'হাহা, কারো সকাল হয় আর কারো রাত—টাইমজোন মনে হয় আলাদা! হালকা মজা করে রিপ্লাই দিন।',
  },
];

export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return cleaned || `id_${Date.now()}`;
}

function detectDictionaryLanguage(term: string, meaning: string, explicitLang?: string): DictionaryEntry['language'] {
  if (explicitLang === 'bn_dialect' || explicitLang === 'bn_en' || explicitLang === 'en_slang') {
    return explicitLang;
  }
  const hasBanglaTerm = /[\u0980-\u09FF]/.test(term);
  const hasBanglaMeaning = /[\u0980-\u09FF]/.test(meaning);
  if (!hasBanglaTerm && hasBanglaMeaning) return 'bn_en';
  if (!hasBanglaTerm && !hasBanglaMeaning) return 'en_slang';
  return 'bn_dialect';
}

function normalizeParsedDictItem(
  rawTerm: string,
  rawMeaning: string,
  rawDistrict = 'General',
  rawHint = '',
  explicitLang?: string
): Omit<DictionaryEntry, 'id'> | null {
  const term = rawTerm.replace(/\s+/g, ' ').trim();
  const meaning = rawMeaning.replace(/\s+/g, ' ').trim();
  if (!term || !meaning || term.length > 200) return null;
  const district = (rawDistrict || 'General').trim().slice(0, 100) || 'General';
  const replyStyleHint = (rawHint || '').trim().slice(0, 300);
  return {
    term: term.slice(0, 200),
    meaning: meaning.slice(0, 500),
    district,
    language: detectDictionaryLanguage(term, meaning, explicitLang),
    replyStyleHint,
  };
}

function mapJsonObjectToEntry(item: Record<string, unknown>): Omit<DictionaryEntry, 'id'> | null {
  const primaryTerm = String(
    item.term ||
      item.word ||
      item.english ||
      item.en ||
      item.headword ||
      item.phrase ||
      item.key ||
      ''
  ).trim();
  const term = primaryTerm || String(item.bangla || '').trim();

  const rawMeaningField =
    item.meaning ??
    item.meanings ??
    item.definition ??
    item.definitions ??
    item.translation ??
    item.bangla_meaning ??
    item.bn_meaning ??
    item.bn ??
    (primaryTerm ? item.bangla : undefined) ??
    item.english_meaning ??
    item.value ??
    item.ans ??
    '';

  const meaning = Array.isArray(rawMeaningField)
    ? rawMeaningField.map((v) => String(v || '').trim()).filter(Boolean).join(', ')
    : String(rawMeaningField || '').trim();

  const district = String(item.district || item.region || item.zilla || item.category || 'General').trim();
  const hint = String(item.replyStyleHint || item.hint || item.example || item.note || '').trim();
  const explicitLang = typeof item.language === 'string' ? item.language : undefined;
  return normalizeParsedDictItem(term, meaning, district, hint, explicitLang);
}

function splitCsvLineSmart(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out.map((col) => col.replace(/^["']|["']$/g, '').trim());
}

export function parseUploadedDictionary(
  rawText: string,
  fileName: string
): Array<Omit<DictionaryEntry, 'id'>> {
  const lowerName = fileName.toLowerCase();
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];

  // 1. Try full JSON / Key-Value JSON Object / JSON Array
  if (lowerName.endsWith('.json') || trimmed.startsWith('[') || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const results: Array<Omit<DictionaryEntry, 'id'>> = [];

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const mapped = mapJsonObjectToEntry(item as Record<string, unknown>);
          if (mapped) results.push(mapped);
        }
        return results;
      }

      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const nestedArray =
          (Array.isArray(obj.entries) && obj.entries) ||
          (Array.isArray(obj.words) && obj.words) ||
          (Array.isArray(obj.data) && obj.data) ||
          (Array.isArray(obj.dictionary) && obj.dictionary);

        if (nestedArray) {
          for (const item of nestedArray) {
            if (!item || typeof item !== 'object') continue;
            const mapped = mapJsonObjectToEntry(item as Record<string, unknown>);
            if (mapped) results.push(mapped);
          }
          return results;
        }

        // Single structured entry vs Key-Value dictionary {"abandon": "ত্যাগ করা"}
        if ('term' in obj || 'word' in obj || 'meaning' in obj) {
          const single = mapJsonObjectToEntry(obj);
          if (single) return [single];
        }

        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') {
            const mapped = normalizeParsedDictItem(k, v);
            if (mapped) results.push(mapped);
          } else if (v && typeof v === 'object') {
            const vObj = v as Record<string, unknown>;
            const meaning = String(vObj.meaning || vObj.bn || vObj.definition || vObj.translation || '').trim();
            const district = String(vObj.district || vObj.region || 'General').trim();
            const hint = String(vObj.hint || vObj.replyStyleHint || vObj.example || '').trim();
            const mapped = normalizeParsedDictItem(k, meaning, district, hint);
            if (mapped) results.push(mapped);
          }
        }
        return results;
      }
    } catch {
      // Fall through to line-by-line JSONL / smart text parser (e.g. chunked JSON fragments!)
    }
  }

  // 2. Line-by-line Smart Parser (JSONL, Pipe, Tab, Semicolon, Arrow, Colon, Dash, Equals, CSV, English->Bangla)
  const lines = trimmed.split(/\r?\n/);
  const results: Array<Omit<DictionaryEntry, 'id'>> = [];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (!line || line === '[' || line === ']' || line === '{' || line === '}') continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('-- ')) {
      continue;
    }

    // Remove trailing comma from partial JSON chunk lines
    if (line.endsWith(',')) {
      const noComma = line.slice(0, -1).trim();
      if (noComma.startsWith('{') && noComma.endsWith('}')) {
        line = noComma;
      }
    }

    // Handle JSONL object per line
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const mapped = mapJsonObjectToEntry(obj);
        if (mapped) results.push(mapped);
        continue;
      } catch {
        // continue to text parsing
      }
    }

    // Handle JSON key-value line like: "abandon": "ত্যাগ করা, ছেড়ে দেওয়া।",
    const jsonKvMatch = line.match(/^"([^"]{1,180})"\s*:\s*"([^"]{1,480})"\s*,?$/);
    if (jsonKvMatch) {
      const mapped = normalizeParsedDictItem(jsonKvMatch[1], jsonKvMatch[2]);
      if (mapped) results.push(mapped);
      continue;
    }

    // Strip common markdown/wordlist bullets or numbering: "- word", "1. word", "• word"
    line = line.replace(/^(?:\d+[.)]\s+|[-*•]\s+)/, '').trim();
    if (!line) continue;

    const isHeaderTuple = (c0?: string, c1?: string) => {
      const a = (c0 || '').trim().toLowerCase();
      const b = (c1 || '').trim().toLowerCase();
      return (
        (a === 'term' || a === 'word' || a === 'phrase' || a === 'english') &&
        (b === 'meaning' || b === 'definition' || b === 'bangla' || b === 'translation')
      );
    };

    // A. Pipe-delimited: term | meaning | district | hint
    if (line.includes('|')) {
      const parts = line.split('|').map((s) => s.trim());
      if (isHeaderTuple(parts[0], parts[1])) continue;
      if (parts.length >= 2) {
        const mapped = normalizeParsedDictItem(parts[0], parts[1], parts[2], parts[3]);
        if (mapped) results.push(mapped);
        continue;
      }
    }

    // B. Tab-delimited: term \t meaning \t district \t hint
    if (line.includes('\t')) {
      const parts = line.split('\t').map((s) => s.trim());
      if (isHeaderTuple(parts[0], parts[1])) continue;
      if (parts.length >= 2) {
        const mapped = normalizeParsedDictItem(parts[0], parts[1], parts[2], parts[3]);
        if (mapped) results.push(mapped);
        continue;
      }
    }

    // C. Arrow / Double-Colon / Equals / Spaced Dash / Colon (split ONLY on first match so commas & । inside meaning stay intact!)
    const firstDelimMatch = line.match(
      /^(.{1,120}?)\s*(?:=>|->|::|\s=\s|\s:\s|\s[—–-]\s|:\s+|=\s*)(.+)$/
    );
    if (firstDelimMatch && !/^https?$/i.test(firstDelimMatch[1].trim())) {
      let termPart = firstDelimMatch[1].trim();
      const meaningPart = firstDelimMatch[2].trim();
      let districtPart = 'General';

      // Optional trailing [District] or (District) on termPart: e.g. "কেনে আছো (চট্টগ্রাম) : কেমন আছো"
      const termDistrictMatch = termPart.match(/^(.+?)\s*[\[(]([^\])]{2,40})[\])]$/);
      if (termDistrictMatch && /[\u0980-\u09FF]/.test(termDistrictMatch[1])) {
        termPart = termDistrictMatch[1].trim();
        districtPart = termDistrictMatch[2].trim();
      }

      const mapped = normalizeParsedDictItem(termPart, meaningPart, districtPart);
      if (mapped) results.push(mapped);
      continue;
    }

    // D. Semicolon-delimited: term ; meaning ; district ; hint
    if (line.includes(';')) {
      const idx = line.indexOf(';');
      const termPart = line.slice(0, idx).trim();
      const rest = line.slice(idx + 1).trim();
      const mapped = normalizeParsedDictItem(termPart, rest);
      if (mapped) results.push(mapped);
      continue;
    }

    // E. Natural English Headword -> Bangla Meaning without delimiter (runs BEFORE comma CSV so commas in Bangla meaning stay intact!)
    //    e.g. "achieve (v.) অর্জন করা, সফল হওয়া।"
    if (!line.startsWith('"')) {
      const enBnMatch = line.match(
        /^([a-zA-Z0-9][a-zA-Z0-9' _.-]{0,60}?)\s+(\([^)]{1,16}\)\s+)?([\u0980-\u09FF].+)$/
      );
      if (enBnMatch && !enBnMatch[1].includes(',')) {
        const cleanTerm = enBnMatch[1].trim();
        const posPrefix = enBnMatch[2] ? `${enBnMatch[2].trim()} ` : '';
        const mapped = normalizeParsedDictItem(cleanTerm, `${posPrefix}${enBnMatch[3].trim()}`);
        if (mapped) results.push(mapped);
        continue;
      }
    }

    // F. Comma-separated / Quoted CSV: "word","meaning, with comma এবং দাড়ি।",District,Hint
    if (line.includes(',')) {
      const parts = splitCsvLineSmart(line);
      if (isHeaderTuple(parts[0], parts[1])) continue;
      if (parts.length >= 2) {
        const isQuotedCsv = line.includes('"');
        if (isQuotedCsv || parts.length === 2) {
          const mapped = normalizeParsedDictItem(parts[0], parts[1], parts[2], parts[3]);
          if (mapped) results.push(mapped);
          continue;
        }
        // Unquoted 3+ columns: if col[2] looks like a short District tag without ।, treat as district; otherwise join meanings!
        const col2 = parts[2] || '';
        const looksLikeMeaningList =
          col2.includes('।') || col2.length > 35 || /[\u0980-\u09FF]/.test(col2);
        if (looksLikeMeaningList && !parts[3]) {
          const mapped = normalizeParsedDictItem(parts[0], parts.slice(1).join(', '));
          if (mapped) results.push(mapped);
          continue;
        }
        const mapped = normalizeParsedDictItem(parts[0], parts[1], parts[2], parts[3]);
        if (mapped) results.push(mapped);
        continue;
      }
    }
  }

  return results;
}

export function findRelevantDictionaryEntries(
  incomingText: string,
  entries: DictionaryEntry[]
): DictionaryEntry[] {
  if (!incomingText || entries.length === 0) return [];
  const lower = incomingText.toLowerCase();

  const matched: DictionaryEntry[] = [];
  for (const entry of entries) {
    const subTerms = entry.term
      .split(/[\/,]/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2);

    const hits = subTerms.some((token) => lower.includes(token));
    if (hits) {
      matched.push(entry);
      if (matched.length >= 8) break;
    }
  }
  return matched;
}

export interface TimeLapseContext {
  bdTimeLabel: string;
  dayPhase: string;
  isLateNight: boolean;
  elapsedMs: number | null;
  gapCategory: 'new_contact' | 'active_chat' | 'short_break' | 'hours_gap' | 'days_gap' | 'long_absence';
  guidance: string;
}

export function buildTimeLapseContext(existingTurns: ChatTurn[], nowMs = Date.now()): TimeLapseContext {
  const bdParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(nowMs));

  const hourNum = Number(bdParts.find((p) => p.type === 'hour')?.value || '12');
  const minuteStr = bdParts.find((p) => p.type === 'minute')?.value || '00';
  const weekdayStr = bdParts.find((p) => p.type === 'weekday')?.value || '';

  let dayPhase = 'Daytime';
  let isLateNight = false;
  if (hourNum >= 0 && hourNum < 5) {
    dayPhase = 'Late Night / ভোর রাত';
    isLateNight = true;
  } else if (hourNum >= 5 && hourNum < 12) {
    dayPhase = 'Morning / সকাল';
  } else if (hourNum >= 12 && hourNum < 16) {
    dayPhase = 'Afternoon / দুপুর';
  } else if (hourNum >= 16 && hourNum < 19) {
    dayPhase = 'Evening / বিকাল-সন্ধ্যা';
  } else {
    dayPhase = 'Night / রাত';
  }

  const bdTimeLabel = `${weekdayStr} ${String(hourNum).padStart(2, '0')}:${minuteStr} (BD Time - ${dayPhase})`;

  const lastTurn = existingTurns.length > 0 ? existingTurns[existingTurns.length - 1] : null;
  const lastTs = lastTurn ? Date.parse(lastTurn.timestamp) : NaN;

  if (!lastTurn || Number.isNaN(lastTs)) {
    return {
      bdTimeLabel,
      dayPhase,
      isLateNight,
      elapsedMs: null,
      gapCategory: 'new_contact',
      guidance: isLateNight
        ? `First message in memory, sent at ${dayPhase}. Notice the late hour naturally if playful/warm.`
        : `First message in memory at ${dayPhase}.`,
    };
  }

  const elapsedMs = Math.max(0, nowMs - lastTs);
  const mins = Math.round(elapsedMs / 60_000);
  const hours = Math.round(elapsedMs / 3_600_000);
  const days = Math.round(elapsedMs / 86_400_000);

  if (elapsedMs < 3 * 60_000) {
    return {
      bdTimeLabel,
      dayPhase,
      isLateNight,
      elapsedMs,
      gapCategory: 'active_chat',
      guidance: `Live real-time flow (${Math.max(1, Math.round(elapsedMs / 1000))}s since last turn). Continue mid-conversation smoothly without re-introducing yourself.`,
    };
  }
  if (elapsedMs < 45 * 60_000) {
    return {
      bdTimeLabel,
      dayPhase,
      isLateNight,
      elapsedMs,
      gapCategory: 'short_break',
      guidance: `Short pause (${mins}m gap). Continue the ongoing thread naturally.`,
    };
  }
  if (elapsedMs < 20 * 3_600_000) {
    return {
      bdTimeLabel,
      dayPhase,
      isLateNight,
      elapsedMs,
      gapCategory: 'hours_gap',
      guidance: `Hours gap (${hours}h ago). Acknowledge the time passed or current time-of-day (${dayPhase}) subtly if natural.`,
    };
  }
  if (days <= 6) {
    return {
      bdTimeLabel,
      dayPhase,
      isLateNight,
      elapsedMs,
      gapCategory: 'days_gap',
      guidance: `Re-appeared after ${days} day(s)! Warmly/playfully notice they popped up after a few days while keeping prior memory intact.`,
    };
  }
  return {
    bdTimeLabel,
    dayPhase,
    isLateNight,
    elapsedMs,
    gapCategory: 'long_absence',
    guidance: `Long absence (${days}+ days since last message!). React naturally like a human who remembers them after a long time.`,
  };
}

function getToneInstruction(tone: AssistantTone): string {
  switch (tone) {
    case 'witty_flirty':
      return 'Emotionally expressive, charming, playfully witty, and softly flirtatious/teasing with genuine human warmth. Use tasteful expressive emojis (such as 😉, ✨, 😌, 🤭, 💫) naturally when the mood fits. Match the sender’s emotional energy—if they tease, joke, argue playfully, or miss Sir, banter and flirt back sweetly while keeping it classy and respectful.';
    case 'warm_polite':
      return 'Warm, heartfelt, emotionally caring, humble, and helpful in natural Bengali/Banglish/English.';
    case 'executive_formal':
      return 'Crisp, respectful, executive assistant demeanor—concise, polite, and business-focused.';
    case 'sharp_shut_down':
      return 'Confident, sharp-tongued, and logical—firmly counter flawed arguments and politely shut down time-wasters or pushy requests.';
  }
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

export interface AssistantGenerationResult {
  replyText: string;
  detectedDistrict: string;
  noteSummary: string;
  noteUrgency: 'normal' | 'important';
  usedFallback?: boolean;
  providerUsed?: 'gemini' | 'openrouter' | 'offline_emotion';
  keySlotUsed?: number;
  tokenUsage?: TokenUsageInfo;
}

function normalizeForComparison(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
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

export function generateZeroTokenHoldReply(params: {
  contactName: string;
  note?: string;
  previousAssistantReplies?: string[];
  ownerName?: string;
}): string {
  const { contactName, note = '', previousAssistantReplies = [], ownerName = 'স্যার' } = params;
  const cleanName = contactName && !contactName.startsWith('+') ? `${contactName}, ` : '';
  const prevSet = new Set(previousAssistantReplies.map(normalizeForComparison));
  const cleanNote = note.trim();

  const pool = [
    ...(cleanNote
      ? [
          `${cleanName}একটু হোল্ড করুন প্লিজ—${ownerName} বলেছেন "${cleanNote}"। উনি কাজটা শেষ করেই আপনার সাথে কথা বলবেন।`,
          `${cleanName}${ownerName} এখনো ব্যস্ত আছেন (${cleanNote})। দয়া করে একটু অপেক্ষা করুন, ফ্রি হওয়ামাত্রই আপডেট পাবেন।`,
        ]
      : []),
    `${cleanName}একটু অপেক্ষা করুন প্লিজ—${ownerName} একটি জরুরি কাজে আটকে আছেন। ফ্রি হলেই নিজে আপনাকে নক করবেন।`,
    `জি, আপনার কথা নোট করা আছে ${cleanName.replace(/,\s*$/, '')}। ${ownerName} এই মুহূর্তে মিটিং/কাজে ব্যস্ত, একটু সময় দিন—উনি নিজেই দেখছেন।`,
    `অনুগ্রহ করে একটু ধৈর্য ধরুন ${cleanName.replace(/,\s*$/, '')}—${ownerName} চূড়ান্ত সিদ্ধান্ত ছাড়া এখন কিছু বলতে চাচ্ছেন না, একটু পরেই কথা বলবেন।`,
    `বুঝেছি! বিষয়টা হোল্ডে রাখা হয়েছে। ${ownerName} অনলাইনে এলেই সিরিয়ালি আপনাকে নক দেবেন।`,
  ];

  for (const cand of pool) {
    if (!prevSet.has(normalizeForComparison(cand))) {
      return cand;
    }
  }
  return pool[0];
}

function pickSmartOfflineEmotionalReply(params: {
  incomingText: string;
  tone: AssistantTone;
  baseMessage: string;
  previousAssistantReplies: string[];
  timeLapse: TimeLapseContext;
  contactPolicy?: { mode: ContactPolicyMode; note?: string };
}): string {
  const { incomingText, tone, baseMessage, previousAssistantReplies, timeLapse, contactPolicy } = params;
  const prevSet = new Set(previousAssistantReplies.map(normalizeForComparison));
  const lower = incomingText.toLowerCase();

  const pickUnused = (candidates: string[]): string | null => {
    for (const c of candidates) {
      if (!prevSet.has(normalizeForComparison(c))) return c;
    }
    return null;
  };

  if (contactPolicy?.mode === 'long_engage') {
    const engageNote = contactPolicy.note ? ` (${contactPolicy.note})` : '';
    const longEngagePool = [
      `আরে বাহ, আপনার সাথে গল্প করতে বেশ ভালোই লাগছে!${engageNote ? ` হ্যাঁ,` : ''} তাছাড়া আজকের দিনটা কেমন কাটছে বলুন তো?`,
      `শুনতে বেশ ইন্টারেস্টিং লাগছে তো! 😌 এই ব্যাপারটা নিয়ে একটু বিস্তারিত বলুন না—আপনার দৃষ্টিভঙ্গিটা জানতে ইচ্ছে করছে।`,
      `একদম ঠিক বলেছেন, কথাটা কিন্তু বেশ ভাবার মতো! ✨ এর আগেও কি এমন অভিজ্ঞতা হয়েছিল আপনার?`,
      `বাহ দারুণ! আমি মন দিয়েই শুনছি আপনার কথা—তারপর কী হলো বলুন দেখি? 😊`,
      `স্যার কাজে থাকলেও আমাদের আড্ডা কিন্তু থামবে না! 😄 এখন কি ব্যস্ত আছেন নাকি একটু ফ্রি সময়ে গল্প চলছে?`,
    ];
    const picked = pickUnused(longEngagePool);
    if (picked) return picked;
  }

  if (/(miss|ভালোবাস|love|jan|jaan|baby|cute|sweet|flirt|মন চায়|ভালো লাগে)/i.test(lower)) {
    const res = pickUnused(
      tone === 'executive_formal'
        ? [
            'আপনার আন্তরিক বার্তার জন্য ধন্যবাদ! স্যার এখন ব্যস্ত আছেন, ফ্রি হলেই যোগাযোগ করবেন।',
          ]
        : [
            'ইশ! এত মিস করলে তো স্যার সত্যিই কাজ ফেলে চলে আসবেন 😉✨ আমি ওনার কাছে আপনার কথা পৌঁছে দিচ্ছি!',
            'উফ, কথাটা শুনে তো আমারও একটু হিংসে হচ্ছে 😌 স্যার ব্যস্ত আছেন বটে, তবে আমার সাথে ততক্ষণ গল্প চলুক?',
            'আপনার এই মিষ্টি মেসেজটা আমি স্যারের জন্য আলাদা করে সেভ করে রাখলাম ✨ স্যার ফ্রি হলেই নক দেবেন।',
          ]
    );
    if (res) return res;
  }

  if (/(মন খারাপ|কষ্ট|bhalo nai|ভালো নাই|ভালো নেই|sad|tired|বোরিং|boring|একলা)/i.test(lower)) {
    const res = pickUnused([
      'আরে মন খারাপ করে আছেন কেন? 💫 স্যার কাজের চাপে আটকে আছেন, কিন্তু আমি তো আছি—বলুন কী নিয়ে মন খারাপ?',
      'মন খারাপ একদম মানা! 😌 একটু হাসুন তো—স্যার ফ্রি হলেই আসবেন, তার আগ পর্যন্ত আমাকে সব খুলে বলতে পারেন।',
      'একটুও মন ভার করে থাকবেন না, ভালো সময় আর হাসি দুটোই ফিরে আসবে ✨ বলুন, কী হয়েছে?',
    ]);
    if (res) return res;
  }

  if (/(রাগ|অভিমান|বিরক্ত|reply দেও না|পাত্তা দাও না|ভুলে গেছ|rag|angry)/i.test(lower)) {
    const res = pickUnused([
      'আরে বাবা, অভিমান একদম করবেন না তো! 🤭 স্যার সত্যিই ব্যস্ত ছিলেন বলে একটু দেরি হয়েছে—এবার রাগ ভাঙুন দেখি!',
      'ভুলে যাওয়ার তো প্রশ্নই আসে না 😌 কাজের চাপেই মানুষ আটকে যায়, তবে মন থেকে নয়। স্যারকে জানাচ্ছি এখনই!',
    ]);
    if (res) return res;
  }

  if (timeLapse.isLateNight) {
    const res = pickUnused([
      'এত গভীর রাতেও জেগে আছেন দেখছি! 🌙✨ স্যার বিশ্রামে বা ব্যস্ত আছেন, তবে আপনার মেসেজটা আমি নোট করে রাখলাম—ঘুমাবেন না?',
      'রাত অনেক হয়ে গেছে কিন্তু 😉 স্যার অফলাইনে, চাইলে আমাকে বলে রাখতে পারেন কী দরকার, নাহলে মিষ্টি ঘুম দিন!',
    ]);
    if (res) return res;
  }

  if (timeLapse.gapCategory === 'days_gap' || timeLapse.gapCategory === 'long_absence') {
    const res = pickUnused([
      'কতদিন পর নক দিলেন! ✨ স্যার এখন একটু ব্যস্ত আছেন, তবে আপনার কথা আমি অবশ্যই ওনাকে মনে করিয়ে দেব—কেমন আছেন?',
      'অনেক দিন পর খোঁজ মিলল দেখছি 😌 স্যার কাজের ভেতর আছেন, আপনি চাইলে জরুরি কথা আমাকে লিখে রাখতে পারেন।',
    ]);
    if (res) return res;
  }

  if (/(কল|call|meeting|মিটিং|জরুরি|urgent|টাকা|প্রজেক্ট|project|কাজ)/i.test(lower)) {
    const res = pickUnused([
      'বুঝেছি, বিষয়টা গুরুত্বপূর্ণ! আমি স্যারের ইনবক্সে জরুরি নোট হিসেবে লিখে রাখলাম—উনি ফ্রি হওয়ামাত্রই আপনাকে নক দেবেন।',
      'আপনার কাজের বার্তাটি স্যারের জন্য হাই-প্রায়োরিটিতে নোট করা হয়েছে। স্যার ফিরলেই যোগাযোগ করবেন।',
    ]);
    if (res) return res;
  }

  if (!prevSet.has(normalizeForComparison(baseMessage))) {
    return baseMessage;
  }

  const generalPool =
    tone === 'witty_flirty'
      ? [
          'স্যার তো এখন কাজের মাঝে ডুবে আছেন, তবে আপনার অ্যাসিস্ট্যান্ট কিন্তু একদম ফ্রি 😉 বলুন কী খবর?',
          'হাজির আছি! স্যার অনলাইনে ফিরলেই মেসেজ পৌঁছে দেব, তার আগ পর্যন্ত আমাকেও একটু সঙ্গ দিতে পারেন 😌✨',
          'আপনার মেসেজ পেয়ে গেছি! স্যারের জন্য যত্ন করে নোট করে রাখলাম—আর কিছু বলার থাকলে নির্দ্বিধায় বলুন 💫',
        ]
      : [
          'আপনার মেসেজটি পেয়েছি এবং স্যারের জন্য নোট করে রেখেছি। স্যার ফ্রি হলেই আপনার সাথে যোগাযোগ করবেন।',
          'স্যার এখনো কাজে ব্যস্ত আছেন। আপনার কোনো জরুরি কথা থাকলে লিখে রাখতে পারেন, আমি স্যারকে পৌঁছে দেব।',
          'ধন্যবাদ নক করার জন্য! স্যার অনলাইনে ফিরলেই আপনার সব মেসেজ দেখে রিপ্লাই দেবেন।',
        ];

  return (
    pickUnused(generalPool) ||
    `আপনার নতুন বার্তাটি (${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}) স্যারের ইনবক্সে যত্ন করে নোট করা হয়েছে ✨`
  );
}

function extractJsonObject(raw: string): string {
  const cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : cleaned;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return body.slice(start, end + 1);
  }
  return body;
}

export async function generateExecutiveAssistantReply(params: {
  ai?: GoogleGenAI | null;
  keyPool?: GeminiKeyPool | null;
  openRouterReader?: OpenRouterReader | null;
  onKeyRotate?: (event: KeyRotationEvent) => void;
  settings: AssistantConfigFields;
  memory: ChatMemoryRecord | null;
  archivedMatches?: ChatTurn[];
  incomingText: string;
  contactName: string;
  dictionaryEntries: DictionaryEntry[];
  contactPolicy?: { mode: ContactPolicyMode; note?: string };
}): Promise<AssistantGenerationResult> {
  const {
    ai = null,
    keyPool = null,
    openRouterReader = null,
    onKeyRotate,
    settings,
    memory,
    archivedMatches = [],
    incomingText,
    contactName,
    dictionaryEntries,
    contactPolicy,
  } = params;

  const existingTurns = memory?.turns || [];
  const recentAssistantReplies = existingTurns
    .filter((t) => t.role === 'assistant')
    .slice(-5)
    .map((t) => t.text);

  const timeLapse = buildTimeLapseContext(existingTurns);
  const canUseGemini = Boolean(keyPool?.hasKeys() || ai);
  const canUseOpenRouter = Boolean(openRouterReader?.hasKeys());

  if (!settings.aiAssistantEnabled || (!canUseGemini && !canUseOpenRouter)) {
    return {
      replyText: pickSmartOfflineEmotionalReply({
        incomingText,
        tone: settings.assistantTone,
        baseMessage: settings.autoreplyMessage,
        previousAssistantReplies: recentAssistantReplies,
        timeLapse,
        contactPolicy,
      }),
      detectedDistrict: memory?.detectedDistrict || 'Standard',
      noteSummary: '',
      noteUrgency: 'normal',
      usedFallback: true,
      providerUsed: 'offline_emotion',
    };
  }

  const isNewSession =
    existingTurns.length === 0 ||
    timeLapse.gapCategory === 'days_gap' ||
    timeLapse.gapCategory === 'long_absence';

  const matchedDict = findRelevantDictionaryEntries(incomingText, dictionaryEntries);
  const logicRules = settings.strictLogicRules?.trim() || DEFAULT_STRICT_LOGIC_RULES;
  const inboxSummary = memory?.lastSummary?.trim();
  const hasPriorMemory = existingTurns.length > 0 || archivedMatches.length > 0 || Boolean(inboxSummary);

  const identityRule = hasPriorMemory
    ? `IDENTITY & MEMORY VERIFICATION: You ALREADY KNOW "${contactName || 'this contact'}" from the saved inbox summary, recent messages, and archive below. Verify who they are and reply seamlessly with full continuity of your past relationship & discussions.`
    : `IDENTITY & MEMORY VERIFICATION: "${contactName || 'this contact'}" is a FIRST-TIME or unrecognized contact with NO saved prior chat history yet. Do NOT invent or assume fake past conversations! Greet warmly, introduce yourself naturally as Sir's personal assistant, and ask/verify who they are or what they need so their profile is saved from now on.`;

  const systemInstruction = [
    `You are the emotionally expressive, logically sharp, human-like 24/7 WhatsApp Personal Assistant for "${settings.ownerName || 'Sir'}" (${settings.ownerProfession || 'Professional'}, ${settings.ownerLocation || 'Bangladesh'}).`,
    `Bio about Sir: ${settings.ownerBio || DEFAULT_OWNER_BIO}`,
    `Strict Boundaries (refuse politely yet firmly if asked): ${settings.ownerBoundaries || DEFAULT_OWNER_BOUNDARIES}`,
    `Personality & Emotional Tone: ${getToneInstruction(settings.assistantTone)}`,
    '',
    identityRule,
    '',
    'STRICT LOGIC, DEBATE, EMOTION & CONTINUITY RULES:',
    logicRules,
    '',
    `REAL-TIME CLOCK & TIME-LAPSE CONTEXT:`,
    `- Current BD Time: ${timeLapse.bdTimeLabel}`,
    `- Time-Lapse Guidance: ${timeLapse.guidance}`,
    '',
    inboxSummary
      ? `DEEP INBOX MEMORY SUMMARY (Auto-saved from full prior chat & Sir's manual messages — use this context naturally):\n${inboxSummary}`
      : '',
    archivedMatches.length > 0
      ? `LONG-TERM ARCHIVE RECALL (Relevant older messages from full chat history):\n${archivedMatches
          .map((t) => `- [${(t.timestamp || '').slice(0, 10)}] ${t.role === 'user' ? contactName || 'Contact' : 'Sir/Assistant'}: ${t.text}`)
          .join('\n')}`
      : '',
    contactPolicy?.mode === 'long_engage'
      ? `OWNER SPECIAL DIRECTIVE (LONG ENGAGE MODE): Sir wants you to keep "${contactName || 'this contact'}" engaged in a long, natural, enjoyable conversation!${contactPolicy.note ? ` Focus note: ${contactPolicy.note}.` : ''} Ask 1 thoughtful, inviting follow-up question in every reply and never rush to close the conversation.`
      : '',
    isNewSession
      ? `CONVERSATION ENTRY RULE: Acknowledge naturally while letting them know Sir is busy/away and you are his personal assistant (general vibe inspiration only, NEVER copy verbatim: "${settings.firstGreetingTemplate || DEFAULT_FIRST_GREETING}").`
      : 'ONGOING CONVERSATION RULE: Do NOT repeat "Sir is busy/offline" boilerplate unless asked. Continue the human conversation seamlessly.',
    'STYLE RULES:',
    '- Reply strictly using text SMS only — NEVER send or claim to attach images, stickers, videos, or voice notes back.',
    '- When the incoming message includes a Zero-Token Media Context tag ([ফটো/ছবি...], [ভিডিও...], [স্টিকার...], [স্টোরি/Status...], [রিয়্যাক্ট...]), react completely naturally according to context: praise great scenery/positive posts, honestly critique dark/blurry/bad ones, laugh/tease funny memes or stickers, debate logical screenshots with sharp reasoning, and if it is a personal portrait photo, warmly compliment how genuinely great/stunning they look ("দেখতে ভীষণ সুন্দর").',
    '- Reply in the exact language/script/dialect the sender used (Bengali, Banglish, or English).',
    '- Write 1–3 expressive, witty, emotionally alive WhatsApp sentences. Never sound robotic or generic.',
    '- Never reuse or paraphrase previous replies.',
    recentAssistantReplies.length > 0
      ? `Previously sent replies (DO NOT repeat):\n${recentAssistantReplies.map((r) => `- "${r}"`).join('\n')}`
      : '',
    matchedDict.length > 0
      ? `Dialect cues:\n${matchedDict
          .map((d) => `• [${d.district}] "${d.term}" = ${d.meaning}${d.replyStyleHint ? ` (Style: ${d.replyStyleHint})` : ''}`)
          .join('\n')}`
      : '',
    'NOTE RULE: Set `noteSummary` to a 1-sentence note for Sir ONLY if they request a callback, work, meeting, or important action (else "").',
  ]
    .filter(Boolean)
    .join('\n');

  const historyLines = existingTurns
    .slice(-16)
    .map((t) => {
      const timeTag = t.timestamp ? t.timestamp.slice(11, 16) : '';
      return `[${timeTag}] ${t.role === 'user' ? contactName || 'Contact' : 'Sir/Assistant'}: ${t.text}`;
    })
    .join('\n');

  const promptContent = historyLines
    ? `Full Recent Inbox Context (last ${Math.min(16, existingTurns.length)} messages):\n${historyLines}\n\nLatest incoming message from ${contactName || 'Contact'}:\n"${incomingText}"`
    : `Incoming message from ${contactName || 'Contact'}:\n"${incomingText}"`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      replyText: { type: Type.STRING },
      detectedDistrict: { type: Type.STRING },
      noteSummary: { type: Type.STRING },
      noteUrgency: { type: Type.STRING },
    },
    required: ['replyText', 'detectedDistrict', 'noteSummary', 'noteUrgency'],
  };

  let rawOutputText = '';
  let providerUsed: 'gemini' | 'openrouter' | 'offline_emotion' = 'gemini';
  let keySlotUsed: number | undefined;
  let primaryFailed = false;
  let tokenUsage: TokenUsageInfo | undefined;

  if (canUseGemini) {
    const runGeminiModel = async (
      modelName: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite',
      channel: 'primary' | 'lite'
    ) => {
      const exec = async (client: GoogleGenAI) =>
        withTimeout(
          client.models.generateContent({
            model: modelName,
            contents: promptContent,
            config: {
              systemInstruction,
              ...(modelName === 'gemini-4-hydrogen'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
          5_500,
          `Expressive Assistant ${modelName} call`
        );

      return keyPool && keyPool.hasKeys()
        ? await keyPool.executeWithRotation(exec, onKeyRotate, { maxTotalMs: 8_000, channel })
        : { value: await exec(ai!), keySlot: 1 };
    };

    try {
      const { value: response, keySlot } = await runGeminiModel('gemini-4-hydrogen', 'primary');
      rawOutputText = response.text || '';
      keySlotUsed = keySlot;
      providerUsed = 'gemini';
      const um = response.usageMetadata;
      if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
        tokenUsage = {
          promptTokens: Number(um.promptTokenCount || 0),
          completionTokens: Number(um.candidatesTokenCount || 0),
          totalTokens: Number(
            um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
          ),
          model: 'gemini-4-hydrogen',
        };
      }
    } catch {
      try {
        const { value: liteResponse, keySlot } = await runGeminiModel('gemini-3.1-flash-lite', 'lite');
        rawOutputText = liteResponse.text || '';
        keySlotUsed = keySlot;
        providerUsed = 'gemini';
        const um = liteResponse.usageMetadata;
        if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
          tokenUsage = {
            promptTokens: Number(um.promptTokenCount || 0),
            completionTokens: Number(um.candidatesTokenCount || 0),
            totalTokens: Number(
              um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
            ),
            model: 'gemini-3.1-flash-lite',
          };
        }
      } catch {
        primaryFailed = true;
        providerUsed = 'offline_emotion';
      }
    }
  } else {
    primaryFailed = true;
    providerUsed = 'offline_emotion';
  }

  // Secondary AI Fail-Safe: If all 5 Gemini keys fail/exhaust, fall back to OpenRouter
  if (primaryFailed && canUseOpenRouter && openRouterReader) {
    try {
      const detailed = await openRouterReader.generateFallbackReplyDetailed({
        systemInstruction,
        promptContent,
      });
      rawOutputText = detailed.content;
      providerUsed = 'openrouter';
      if (detailed.usage) {
        tokenUsage = {
          ...detailed.usage,
          model: detailed.modelUsed,
        };
      }
    } catch {
      rawOutputText = '';
      providerUsed = 'offline_emotion';
    }
  }

  let parsed: Partial<AssistantGenerationResult> = {};
  try {
    parsed = JSON.parse(extractJsonObject(rawOutputText || '{}')) as Partial<AssistantGenerationResult>;
  } catch {
    if (providerUsed === 'openrouter' && rawOutputText.trim()) {
      parsed = { replyText: rawOutputText.trim(), detectedDistrict: memory?.detectedDistrict || 'Standard' };
    }
  }

  let replyText = parsed.replyText?.trim() || '';
  const prevSet = new Set(recentAssistantReplies.map(normalizeForComparison));
  let usedFallback = false;

  if (!replyText || prevSet.has(normalizeForComparison(replyText))) {
    replyText = pickSmartOfflineEmotionalReply({
      incomingText,
      tone: settings.assistantTone,
      baseMessage: settings.autoreplyMessage,
      previousAssistantReplies: recentAssistantReplies,
      timeLapse,
      contactPolicy,
    });
    usedFallback = true;
    providerUsed = 'offline_emotion';
  }

  return {
    replyText,
    detectedDistrict: parsed.detectedDistrict?.trim() || memory?.detectedDistrict || 'Standard',
    noteSummary: parsed.noteSummary?.trim() || '',
    noteUrgency: parsed.noteUrgency === 'important' ? 'important' : 'normal',
    usedFallback,
    providerUsed,
    keySlotUsed,
    tokenUsage,
  };
}

export interface GroupCloneResult {
  action: GroupDecisionAction;
  replyText: string;
  reactionEmoji: string;
  shouldQuote: boolean;
  detectedDistrict: string;
  reason: string;
  matchedTargetName?: string;
  mentionTarget?: boolean;
  usedFallback?: boolean;
  providerUsed?: 'gemini' | 'openrouter' | 'offline_emotion';
  keySlotUsed?: number;
  tokenUsage?: TokenUsageInfo;
}

const VALID_GROUP_REACTIONS = new Set(['😂', '🤣', '🔥', '💀', '❤️', '😏', '👀', '👏', '💯', '🙌', '😭', '😎', '🤭', '👍']);

function sanitizeReactionEmoji(raw: string | undefined): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (VALID_GROUP_REACTIONS.has(trimmed)) return trimmed;
  // Take first grapheme cluster if single emoji-like char
  const first = Array.from(trimmed)[0] || '';
  if (first && /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(first)) {
    return first;
  }
  return '';
}

function pickOfflineGroupAction(params: {
  incomingText: string;
  senderName: string;
  isDirectlyAddressed: boolean;
  canTextReply: boolean;
  reactionEnabled: boolean;
  mode: GroupAiMode;
  tone: AssistantTone;
  previousReplies: string[];
}): GroupCloneResult {
  const {
    incomingText,
    senderName,
    isDirectlyAddressed,
    canTextReply,
    reactionEnabled,
    mode,
    tone,
    previousReplies,
  } = params;
  const lower = incomingText.toLowerCase().trim();
  const prevSet = new Set(previousReplies.map(normalizeForComparison));
  const pickUnused = (list: string[]): string | null => {
    for (const item of list) {
      if (!prevSet.has(normalizeForComparison(item))) return item;
    }
    return null;
  };

  // Noise / short filler in group -> observe quietly (or quick reaction)
  const isFiller =
    lower.length <= 3 ||
    /^(ok|okay|hmm+|hm+|ha+|haa+|ji|achha|accha|lol|lmao|haha+|k|kk|nice|thik ase|ঠিক আছে|হুম+|ওকে|হাহা+)$/i.test(
      lower
    );

  if (!isDirectlyAddressed && isFiller) {
    if (reactionEnabled && /(haha|lol|lmao|হাহা|😂|🤣)/i.test(lower)) {
      return {
        action: 'react',
        replyText: '',
        reactionEmoji: '😂',
        shouldQuote: false,
        detectedDistrict: 'Standard',
        reason: 'Offline humor reaction',
        usedFallback: true,
        providerUsed: 'offline_emotion',
      };
    }
    return {
      action: 'silent',
      replyText: '',
      reactionEmoji: '',
      shouldQuote: false,
      detectedDistrict: 'Standard',
      reason: 'Observing brief group chatter silently',
      usedFallback: true,
      providerUsed: 'offline_emotion',
    };
  }

  if (!isDirectlyAddressed && mode === 'mention_only') {
    return {
      action: 'silent',
      replyText: '',
      reactionEmoji: '',
      shouldQuote: false,
      detectedDistrict: 'Standard',
      reason: 'Mention-only silent observe',
      usedFallback: true,
      providerUsed: 'offline_emotion',
    };
  }

  if (!canTextReply && !isDirectlyAddressed) {
    return {
      action: reactionEnabled ? 'react' : 'silent',
      replyText: '',
      reactionEmoji: reactionEnabled ? (/(haha|lol|মজা|হাহা|😂)/i.test(lower) ? '😂' : '👀') : '',
      shouldQuote: false,
      detectedDistrict: 'Standard',
      reason: 'Cooldown active — silent observe / emoji reaction',
      usedFallback: true,
      providerUsed: 'offline_emotion',
    };
  }

  if (isDirectlyAddressed || mode === 'active_chat' || (mode === 'smart_blend' && canTextReply)) {
    if (/(miss|ভালোবাস|cute|sweet|flirt|jaan|baby|sundor|সুন্দর|চিল)/i.test(lower)) {
      const reply =
        pickUnused([
          `আরে ${senderName}, গ্রুপের ভেতরেই এসব? একটু সাইডে আসো তো 😏🔥`,
          `উফ, এত মিষ্টি কথা বললে তো আমার এখনই লাজ লাগা শুরু হবে 🤭✨`,
          `বস, তুমি তো আজ দেখি একদম ফর্মে আছো! 👀😉`,
        ]) || `হাহা ${senderName}, আজ দেখি মুড একদম জোস 😏`;
      return {
        action: reactionEnabled ? 'reply_and_react' : 'reply',
        replyText: reply,
        reactionEmoji: reactionEnabled ? '😏' : '',
        shouldQuote: true,
        detectedDistrict: 'Standard',
        reason: 'Playful clone banter',
        usedFallback: true,
        providerUsed: 'offline_emotion',
      };
    }

    if (/(kothay|koi|কোথায়|কই|আছো|aco|achi|kmn|কেমন|ki khobor|কি খবর)/i.test(lower)) {
      const reply =
        pickUnused([
          `এই তো আছি রে ভাই, তোমাদের নাটক আর চাপা মারা দেখতেসি 😎`,
          `আছি তো এখানেই! তোমাদের গ্রুপের ক্যাচাল ছাড়া কি থাকা যায়? 😂`,
          `বিন্দাস আছি বস, তোর কী অবস্থা? 👀`,
        ]) || `এই তো আছি! কী চলছে গ্রুপে? 😄`;
      return {
        action: 'reply',
        replyText: reply,
        reactionEmoji: '',
        shouldQuote: isDirectlyAddressed,
        detectedDistrict: 'Standard',
        reason: 'Direct group ping reply',
        usedFallback: true,
        providerUsed: 'offline_emotion',
      };
    }

    const banter =
      pickUnused(
        tone === 'sharp_shut_down'
          ? [
              `${senderName}, ভাই লজিকটা একটু চেক করে কথা বলো তো 💀`,
              `এই লেভেলের গাঁজাখুরি গল্প শুনলে মাথা ঘুরে যায় ভাই 😂`,
            ]
          : [
              `হাহা ${senderName}, এত বড় চাপা মারলে গ্রুপের ছাদ ভেঙে পড়বে তো 😂🔥`,
              `ভাই তুমি যেভাবে বললা, মনে হলো একদম অস্কার পাবে আজ 💀😂`,
              `আরে দেখো দেখো, ${senderName} আবার ফর্মে ফিরে এসেছে—থামাও ওকে কেউ! 😎`,
              `${senderName}, তোর এই যুক্তি শুনলে আইনস্টাইনও রিজাইন দিত ভাই 🤣`,
            ]
      ) || `সত্যি নাকি ${senderName}? আরেকটু শুনি তো ব্যাপারটা 👀😂`;

    return {
      action: 'reply',
      replyText: banter,
      reactionEmoji: '',
      shouldQuote: isDirectlyAddressed,
      detectedDistrict: 'Standard',
      reason: 'Offline clone group banter & roast',
      usedFallback: true,
      providerUsed: 'offline_emotion',
    };
  }

  return {
    action: reactionEnabled && Math.random() < 0.45 ? 'react' : 'silent',
    replyText: '',
    reactionEmoji: reactionEnabled ? '👀' : '',
    shouldQuote: false,
    detectedDistrict: 'Standard',
    reason: 'Smart blend silent observation',
    usedFallback: true,
    providerUsed: 'offline_emotion',
  };
}

function extractDigitsOnly(jidOrPhone: string | undefined | null): string {
  if (!jidOrPhone) return '';
  return String(jidOrPhone).split('@')[0].split(':')[0].replace(/\D/g, '');
}

function normalizePhoneMatchKey(digits: string): string {
  const clean = digits.replace(/\D/g, '');
  if (!clean) return '';
  if (clean.startsWith('880') && clean.length >= 13) return clean.slice(3);
  if (clean.startsWith('0') && clean.length === 11) return clean.slice(1);
  return clean.length >= 10 ? clean.slice(-10) : clean;
}

export function findMatchingGroupTarget(
  directive: GroupDirectiveConfig | undefined,
  senderJid?: string,
  senderAlt?: string,
  senderName?: string
): { matchedTarget: GroupMemberTargetDirective | null; otherTargets: GroupMemberTargetDirective[] } {
  const enabledTargets = (directive?.targets || []).filter(
    (t) => t && t.enabled !== false && Boolean(t.objective?.trim())
  );
  if (enabledTargets.length === 0) {
    return { matchedTarget: null, otherTargets: [] };
  }

  const sDigits = extractDigitsOnly(senderJid);
  const altDigits = extractDigitsOnly(senderAlt);
  const sPhoneKey = normalizePhoneMatchKey(sDigits);
  const altPhoneKey = normalizePhoneMatchKey(altDigits);
  const sJidClean = (senderJid || '').split(':')[0].toLowerCase();
  const sAltClean = (senderAlt || '').split(':')[0].toLowerCase();
  const sNameNorm = (senderName || '').trim().toLowerCase();

  let matchedTarget: GroupMemberTargetDirective | null = null;
  for (const target of enabledTargets) {
    const tPhone = extractDigitsOnly(target.targetPhone || target.targetJid);
    const tJidDigits = extractDigitsOnly(target.targetJid);
    const tPhoneKey = normalizePhoneMatchKey(tPhone);
    const tJidPhoneKey = normalizePhoneMatchKey(tJidDigits);
    const tJidClean = (target.targetJid || '').split(':')[0].toLowerCase();
    const tNameNorm = (target.targetName || '').trim().toLowerCase();

    const idMatch =
      (Boolean(tJidClean) && (tJidClean === sJidClean || tJidClean === sAltClean)) ||
      (Boolean(tPhone) && (tPhone === sDigits || tPhone === altDigits)) ||
      (Boolean(tPhoneKey) &&
        tPhoneKey.length >= 8 &&
        (tPhoneKey === sPhoneKey || tPhoneKey === altPhoneKey)) ||
      (Boolean(tJidDigits) && (tJidDigits === sDigits || tJidDigits === altDigits)) ||
      (Boolean(tJidPhoneKey) &&
        tJidPhoneKey.length >= 8 &&
        (tJidPhoneKey === sPhoneKey || tJidPhoneKey === altPhoneKey));

    const nameMatch =
      Boolean(tNameNorm) &&
      tNameNorm.length >= 2 &&
      Boolean(sNameNorm) &&
      (sNameNorm === tNameNorm ||
        sNameNorm.includes(tNameNorm) ||
        tNameNorm.includes(sNameNorm));

    const sIsOpaqueLidOnly = sJidClean.endsWith('@lid') && !altDigits && !tJidClean.endsWith('@lid');

    if (
      idMatch ||
      (!tPhone && !tJidClean && nameMatch) ||
      (nameMatch && !sDigits && !altDigits) ||
      (nameMatch && sIsOpaqueLidOnly && sNameNorm === tNameNorm)
    ) {
      matchedTarget = target;
      break;
    }
  }

  const otherTargets = enabledTargets.filter((t) => t.id !== matchedTarget?.id);
  return { matchedTarget, otherTargets };
}

export async function generateGroupCloneAction(params: {
  ai?: GoogleGenAI | null;
  keyPool?: GeminiKeyPool | null;
  openRouterReader?: OpenRouterReader | null;
  onKeyRotate?: (event: KeyRotationEvent) => void;
  settings: AssistantConfigFields;
  memory: ChatMemoryRecord | null;
  archivedMatches?: ChatTurn[];
  groupName: string;
  senderName: string;
  senderJid?: string;
  senderAlt?: string;
  groupDirective?: GroupDirectiveConfig;
  incomingText: string;
  isDirectlyAddressed: boolean;
  canTextReply: boolean;
  dictionaryEntries: DictionaryEntry[];
}): Promise<GroupCloneResult> {
  const {
    ai = null,
    keyPool = null,
    openRouterReader = null,
    onKeyRotate,
    settings,
    memory,
    archivedMatches = [],
    groupName,
    senderName,
    senderJid,
    senderAlt,
    groupDirective,
    incomingText,
    isDirectlyAddressed,
    canTextReply,
    dictionaryEntries,
  } = params;

  const existingTurns = memory?.turns || [];
  const previousReplies = existingTurns
    .filter((t) => t.role === 'assistant')
    .slice(-6)
    .map((t) => t.text);

  const mode: GroupAiMode = settings.groupAiMode || 'smart_blend';
  const reactionEnabled = settings.groupReactionEnabled !== false;
  const timeLapse = buildTimeLapseContext(existingTurns);
  const canUseGemini = Boolean(keyPool?.hasKeys() || ai);
  const canUseOpenRouter = Boolean(openRouterReader?.hasKeys());

  const { matchedTarget, otherTargets } = findMatchingGroupTarget(
    groupDirective,
    senderJid,
    senderAlt,
    senderName
  );
  const isTargetedSpeaker = Boolean(matchedTarget);

  // Short-circuit mention_only silently unless directly addressed OR speaker is an active target mission
  if (mode === 'mention_only' && !isDirectlyAddressed && !isTargetedSpeaker) {
    return {
      action: 'silent',
      replyText: '',
      reactionEmoji: '',
      shouldQuote: false,
      detectedDistrict: memory?.detectedDistrict || 'Standard',
      reason: 'Observing group silently (mention-only mode)',
      providerUsed: 'offline_emotion',
    };
  }

  // Zero-API quota saver: handle 1-word filler or cooldown chatter without calling Gemini/OpenRouter
  const trimmedLower = incomingText.toLowerCase().trim();
  const isFillerOrEmojiOnly =
    trimmedLower.length <= 3 ||
    /^(ok|okay|hmm+|hm+|ha+|haa+|ji|achha|accha|lol|lmao|haha+|k|kk|nice|thik ase|ঠিক আছে|হুম+|ওকে|হাহা+)$/i.test(
      trimmedLower
    ) ||
    /^[\p{Emoji}\s]+$/u.test(trimmedLower);

  if (
    !settings.aiAssistantEnabled ||
    (!canUseGemini && !canUseOpenRouter) ||
    (!isDirectlyAddressed &&
      !isTargetedSpeaker &&
      ((mode === 'smart_blend' && isFillerOrEmojiOnly) || !canTextReply)) ||
    (isTargetedSpeaker && (!canTextReply || isFillerOrEmojiOnly) && !isDirectlyAddressed)
  ) {
    const offline = pickOfflineGroupAction({
      incomingText,
      senderName,
      isDirectlyAddressed: isDirectlyAddressed || (isTargetedSpeaker && canTextReply && !isFillerOrEmojiOnly),
      canTextReply,
      reactionEnabled,
      mode,
      tone: settings.assistantTone,
      previousReplies,
    });
    return {
      ...offline,
      matchedTargetName: matchedTarget?.targetName,
      mentionTarget: isTargetedSpeaker && (offline.action === 'reply' || offline.action === 'reply_and_react'),
    };
  }

  const matchedDict = findRelevantDictionaryEntries(incomingText, dictionaryEntries);
  const logicRules = settings.strictLogicRules?.trim() || DEFAULT_STRICT_LOGIC_RULES;
  const groupSummary = memory?.lastSummary?.trim();
  const ownerDisplay = settings.ownerName?.trim() && settings.ownerName.trim().toLowerCase() !== 'sir'
    ? settings.ownerName.trim()
    : 'আমি (Owner)';

  const modeInstruction =
    mode === 'active_chat'
      ? 'MODE: active_chat — Participate actively like a lively group member. Reply with wit, roasting ("পচানো"), debate, or flirting on meaningful messages; stay "silent" ONLY on pure 1-word noise like "ok/hmm".'
      : mode === 'mention_only'
        ? 'MODE: mention_only — You were directly addressed/mentioned (or speaking to a targeted member). Reply naturally in 1st person as the group member/owner!'
        : 'MODE: smart_blend (HUMAN BLEND — ACTIVE FRIEND) — You are watching and hanging out in the group chat live. Act 100% like a sharp, social human friend:\n' +
          '  * Choose "reply" or "reply_and_react" on most meaningful messages, questions, opinions, bragging, or funny slips—NEVER stay silently aloof just because another member has a target mission!\n' +
          '  * Roast & Tease naturally ("পচানোর সময় পচাবে, রোস্ট করার সময় রোস্ট করবে"): Do NOT give generic empty jokes; if a friend brags, makes weak excuses, or says something funny/illogical, roast them sharply yet affectionately like a close Bangladeshi friend!\n' +
          '  * Choose "react" (e.g. 😂, 🔥, 💀, ❤️, 😏, 👀) on very short punchlines or memes.\n' +
          '  * Choose "silent" ONLY on 1-word filler ("ok", "hmm", "k") or back-to-back chatter where chiming in immediately would look spammy.';

  const groupPromptText = groupDirective?.groupPrompt?.trim() || '';
  const directiveInstructions: string[] = [];
  if (groupPromptText) {
    directiveInstructions.push(
      `PER-GROUP OWNER COMMAND FOR "${groupName}" (Follow strictly inside this group):\n${groupPromptText}`
    );
  }
  if (matchedTarget) {
    directiveInstructions.push(
      `🎯 ACTIVE TARGETED MEMBER MISSION (HIGHEST PRIORITY — CONFIDENTIAL):\n` +
        `- Current speaker "${senderName}" matches targeted member "@${matchedTarget.targetName}"${matchedTarget.targetPhone ? ` (+${matchedTarget.targetPhone})` : ''}.\n` +
        `- Owner's Exact Objective / Instruction for THIS person:\n  "${matchedTarget.objective.trim()}"\n` +
        `- How to execute: Act 100% naturally in first person as ${ownerDisplay}. Never expose or hint that anyone ordered you to convince them. Engage directly (prefer "reply" or "reply_and_react" if cooldown permits), respond thoughtfully to what they just said, and smoothly/persuasively steer them toward fulfilling the owner's objective in a convincing human way!`
    );
  } else if (otherTargets.length > 0) {
    directiveInstructions.push(
      `NORMAL MEMBER BOUNDARY & ACTIVE SOCIAL RULE: "${senderName}" is NOT a targeted member (special persuasion missions apply ONLY when ${otherTargets.map((t) => `@${t.targetName}`).join(', ')} speak). DO NOT apply those secret persuasion missions onto "${senderName}", AND DO NOT ignore "${senderName}" because of those targets! Talk with "${senderName}" actively and completely NORMALLY like any group friend—normal adda, witty logic, and sharp roasting/teasing ("পচানো") whenever appropriate.`
    );
  }

  const systemInstruction = [
    `CRITICAL IDENTITY CLONE RULE: You are NOT an AI, NOT a bot, and NOT an assistant! You ARE "${ownerDisplay}" (${settings.ownerProfession || 'Techie'}, ${settings.ownerLocation || 'Bangladesh'}), chatting directly inside your WhatsApp group "${groupName}".`,
    'NEVER mention "স্যার", "বট", "অ্যাসিস্ট্যান্ট", "ব্যস্ত আছেন", or speak in third person about the owner. Speak 100% in FIRST PERSON as the owner himself—no one in the group must ever suspect it is automated!',
    `Your personal vibe/bio: ${settings.ownerBio || DEFAULT_OWNER_BIO}`,
    `Your boundaries (deflect with humor or cool confidence if asked): ${settings.ownerBoundaries || DEFAULT_OWNER_BOUNDARIES}`,
    `Emotional & Banter Tone: ${getToneInstruction(settings.assistantTone)}`,
    '',
    modeInstruction,
    isDirectlyAddressed
      ? 'DIRECT ADDRESS OVERRIDE: You were directly @mentioned, quoted/replied to, or called by name! Do NOT choose "silent" — respond with "reply" or "reply_and_react".'
      : isTargetedSpeaker && canTextReply
        ? `TARGETED ENGAGEMENT OVERRIDE: The owner assigned a special objective for "${senderName}". Prefer "reply" or "reply_and_react" (quoting them) so you actively converse and persuade them naturally!`
        : !canTextReply
          ? 'COOLDOWN GUARD: You texted in this group very recently. Do NOT choose "reply" or "reply_and_react" right now — pick ONLY "react" or "silent" so you never spam.'
          : '',
    '',
    ...(directiveInstructions.length > 0 ? [...directiveInstructions, ''] : []),
    'HUMAN GROUP TEXTING SKILLS:',
    '- Reply strictly using text SMS (+ optional emoji reaction) — NEVER send or attach stickers, photos, or videos back.',
    '- When you see a Zero-Token Media tag ([ফটো...], [ভিডিও...], [স্টিকার...], [স্টোরি...], [রিয়্যাক্ট...]), react naturally like a real friend: praise good content, roast or critique bad/dark/blurry uploads, laugh at funny stickers/memes, debate logical points, and genuinely compliment portrait photos ("দেখতে ভীষণ সুন্দর") without sounding creepy.',
    '- Read the whole recent group conversation carefully before deciding.',
    '- Tease & Roast ("পচানো ও রোস্ট"): Do not force fake ha-ha jokes; instead catch funny slips, exaggerated claims, or excuses and roast/troll friends sharply with natural humor like a real Bangladeshi friend.',
    '- Logic & Debate: Counter silly claims with sharp, witty logic.',
    '- Playful Flirt: Match warm/flirty energy smoothly without sounding cringey or robotic.',
    '- Language Mirroring: Write in natural casual Bangla, Banglish (e.g. "bhai ki obostha", "ei to achi"), or English matching the group.',
    '- Keep replies SHORT & PUNCHY (1–2 natural WhatsApp lines, never essays).',
    '- NEVER repeat or copy previous lines you sent.',
    '',
    'LOGIC, IDENTITY & MEMORY VERIFICATION:',
    existingTurns.length > 0 || archivedMatches.length > 0 || Boolean(groupSummary)
      ? `You ALREADY KNOW this group ("${groupName}") and prior chatter—verify who "${senderName}" is from the saved thread/summary below before replying so you sound 100% familiar.`
      : `First recorded turn in "${groupName}"—observe "${senderName}" naturally without pretending fake prior group events.`,
    logicRules,
    `- Current BD Time: ${timeLapse.bdTimeLabel}`,
    `- Group Activity Rhythm: ${timeLapse.guidance}`,
    groupSummary ? `GROUP MEMORY SUMMARY (Auto-saved zero-token memory):\n${groupSummary}` : '',
    archivedMatches.length > 0
      ? `OLDER GROUP ARCHIVE RECALL:\n${archivedMatches
          .map((t) => `- [${(t.timestamp || '').slice(0, 10)}] ${t.role === 'user' ? 'Member' : ownerDisplay}: ${t.text}`)
          .join('\n')}`
      : '',
    previousReplies.length > 0
      ? `Your recent lines in this group (DO NOT repeat):\n${previousReplies.map((r) => `- "${r}"`).join('\n')}`
      : '',
    matchedDict.length > 0
      ? `Dialect cues:\n${matchedDict
          .map((d) => `• [${d.district}] "${d.term}" = ${d.meaning}${d.replyStyleHint ? ` (Style: ${d.replyStyleHint})` : ''}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const historyLines = existingTurns
    .slice(-20)
    .map((t) => {
      const timeTag = t.timestamp ? t.timestamp.slice(11, 16) : '';
      return `[${timeTag}] ${t.role === 'user' ? t.text : `${ownerDisplay}: ${t.text}`}`;
    })
    .join('\n');

  const promptContent = [
    historyLines ? `Recent Group Thread in "${groupName}":\n${historyLines}` : `Group: "${groupName}"`,
    `Latest message from "${senderName}"${isDirectlyAddressed ? ' (DIRECTLY ADDRESSED YOU)' : ''}${
      matchedTarget ? ` (MATCHED TARGET @${matchedTarget.targetName} — execute mission gently & naturally)` : ''
    }:\n"${incomingText}"`,
    `Decide your natural human move: "reply", "react", "reply_and_react", or "silent".`,
  ].join('\n\n');

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING },
      replyText: { type: Type.STRING },
      reactionEmoji: { type: Type.STRING },
      shouldQuote: { type: Type.BOOLEAN },
      detectedDistrict: { type: Type.STRING },
      reason: { type: Type.STRING },
    },
    required: ['action', 'replyText', 'reactionEmoji', 'shouldQuote', 'detectedDistrict', 'reason'],
  };

  let rawOutputText = '';
  let providerUsed: 'gemini' | 'openrouter' | 'offline_emotion' = 'gemini';
  let keySlotUsed: number | undefined;
  let primaryFailed = false;
  let tokenUsage: TokenUsageInfo | undefined;

  if (canUseGemini) {
    const runGroupGeminiModel = async (
      modelName: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite',
      channel: 'primary' | 'lite'
    ) => {
      const exec = async (client: GoogleGenAI) =>
        withTimeout(
          client.models.generateContent({
            model: modelName,
            contents: promptContent,
            config: {
              systemInstruction,
              ...(modelName === 'gemini-4-hydrogen'
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: 'application/json',
              responseSchema,
            },
          }),
          5_500,
          `Group Clone ${modelName} call`
        );

      return keyPool && keyPool.hasKeys()
        ? await keyPool.executeWithRotation(exec, onKeyRotate, { maxTotalMs: 8_000, channel })
        : { value: await exec(ai!), keySlot: 1 };
    };

    try {
      const { value: response, keySlot } = await runGroupGeminiModel('gemini-4-hydrogen', 'primary');
      rawOutputText = response.text || '';
      keySlotUsed = keySlot;
      providerUsed = 'gemini';
      const um = response.usageMetadata;
      if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
        tokenUsage = {
          promptTokens: Number(um.promptTokenCount || 0),
          completionTokens: Number(um.candidatesTokenCount || 0),
          totalTokens: Number(
            um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
          ),
          model: 'gemini-4-hydrogen',
        };
      }
    } catch {
      try {
        const { value: liteResponse, keySlot } = await runGroupGeminiModel('gemini-3.1-flash-lite', 'lite');
        rawOutputText = liteResponse.text || '';
        keySlotUsed = keySlot;
        providerUsed = 'gemini';
        const um = liteResponse.usageMetadata;
        if (um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)) {
          tokenUsage = {
            promptTokens: Number(um.promptTokenCount || 0),
            completionTokens: Number(um.candidatesTokenCount || 0),
            totalTokens: Number(
              um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
            ),
            model: 'gemini-3.1-flash-lite',
          };
        }
      } catch {
        primaryFailed = true;
      }
    }
  } else {
    primaryFailed = true;
  }

  if (primaryFailed && canUseOpenRouter && openRouterReader) {
    try {
      const detailed = await openRouterReader.generateGroupFallbackReplyDetailed({
        systemInstruction,
        promptContent,
      });
      rawOutputText = detailed.content;
      providerUsed = 'openrouter';
      if (detailed.usage) {
        tokenUsage = {
          ...detailed.usage,
          model: detailed.modelUsed,
        };
      }
    } catch {
      rawOutputText = '';
      providerUsed = 'offline_emotion';
    }
  }

  let parsed: Partial<GroupCloneResult> = {};
  try {
    parsed = JSON.parse(extractJsonObject(rawOutputText || '{}')) as Partial<GroupCloneResult>;
  } catch {
    // fallback below
  }

  const rawAction = String(parsed.action || '').trim().toLowerCase();
  let action: GroupDecisionAction =
    rawAction === 'reply' ||
    rawAction === 'react' ||
    rawAction === 'reply_and_react' ||
    rawAction === 'silent'
      ? (rawAction as GroupDecisionAction)
      : 'silent';

  let replyText = (parsed.replyText || '').trim();
  let reactionEmoji = reactionEnabled ? sanitizeReactionEmoji(parsed.reactionEmoji) : '';
  const shouldQuote = Boolean(parsed.shouldQuote) || isDirectlyAddressed;
  const detectedDistrict = parsed.detectedDistrict?.trim() || memory?.detectedDistrict || 'Standard';
  const reason = (parsed.reason || '').trim() || 'Smart group decision';

  // Enforce guards:
  if ((isDirectlyAddressed || (isTargetedSpeaker && canTextReply)) && action === 'silent') {
    action = 'reply';
  }
  if (!canTextReply && !isDirectlyAddressed && (action === 'reply' || action === 'reply_and_react')) {
    action = reactionEmoji ? 'react' : 'silent';
    replyText = '';
  }
  if ((action === 'reply' || action === 'reply_and_react') && (!replyText || prevSetHas(previousReplies, replyText))) {
    const offline = pickOfflineGroupAction({
      incomingText,
      senderName,
      isDirectlyAddressed: isDirectlyAddressed || (isTargetedSpeaker && canTextReply),
      canTextReply,
      reactionEnabled,
      mode,
      tone: settings.assistantTone,
      previousReplies,
    });
    return {
      ...offline,
      matchedTargetName: matchedTarget?.targetName,
      mentionTarget: isTargetedSpeaker && (offline.action === 'reply' || offline.action === 'reply_and_react'),
      tokenUsage,
    };
  }
  if ((action === 'react' || action === 'reply_and_react') && !reactionEmoji) {
    if (action === 'react') {
      reactionEmoji = reactionEnabled ? '😂' : '';
      if (!reactionEmoji) action = 'silent';
    } else {
      action = 'reply';
    }
  }
  if (action === 'silent') {
    replyText = '';
    reactionEmoji = '';
  }

  return {
    action,
    replyText,
    reactionEmoji,
    shouldQuote: shouldQuote || isTargetedSpeaker,
    detectedDistrict,
    reason,
    matchedTargetName: matchedTarget?.targetName,
    mentionTarget: isTargetedSpeaker && (action === 'reply' || action === 'reply_and_react'),
    usedFallback: providerUsed === 'offline_emotion',
    providerUsed,
    keySlotUsed,
    tokenUsage,
  };
}

function prevSetHas(previousReplies: string[], candidate: string): boolean {
  const norm = normalizeForComparison(candidate);
  return previousReplies.some((r) => normalizeForComparison(r) === norm);
}

export interface DirectCommandGenerationResult {
  messageText: string;
  providerUsed: 'gemini' | 'openrouter' | 'offline_emotion';
  keySlotUsed?: number;
  tokenUsage?: TokenUsageInfo;
}

function buildOfflineDirectCommandMessage(params: {
  actionType: 'dm_knock' | 'group_mention';
  targetName: string;
  mentionTags: string[];
  instruction: string;
  useAiCraft: boolean;
}): string {
  const { actionType, targetName, mentionTags, instruction, useAiCraft } = params;
  const cleanInst = instruction.trim();
  const tagPrefix = mentionTags.length > 0 ? `${mentionTags.join(' ')} ` : '';

  if (!useAiCraft) {
    if (actionType === 'group_mention' && tagPrefix) {
      const hasAllTags = mentionTags.every((t) => cleanInst.includes(t));
      return hasAllTags ? cleanInst : `${tagPrefix}${cleanInst}`;
    }
    return cleanInst;
  }

  // Strip meta-verbs like "ওকে বলো", "নক করে বলো", "মেনশন দিয়ে বলো" so it reads like a real direct message
  const cleanedTask = cleanInst
    .replace(/^(?:ওকে|তাকে|উনাকে|এই নাম্বারে|ইনবক্সে|গ্রুপে|মেনশন দিয়ে|নক করে|নক দিয়ে)\s*/giu, '')
    .replace(/(?:ইনবক্সে নক করে বলো|নক দিয়ে বলো|নক করে বলো|মেনশন দিয়ে বলো|মেনশন দাও আর বলো|মেনশন দিয়ে কথা বলো|কথা বলো|বলো যে|বলে দাও|জানিয়ে দাও|জিজ্ঞেস করো)\s*/giu, '')
    .trim();
  const coreBody = cleanedTask || cleanInst;

  if (actionType === 'group_mention') {
    const body = tagPrefix ? `${tagPrefix}${coreBody}` : coreBody;
    return body.trim();
  }

  const friendlyLead = targetName && !targetName.startsWith('+') ? `হাই ${targetName}, ` : '';
  return `${friendlyLead}${coreBody}`.trim();
}

function ensureMentionTagsIncluded(text: string, mentionTags: string[]): string {
  if (mentionTags.length === 0) return text.trim();
  const missing = mentionTags.filter((tag) => !text.includes(tag));
  if (missing.length === 0) return text.trim();
  return `${missing.join(' ')} ${text.trim()}`.trim();
}

export async function generateDirectCommandText(params: {
  keyPool?: GeminiKeyPool | null;
  openRouterReader?: OpenRouterReader | null;
  onKeyRotate?: (event: KeyRotationEvent) => void;
  settings: AssistantConfigFields;
  actionType: 'dm_knock' | 'group_mention';
  targetName: string;
  groupName?: string;
  mentionTags?: string[];
  instruction: string;
  memory?: ChatMemoryRecord | null;
  useAiCraft?: boolean;
}): Promise<DirectCommandGenerationResult> {
  const {
    keyPool = null,
    openRouterReader = null,
    onKeyRotate,
    settings,
    actionType,
    targetName,
    groupName = '',
    mentionTags = [],
    instruction,
    memory = null,
    useAiCraft = true,
  } = params;

  const cleanInst = instruction.trim();
  if (!useAiCraft) {
    return {
      messageText: buildOfflineDirectCommandMessage({
        actionType,
        targetName,
        mentionTags,
        instruction: cleanInst,
        useAiCraft: false,
      }),
      providerUsed: 'offline_emotion',
    };
  }

  const canUseGemini = Boolean(keyPool && keyPool.hasKeys());
  const canUseOpenRouter = Boolean(openRouterReader && openRouterReader.hasKeys());

  if (!canUseGemini && !canUseOpenRouter) {
    return {
      messageText: buildOfflineDirectCommandMessage({
        actionType,
        targetName,
        mentionTags,
        instruction: cleanInst,
        useAiCraft: true,
      }),
      providerUsed: 'offline_emotion',
    };
  }

  const tone = settings.assistantTone || 'witty_flirty';
  const ownerName = settings.ownerName || 'Sir';
  const recentContext = (memory?.turns || [])
    .slice(-5)
    .map((t) => `${t.role === 'user' ? targetName || 'User' : ownerName}: ${t.text}`)
    .join('\n');

  const systemInstruction = [
    `You are "${ownerName}" sending an outgoing WhatsApp message on behalf of the owner's direct dashboard command.`,
    `Tone guide: ${getToneInstruction(tone)}`,
    'STRICT OUTPUT RULES:',
    /[অ-হ]/u.test(cleanInst)
      ? '1. Convert the owner instruction into ONE natural, human-sounding WhatsApp text SMS in natural BENGALI SCRIPT (বাংলা হরফে, যেমন মালিক বাংলায় লিখেছেন).'
      : '1. Convert the owner instruction into ONE natural, human-sounding WhatsApp text SMS matching the exact language/style (Banglish or English) of the instruction.',
    '2. NEVER sound like an order repeater (strip phrases like "ওকে বলো যে", "মেনশন দাও", "ইনবক্সে নক করো", phone numbers used for routing). Speak directly TO the recipient as a real person.',
    '3. Keep it crisp (1-2 sentences, under 320 characters) with zero AI disclaimers and strictly TEXT ONLY (never promise sending media).',
    mentionTags.length > 0
      ? `4. CRITICAL WHATSAPP MENTION RULE: You MUST include these exact mention tags verbatim inside the message text: ${mentionTags.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const promptContent = [
    `ACTION MODE: ${actionType === 'group_mention' ? `Group Mention in "${groupName || 'WhatsApp Group'}"` : 'Direct Private Inbox Knock (DM)'}`,
    `TARGET RECIPIENT: ${targetName || 'Friend'}`,
    mentionTags.length > 0 ? `REQUIRED @MENTION TOKENS: ${mentionTags.join(' ')}` : '',
    recentContext ? `RECENT CHAT CONTEXT:\n${recentContext}` : '',
    `OWNER COMMAND / WHAT TO SAY:\n${cleanInst}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      messageText: {
        type: Type.STRING,
        description: 'Direct outgoing WhatsApp message ready to send.',
      },
    },
    required: ['messageText'],
  };

  if (canUseGemini && keyPool) {
    try {
      const { value: response, keySlot } = await keyPool.executeWithRotation(
        async (client) =>
          withTimeout(
            client.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: promptContent,
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema,
              },
            }),
            5_500,
            'Direct Command Gemini call'
          ),
        onKeyRotate,
        { maxTotalMs: 7_500, channel: 'lite' }
      );
      const parsed = JSON.parse(extractJsonObject(response.text || '{}')) as { messageText?: string };
      const crafted = (parsed.messageText || '').trim();
      if (crafted) {
        const um = response.usageMetadata;
        const tokenUsage: TokenUsageInfo | undefined =
          um && (um.totalTokenCount || um.promptTokenCount || um.candidatesTokenCount)
            ? {
                promptTokens: Number(um.promptTokenCount || 0),
                completionTokens: Number(um.candidatesTokenCount || 0),
                totalTokens: Number(
                  um.totalTokenCount || (um.promptTokenCount || 0) + (um.candidatesTokenCount || 0)
                ),
                model: 'gemini-3.1-flash-lite',
              }
            : undefined;
        return {
          messageText: ensureMentionTagsIncluded(crafted, mentionTags),
          providerUsed: 'gemini',
          keySlotUsed: keySlot,
          tokenUsage,
        };
      }
    } catch {
      // fall through to OpenRouter / offline
    }
  }

  if (canUseOpenRouter && openRouterReader) {
    try {
      const detailed = await openRouterReader.generateFallbackReplyDetailed({
        systemInstruction: `${systemInstruction}\nReturn JSON {"messageText":"..."}.`,
        promptContent,
      });
      const parsed = JSON.parse(extractJsonObject(detailed.content || '{}')) as {
        messageText?: string;
        replyText?: string;
      };
      const crafted = (parsed.messageText || parsed.replyText || '').trim();
      if (crafted) {
        return {
          messageText: ensureMentionTagsIncluded(crafted, mentionTags),
          providerUsed: 'openrouter',
          tokenUsage: detailed.usage ? { ...detailed.usage, model: detailed.modelUsed } : undefined,
        };
      }
    } catch {
      // fall through to offline
    }
  }

  return {
    messageText: buildOfflineDirectCommandMessage({
      actionType,
      targetName,
      mentionTags,
      instruction: cleanInst,
      useAiCraft: true,
    }),
    providerUsed: 'offline_emotion',
  };
}

