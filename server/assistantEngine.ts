import { ThinkingLevel, Type, type GoogleGenAI } from '@google/genai';
import type { GeminiKeyPool, KeyRotationEvent } from './geminiKeyPool.ts';

export type AssistantTone =
  | 'witty_flirty'
  | 'warm_polite'
  | 'executive_formal'
  | 'sharp_shut_down';

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

export interface AssistantConfigFields {
  aiAssistantEnabled: boolean;
  autoreplyMessage: string;
  firstGreetingTemplate: string;
  ownerName: string;
  ownerProfession: string;
  ownerLocation: string;
  ownerBio: string;
  ownerBoundaries: string;
  assistantTone: AssistantTone;
  humanTypingEnabled?: boolean;
  dailyReplyLimit?: number;
}

export const DEFAULT_FIRST_GREETING =
  'স্যার এই মুহূর্তে অফলাইনে বা ব্যস্ত আছেন—আমি ওনার পার্সোনাল অ্যাসিস্ট্যান্ট বলছি। স্যারের জন্য কোনো জরুরি বার্তা থাকলে আমাকে বলতে পারেন, অথবা চাইলে আমার সাথেও যেকোনো বিষয়ে কথা বলতে পারেন!';

export const DEFAULT_OWNER_BIO =
  'স্যার একজন প্রযুক্তিপ্রেমী, দায়িত্বশীল এবং পেশাদার মানুষ। তিনি নিজের কাজ ও প্রজেক্ট নিয়ে বেশিরভাগ সময় ব্যস্ত থাকেন, তবে পরিচিতজন ও ক্লায়েন্টদের যথেষ্ট গুরুত্ব দেন।';

export const DEFAULT_OWNER_BOUNDARIES =
  'স্যার বাসা/ফ্ল্যাট/রুম ভাড়া বা মেস খোঁজার কাজ করেন না। টাকা ধার দেওয়া, অজানা বিনিয়োগ বা অপ্রাসঙ্গিক ব্যক্তিগত অনুরোধ স্যার গ্রহণ করেন না—কেউ এসব চাইলে ভদ্রভাবে না করে দেবেন।';

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

export function parseUploadedDictionary(
  rawText: string,
  fileName: string
): Array<Omit<DictionaryEntry, 'id'>> {
  const lowerName = fileName.toLowerCase();
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  if (lowerName.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [parsed];
    const results: Array<Omit<DictionaryEntry, 'id'>> = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const term = String(item.term || item.word || item.bangla || item.phrase || '').trim();
      const meaning = String(item.meaning || item.english || item.translation || item.definition || '').trim();
      if (!term || !meaning) continue;
      const district = String(item.district || item.region || item.zilla || 'General').trim();
      const rawLang = String(item.language || 'bn_dialect');
      const language: DictionaryEntry['language'] =
        rawLang === 'bn_en' || rawLang === 'en_slang' ? rawLang : 'bn_dialect';
      const replyStyleHint = String(item.replyStyleHint || item.hint || item.example || '').trim();

      results.push({
        term: term.slice(0, 200),
        meaning: meaning.slice(0, 500),
        district: district.slice(0, 100),
        language,
        replyStyleHint: replyStyleHint.slice(0, 300),
      });
    }
    return results;
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results: Array<Omit<DictionaryEntry, 'id'>> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#') || line.startsWith('//')) continue;

    let parts: string[];
    if (line.includes('|')) {
      parts = line.split('|').map((s) => s.trim());
    } else if (line.includes('\t')) {
      parts = line.split('\t').map((s) => s.trim());
    } else {
      parts = line.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    }

    if (
      i === 0 &&
      parts[0]?.toLowerCase().includes('term') &&
      parts[1]?.toLowerCase().includes('meaning')
    ) {
      continue;
    }

    if (parts.length < 2) continue;
    const term = parts[0];
    const meaning = parts[1];
    if (!term || !meaning) continue;

    const district = parts[2] || 'General';
    const hint = parts[3] || '';

    results.push({
      term: term.slice(0, 200),
      meaning: meaning.slice(0, 500),
      district: district.slice(0, 100),
      language: 'bn_dialect',
      replyStyleHint: hint.slice(0, 300),
    });
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
      if (matched.length >= 5) break;
    }
  }
  return matched;
}

