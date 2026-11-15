import { Type, type GoogleGenAI } from '@google/genai';

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

  // 1. JSON array or object format
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

  // 2. CSV or Pipe/Tab-delimited TXT lines
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results: Array<Omit<DictionaryEntry, 'id'>> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('#') || line.startsWith('//')) continue;

    // Detect delimiter: pipe '|', tab '\t', or comma ','
    let parts: string[];
    if (line.includes('|')) {
      parts = line.split('|').map((s) => s.trim());
    } else if (line.includes('\t')) {
      parts = line.split('\t').map((s) => s.trim());
    } else {
      parts = line.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    }

    // Skip CSV header row
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
      if (matched.length >= 8) break;
    }
  }
  return matched;
}

function getToneInstruction(tone: AssistantTone): string {
  switch (tone) {
    case 'witty_flirty':
      return 'Friendly, charming, playfully witty, and lightly flirtatious/bantering when appropriate (while staying classy, respectful, and never offensive). Match the user’s playful energy—if they tease or joke (like saying Good Night when you said Good Morning), banter back smoothly while reminding them Sir is away and you are holding the fort.';
    case 'warm_polite':
      return 'Warm, welcoming, humble, and helpful in natural Bengali/Banglish/English matching the sender.';
    case 'executive_formal':
      return 'Crisp, respectful, executive assistant demeanor—concise, polite, and business-focused.';
    case 'sharp_shut_down':
      return 'Confident, sharp-tongued, and firm—politely but decisively shut down time-wasters, boundary-crossers, or pushy requests without tolerating nonsense.';
  }
}

