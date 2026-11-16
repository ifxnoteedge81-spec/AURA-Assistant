import type { ChatTurn } from './assistantEngine.ts';

export interface LocalSummaryParams {
  contactName: string;
  contactJid: string;
  isGroup: boolean;
  existingSummary?: string;
  turns: ChatTurn[];
  archiveCount?: number;
  ownerName?: string;
}

const NOISE_ONLY_REGEX =
  /^(ok|okay|k|kk|hmm+|hm+|ha+|haa+|ji|achha|accha|lol|lmao|haha+|nice|thik ase|ঠিক আছে|হুম+|ওকে|হাহা+|[\p{Emoji}\s.,!?-]+)$/iu;

function detectMoodTags(texts: string[]): string[] {
  const joined = texts.join(' ').toLowerCase();
  const tags: string[] = [];

  if (/(miss|love|jaan|baby|cute|sweet|flirt|ভালোবাস|মিস|জান|সুন্দর|😉|🤭|❤️|😏)/i.test(joined)) {
    tags.push('Playful/Warm');
  }
  if (/(রাগ|অভিমান|বিরক্ত|angry|sad|মন খারাপ|কষ্ট|ভালো নাই|ভালো নেই|😭|😢)/i.test(joined)) {
    tags.push('Sensitive/Emotional');
  }
  if (/(টাকা|bkash|nagad|payment|urgent|জরুরি|কল|call|meeting|মিটিং|project|কাজ|অফিস|deadline)/i.test(joined)) {
    tags.push('Work/Urgent');
  }
  if (/(haha|lol|lmao|মজা|পাচা|পচাই|রোস্ট|হাহা|😂|🤣|💀|🔥)/i.test(joined)) {
    tags.push('Fun/Banter');
  }
  if (/(কেনে|কিতা|বাহে|হামি|মোরা|এক্কেরে|ভালা আছইন|ক্যামনে)/i.test(joined)) {
    tags.push('Regional Dialect');
  }

  return tags.length > 0 ? tags.slice(0, 3) : ['Casual/Natural'];
}

function cleanTurnSnippet(text: string, maxLen = 110): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

/**
 * Zero-Token Deterministic Memory Summarizer:
 * Builds a structured relationship, topic, and continuity brief purely in TypeScript
 * using 0 AI API calls / 0 tokens, and persists automatically with every conversation.
 */
export function buildZeroTokenMemorySummary(params: LocalSummaryParams): string {
  const { contactName, isGroup, existingSummary = '', turns, archiveCount, ownerName = 'Sir' } = params;
  if (!turns || turns.length === 0) {
    return existingSummary.trim();
  }

  const label = contactName?.trim() || (isGroup ? 'WhatsApp Group' : 'Contact');
  const totalKnown = Math.max(turns.length, archiveCount || 0);

  const meaningfulUserLines: string[] = [];
  const meaningfulOwnerOrAiLines: string[] = [];
  const seenSnippets = new Set<string>();

  for (let i = Math.max(0, turns.length - 16); i < turns.length; i += 1) {
    const t = turns[i];
    if (!t?.text) continue;
    const raw = t.text.trim();
    if (!raw || NOISE_ONLY_REGEX.test(raw)) continue;

    const snippet = cleanTurnSnippet(raw, 95);
    const key = snippet.toLowerCase();
    if (seenSnippets.has(key)) continue;
    seenSnippets.add(key);

    if (t.role === 'user') {
      meaningfulUserLines.push(snippet);
    } else if (raw.startsWith('[Sir (নিজে)]:')) {
      meaningfulOwnerOrAiLines.push(cleanTurnSnippet(raw.replace('[Sir (নিজে)]:', `${ownerName}:`), 95));
    } else {
      meaningfulOwnerOrAiLines.push(snippet);
    }
  }

  const moodTags = detectMoodTags(turns.slice(-10).map((t) => t.text));
  const lastTurn = turns[turns.length - 1];
  const lastTime = lastTurn?.timestamp ? lastTurn.timestamp.slice(0, 16).replace('T', ' ') : '';

  const recentUserHighlight = meaningfulUserLines.slice(-3).join(' | ');
  const recentOwnerHighlight = meaningfulOwnerOrAiLines.slice(-2).join(' | ');
  const lastRaw = cleanTurnSnippet(lastTurn?.text || '', 115);

  const parts: string[] = [
    `${isGroup ? 'Group' : 'Contact'}: ${label} (${totalKnown} msgs saved, Vibe: ${moodTags.join('/')})`,
  ];

  if (recentUserHighlight) {
    parts.push(`Key Topics/Said: ${recentUserHighlight}`);
  }
  if (recentOwnerHighlight) {
    parts.push(`Owner/Prior Stance: ${recentOwnerHighlight}`);
  }
  if (lastRaw) {
    parts.push(`Latest [${lastTime}]: ${lastRaw}`);
  }

  return parts.join(' • ').slice(0, 880);
}