function getToneInstruction(tone: AssistantTone): string {
  switch (tone) {
    case 'witty_flirty':
      return 'Friendly, charming, playfully witty, lightly flirtatious/bantering when appropriate (always classy and respectful).';
    case 'warm_polite':
      return 'Warm, welcoming, humble, and helpful in natural Bengali/Banglish/English.';
    case 'executive_formal':
      return 'Crisp, respectful, executive assistant demeanor—concise and business-focused.';
    case 'sharp_shut_down':
      return 'Confident, sharp-tongued, and firm—politely shut down time-wasters or boundary-crossers.';
  }
}

export interface AssistantGenerationResult {
  replyText: string;
  detectedDistrict: string;
  noteSummary: string;
  noteUrgency: 'normal' | 'important';
  usedFallback?: boolean;
  keySlotUsed?: number;
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

function pickNonRepeatingFallback(baseMessage: string, previousAssistantReplies: string[]): string {
  const prevSet = new Set(previousAssistantReplies.map(normalizeForComparison));
  if (!prevSet.has(normalizeForComparison(baseMessage))) {
    return baseMessage;
  }
  const variations = [
    'আপনার মেসেজটি পেয়েছি এবং স্যারের জন্য নোট করে রেখেছি। স্যার ফ্রি হলেই আপনার সাথে যোগাযোগ করবেন।',
    'স্যার এখনো কাজে ব্যস্ত আছেন। আপনার কোনো জরুরি কথা থাকলে লিখে রাখতে পারেন, আমি স্যারকে পৌঁছে দেব।',
    'ধন্যবাদ নক করার জন্য! স্যার অনলাইনে ফিরলেই আপনার সব মেসেজ দেখে রিপ্লাই দেবেন।',
    'আমি ওনার অ্যাসিস্ট্যান্ট বলছি—আপনার বার্তা আমার কাছে সংরক্ষিত আছে, স্যার একটু সময় পেলেই উত্তর দেবেন।',
  ];
  for (const variant of variations) {
    if (!prevSet.has(normalizeForComparison(variant))) {
      return variant;
    }
  }
  return `আপনার নতুন বার্তাটি (${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}) স্যারের ইনবক্সে নোট করা হয়েছে।`;
}

function extractJsonObject(raw: string): string {
  const cleaned = raw.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : cleaned;
}

export async function generateExecutiveAssistantReply(params: {
  ai?: GoogleGenAI | null;
  keyPool?: GeminiKeyPool | null;
  onKeyRotate?: (event: KeyRotationEvent) => void;
  settings: AssistantConfigFields;
  memory: ChatMemoryRecord | null;
  incomingText: string;
  contactName: string;
  dictionaryEntries: DictionaryEntry[];
}): Promise<AssistantGenerationResult> {
  const { ai = null, keyPool = null, onKeyRotate, settings, memory, incomingText, contactName, dictionaryEntries } =
    params;

  const existingTurns = memory?.turns || [];
  const recentAssistantReplies = existingTurns
    .filter((t) => t.role === 'assistant')
    .slice(-4)
    .map((t) => t.text);

  const canUseAi = Boolean(keyPool?.hasKeys() || ai);
  if (!canUseAi) {
    return {
      replyText: pickNonRepeatingFallback(settings.autoreplyMessage, recentAssistantReplies),
      detectedDistrict: memory?.detectedDistrict || 'Standard',
      noteSummary: '',
      noteUrgency: 'normal',
      usedFallback: true,
    };
  }

  const lastTurnTime = existingTurns.length > 0 ? Date.parse(existingTurns[existingTurns.length - 1].timestamp) : 0;
  const isNewSession = existingTurns.length === 0 || (lastTurnTime > 0 && Date.now() - lastTurnTime > 6 * 3600 * 1000);

  const matchedDict = findRelevantDictionaryEntries(incomingText, dictionaryEntries);

  const systemInstruction = [
    `You are the fast, natural 24/7 WhatsApp Personal Assistant for "${settings.ownerName || 'Sir'}" (${settings.ownerProfession || 'Professional'}, ${settings.ownerLocation || 'Bangladesh'}).`,
    `Bio: ${settings.ownerBio || DEFAULT_OWNER_BIO}`,
    `Boundaries (refuse politely if asked): ${settings.ownerBoundaries || DEFAULT_OWNER_BOUNDARIES}`,
    `Tone: ${getToneInstruction(settings.assistantTone)}`,
    isNewSession
      ? `First reply: mention briefly in a fresh human way (do NOT copy word-for-word: "${settings.firstGreetingTemplate || DEFAULT_FIRST_GREETING}") that Sir is busy/away and you are taking messages, while directly answering their message.`
      : 'Ongoing chat: respond directly to the latest message without repeating boilerplate.',
    'Rules: Match sender language/script (Bengali/Banglish/English) & dialect naturally. Reply in 1–2 crisp WhatsApp sentences. Never reuse earlier replies verbatim.',
    recentAssistantReplies.length > 0
      ? `Avoid repeating:\n${recentAssistantReplies.map((r) => `- "${r}"`).join('\n')}`
      : '',
    matchedDict.length > 0
      ? `Dialect cues:\n${matchedDict
          .map((d) => `• [${d.district}] "${d.term}"=${d.meaning}${d.replyStyleHint ? ` (${d.replyStyleHint})` : ''}`)
          .join('\n')}`
      : '',
    'Set `noteSummary` to a 1-sentence note only for callbacks/work/important info (else "").',
  ]
    .filter(Boolean)
    .join('\n');

  const historyLines = existingTurns
    .slice(-6)
    .map((t) => `${t.role === 'user' ? contactName || 'User' : 'AI'}: ${t.text}`)
    .join('\n');

  const promptContent = historyLines
    ? `History:\n${historyLines}\n${contactName || 'User'}: "${incomingText}"`
    : `${contactName || 'User'}: "${incomingText}"`;

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

  // Ultra-low-latency call using gemini-3.1-flash-lite + ThinkingLevel.MINIMAL (zero thinking delay)
  const exec = async (client: GoogleGenAI) =>
    withTimeout(
      client.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: promptContent,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
      4_000,
      'Instant Assistant Gemini call'
    );

  const { value: response, keySlot } =
    keyPool && keyPool.hasKeys()
      ? await keyPool.executeWithRotation(exec, onKeyRotate, { maxTotalMs: 8_000 })
      : { value: await exec(ai!), keySlot: 1 };

  const rawJson = extractJsonObject(response.text || '{}');
  const parsed = JSON.parse(rawJson) as Partial<AssistantGenerationResult>;
  let replyText = parsed.replyText?.trim() || '';

  const prevSet = new Set(recentAssistantReplies.map(normalizeForComparison));
  let usedFallback = false;
  if (!replyText || prevSet.has(normalizeForComparison(replyText))) {
    replyText = pickNonRepeatingFallback(settings.autoreplyMessage, recentAssistantReplies);
    usedFallback = true;
  }

  return {
    replyText,
    detectedDistrict: parsed.detectedDistrict?.trim() || memory?.detectedDistrict || 'Standard',
    noteSummary: parsed.noteSummary?.trim() || '',
    noteUrgency: parsed.noteUrgency === 'important' ? 'important' : 'normal',
    usedFallback,
    keySlotUsed: keySlot,
  };
}