export interface AssistantGenerationResult {
  replyText: string;
  detectedDistrict: string;
  noteSummary: string;
  noteUrgency: 'normal' | 'important';
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

export async function generateExecutiveAssistantReply(params: {
  ai: GoogleGenAI | null;
  settings: AssistantConfigFields;
  memory: ChatMemoryRecord | null;
  incomingText: string;
  contactName: string;
  dictionaryEntries: DictionaryEntry[];
}): Promise<AssistantGenerationResult> {
  const { ai, settings, memory, incomingText, contactName, dictionaryEntries } = params;

  const existingTurns = memory?.turns || [];
  const recentAssistantReplies = existingTurns
    .filter((t) => t.role === 'assistant')
    .slice(-6)
    .map((t) => t.text);

  if (!ai) {
    return {
      replyText: pickNonRepeatingFallback(settings.autoreplyMessage, recentAssistantReplies),
      detectedDistrict: memory?.detectedDistrict || 'Standard',
      noteSummary: '',
      noteUrgency: 'normal',
    };
  }

  const lastTurnTime = existingTurns.length > 0 ? Date.parse(existingTurns[existingTurns.length - 1].timestamp) : 0;
  const isNewSession = existingTurns.length === 0 || (lastTurnTime > 0 && Date.now() - lastTurnTime > 6 * 3600 * 1000);

  const matchedDict = findRelevantDictionaryEntries(incomingText, dictionaryEntries);
  const sampleDistricts = dictionaryEntries.slice(0, 6);
  const dictionaryContext = [...matchedDict, ...sampleDistricts.filter((d) => !matchedDict.some((m) => m.id === d.id))];

  const systemInstruction = [
    `You are the smart, 24/7 WhatsApp Personal Assistant acting on behalf of "${settings.ownerName || 'Sir'}".`,
    `Sir's Profession: ${settings.ownerProfession || 'Not specified'}.`,
    `Sir's Location: ${settings.ownerLocation || 'Bangladesh'}.`,
    `Positive Bio about Sir (use this whenever someone asks about Sir): ${settings.ownerBio || DEFAULT_OWNER_BIO}`,
    `Strict Boundaries (Things Sir DOES NOT do — refuse politely & firmly if asked): ${settings.ownerBoundaries || DEFAULT_OWNER_BOUNDARIES}`,
    `Personality & Tone: ${getToneInstruction(settings.assistantTone)}`,
    '',
    isNewSession
      ? `FIRST MESSAGE RULE: This is the start of a new conversation while Sir is away/busy. Naturally mention that Sir is currently unavailable/offline and you are his personal assistant replying on his behalf (reference style: "${settings.firstGreetingTemplate || DEFAULT_FIRST_GREETING}"), then respond directly to what the sender said and let them know they can leave a message for Sir or talk to you.`
      : `ONGOING CONVERSATION RULE: You have already introduced yourself in this conversation. Do NOT repeat the "Sir is busy/offline" boilerplate unless asked where Sir is. Continue naturally from the chat history.`,
    '',
    'ANTI-REPETITION RULE (CRITICAL):',
    '- NEVER repeat the exact same SMS or sentence you already sent earlier to this contact.',
    '- Even if the contact says the same greeting or asks repeatedly, always vary your wording naturally so every reply feels fresh and human.',
    recentAssistantReplies.length > 0
      ? `Previous replies you ALREADY sent to this contact (NEVER repeat any of these word-for-word):\n${recentAssistantReplies
          .map((r, i) => `${i + 1}. "${r}"`)
          .join('\n')}`
      : '',
    '',
    'LANGUAGE & 64-DISTRICT DIALECT RULE:',
    '- Reply in the exact language/script/flavor the sender used (Bengali script, Banglish/Roman Bengali, or English).',
    '- If the sender uses regional dialect words from any of the 64 districts of Bangladesh, recognize the dialect and mirror its friendly local charm naturally without exaggerating.',
    dictionaryContext.length > 0
      ? `Uploaded Regional & Bangla-English Dictionary Reference:\n${dictionaryContext
          .map(
            (d) =>
              `• [${d.district}] "${d.term}" => ${d.meaning}${d.replyStyleHint ? ` (Reply flavor: ${d.replyStyleHint})` : ''}`
          )
          .join('\n')}`
      : '',
    '',
    'NOTE-TAKING RULE:',
    '- If the sender asks Sir to call back, leaves a concrete message, proposes work/meeting, or shares something important Sir should know, write a concise 1-sentence summary in `noteSummary`. For casual greetings or small talk, leave `noteSummary` as an empty string "".',
    '- Keep `replyText` concise (1–4 sentences max), natural for WhatsApp, and never invent false facts about Sir.',
  ]
    .filter(Boolean)
    .join('\n');

  const historyLines = existingTurns
    .slice(-10)
    .map((t) => `${t.role === 'user' ? contactName || 'Contact' : 'Assistant'}: ${t.text}`)
    .join('\n');

  const promptContent = historyLines
    ? `Recent Conversation History:\n${historyLines}\n\nLatest incoming message from ${contactName || 'Contact'}:\n"${incomingText}"`
    : `Incoming message from ${contactName || 'Contact'}:\n"${incomingText}"`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      replyText: {
        type: Type.STRING,
        description: 'Natural WhatsApp reply to send back to the contact.',
      },
      detectedDistrict: {
        type: Type.STRING,
        description: 'Detected Bangladesh district dialect or Standard/English.',
      },
      noteSummary: {
        type: Type.STRING,
        description: 'Concise 1-sentence note for Sir if the contact left a real message/request, else empty string.',
      },
      noteUrgency: {
        type: Type.STRING,
        description: 'Either "normal" or "important".',
      },
    },
    required: ['replyText', 'detectedDistrict', 'noteSummary', 'noteUrgency'],
  };

  const response = await withTimeout(
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: promptContent,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema,
      },
    }),
    25_000,
    'Executive Assistant Gemini call'
  );

  const rawJson = (response.text || '{}').trim();
  let parsed = JSON.parse(rawJson) as Partial<AssistantGenerationResult>;
  let replyText = parsed.replyText?.trim() || '';

  const prevSet = new Set(recentAssistantReplies.map(normalizeForComparison));
  if (!replyText || prevSet.has(normalizeForComparison(replyText))) {
    // Re-prompt once if Gemini generated an exact duplicate
    const retryResponse = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `${promptContent}\n\nIMPORTANT: Your previous draft "${replyText}" was already sent earlier to this contact. Write a completely DIFFERENT, fresh, natural reply without reusing the same wording.`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
        },
      }),
      15_000,
      'Executive Assistant retry call'
    );
    try {
      const retryParsed = JSON.parse((retryResponse.text || '{}').trim()) as Partial<AssistantGenerationResult>;
      if (retryParsed.replyText?.trim() && !prevSet.has(normalizeForComparison(retryParsed.replyText))) {
        parsed = retryParsed;
        replyText = retryParsed.replyText.trim();
      }
    } catch {
      // fall through to safe fallback below
    }
  }

  if (!replyText || prevSet.has(normalizeForComparison(replyText))) {
    replyText = pickNonRepeatingFallback(settings.autoreplyMessage, recentAssistantReplies);
  }

  return {
    replyText,
    detectedDistrict: parsed.detectedDistrict?.trim() || memory?.detectedDistrict || 'Standard',
    noteSummary: parsed.noteSummary?.trim() || '',
    noteUrgency: parsed.noteUrgency === 'important' ? 'important' : 'normal',
  };
}
