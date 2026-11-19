import type {
  AssistantConfigFields,
  AssistantTone,
  ChatMemoryRecord,
  ContactPolicyEntry,
  ContactPolicyMode,
  InboxNoteRecord,
} from './assistantEngine.ts';
import type { MediaInsight } from './mediaReader.ts';
import type { PublicEmailSenderProfile, WebOutreachController } from './webResearchOutreach.ts';

export interface SelfChatTurnItem {
  id: string;
  role: 'owner' | 'assistant';
  text: string;
  mediaKind?: string;
  actionSummary?: string;
  timestamp: string;
}

export interface SelfChatPendingDraft {
  kind: 'dm_knock' | 'group_mention' | 'ready_draft' | 'dm_excluding';
  targets: Array<{ jid: string; phone: string; name: string }>;
  excludePhones?: string[];
  groupJid?: string;
  groupName?: string;
  draftChannel?: 'email' | 'whatsapp';
  draftSubject?: string;
  draftBody?: string;
  expiresAt: number;
}

export interface SelfChatDirectoryContact {
  jid: string;
  phone: string;
  name: string;
}

export interface SelfChatKnownGroup {
  jid: string;
  name: string;
  members?: Array<{ jid: string; phone: string; name: string }>;
}

export interface SelfChatRecentLog {
  timestamp: string;
  category: string;
  actor: string;
  summary: string;
  outcome: string;
}

export interface SelfChatCopilotContext {
  incomingText: string;
  mediaInsight?: MediaInsight | null;
  botConfig: AssistantConfigFields;
  botStatus: string;
  connectedPhone: string;
  dailyStats: { count: number; limit: number };
  memoryRssMb: number;
  directoryContacts: SelfChatDirectoryContact[];
  knownGroups: SelfChatKnownGroup[];
  recentLogs: SelfChatRecentLog[];
  recentMemories: ChatMemoryRecord[];
  unreadNotes: InboxNoteRecord[];
  activeTakeovers: Array<{ jid: string; phone: string; remainingMs: number }>;
  selfChatHistory: SelfChatTurnItem[];
  pendingDraft: SelfChatPendingDraft | null;
  outreach: WebOutreachController;
  // Action callbacks wired by server.ts
  dispatchDirectDm: (params: {
    targets: Array<{ jid: string; phone: string; name: string }>;
    messageText: string;
    originalInstruction: string;
  }) => Promise<{ deliveredCount: number; draftCount: number; targetLabels: string[] }>;
  dispatchGroupMention: (params: {
    groupJid: string;
    groupName: string;
    members: Array<{ jid: string; phone: string; name: string }>;
    messageText: string;
    originalInstruction: string;
  }) => Promise<{ deliveredLive: boolean; groupName: string; mentionedCount: number }>;
  kickGroupMember: (params: {
    groupJid: string;
    groupName: string;
    targetPhoneOrName: string;
  }) => Promise<{ ok: boolean; kickedLabel?: string; reason: string }>;
  upsertContactPolicies: (
    entries: Array<{ jid: string; phone: string; name: string; mode: ContactPolicyMode; note?: string }>
  ) => Promise<ContactPolicyEntry[]>;
  updateSystemSettings: (patch: Partial<AssistantConfigFields>) => Promise<void>;
  clearTakeovers: (targetJid?: string) => number;
  runSelfHealNow?: () => Promise<{ rssBeforeMb: number; rssAfterMb: number; actionsTaken: string[]; botStatus: string }>;
  getSystemDiagnostics?: () => {
    selfPing: { enabled: boolean; targetUrl: string; lastPingAt: string | null; lastPingOk: boolean | null };
    watchdog: { enabled: boolean; cycleCount: number; totalHealsApplied: number; processErrorsIntercepted: number } | null;
    mobileWorkers: Array<{ deviceLabel: string; deviceMemoryGb: number | null; networkType: string; jobsCompleted: number }>;
    firestore: { configuredProjectId: string; serviceAccountProjectId: string | null; projectMatch: boolean | null; mode: string };
    schedulesCount: number;
  };
  runAutonomousMission?: (goal: string) => Promise<{
    finalReport: string;
    tokensUsed: number;
    providerUsed: string;
    stepsCount: number;
  }>;
}

export interface SelfChatCopilotResult {
  replyText: string;
  actionSummary: string;
  tokensUsed: number;
  nextPendingDraft: SelfChatPendingDraft | null;
}

export function redactSecretsInText(input: string): string {
  let masked = input;
  // Redact explicit password / app-password fields in natural Bengali/English commands
  masked = masked.replace(
    /(পাসওয়ার্ড|পাসওয়ার্ড|অ্যাপ\s*পাসওয়ার্ড|app\s*password|password|pass|secret|key)\s*[:=\-]?\s*(?:["'“]?([a-zA-Z0-9!@#$%^&*_.\-]{4,}(?:\s+[a-zA-Z0-9]{4}){0,3})["'”]?)/giu,
    (_m, label: string) => `${label}: [REDACTED]`
  );
  // Also redact standalone 16-letter grouped Google App Passwords like "abcd efgh ijkl mnop"
  masked = masked.replace(/\b[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\b/g, '[REDACTED_APP_PASSWORD]');
  return masked;
}

function normalizePhoneForWa(raw: string | undefined | null): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('01') && digits.length === 11) {
    return `88${digits}`;
  }
  if (digits.startsWith('1') && digits.length === 10) {
    return `880${digits}`;
  }
  return digits;
}

function isGenericLabel(name: string | undefined | null): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  return !trimmed || /^\+?\d{5,}$/.test(trimmed) || /^Member(?:\s|\(|•)/i.test(trimmed);
}

function extractTargetsFromText(
  text: string,
  directoryContacts: SelfChatDirectoryContact[]
): {
  targets: Array<{ jid: string; phone: string; name: string }>;
  matchedPhonesRaw: string[];
} {
  const seenKey = new Set<string>();
  const targets: Array<{ jid: string; phone: string; name: string }> = [];
  const matchedPhonesRaw: string[] = [];

  const phoneRegex = /(?:\+?88)?01[3-9]\d{8}|\b8801[3-9]\d{8}\b|\b\d{10,15}\b/g;
  for (const match of text.matchAll(phoneRegex)) {
    const rawMatch = match[0];
    matchedPhonesRaw.push(rawMatch);
    const pn = normalizePhoneForWa(rawMatch);
    if (pn.length < 7) continue;
    const key = pn.slice(-10);
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const existing = directoryContacts.find(
      (c) => normalizePhoneForWa(c.phone || c.jid).slice(-10) === key
    );
    targets.push({
      jid: existing?.jid || `${pn}@s.whatsapp.net`,
      phone: pn,
      name: existing?.name && !isGenericLabel(existing.name) ? existing.name : `+${pn}`,
    });
  }

  const lower = text.toLowerCase();
  for (const contact of directoryContacts) {
    if (!contact.name || isGenericLabel(contact.name) || contact.name.trim().length < 2) continue;
    const nameLower = contact.name.trim().toLowerCase();
    if (lower.includes(nameLower)) {
      const pn = normalizePhoneForWa(contact.phone || contact.jid);
      const key = pn ? pn.slice(-10) : contact.jid.toLowerCase();
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      targets.push({
        jid: contact.jid || (pn ? `${pn}@s.whatsapp.net` : ''),
        phone: pn,
        name: contact.name,
      });
    }
  }

  return { targets: targets.slice(0, 20), matchedPhonesRaw };
}

function findMatchedGroup(text: string, knownGroups: SelfChatKnownGroup[]): SelfChatKnownGroup | undefined {
  const lower = text.toLowerCase();
  // Match longest group name first so short substrings don't shadow specific names
  const sorted = [...knownGroups].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
  return sorted.find((g) => g.name && g.name.trim().length >= 2 && lower.includes(g.name.toLowerCase()));
}

function stripRoutingForOutgoingMessage(
  rawText: string,
  matchedPhonesRaw: string[],
  matchedNames: string[]
): string {
  let cleaned = rawText.trim();

  const colonSplit = cleaned.match(
    /(?:বলো যে|বলে দাও যে|পাঠাও যে|পাঠিয়ে দাও যে|মেসেজ দাও যে|মেইল করো যে|ইমেইল করো যে|বলো|পাঠাও|পাঠিয়ে দাও|মেসেজ দাও|জানাও|লিখে দাও)\s*[:\-—]?\s*["'“]?(.+?)["'”]?$/iu
  );
  if (colonSplit && colonSplit[1] && colonSplit[1].trim().length >= 3) {
    cleaned = colonSplit[1].trim();
  }

  for (const ph of matchedPhonesRaw) {
    const escapedPh = ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`${escapedPh}(?:\\s*(?:কে|দের|র|গুলোকে|গুলোতে|বাদে|ছাড়া))?`, 'gu'), ' ');
  }
  for (const nm of matchedNames) {
    if (nm && !nm.startsWith('+') && nm.length >= 2) {
      const escaped = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`@${escaped}|${escaped}(?:\\s*(?:কে|দের|র|বাদে))?`, 'giu'), ' ');
    }
  }

  cleaned = cleaned
    .replace(
      /(?:এই নাম্বারগুলোতে|এই নাম্বারে|নাম্বারগুলোতে|নাম্বারে|ইনবক্সে গিয়ে|ইনবক্সে|ডিরেক্ট|পার্সোনালি|গ্রুপে গিয়ে|গ্রুপে|মেনশন দিয়ে|মেনশন দাও|ট্যাগ করে|এদেরকে|তাদেরকে|ওকে|তাকে|উনাকে|বাকিগুলোতে|বাকিদেরকে|সবাইকে|লিডগুলোকে|নক করে বলো যে|নক দিয়ে বলো যে|নক করে বলো|নক দাও|পাঠিয়ে দাও যে|পাঠিয়ে দাও|পাঠাইতে হবে|পাঠাও যে|পাঠাও|বলে দাও যে|বলে দাও|বলো যে|জানিয়ে দাও যে|জানিয়ে দাও)\s*/giu,
      ' '
    )
    .replace(/^(?:[,.\-—:\s]|কে\s+|দের\s+|ও\s+|আর\s+)+/iu, '')
    .replace(/^[,.\-—:\s]+|[,.\-—:\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned;
}

function extractOptionalNote(text: string): string {
  const m = text.match(/(?:কারণ|নোট|বলে|note|reason)\s*[:\-—]?\s*(.+)$/iu);
  return m && m[1] ? m[1].trim().slice(0, 140) : '';
}

function buildAtoZHelpReply(ctx: SelfChatCopilotContext): SelfChatCopilotResult {
  const senders = ctx.outreach.listEmailSenders();
  const activeSender = senders.find((s) => s.active);
  return {
    replyText: [
      `🤖 *WaNexus A-to-Z সেলফ-চ্যাট রিমোট কন্ট্রোল (০ টোকেন)*`,
      `ড্যাশবোর্ডে না গিয়েই সরাসরি এখান থেকে সব নিয়ন্ত্রণ করতে পারবেন:`,
      '',
      `1️⃣ *ড্রাফট ও সরাসরি মেসেজ:*`,
      `• *"আমার জন্য একটা ইমেইল/মেসেজ ড্রাফট করো [বিষয়]"*`,
      `• *"01711..., 01811... এদেরকে পাঠাও [মেসেজ]"*`,
      `• *"01711... এই নাম্বারে কোনো এসএমএস করবা না, বাকিগুলোতে করবা"*`,
      '',
      `2️⃣ *গ্রুপ ফুল কন্ট্রোল:*`,
      `• *"[গ্রুপের নাম] গ্রুপের 017... / রহিম কে কিক আউট করে দাও"*`,
      `• *"[গ্রুপের নাম] গ্রুপের 017... নাম্বারটা অফ/মিউট করে দাও"*`,
      `• *"[গ্রুপের নাম] গ্রুপে অ্যান্টি-লিংক অন/অফ করো"*`,
      `• *"[গ্রুপের নাম] গ্রুপে গ্রুপ এআই অন/অফ করো"*`,
      '',
      `3️⃣ *ওয়েব রিসার্চ, লিড ও ইমেইল প্রোফাইল:*`,
      `• *"ওয়েব সার্চ করো Dhaka software company contact email"*`,
      `• *"https://example.com স্ক্যান করো"* · *"লিড দেখাও"*`,
      `• *"আমার ইমেইল abc@gmail.com পাসওয়ার্ড xxxx দিয়ে সেট করো, আগেরটা ডিলিট করো"*`,
      `• *"সব লিডকে ইমেইল পাঠাও"* অথবা *"client@site.com কে মেইল করো ..."*`,
      '',
      `4️⃣ *পুরো বট ও সেটিংস:*`,
      `• *"স্ট্যাটাস ও র‍্যাম দেখাও"* · *"টেকওভার ক্লিয়ার করো"*`,
      `• *"অটোরিপ্লাই অন/অফ"* · *"টোন ফর্মাল/পোলাইট/ফ্লার্টি/কড়া করো"*`,
      `• *"এআই ব্রেইন অন/অফ"* · *"ডেইলি লিমিট ১৫০ করো"*`,
      `• *"017... কে হোল্ডে রাখো / দীর্ঘক্ষণ কথা বলো / নরমাল করো"*`,
      '',
      `5️⃣ *অটোনোমাস এজেন্ট, সেলফ-হিল ও মোবাইল অফলোড:*`,
      `• *"এজেন্ট [যেকোনো মাল্টি-স্টেপ কাজ]"* (যেমন: রিসার্চ করে WA/ইমেইল পাঠানো)`,
      `• *"সেলফ হিল চালাও"* · *"সেলফ পিং স্ট্যাটাস"* · *"মোবাইল অফলোড স্ট্যাটাস"*`,
      '',
      `📌 অ্যাক্টিভ ইমেইল প্রোফাইল: ${activeSender ? `*${activeSender.email}*` : 'সেট নেই (অ্যাপ পাসওয়ার্ড দিন)'}`,
    ].join('\n'),
    actionSummary: 'Displayed A-to-Z Self-Chat Command Guide (0 Tokens)',
    tokensUsed: 0,
    nextPendingDraft: null,
  };
}

function buildVideoAndMediaMistakeReport(ctx: SelfChatCopilotContext): SelfChatCopilotResult {
  const { mediaInsight, incomingText, botConfig, botStatus, dailyStats, recentLogs, recentMemories, activeTakeovers } = ctx;
  const caption = (mediaInsight?.caption || incomingText || '').trim();
  const quoted = (mediaInsight?.quotedSummary || '').trim();
  const combinedQuery = `${caption} ${quoted}`.trim();

  const kindLabel =
    mediaInsight?.kind === 'video'
      ? `ভিডিও${mediaInsight.durationSec ? ` (${mediaInsight.durationSec} সেকেন্ড)` : ''}`
      : mediaInsight?.kind === 'photo'
        ? 'ছবি / স্ক্রিনশট'
        : mediaInsight?.kind === 'audio'
          ? `ভয়েস নোট (${mediaInsight.durationSec || '?'}s)`
          : 'মিডিয়া';

  const visual = mediaInsight?.visual;
  let visualSummary = 'মেটাডেটা + ভিজ্যুয়াল সিগন্যাল স্ক্যান সম্পন্ন হয়েছে (০ টোকেন, র‍্যাম সেফ মোড)';
  if (visual) {
    if (visual.scene === 'screenshot_or_meme' || visual.uniformLightRatio > 0.45 || visual.uniformDarkRatio > 0.52) {
      visualSummary = `স্ক্রিন রেকর্ডিং / চ্যাট স্ক্রিনশট টাইপ ফ্রেম (${visual.aspect}, ব্রাইটনেস ${visual.brightness}, কনট্রাস্ট ${visual.contrast})`;
    } else if (visual.quality === 'dark_or_unclear') {
      visualSummary = `অন্ধকার বা অস্পষ্ট ফ্রেম (ব্রাইটনেস ${visual.brightness}, কনট্রাস্ট ${visual.contrast})`;
    } else {
      visualSummary = `${mediaInsight?.banglaSceneLabel || visual.scene} (${visual.aspect}, ব্রাইটনেস ${visual.brightness})`;
    }
  }

  const findings: string[] = [];
  if (botStatus !== 'connected') {
    findings.push(`• WhatsApp সকেট স্ট্যাটাস এখন *${botStatus}* — লাইভ রিপ্লাই/স্টোরি ডেলিভারি থামতে পারে।`);
  }
  if (!botConfig.autoreply) {
    findings.push('• *Private Auto-Reply* বর্তমানে **OFF** আছে — কেউ ইনবক্সে নক করলে অটো রিপ্লাই যাবে না। (চালু করতে লিখুন: *"অটোরিপ্লাই অন করো"*)');
  }
  if (dailyStats.count >= dailyStats.limit) {
    findings.push(`• আজকের সেফটি লিমিট পূর্ণ হয়েছে (${dailyStats.count}/${dailyStats.limit}) — এজন্য নতুন রিপ্লাই থেমে আছে।`);
  }
  if (activeTakeovers.length > 0) {
    findings.push(
      `• ${activeTakeovers.length}টি চ্যাটে **Manual Takeover Pause** চালু আছে (${activeTakeovers
        .map((t) => `+${t.phone}`)
        .slice(0, 3)
        .join(', ')}) — এগুলোতে এআই সাময়িকভাবে থেমে আছে। (ছাড়তে লিখুন: *"টেকওভার ক্লিয়ার করো"*)`
    );
  }
  if (botConfig.storyWhitelistMode === 'selected_only') {
    const count = (botConfig.storyAllowedContacts || []).filter((c) => c.enabled !== false).length;
    findings.push(`• *Story Whitelist* মোড **Selected Only** (${count} জন) — বাকিদের স্টোরি স্কিপ হচ্ছে।`);
  }
  const activePolicies = (botConfig.contactPolicies || []).filter((p) => p.mode !== 'normal');
  if (activePolicies.length > 0) {
    const holds = activePolicies.filter((p) => p.mode === 'hold_wait' || p.mode === 'mute_ai');
    if (holds.length > 0) {
      findings.push(
        `• ${holds.length} জন কন্টাক্ট হোল্ড/মিউট রুলে আটকানো আছে: ${holds
          .slice(0, 3)
          .map((h) => `${h.name} (${h.mode === 'mute_ai' ? 'মিউট' : 'হোল্ড'})`)
          .join(', ')}`
      );
    }
  }

  const recentIssues = recentLogs.filter((l) => l.outcome === 'error' || l.outcome === 'blocked').slice(0, 3);
  for (const log of recentIssues) {
    findings.push(`• সাম্প্রতিক লগ (${log.actor}): ${log.summary}`);
  }

  let matchedChatNote = '';
  if (combinedQuery) {
    const { targets } = extractTargetsFromText(combinedQuery, ctx.directoryContacts);
    let memMatch: ChatMemoryRecord | undefined;
    if (targets.length > 0) {
      const targetKey = targets[0].phone.slice(-10);
      memMatch = recentMemories.find(
        (m) =>
          m.contactJid === targets[0].jid ||
          (targetKey && m.contactJid.replace(/\D/g, '').endsWith(targetKey))
      );
    }
    if (!memMatch) {
      const lowerQ = combinedQuery.toLowerCase();
      memMatch = recentMemories.find(
        (m) => m.contactName && !isGenericLabel(m.contactName) && lowerQ.includes(m.contactName.toLowerCase())
      );
    }
    if (memMatch && memMatch.turns.length > 0) {
      const lastTurns = memMatch.turns
        .slice(-3)
        .map((t) => `   ${t.role === 'user' ? memMatch!.contactName : 'বট'}: "${t.text.slice(0, 90)}"`)
        .join('\n');
      matchedChatNote = `\n💬 *${memMatch.contactName}-এর শেষ চ্যাট রেকর্ড:*\n${lastTurns}`;
    }
  }

  const captionLower = combinedQuery.toLowerCase();
  const mistakeHints: string[] = [];
  if (/(ভুল|mistake|মিসটেক|wrong|উল্টাপাল্টা|রিপ্লাই দেয় না|reply দেয়নি|দাম|হোল্ড)/i.test(captionLower)) {
    if (findings.length === 0) {
      mistakeHints.push(
        '• সিস্টেম কনফিগ, টেকওভার বা ডেইলি লিমিটে কোনো ব্লকার নেই। সম্ভবত টার্গেট কন্টাক্টের চ্যাট মেমোরি বা অ্যাসিস্ট্যান্ট টোন অ্যাডজাস্ট করতে হবে।'
      );
    }
    if (botConfig.mediaZeroTokenReplyMode) {
      mistakeHints.push(
        '• *Zero-Token Media Mode* ON থাকায় মিডিয়া/স্টোরি রিপ্লাই সম্পূর্ণ অফলাইন ও ০ টোকেনে চলছে।'
      );
    }
  }

  const allDiagnoses = [...findings, ...mistakeHints];
  const diagnosisBlock =
    allDiagnoses.length > 0
      ? allDiagnoses.join('\n')
      : '• এই মুহূর্তে সিস্টেম লগ বা কনফিগারেশনে কোনো টেকনিক্যাল এরর, ব্লক বা টেকওভার আটকে নেই — সব নরমাল চলছে!';

  const replyText = [
    `🎬 *${kindLabel} স্ক্যান ও মিসটেক রিপোর্ট (০ টোকেন)*`,
    `👁️ ফ্রেম বিশ্লেষণ: ${visualSummary}`,
    caption ? `📝 আপনার নোট: "${caption}"` : '',
    '',
    `🔍 *সিস্টেম ও মিসটেক অ্যানালাইসিস:*`,
    diagnosisBlock,
    matchedChatNote,
    '',
    `💡 পরের ধাপ: নির্দিষ্ট কারো রিপ্লাই/ভুল ঠিক করতে চাইলে নাম বা নাম্বার লিখে বলুন (যেমন: *"০১৭... কে হোল্ডে রাখো"* বা *"টেকওভার ক্লিয়ার করো"*)!`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    replyText,
    actionSummary: `Video/Media Diagnostic (${kindLabel}, 0 Tokens)`,
    tokensUsed: 0,
    nextPendingDraft: null,
  };
}

function buildAdvisorConsultationReply(ctx: SelfChatCopilotContext): SelfChatCopilotResult {
  const text = ctx.incomingText.trim();
  const lower = text.toLowerCase();
  const unreadCount = ctx.unreadNotes.length;
  const activePolicies = (ctx.botConfig.contactPolicies || []).filter((p) => p.mode !== 'normal');
  const outreachSummary = ctx.outreach.getSummary();
  const activeSender = outreachSummary.senders.find((s) => s.active);

  if (/(দাম|discount|ডিসকাউন্ট|কম|বাজেট|টাকা|পেমেন্ট|payment)/i.test(lower)) {
    const sampleBody =
      'ভাইয়া, কাজের কোয়ালিটি ও ফুল সাপোর্টের কারণে স্ট্যান্ডার্ড চার্জের নিচে যাওয়া কঠিন—তবে আজকের মধ্যে কনফার্ম করলে আপনার জন্য স্পেশাল প্রায়োরিটি ডেলিভারি অ্যারেঞ্জ করে দিতে পারি।';
    return {
      replyText: [
        `💼 *পরামর্শ (প্রাইসিং ও ডিল হ্যান্ডলিং):*`,
        `ক্লায়েন্ট দাম কমাতে চাইলে সরাসরি 'না' না বলে ভ্যালু বুঝিয়ে বলুন, অথবা টাইম-লিমিটেড শর্ত দিন।`,
        '',
        `📩 *রেডিমেড মেসেজ ড্রাফট:*`,
        `"${sampleBody}"`,
        '',
        `চাইলে এখনই লিখুন—*"017... কে এই ড্রাফটটা পাঠাও"*, আমি পাঠিয়ে দেব!`,
      ].join('\n'),
      actionSummary: 'Business Pricing Consultation + Ready Draft (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: {
        kind: 'ready_draft',
        targets: [],
        draftChannel: 'whatsapp',
        draftBody: sampleBody,
        expiresAt: Date.now() + 10 * 60_000,
      },
    };
  }

  if (/(বিরক্ত|spam|স্প্যাম|রাগ|ঝামেলা|অযথা|বাজে কথা|প্যারা)/i.test(lower)) {
    return {
      replyText: [
        `🛡️ *পরামর্শ (বিরক্তিকর কন্টাক্ট নিয়ন্ত্রণ):*`,
        `অযথা প্যারা বা স্প্যাম করলে তর্কে না জড়িয়ে তিনভাবে আটকাতে পারেন:`,
        `১) *হোল্ডে রাখা*: লিখুন *"০১৭... কে আটকে রাখো"*`,
        `২) *সম্পূর্ণ মিউট (গ্রুপ+ইনবক্স)*: লিখুন *"০১৭... নাম্বারটা অফ করে দাও"*`,
        `৩) *গ্রুপ থেকে কিক*: লিখুন *"[গ্রুপের নাম] গ্রুপের ০১৭... কে কিক আউট করে দাও"*`,
      ].join('\n'),
      actionSummary: 'Contact Control Consultation (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (/(গুরুত্বপূর্ণ|নোট|summary|কে কে নক|ইনবক্স|inbox|খবর|আপডেট|status|স্ট্যাটাস|ram|র‍্যাম|token|টোকেন)/i.test(lower)) {
    const recentNotesText =
      unreadCount > 0
        ? ctx.unreadNotes
            .slice(0, 4)
            .map((n, i) => `${i + 1}. *${n.contactName}* (${n.urgency === 'important' ? 'জরুরি' : 'সাধারণ'}): ${n.summary}`)
            .join('\n')
        : 'কোনো আনরিড নোট নেই।';

    const recentMemText =
      ctx.recentMemories.length > 0
        ? ctx.recentMemories
            .slice(0, 4)
            .map((m) => `• *${m.contactName}*: ${m.lastSummary || m.turns[m.turns.length - 1]?.text.slice(0, 55) || 'চ্যাট সেভড'}`)
            .join('\n')
        : 'এখনো কোনো রিসেন্ট চ্যাট রেকর্ড নেই।';

    return {
      replyText: [
        `📊 *সম্পূর্ণ সিস্টেম ও আউটরিচ ড্যাশবোর্ড রিপোর্ট (০ টোকেন)*`,
        `• WhatsApp: *${ctx.botStatus}* | মেমোরি (RAM): *${ctx.memoryRssMb} MB*`,
        `• অটোরিপ্লাই: *${ctx.botConfig.autoreply ? 'ON' : 'OFF'}* | এআই ব্রেইন: *${ctx.botConfig.aiAssistantEnabled ? 'ON' : 'OFF'}*`,
        `• গ্রুপ AI: *${ctx.botConfig.groupAiEnabled ? 'ON' : 'OFF'}* (${ctx.botConfig.groupAiMode || 'smart_blend'}) | টোন: *${ctx.botConfig.assistantTone}*`,
        `• আজকের WA রিপ্লাই: *${ctx.dailyStats.count}/${ctx.dailyStats.limit}* | স্টোরি মোড: *${ctx.botConfig.storyWhitelistMode || 'all'}*`,
        `• কন্টাক্ট রুলস: *${activePolicies.length}টি* | টেকওভার পজ: *${ctx.activeTakeovers.length}টি*`,
        `• লিড ভল্ট: *${outreachSummary.totalLeads}টি লিড* (${outreachSummary.verifiedLeadsCount} WA ভেরিফাইড)`,
        `• আজকের আউটরিচ: Email *${outreachSummary.stats.emailsSentToday}/${outreachSummary.policy.dailyEmailLimit}* · WA *${outreachSummary.stats.whatsappSentToday}/${outreachSummary.policy.dailyWhatsappLimit}*`,
        `• অ্যাক্টিভ ইমেইল প্রোফাইল: ${activeSender ? `*${activeSender.email}*` : 'নেই (App Password দিয়ে সেট করা যাবে)'}`,
        '',
        `📌 *আনরিড ইনবক্স নোট (${unreadCount}):*`,
        recentNotesText,
        '',
        `💬 *রিসেন্ট চ্যাটস:*`,
        recentMemText,
      ].join('\n'),
      actionSummary: 'System & Outreach Executive Briefing (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  return buildAtoZHelpReply(ctx);
}

export async function runZeroTokenSelfChatCopilot(
  ctx: SelfChatCopilotContext
): Promise<SelfChatCopilotResult> {
  const rawText = ctx.incomingText.trim();
  const safeDisplayText = redactSecretsInText(rawText);
  const lower = rawText.toLowerCase();

  // 1. Video / Media Mistake Diagnosis takes priority when owner sends Video/Photo/Voice in Self-Chat
  if (ctx.mediaInsight?.isMedia && ctx.mediaInsight.kind !== 'text' && ctx.mediaInsight.kind !== 'story_text') {
    return buildVideoAndMediaMistakeReport(ctx);
  }

  // 2. Cancel active pending draft if requested
  if (ctx.pendingDraft && /^(?:বাতিল|cancel|থাক|বাদ দাও|ক্যান্সেল)$/iu.test(lower)) {
    return {
      replyText: '✅ আগের পেন্ডিং ড্রাফট/অ্যাকশন বাতিল করা হয়েছে বস।',
      actionSummary: 'Cancelled Pending Self-Chat Action (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 3. Explicit Help / Command List
  if (/^(?:help|commands?|কমান্ড|কমান্ড লিস্ট|হেল্প|কি কি করতে পারো|কী কী করতে পারো|মেনু|menu|\?)$/iu.test(lower)) {
    return buildAtoZHelpReply(ctx);
  }

  // 4. Multi-Account Email Sender Login / Switch / Delete + Direct Email Dispatch via Self-Chat
  const emailMatches = Array.from(new Set((rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,12}/g) || []).map((e) => e.toLowerCase())));
  const hasPasswordHint = /(পাসওয়ার্ড|পাসওয়ার্ড|অ্যাপ\s*পাসওয়ার্ড|app\s*password|password|pass)/iu.test(lower);
  const hasEmailDeleteCmd = /(আগের\s*(?:ইমেইল|মেইল|অ্যাকাউন্ট).*?(?:ডিলিট|রিমুভ|মুছে|বাদ)|(?:ইমেইল|মেইল)\s*(?:ডিলিট|রিমুভ|মুছে দাও))/iu.test(lower);
  const hasEmailListCmd = /(ইমেইল\s*(?:অ্যাকাউন্ট|লিস্ট|প্রোফাইল)|মেইল\s*(?:লিস্ট|প্রোফাইল)|sender\s*list)/iu.test(lower);
  const hasEmailSwitchCmd = /(এই\s*ইমেইল(?:টা|টি)?\s*(?:ব্যবহার|চালু|সেট|অ্যাক্টিভ)|ইমেইল\s*সুইচ|switch\s*email)/iu.test(lower);

  if (hasEmailListCmd && !hasPasswordHint) {
    const senders = ctx.outreach.listEmailSenders();
    if (senders.length === 0) {
      return {
        replyText: [
          '📧 এখনো কোনো SMTP / App Password সেন্ডার প্রোফাইল সেভ করা নেই।',
          'যেকোনো জিমেইল যুক্ত করতে লিখুন:',
          '*"আমার ইমেইল example@gmail.com পাসওয়ার্ড xxxx xxxx xxxx xxxx দিয়ে সেট করো"*',
        ].join('\n'),
        actionSummary: 'Listed Email Sender Profiles (Empty, 0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
    return {
      replyText: [
        `📧 *সংরক্ষিত ইমেইল সেন্ডার প্রোফাইল (${senders.length}টি):*`,
        ...senders.map(
          (s: PublicEmailSenderProfile, i: number) =>
            `${i + 1}. *${s.email}* ${s.active ? '✅ (Active)' : ''} · Pass: ${s.maskedSecret}`
        ),
        '',
        `নতুন ইমেইল দিতে বা আগেরটা ডিলিট করতে চাইলে সরাসরি বলুন!`,
      ].join('\n'),
      actionSummary: `Listed ${senders.length} Email Sender(s) (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // Add/Login with email + password (and optionally delete previous email, and optionally immediately send!)
  if (hasPasswordHint && emailMatches.length > 0) {
    const senderEmail = emailMatches[0];
    // Extract password after keyword OR 16-char Google App Password format
    const explicitPassMatch = rawText.match(
      /(?:অ্যাপ\s*পাসওয়ার্ড|পাসওয়ার্ড|পাসওয়ার্ড|app\s*password|password|pass)\s*[:=\-]?\s*(?:["'“]?([a-zA-Z0-9!@#$%^&*_.\-]{4,}(?:\s+[a-zA-Z0-9]{4}){0,3})["'”]?)/iu
    );
    const appPassGrouped = rawText.match(/\b([a-z]{4}\s+[a-z]{4}\s+[a-z]{4}\s+[a-z]{4})\b/);
    let extractedSecret = (explicitPassMatch?.[1] || appPassGrouped?.[1] || '').trim();
    // Trim trailing Bengali action words if regex grabbed extra tokens after grouped app password
    extractedSecret = extractedSecret.replace(/\s+(?:দিয়ে|দিয়েই|করে|লগইন|সেট|এবং|আর).*$/iu, '').trim();

    if (!extractedSecret || extractedSecret.length < 4) {
      return {
        replyText: `বুঝেছি বস, *${senderEmail}* অ্যাকাউন্ট যুক্ত করতে হবে—কিন্তু পাসওয়ার্ড/১৬ সংখ্যার Google App Password বুঝতে পারিনি। স্পষ্টভাবে *"ইমেইল ${senderEmail} পাসওয়ার্ড xxxx xxxx xxxx xxxx সেট করো"* লিখে দিন!`,
        actionSummary: 'Requested Email App Password Clarification (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const deletePrevious = /(আগের|পুরাতন|পুরনো|previous|old).*(ডিলিট|রিমুভ|মুছ|বাদ|delete|remove)/iu.test(lower);
    const saved = ctx.outreach.addAndActivateEmailSender({
      email: senderEmail,
      secret: extractedSecret,
      deletePrevious,
    });

    // If the same message ALSO asks to send to collected leads or another target email right now
    const wantsImmediateSend = /(পাঠাও|পাঠিয়ে দাও|মেইল করো|ইমেইল করো|সেন্ড করো|send)/iu.test(lower);
    const recipientEmails = emailMatches.slice(1);
    let sendSummary = '';
    if (wantsImmediateSend) {
      const draftSubject =
        ctx.pendingDraft?.draftSubject ||
        `সহযোগিতা ও কাজের প্রস্তাব — ${ctx.botConfig.ownerName || 'Sir'}`;
      const draftBody =
        ctx.pendingDraft?.draftBody ||
        (await ctx.outreach.draftMessage({ channel: 'email', useAi: false })).body;

      const sendRes = await ctx.outreach.sendEmailOutreach({
        subject: draftSubject,
        body: draftBody,
        directEmails: recipientEmails,
        useCollectedLeads: recipientEmails.length === 0,
        provider: 'smtp_profile',
      });
      if (sendRes.error) {
        sendSummary = `\n⚠️ ইমেইল পাঠানোর আপডেট: ${sendRes.error}`;
      } else {
        sendSummary = `\n🚀 *ইমেইল পাঠানো হয়েছে:* ${sendRes.sentCount}টি সফল${sendRes.failedCount > 0 ? `, ${sendRes.failedCount}টি ব্যর্থ` : ''} (Sender: *${senderEmail}*)`;
      }
    }

    return {
      replyText: [
        `✅ *${saved.profile.email}* নতুন অ্যাক্টিভ ইমেইল প্রোফাইল হিসেবে সেট হয়েছে! (পাসওয়ার্ড [REDACTED] সুরক্ষিত)`,
        saved.deletedCount > 0 ? `🗑️ আগের ${saved.deletedCount}টি ইমেইল অ্যাকাউন্ট মুছে ফেলা হয়েছে।` : '',
        saved.warning ? `⚠️ ${saved.warning}` : '',
        sendSummary,
      ]
        .filter(Boolean)
        .join('\n'),
      actionSummary: `Activated Email Sender ${senderEmail}${deletePrevious ? ' (Deleted Previous)' : ''} [0 Tokens]`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (hasEmailDeleteCmd) {
    const deleteAll = /(সব|all)/iu.test(lower);
    const target = deleteAll ? 'all' : emailMatches[0] || 'previous';
    const delRes = ctx.outreach.deleteEmailSender(target);
    return {
      replyText:
        delRes.removedCount > 0
          ? `🗑️ সফলভাবে *${delRes.removedCount}টি* ইমেইল প্রোফাইল ডিলিট করা হয়েছে। এখন অবশিষ্ট প্রোফাইল: ${delRes.remaining.length}টি।`
          : 'ডিলিট করার মতো কোনো সংরক্ষিত ইমেইল প্রোফাইল পাওয়া যায়নি।',
      actionSummary: `Deleted Email Sender Profile(s) [0 Tokens]`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (hasEmailSwitchCmd && emailMatches.length > 0) {
    const switched = ctx.outreach.switchEmailSender(emailMatches[0]);
    return {
      replyText: switched
        ? `✅ অ্যাক্টিভ সেন্ডার হিসেবে *${switched.email}* চালু করা হয়েছে!`
        : `❌ *${emailMatches[0]}* প্রোফাইলটি লিস্টে নেই। আগে পাসওয়ার্ড সহ যুক্ত করুন।`,
      actionSummary: `Switched Active Email Sender (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 5. Pending Draft / Multi-turn Completion
  if (ctx.pendingDraft && Date.now() < ctx.pendingDraft.expiresAt && rawText) {
    const isUsingExistingDraft = /(?:এই ড্রাফট|ড্রাফটটা|এটা|এটাই|ওটা|এইটা).*(?:পাঠাও|পাঠিয়ে|করো|দাও|সেন্ড|মেইল|ইমেইল)/iu.test(lower);
    if (ctx.pendingDraft.kind === 'ready_draft' && isUsingExistingDraft && ctx.pendingDraft.draftBody) {
      // Check if user wants email dispatch to leads/emails or WA dispatch to targets/leads
      if (/(মেইল|ইমেইল|email|mail)/iu.test(lower)) {
        const res = await ctx.outreach.sendEmailOutreach({
          subject: ctx.pendingDraft.draftSubject || `সহযোগিতা প্রস্তাব — ${ctx.botConfig.ownerName || 'WaNexus'}`,
          body: ctx.pendingDraft.draftBody,
          directEmails: emailMatches,
          useCollectedLeads: emailMatches.length === 0,
        });
        return {
          replyText: res.error
            ? `⚠️ ${res.error}`
            : `✅ ড্রাফট ইমেইল পাঠানো সম্পন্ন: *${res.sentCount}টি* সফল${res.failedCount > 0 ? `, ${res.failedCount}টি ব্যর্থ` : ''} (${res.providerUsed})!`,
          actionSummary: `Sent Pending Draft via Email (${res.sentCount} sent, 0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }

      const matchedGrp = findMatchedGroup(rawText, ctx.knownGroups);
      if (matchedGrp) {
        const gRes = await ctx.dispatchGroupMention({
          groupJid: matchedGrp.jid,
          groupName: matchedGrp.name,
          members: [],
          messageText: ctx.pendingDraft.draftBody,
          originalInstruction: rawText,
        });
        return {
          replyText: `✅ ড্রাফট মেসেজটি *${gRes.groupName}* গ্রুপে ${gRes.deliveredLive ? 'লাইভ পাঠানো হয়েছে' : 'ড্রাফট সেভ হয়েছে'}!`,
          actionSummary: `Sent Pending Draft to Group ${gRes.groupName} (0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }

      const { targets } = extractTargetsFromText(rawText, ctx.directoryContacts);
      if (targets.length > 0) {
        const dmRes = await ctx.dispatchDirectDm({
          targets,
          messageText: ctx.pendingDraft.draftBody,
          originalInstruction: rawText,
        });
        return {
          replyText: `✅ আপনার তৈরি করা ড্রাফট মেসেজটি *${dmRes.targetLabels.join(', ')}*-কে পাঠানো হয়েছে!`,
          actionSummary: `Sent Ready Draft to ${targets.length} DM target(s) (0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }
    }

    const looksLikeNewCommand = /(?:আটকে রাখ|দীর্ঘক্ষণ|মিউট|অন করো|অফ করো|স্ট্যাটাস|দেখাও|কিক|ডিলিট|সার্চ|রিসার্চ|ড্রাফট করো|বানাও)/i.test(lower);
    if (!looksLikeNewCommand) {
      if (ctx.pendingDraft.kind === 'dm_knock' && ctx.pendingDraft.targets.length > 0) {
        const res = await ctx.dispatchDirectDm({
          targets: ctx.pendingDraft.targets,
          messageText: rawText,
          originalInstruction: rawText,
        });
        return {
          replyText: `✅ হয়ে গেছে বস! ${res.targetLabels.join(', ')}-এর ইনবক্সে মেসেজ ${res.deliveredCount > 0 ? 'লাইভ পাঠানো হয়েছে' : 'ড্রাফট করা হয়েছে'}:\n"${rawText}"`,
          actionSummary: `Completed Pending DM Dispatch (${res.targetLabels.length} target, 0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }
      if (ctx.pendingDraft.kind === 'dm_excluding') {
        const excludedSet = new Set((ctx.pendingDraft.excludePhones || []).map((p) => p.slice(-10)));
        const validTargets = ctx.pendingDraft.targets.filter((t) => !excludedSet.has(t.phone.slice(-10)));
        if (validTargets.length > 0) {
          const res = await ctx.dispatchDirectDm({
            targets: validTargets,
            messageText: rawText,
            originalInstruction: rawText,
          });
          return {
            replyText: `✅ বাদ দেওয়া নাম্বার ছাড়া বাকি *${res.deliveredCount || res.targetLabels.length} জনকে* (${res.targetLabels.slice(0, 5).join(', ')}) মেসেজ পাঠানো হয়েছে!\n"${rawText}"`,
            actionSummary: `Completed Exclusion Broadcast (${validTargets.length} targets, 0 Tokens)`,
            tokensUsed: 0,
            nextPendingDraft: null,
          };
        }
        const outRes = await ctx.outreach.sendWhatsappOutreach({
          body: rawText,
          excludePhones: ctx.pendingDraft.excludePhones || [],
          useCollectedLeads: true,
        });
        return {
          replyText: outRes.error
            ? `⚠️ ${outRes.error}`
            : `✅ বাদ দেওয়া নাম্বার স্কিপ করে বাকি *${outRes.totalTargets}টি* লিডে মেসেজ ${outRes.queued ? 'অ্যান্টি-ব্যান কিউতে পাঠানো হচ্ছে' : 'পাঠানো হয়েছে'}!`,
          actionSummary: `Completed Exclusion Lead Outreach (0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }
    }
  }

  // 5b. Explicit Autonomous Agent Trigger ("এজেন্ট ...", "অটোনোমাস ...", "agent ...")
  const explicitAgentTrigger = /^(?:এজেন্ট|অটোনোমাস|agent|autonomous|নিজে থেকেই|মিশন|mission)(?:\s|$|[:\-—])/iu.test(lower);
  if (explicitAgentTrigger && ctx.runAutonomousMission) {
    const cleanedGoal = rawText.replace(/^(?:এজেন্ট|অটোনোমাস|agent|autonomous|নিজে থেকেই|মিশন|mission)\s*[:\-—]?\s*/iu, '').trim() || rawText;
    const agentRes = await ctx.runAutonomousMission(cleanedGoal);
    return {
      replyText: `${agentRes.finalReport}\n\n_(${agentRes.providerUsed.toUpperCase()} · ${agentRes.stepsCount} ধাপ · ${agentRes.tokensUsed} টোকেন)_`,
      actionSummary: `Autonomous Agent (${agentRes.providerUsed}, ${agentRes.stepsCount} steps, ${agentRes.tokensUsed} tok)`,
      tokensUsed: agentRes.tokensUsed,
      nextPendingDraft: null,
    };
  }

  // 6. Group Control: Kick Member Out + Mute Specific Number/Member + Antilink + Group AI Toggles
  const matchedGroup = findMatchedGroup(rawText, ctx.knownGroups);
  const isKickCmd = /(?:কিক\s*আউট|কিক\s*কর|কিক\s*মার|বের\s*করে\s*দাও|রিমুভ\s*কর|গ্রুপ\s*থেকে\s*(?:বাদ|সরাও|বের)|kick|remove\s*(?:from|member))/iu.test(lower);
  if (isKickCmd) {
    const targetGroup = matchedGroup || (ctx.knownGroups.length === 1 ? ctx.knownGroups[0] : undefined);
    if (!targetGroup) {
      const sample = ctx.knownGroups.slice(0, 4).map((g) => `"${g.name}"`).join(', ');
      return {
        replyText: `কোন গ্রুপ থেকে মেম্বার কিক আউট করবো গ্রুপের নাম লিখুন বস${sample ? ` (আপনার গ্রুপ: ${sample})` : ''}।`,
        actionSummary: 'Requested Group Name for Kick (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const { targets, matchedPhonesRaw } = extractTargetsFromText(rawText, [
      ...(targetGroup.members || []),
      ...ctx.directoryContacts,
    ]);
    let targetQuery = targets[0]?.phone || targets[0]?.name || '';
    if (!targetQuery) {
      // Fall back to removing group name & kick words to extract any typed member name
      targetQuery = stripRoutingForOutgoingMessage(rawText, matchedPhonesRaw, [targetGroup.name])
        .replace(/(?:গ্রুপের|গ্রুপ\s*থেকে|মেম্বার|নাম্বারটা|কে|কিক\s*আউট|কিক|বের\s*করে\s*দাও|রিমুভ\s*কর| করে\s*দাও)/giu, '')
        .trim();
    }
    if (!targetQuery) {
      return {
        replyText: `*${targetGroup.name}* গ্রুপ থেকে কাকে কিক আউট করবো তার নাম বা নাম্বার দিন বস (যেমন: *"${targetGroup.name} গ্রুপের 017... কে কিক আউট করো"*)।`,
        actionSummary: 'Requested Target Member for Kick (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const kickRes = await ctx.kickGroupMember({
      groupJid: targetGroup.jid,
      groupName: targetGroup.name,
      targetPhoneOrName: targetQuery,
    });
    return {
      replyText: kickRes.ok
        ? `✅ *${targetGroup.name}* গ্রুপ থেকে *${kickRes.kickedLabel || targetQuery}*-কে কিক আউট করা হয়েছে!`
        : `⚠️ কিক করা যায়নি: ${kickRes.reason}`,
      actionSummary: `Group Kick Attempt (${targetGroup.name}: ${kickRes.ok ? 'Success' : 'Blocked'}, 0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // Group-specific Anti-Link or Group AI toggle (or specific member off inside a group)
  const isAntilinkToggle = /(?:অ্যান্টি\s*লিংক|antilink|anti-link|লিংক\s*ডিলিট)/iu.test(lower);
  if (isAntilinkToggle) {
    const turnOn = /(?:অন|চালু|enable|on)/iu.test(lower);
    const turnOff = /(?:অফ|বন্ধ|disable|off)/iu.test(lower);
    const targetGroup = matchedGroup || (ctx.knownGroups.length === 1 ? ctx.knownGroups[0] : undefined);
    if (!targetGroup || (!turnOn && !turnOff)) {
      const sample = ctx.knownGroups.slice(0, 4).map((g) => `"${g.name}"`).join(', ');
      return {
        replyText: `Anti-Link পরিবর্তন করতে গ্রুপের নাম সহ অন/অফ লিখুন বস${sample ? ` (গ্রুপ: ${sample})` : ''}। যেমন: *"Test Group এ অ্যান্টি-লিংক অন করো"*।`,
        actionSummary: 'Requested Group Name for Anti-Link Toggle (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
    const nextMap = { ...(ctx.botConfig.antilinkGroups || {}), [targetGroup.jid]: turnOn };
    await ctx.updateSystemSettings({ antilinkGroups: nextMap });
    return {
      replyText: `${turnOn ? '🛡️ Anti-Link ON' : '🛑 Anti-Link OFF'} করা হয়েছে *${targetGroup.name}* গ্রুপের জন্য!`,
      actionSummary: `Toggled Anti-Link ${turnOn ? 'ON' : 'OFF'} for ${targetGroup.name} (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (matchedGroup && /(?:গ্রুপ\s*এআই|group\s*ai|বট|এআই|রিপ্লাই).*(?:অন|অফ|চালু|বন্ধ|on|off)/iu.test(lower)) {
    const { targets } = extractTargetsFromText(rawText, [
      ...(matchedGroup.members || []),
      ...ctx.directoryContacts,
    ]);
    // If specific member is NOT mentioned, toggle Group AI for the whole group!
    if (targets.length === 0) {
      const turnOn = /(?:অন|চালু|enable|on)/iu.test(lower);
      const nextMap = { ...(ctx.botConfig.groupAiGroups || {}), [matchedGroup.jid]: turnOn };
      await ctx.updateSystemSettings({
        ...(turnOn ? { groupAiEnabled: true } : {}),
        groupAiGroups: nextMap,
      });
      return {
        replyText: `${turnOn ? '✅' : '🛑'} *${matchedGroup.name}* গ্রুপে Group AI Clone এখন **${turnOn ? 'ON' : 'OFF'}** করা হয়েছে!`,
        actionSummary: `Toggled Group AI ${turnOn ? 'ON' : 'OFF'} for ${matchedGroup.name} (0 Tokens)`,
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
  }

  // 7. Exclusion Rule + Optional Broadcast ("এই নাম্বারে কোনো এসএমএস করবা না, বাকিগুলোতে করবা" / "017... বাদে সবাইকে পাঠাও")
  const hasExclusionPhrase =
    /(?:কোনো\s*এসএমএস\s*করবা\s*না|এসএমএস\s*দিবা\s*না|মেসেজ\s*করবা\s*না|মেসেজ\s*দিবা\s*না|বাদে\s*সবাইকে|বাদ\s*দিয়ে\s*বাকি|ছাড়া\s*বাকি|বাকিগুলোতে\s*(?:করবা|পাঠাও|দাও)|exclude|don'?t\s*(?:sms|text|message))/iu.test(
      lower
    );

  if (hasExclusionPhrase) {
    // Parse contacts BEFORE "বাদে/ছাড়া/করবা না" as excluded, and contacts AFTER (if any) as explicit recipients
    const splitMatch = rawText.split(/(?:বাদে|বাদ\s*দিয়ে|ছাড়া|কোনো\s*এসএমএস\s*করবা\s*না|এসএমএস\s*করবা\s*না|মেসেজ\s*করবা\s*না|না\s*,?\s*বাকি)/iu);
    const excludeSegment = splitMatch[0] || rawText;
    const includeSegment = splitMatch.slice(1).join(' ');

    const { targets: excludedTargets, matchedPhonesRaw: exRawPhones } = extractTargetsFromText(
      excludeSegment,
      ctx.directoryContacts
    );
    const { targets: includedExplicitTargets, matchedPhonesRaw: incRawPhones } = extractTargetsFromText(
      includeSegment,
      ctx.directoryContacts
    );

    // Apply permanent mute_ai policy to excluded contacts so neither Auto-Reply, Group AI, nor Broadcast touches them
    if (excludedTargets.length > 0) {
      await ctx.upsertContactPolicies(
        excludedTargets.map((t) => ({
          jid: t.jid,
          phone: t.phone,
          name: t.name,
          mode: 'mute_ai',
          note: 'Excluded via Self-Chat SMS Exclusion Command',
        }))
      );
    }

    const excludedSuffixes = new Set([
      ...excludedTargets.map((t) => t.phone.slice(-10)).filter((s) => s.length >= 7),
      ...(ctx.botConfig.contactPolicies || [])
        .filter((p) => p.mode === 'mute_ai')
        .map((p) => normalizePhoneForWa(p.phone || p.jid).slice(-10))
        .filter((s) => s.length >= 7),
    ]);

    const wantsToSendOthers = /(?:বাকিগুলোতে|বাকিগুলো|বাকিদেরকে|বাকিদের|সবাইকে|অন্যদের|পাঠাও|পাঠিয়ে\s*দাও|মেসেজ\s*দাও|সেন্ড|send)/iu.test(lower);
    if (!wantsToSendOthers) {
      const excludedLabel =
        excludedTargets.map((t) => `${t.name} (+${t.phone})`).join(', ') || 'নির্দিষ্ট নাম্বার';
      return {
        replyText: `🔇 ডান বস! *${excludedLabel}*-কে স্থায়ীভাবে অফ (No SMS & No AI Reply) করা হয়েছে — এই নাম্বারে আর কোনো অটোরিপ্লাই বা আউটরিচ এসএমএস যাবে না!`,
        actionSummary: `Muted/Excluded ${excludedTargets.length} Contact(s) [0 Tokens]`,
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    if (wantsToSendOthers) {
      const candidatePool =
        includedExplicitTargets.length > 0
          ? includedExplicitTargets
          : ctx.directoryContacts
              .filter((c) => c.phone && c.phone.length >= 9)
              .map((c) => ({ jid: c.jid, phone: normalizePhoneForWa(c.phone || c.jid), name: c.name }));

      const remainingTargets = candidatePool.filter((t) => {
        const sfx = normalizePhoneForWa(t.phone || t.jid).slice(-10);
        return sfx.length >= 7 && !excludedSuffixes.has(sfx);
      });

      const bodyCandidate = stripRoutingForOutgoingMessage(
        includeSegment || rawText,
        [...exRawPhones, ...incRawPhones],
        [...excludedTargets.map((t) => t.name), ...includedExplicitTargets.map((t) => t.name)]
      )
        .replace(/^(?:বাকিগুলোতে\s*(?:করবা|দাও|পাঠাও)?|আর\s+|সবাইকে\s*)/giu, '')
        .trim();

      const excludedLabel =
        excludedTargets.map((t) => `${t.name} (+${t.phone})`).join(', ') || 'মিউট করা নাম্বার';

      if (bodyCandidate.length >= 4) {
        if (remainingTargets.length > 0) {
          const res = await ctx.dispatchDirectDm({
            targets: remainingTargets.slice(0, 15),
            messageText: bodyCandidate,
            originalInstruction: rawText,
          });
          return {
            replyText: [
              `🔇 *এক্সক্লুশন প্রয়োগ করা হয়েছে:* ${excludedLabel}-কে কোনো এসএমএস করা হয়নি (স্থায়ীভাবে অফ রাখা হয়েছে)।`,
              `✅ বাকি *${res.targetLabels.length} জনকে* (${res.targetLabels.slice(0, 4).join(', ')}) মেসেজ পাঠানো হয়েছে:`,
              `"${bodyCandidate}"`,
            ].join('\n'),
            actionSummary: `Excluded ${excludedTargets.length} & Messaged ${remainingTargets.length} Target(s) [0 Tokens]`,
            tokensUsed: 0,
            nextPendingDraft: null,
          };
        }
        const outRes = await ctx.outreach.sendWhatsappOutreach({
          body: bodyCandidate,
          excludePhones: Array.from(excludedSuffixes),
          useCollectedLeads: true,
        });
        return {
          replyText: outRes.error
            ? `🔇 ${excludedLabel}-কে মিউট রাখা হয়েছে।\n⚠️ বাকি লিড পাঠানো যায়নি: ${outRes.error}`
            : `🔇 ${excludedLabel}-কে বাদ দিয়ে বাকি *${outRes.totalTargets}টি* লিডে পাঠানো হচ্ছে!`,
          actionSummary: `Excluded ${excludedTargets.length} & Sent Lead Outreach (0 Tokens)`,
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }

      return {
        replyText: [
          `🔇 ডান বস! *${excludedLabel}*-কে সম্পূর্ণ অফ (No SMS / No AI Reply) রাখা হয়েছে।`,
          `📩 বাকি *${remainingTargets.length || ctx.outreach.getSummary().totalLeads}* জনকে ঠিক কী মেসেজ পাঠাবো শুধু সেই টেক্সটটা এখন লিখে দিন!`,
        ].join('\n'),
        actionSummary: `Excluded ${excludedTargets.length} Contact(s) & Awaiting Broadcast Text (0 Tokens)`,
        tokensUsed: 0,
        nextPendingDraft: {
          kind: 'dm_excluding',
          targets: remainingTargets,
          excludePhones: Array.from(excludedSuffixes),
          expiresAt: Date.now() + 8 * 60_000,
        },
      };
    }
  }

  // 8. List Active Contact Policies
  if (/(কার কার|পলিসি লিস্ট|policy list|কন্টাক্ট রুল|কাকে আটকে|দীর্ঘক্ষণ কার)/i.test(lower)) {
    const active = (ctx.botConfig.contactPolicies || []).filter((p) => p.mode !== 'normal');
    if (active.length === 0) {
      return {
        replyText: 'এখনো কোনো কন্টাক্টের ওপর আলাদা রুল সেট করা নেই বস। যেকোনো নাম/নাম্বার দিয়ে বলতে পারেন!',
        actionSummary: 'Listed Contact Policies (Empty, 0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
    const modeLabel: Record<ContactPolicyMode, string> = {
      long_engage: '💬 দীর্ঘক্ষণ কথা (Engage)',
      hold_wait: '⏳ আটকে রাখা (Hold/Wait)',
      mute_ai: '🔇 রিপ্লাই ও এসএমএস বন্ধ (Off/Mute)',
      normal: '✅ নরমাল',
    };
    return {
      replyText: [
        `📋 *অ্যাক্টিভ কন্টাক্ট ও মেম্বার রুলস (${active.length} জন):*`,
        ...active.map(
          (p, idx) => `${idx + 1}. *${p.name}* (+${p.phone || '?'}) — ${modeLabel[p.mode]}${p.note ? ` [${p.note}]` : ''}`
        ),
      ].join('\n'),
      actionSummary: `Listed ${active.length} Contact Policies (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 9. Message / Email Draft Generator ("আমার জন্য একটা মেসেজ/ইমেইল ড্রাফট করো ...")
  const isDraftRequest = /(?:ড্রাফট|draft|খসড়া|টেমপ্লেট\s*বানাও|মেসেজ\s*লিখে\s*দাও|ইমেইল\s*লিখে\s*দাও|কপি\s*লিখে\s*দাও)/iu.test(lower);
  if (isDraftRequest && !/(?:এই ড্রাফটটা|ড্রাফটটা\s*পাঠাও)/iu.test(lower)) {
    const channel: 'email' | 'whatsapp' = /(ইমেইল|মেইল|email|mail)/iu.test(lower) ? 'email' : 'whatsapp';
    const useAi = /(?:ai\s*দিয়ে|এআই\s*দিয়ে|স্মার্ট\s*ai|smart\s*draft)/iu.test(lower);
    const topicClean = rawText
      .replace(/(?:আমার জন্য|একটা|একটি|মেসেজ|ইমেইল|মেইল|ড্রাফট|বানাও|করে দাও|লিখে দাও|তৈরি করো|ai দিয়ে|এআই দিয়ে|draft|make|write)/giu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const drafted = await ctx.outreach.draftMessage({
      channel,
      topic: topicClean,
      useAi,
    });

    const previewLines = [
      `✍️ *${channel === 'email' ? 'ইমেইল' : 'হোয়াটসঅ্যাপ মেসেজ'} ড্রাফট প্রস্তুত (${drafted.tokensSpent} টোকেন):*`,
      drafted.subject ? `📌 *Subject:* ${drafted.subject}` : '',
      '',
      drafted.body,
      '',
      `💡 সরাসরি পাঠাতে এখন লিখুন:`,
      channel === 'email'
        ? `• *"এই ড্রাফটটা সব লিডকে ইমেইল করো"* অথবা *"এই ড্রাফটটা client@site.com কে মেইল করো"*`
        : `• *"এই ড্রাফটটা 017... কে পাঠাও"* অথবা *"এই ড্রাফটটা [গ্রুপের নাম] গ্রুপে পাঠাও"*`,
    ].filter((v) => v !== '');

    return {
      replyText: previewLines.join('\n'),
      actionSummary: `Generated ${channel.toUpperCase()} Draft (${drafted.tokensSpent} Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: {
        kind: 'ready_draft',
        targets: [],
        draftChannel: channel,
        draftSubject: drafted.subject,
        draftBody: drafted.body,
        expiresAt: Date.now() + 15 * 60_000,
      },
    };
  }

  // 10. Web Research, URL Extraction & Lead Vault Management
  const urlMatch = rawText.match(/https?:\/\/[^\s,]+/i);
  if (urlMatch && /(?:স্ক্যান|চেক|ইমেইল|নাম্বার|বের|লিড|ডাটা|scrape|extract|scan|visit)/iu.test(lower)) {
    const res = await ctx.outreach.scrapeUrls({ urlsText: urlMatch[0], topic: 'Self-Chat URL Scrape' });
    const allEmails = Array.from(new Set(res.leads.flatMap((l) => l.emails))).slice(0, 6);
    const allPhones = Array.from(new Set(res.leads.flatMap((l) => l.phones))).slice(0, 6);
    return {
      replyText: [
        `🌐 *ওয়েবসাইট স্ক্যান সম্পন্ন (০ টোকেন)*`,
        `🔗 সাইট: ${urlMatch[0]}`,
        `📧 ইমেইল (${res.research.emailsFound}): ${allEmails.length > 0 ? allEmails.join(', ') : 'পাওয়া যায়নি'}`,
        `📱 ফোন/WA (${res.research.phonesFound}): ${allPhones.length > 0 ? allPhones.join(', ') : 'পাওয়া যায়নি'}`,
        res.errors.length > 0 ? `⚠️ নোট: ${res.errors[0]}` : '',
        '',
        `এখন চাইলে লিখুন: *"সব লিডকে ইমেইল পাঠাও"* বা *"লিডগুলোর হোয়াটসঅ্যাপ চেক করো"*।`,
      ]
        .filter(Boolean)
        .join('\n'),
      actionSummary: `Self-Chat URL Scrape (${res.research.emailsFound} emails, ${res.research.phonesFound} phones, 0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  const isWebResearchCmd = /(?:ওয়েব\s*সার্চ|ওয়েব\s*রিসার্চ|রিসার্চ\s*করো|লিড\s*খুঁজ|লিড\s*সংগ্রহ|খুঁজে\s*বের\s*করো|web\s*search|research)/iu.test(lower);
  if (isWebResearchCmd) {
    const cleanQuery = rawText
      .replace(/(?:ওয়েব\s*সার্চ\s*করো|ওয়েব\s*রিসার্চ\s*করো|রিসার্চ\s*করো|লিড\s*খুঁজে\s*দাও|লিড\s*সংগ্রহ\s*করো|খুঁজে\s*বের\s*করো|web\s*search|research|থেকে ইমেইল ও নাম্বার বের করো)/giu, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!cleanQuery || cleanQuery.length < 2) {
      return {
        replyText: 'কী বিষয় বা কোন ইন্ডাস্ট্রি নিয়ে ওয়েব রিসার্চ করবো লিখুন বস (যেমন: *"ওয়েব সার্চ করো Dhaka IT company contact email phone"*)।',
        actionSummary: 'Requested Web Research Query (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
    const useAiSummary = /(?:ai\s*রিপোর্ট|ai\s*সহ|এআই\s*সহ)/iu.test(lower);
    const res = await ctx.outreach.runResearch({ query: cleanQuery, useAiSummary });
    const sampleLeads = res.leads
      .filter((l) => l.emails.length > 0 || l.phones.length > 0)
      .slice(0, 4)
      .map((l) => `• *${l.name.slice(0, 35)}*: ${[...l.emails.slice(0, 2), ...l.phones.slice(0, 2)].join(' | ')}`);
    return {
      replyText: [
        `🔎 *ওয়েব রিসার্চ ও লিড কালেকশন সম্পন্ন*`,
        res.research.summary,
        sampleLeads.length > 0 ? `\n📋 *সংগৃহীত স্যাম্পল লিড:*\n${sampleLeads.join('\n')}` : '',
        `\nসকল লিড ড্যাশবোর্ডের *Lead Vault*-এ সেভ হয়েছে!`,
      ]
        .filter(Boolean)
        .join('\n'),
      actionSummary: `Self-Chat Web Research (${res.research.emailsFound} emails, ${res.research.phonesFound} phones)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (/(?:লিড.*(?:ভেরিফাই|চেক|হোয়াটসঅ্যাপ)|verify\s*leads)/iu.test(lower)) {
    const vRes = await ctx.outreach.verifyWhatsappLeads();
    return {
      replyText: `✅ ০ টোকেনে *${vRes.checkedCount}টি* নম্বর যাচাই সম্পন্ন হয়েছে — এর মধ্যে *${vRes.activeFound}টি* নম্বরে সক্রিয় WhatsApp পাওয়া গেছে!`,
      actionSummary: `Verified Lead WhatsApp Numbers (${vRes.activeFound}/${vRes.checkedCount}, 0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (/(?:লিড\s*(?:লিস্ট|দেখাও|সংগ্রহ)|show\s*leads)/iu.test(lower)) {
    const summary = ctx.outreach.getSummary();
    if (summary.leads.length === 0) {
      return {
        replyText: 'এখনো কোনো লিড সংরক্ষিত নেই বস। লিখুন: *"ওয়েব সার্চ করো ..."* বা সরাসরি ওয়েবসাইট URL দিন।',
        actionSummary: 'Listed Leads (Empty, 0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }
    return {
      replyText: [
        `🗂️ *Lead Vault (${summary.totalLeads}টি লিড · ${summary.verifiedLeadsCount} WA ভেরিফাইড):*`,
        ...summary.leads.slice(0, 6).map(
          (l, i) =>
            `${i + 1}. *${l.name.slice(0, 30)}* — 📧 ${l.emails[0] || '—'} · 📱 ${l.whatsappVerifiedPhones[0] || l.phones[0] || '—'}`
        ),
      ].join('\n'),
      actionSummary: `Listed Top Leads (${summary.totalLeads} total, 0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (/(?:সব\s*লিড\s*(?:ডিলিট|ক্লিয়ার|মুছ)|clear\s*leads)/iu.test(lower)) {
    const cleared = ctx.outreach.clearLeads();
    return {
      replyText: `🗑️ Lead Vault থেকে *${cleared}টি* লিড মুছে ফেলা হয়েছে।`,
      actionSummary: `Cleared ${cleared} Leads (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // Send Email Campaign directly from Self-Chat ("সব লিডকে ইমেইল পাঠাও" / "client@site.com কে ইমেইল পাঠাও ...")
  const wantsEmailSend =
    /(?:সব\s*লিডকে|লিডগুলোকে|সংগ্রহ\s*করা).*(?:ইমেইল|মেইল)/iu.test(lower) ||
    (emailMatches.length > 0 && /(?:পাঠাও|পাঠিয়ে\s*দাও|মেইল\s*করো|ইমেইল\s*করো|send)/iu.test(lower));
  if (wantsEmailSend && !hasPasswordHint) {
    const customMsg = stripRoutingForOutgoingMessage(rawText, [], emailMatches)
      .replace(/(?:সব\s*লিডকে|লিডগুলোকে|সংগ্রহ\s*করা|ইমেইল\s*পাঠাও|মেইল\s*পাঠাও|মেইল\s*করো|ইমেইল\s*করো)/giu, '')
      .trim();
    const fallbackDraft = await ctx.outreach.draftMessage({ channel: 'email', useAi: false });
    const subject = ctx.pendingDraft?.draftSubject || fallbackDraft.subject;
    const body = customMsg.length >= 12 ? customMsg : ctx.pendingDraft?.draftBody || fallbackDraft.body;

    const sendRes = await ctx.outreach.sendEmailOutreach({
      subject,
      body,
      directEmails: emailMatches,
      useCollectedLeads: emailMatches.length === 0,
    });
    return {
      replyText: sendRes.error
        ? `⚠️ ${sendRes.error}`
        : `📧 *ইমেইল ডিসপ্যাচ সম্পন্ন (${sendRes.providerUsed}):*\n• পাঠানো হয়েছে: *${sendRes.sentCount}টি*\n• ব্যর্থ: *${sendRes.failedCount}টি*\n• AI টোকেন খরচ: *০*`,
      actionSummary: `Self-Chat Email Dispatch (${sendRes.sentCount} sent, 0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 11. Complete Dashboard Settings Control (Auto-Reply, Group AI, Brain, Tone, Media, Story, Daily Limit, Takeover)
  if (/টেকওভার\s*(?:ক্লিয়ার|রিসেট|মুছ|খুল|clear|reset)/i.test(lower)) {
    const cleared = ctx.clearTakeovers();
    return {
      replyText: `✅ সব Manual Takeover Pause ক্লিয়ার করা হয়েছে (${cleared}টি চ্যাট আনলক)।`,
      actionSummary: `Cleared ${cleared} Takeover Pauses (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/অটোরিপ্লাই\s*(?:অন|চালু|start|enable|on)/i.test(lower)) {
    await ctx.updateSystemSettings({ autoreply: true });
    return {
      replyText: '✅ *Private Auto-Reply* এখন ON করা হয়েছে বস!',
      actionSummary: 'Enabled Auto-Reply via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/অটোরিপ্লাই\s*(?:অফ|বন্ধ|stop|disable|off)/i.test(lower)) {
    await ctx.updateSystemSettings({ autoreply: false });
    return {
      replyText: '🛑 *Private Auto-Reply* OFF করা হয়েছে বস!',
      actionSummary: 'Disabled Auto-Reply via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/(?:গ্রুপ\s*এআই|group\s*ai)\s*(?:অন|চালু|on|enable)/i.test(lower)) {
    await ctx.updateSystemSettings({ groupAiEnabled: true });
    return {
      replyText: '✅ *Group AI Clone* গ্লোবালি ON করা হয়েছে বস!',
      actionSummary: 'Enabled Group AI via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/(?:গ্রুপ\s*এআই|group\s*ai)\s*(?:অফ|বন্ধ|off|disable)/i.test(lower)) {
    await ctx.updateSystemSettings({ groupAiEnabled: false });
    return {
      replyText: '🛑 *Group AI Clone* গ্লোবালি OFF করা হয়েছে বস!',
      actionSummary: 'Disabled Group AI via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/(?:এআই\s*ব্রেইন|এআই\s*অ্যাসিস্ট্যান্ট|ai\s*brain|gemini\s*ai)\s*(?:অন|চালু|on|enable)/iu.test(lower)) {
    await ctx.updateSystemSettings({ aiAssistantEnabled: true });
    return {
      replyText: '🧠 *AI Assistant Brain (Gemini/OpenRouter)* ON করা হয়েছে বস!',
      actionSummary: 'Enabled AI Brain via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/(?:এআই\s*ব্রেইন|এআই\s*অ্যাসিস্ট্যান্ট|ai\s*brain|gemini\s*ai)\s*(?:অফ|বন্ধ|off|disable)/iu.test(lower)) {
    await ctx.updateSystemSettings({ aiAssistantEnabled: false });
    return {
      replyText: '🛡️ *AI Assistant Brain* OFF করা হয়েছে — এখন পুরো বট ০-টোকেন অফলাইন মোডে চলবে!',
      actionSummary: 'Disabled AI Brain (0-Token Mode) via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/টোন.*(?:ফর্মাল|অফিসিয়াল|অফিশিয়াল|কর্পোরেট|প্রফেশনাল|formal|executive|corporate|professional)/iu.test(lower)) {
    await ctx.updateSystemSettings({ assistantTone: 'executive_formal' as AssistantTone });
    return {
      replyText: '👔 অ্যাসিস্ট্যান্ট টোন **Executive Formal** করা হয়েছে বস!',
      actionSummary: 'Set Assistant Tone to executive_formal (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/টোন.*(?:পোলাইট|ভদ্র|নরম|warm|polite)/iu.test(lower)) {
    await ctx.updateSystemSettings({ assistantTone: 'warm_polite' as AssistantTone });
    return {
      replyText: '🌸 অ্যাসিস্ট্যান্ট টোন **Warm Polite** করা হয়েছে বস!',
      actionSummary: 'Set Assistant Tone to warm_polite (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/টোন.*(?:ফ্লার্টি|দুষ্টু|উইটি|witty|flirty)/iu.test(lower)) {
    await ctx.updateSystemSettings({ assistantTone: 'witty_flirty' as AssistantTone });
    return {
      replyText: '😉 অ্যাসিস্ট্যান্ট টোন **Witty Flirty** করা হয়েছে বস!',
      actionSummary: 'Set Assistant Tone to witty_flirty (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/টোন.*(?:কড়া|শার্ট|সাটডাউন|sharp|shut)/iu.test(lower)) {
    await ctx.updateSystemSettings({ assistantTone: 'sharp_shut_down' as AssistantTone });
    return {
      replyText: '🔥 অ্যাসিস্ট্যান্ট টোন **Sharp Shut-Down** করা হয়েছে বস!',
      actionSummary: 'Set Assistant Tone to sharp_shut_down (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  const limitMatch = rawText.match(/(?:ডেইলি\s*লিমিট|রিপ্লাই\s*লিমিট|daily\s*limit)\s*[:\-]?\s*(\d{1,4})/iu);
  if (limitMatch) {
    const newLimit = Math.max(5, Math.min(2000, Number(limitMatch[1])));
    await ctx.updateSystemSettings({ dailyReplyLimit: newLimit });
    return {
      replyText: `✅ ডেইলি সেফটি রিপ্লাই লিমিট *${newLimit}* সেট করা হয়েছে!`,
      actionSummary: `Updated dailyReplyLimit to ${newLimit} (0 Tokens)`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/স্টোরি.*(?:সবার|সবাইকে|all)/i.test(lower)) {
    await ctx.updateSystemSettings({ storyWhitelistMode: 'all' });
    return {
      replyText: '✅ *Story Reader* সবার জন্য (All Contacts) চালু করা হয়েছে (০ টোকেন)।',
      actionSummary: 'Story Whitelist set to All Contacts (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }
  if (/স্টোরি.*(?:সিলেক্ট|নির্দিষ্ট|selected|whitelist)/i.test(lower)) {
    await ctx.updateSystemSettings({ storyWhitelistMode: 'selected_only' });
    return {
      replyText: '🎯 *Story Reader* শুধু Selected Whitelist কন্টাক্টের জন্য সেট করা হয়েছে।',
      actionSummary: 'Story Whitelist set to Selected Only (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 12. Contact Policy Rules ("দীর্ঘক্ষণ কথা বলো" / "আটকে রাখো" / "অফ করো / মিউট করো" / "নরমাল করো")
  const isLongEngageCmd = /(?:দীর্ঘক্ষণ|অনেকক্ষণ|বেশিক্ষণ|ব্যস্ত রাখ|এনগেজ রাখ|গল্প চালা|কথা চালিয়ে|long\s*engage|keep\s*talking)/iu.test(lower);
  const isClearPolicyCmd = /(?:নরমাল করো|ছেড়ে দাও|আনব্লক|রিজিউম|হোল্ড ছাড়|আটকে রাখা বন্ধ|পলিসি রিমুভ|remove\s*policy|resume|unhold|unblock|আবার অন করো|চালু করে দাও)/iu.test(lower);
  const isMuteCmd = /(?:রিপ্লাই বন্ধ|মিউট কর|ব্লক রাখ|কথা বলো না|চুপ থাক|অফ করে দাও|অফ করো|বন্ধ করে দাও|mute|block\s*ai|stop\s*reply)/iu.test(lower);
  const isHoldWaitCmd = /(?:আটকে রাখ|হোল্ডে রাখ|হোল্ড কর|অপেক্ষায় রাখ|থামিয়ে রাখ|hold\s*wait|stall|keep\s*waiting)/iu.test(lower);

  if (isLongEngageCmd || isClearPolicyCmd || isMuteCmd || isHoldWaitCmd) {
    const memberPool = matchedGroup?.members ? [...matchedGroup.members, ...ctx.directoryContacts] : ctx.directoryContacts;
    const { targets } = extractTargetsFromText(rawText, memberPool);
    if (targets.length === 0) {
      return {
        replyText:
          'কার নাম বা নাম্বারে এই রুল সেট করবো বুঝতে পারিনি বস—নাম্বার বা সেভড নাম লিখে দিন (যেমন: *"01711223344 নাম্বারটা অফ করে দাও"* বা *"আয়েশার সাথে দীর্ঘক্ষণ কথা বলো"*)।',
        actionSummary: 'Requested target for Contact Policy (0 Tokens)',
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const mode: ContactPolicyMode = isClearPolicyCmd
      ? 'normal'
      : isMuteCmd
        ? 'mute_ai'
        : isHoldWaitCmd
          ? 'hold_wait'
          : 'long_engage';
    const note = extractOptionalNote(rawText) || (matchedGroup ? `Group rule (${matchedGroup.name})` : undefined);

    await ctx.upsertContactPolicies(
      targets.map((t) => ({
        jid: t.jid,
        phone: t.phone,
        name: t.name,
        mode,
        note,
      }))
    );

    const namesLabel = targets.map((t) => `${t.name} (+${t.phone || '?'})`).join(', ');
    const actionDesc =
      mode === 'long_engage'
        ? `💬 *দীর্ঘক্ষণ কথা বলার (Long Engage)* মুড চালু হয়েছে — তারা নক করলে বট আন্তরিক ফলো-আপ প্রশ্ন করে দীর্ঘক্ষণ কথা চালিয়ে যাবে।`
        : mode === 'hold_wait'
          ? `⏳ *আটকে রাখার (Hold/Wait)* মুড চালু হয়েছে — তারা নক করলে বট ০ টোকেনে ভদ্রভাবে অপেক্ষায় রাখবে কোনো চূড়ান্ত কমিটমেন্ট না দিয়েই।`
          : mode === 'mute_ai'
            ? `🔇 *অফ / মিউট (No SMS & No AI Reply)* মুড চালু হয়েছে — ওই নাম্বারে ইনবক্স ও গ্রুপ এআই আর কোনো রিপ্লাই বা এসএমএস করবে না, বাকি সবারটা স্বাভাবিকভাবে চলবে!`
            : `✅ *স্বাভাবিক (Normal)* মোডে ফিরিয়ে আনা হয়েছে।`;

    return {
      replyText: `ডান বস! *${namesLabel}*-এর জন্য ${actionDesc}${note ? `\n📝 নোট: ${note}` : ''}`,
      actionSummary: `Updated Contact Policy (${mode}) for ${targets.length} target(s) [0 Tokens]`,
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 13. Group @Mention Dispatch OR Direct Multi-Number / Single DM Dispatch
  const looksLikeGroupMention = Boolean(matchedGroup) || /(?:গ্রুপে|মেনশন|ট্যাগ|@mention)/iu.test(lower);
  const looksLikeSendCommand =
    looksLikeGroupMention ||
    /(?:পাঠাও|পাঠিয়ে দাও|পাঠাইতে|নক কর|নক দাও|ইনবক্স|মেসেজ দাও|বলে দাও|জানিয়ে দাও|বলো যে|send\s*to|dm\s*to)/iu.test(lower);

  if (looksLikeSendCommand) {
    if (looksLikeGroupMention && matchedGroup) {
      const groupMembers = matchedGroup.members || [];
      const matchedMembers = groupMembers.filter(
        (m) =>
          (m.name && !isGenericLabel(m.name) && lower.includes(m.name.toLowerCase())) ||
          (m.phone && rawText.includes(m.phone.slice(-10)))
      );
      const { targets: extraPhoneTargets, matchedPhonesRaw } = extractTargetsFromText(rawText, ctx.directoryContacts);
      const finalMembers =
        matchedMembers.length > 0
          ? matchedMembers.map((m) => ({ jid: m.jid, phone: m.phone, name: m.name }))
          : extraPhoneTargets;

      const bodyText = stripRoutingForOutgoingMessage(
        rawText,
        matchedPhonesRaw,
        [matchedGroup.name, ...finalMembers.map((m) => m.name)]
      );
      const tags = finalMembers.map((m) => `@${(m.jid || m.phone).split('@')[0]}`);
      const finalMsg = tags.length > 0 ? `${tags.join(' ')} ${bodyText || 'একটু দেখুন তো।'}` : bodyText;

      if (!finalMsg.trim()) {
        return {
          replyText: `*${matchedGroup.name}* গ্রুপে ঠিক কী মেসেজ দেবো একটু লিখে দিন বস!`,
          actionSummary: 'Asked for group message body (0 Tokens)',
          tokensUsed: 0,
          nextPendingDraft: null,
        };
      }

      const res = await ctx.dispatchGroupMention({
        groupJid: matchedGroup.jid,
        groupName: matchedGroup.name,
        members: finalMembers,
        messageText: finalMsg,
        originalInstruction: rawText,
      });

      return {
        replyText: `✅ *${res.groupName}* গ্রুপে${res.mentionedCount > 0 ? ` (${res.mentionedCount} জনকে @মেনশন সহ)` : ''} মেসেজ ${res.deliveredLive ? 'পাঠানো হয়েছে' : 'ড্রাফট হয়েছে'}:\n"${finalMsg}"`,
        actionSummary: `Self-Chat Group @Mention (${res.groupName}, 0 Tokens)`,
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const { targets, matchedPhonesRaw } = extractTargetsFromText(rawText, ctx.directoryContacts);
    if (targets.length > 0) {
      let cleanedMsg = stripRoutingForOutgoingMessage(
        rawText,
        matchedPhonesRaw,
        targets.map((t) => t.name)
      );

      if (/^(?:এই মেসেজ(?:টা|টি)?|এটাই|ওটা|এইটা)$/iu.test(cleanedMsg)) {
        const lastBot = [...ctx.selfChatHistory].reverse().find((t) => t.role === 'assistant');
        const quotedDraft = lastBot?.text.match(/"([^"]{15,360})"/)?.[1];
        if (quotedDraft) {
          cleanedMsg = quotedDraft;
        }
      }

      if (!cleanedMsg || cleanedMsg.length < 2) {
        return {
          replyText: `বুঝেছি বস, *${targets.map((t) => t.name).join(', ')}*-এর ইনবক্সে পাঠাতে হবে। ঠিক কী মেসেজ পাঠাবো শুধু টেক্সটটা লিখে দিন!`,
          actionSummary: `Pending DM body for ${targets.length} target(s) [0 Tokens]`,
          tokensUsed: 0,
          nextPendingDraft: {
            kind: 'dm_knock',
            targets,
            expiresAt: Date.now() + 5 * 60_000,
          },
        };
      }

      const res = await ctx.dispatchDirectDm({
        targets,
        messageText: cleanedMsg,
        originalInstruction: safeDisplayText,
      });

      return {
        replyText: [
          `✅ *${res.targetLabels.join(', ')}*-এর ইনবক্সে মেসেজ ${res.deliveredCount > 0 ? `সফলভাবে পাঠানো হয়েছে (${res.deliveredCount} জন)` : `ড্রাফট তৈরি হয়েছে (${res.draftCount} জন)`}:`,
          `"${cleanedMsg}"`,
          `_(০ টোকেন · চ্যাট মেমোরি সেভড)_`,
        ].join('\n'),
        actionSummary: `Self-Chat DM Dispatch (${targets.length} target, 0 Tokens)`,
        tokensUsed: 0,
        nextPendingDraft: null,
      };
    }

    const sampleGroups = ctx.knownGroups.slice(0, 4).map((g) => `"${g.name}"`).join(', ');
    return {
      replyText: looksLikeGroupMention
        ? `গ্রুপে মেনশন পাঠাতে চাইলে স্পষ্ট গ্রুপের নাম ও মেম্বার উল্লেখ করুন বস${sampleGroups ? ` (যেমন: ${sampleGroups})` : ''}।`
        : 'কাকে পাঠাতে চান তার নাম্বার বা সেভড নাম স্পষ্টভাবে লিখুন বস (যেমন: *"01712345678 কে পাঠাও আজকে মিটিং হবে"*)।',
      actionSummary: 'Requested Target Clarification (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 14. 5-Minute Self-Healing Watchdog, Keep-Alive Ping & Mobile PWA Offload Status (0 Tokens)
  if (/(?:সেলফ\s*হিল|self[\s\-]*heal|র‍্যাম\s*ফ্রি|র‍্যাম\s*ক্লিয়ার|বট\s*হিল|বাগ\s*ফিক্স)/iu.test(lower) && ctx.runSelfHealNow) {
    const ev = await ctx.runSelfHealNow();
    return {
      replyText: [
        `🛠️ *৫-মিনিট সেলফ-হিলিং ওয়াচডগ সম্পন্ন (০ টোকেন)*`,
        `• RAM: *${ev.rssBeforeMb} MB → ${ev.rssAfterMb} MB* (512MB Cloud/HF Safe)`,
        `• WhatsApp স্ট্যাটাস: *${ev.botStatus}*`,
        `• নেওয়া পদক্ষেপ:\n${ev.actionsTaken.map((a) => `  - ${a}`).join('\n')}`,
      ].join('\n'),
      actionSummary: 'Triggered 5-Min Self-Heal Cycle via Self-Chat (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  if (
    /(?:সেলফ\s*পিং|keep[\s\-]*alive|মোবাইল\s*অফলোড|offload|ফায়ারবেস|firestore|ওয়াচডগ|watchdog|শিডিউল|schedule)/iu.test(lower) &&
    !/^(?:এজেন্ট|অটোনোমাস|agent)/iu.test(lower) &&
    ctx.getSystemDiagnostics
  ) {
    const diag = ctx.getSystemDiagnostics();
    const workersText =
      diag.mobileWorkers.length > 0
        ? diag.mobileWorkers
            .map((w) => `${w.deviceLabel} (${w.deviceMemoryGb ? `${w.deviceMemoryGb}GB RAM` : 'PWA'}, ${w.networkType}, Done: ${w.jobsCompleted})`)
            .join(', ')
        : 'কোনো ফোন অফলোড ওয়ার্কার এই মুহূর্তে অ্যাক্টিভ নেই (ফোন PWA-তে Mobile Offload চালু করুন)।';

    const fbMatchLabel =
      diag.firestore.projectMatch === true
        ? '✅ সার্ভিস অ্যাকাউন্ট প্রজেক্ট ম্যাচ করেছে'
        : diag.firestore.projectMatch === false
          ? `⚠️ সার্ভিস অ্যাকাউন্ট ভিন্ন প্রজেক্টের (${diag.firestore.serviceAccountProjectId} != ${diag.firestore.configuredProjectId})`
          : `ℹ️ মোড: ${diag.firestore.mode}`;

    return {
      replyText: [
        `📡 *24/7 আপটাইম, সেলফ-হিল, ফায়ারবেস ও মোবাইল অফলোড রিপোর্ট (০ টোকেন)*`,
        `• Self-Ping KeepAlive: *${diag.selfPing.enabled ? 'ON (প্রতি ৪ মিনিট)' : 'OFF'}* -> ${diag.selfPing.targetUrl}`,
        `  শেষ পিং: ${diag.selfPing.lastPingAt ? `${diag.selfPing.lastPingAt} (${diag.selfPing.lastPingOk ? 'OK' : 'Retry'})` : 'Warmup pending'}`,
        `• 5m Self-Healing Watchdog: *${diag.watchdog?.enabled ? 'ACTIVE' : 'OFF'}* | সাইকেল: ${diag.watchdog?.cycleCount || 0} | হিল: ${diag.watchdog?.totalHealsApplied || 0} | ক্র্যাশ গার্ড: ${diag.watchdog?.processErrorsIntercepted || 0}`,
        `• Firebase (${diag.firestore.configuredProjectId}): ${fbMatchLabel}`,
        `• শিডিউলড মিশন: *${diag.schedulesCount}টি*`,
        `• মোবাইল ব্রাউজার/PWA অফলোড: ${workersText}`,
      ].join('\n'),
      actionSummary: 'Displayed Uptime, Watchdog, Firestore & Offload Report (0 Tokens)',
      tokensUsed: 0,
      nextPendingDraft: null,
    };
  }

  // 15. Autonomous Multi-Step Action Agent ("Hands & Feet") — implicit multi-step hint catch-all
  const multiStepActionHint =
    (/(খুঁজে|রিসার্চ|সার্চ|স্ক্যান|পড়ে|ভেরিফাই|চেক করে)/iu.test(lower) &&
      /(পাঠাও|পাঠিয়ে দাও|মেইল করো|মেসেজ দাও|রিপোর্ট দাও|শিডিউল|জানাও)/iu.test(lower)) ||
    /(?:প্রতিদিন|প্রতি ঘন্টা|প্রতি ঘণ্টা|শিডিউল|schedule|follow[\s\-]*up|ফলোআপ)/iu.test(lower);

  if (ctx.runAutonomousMission && multiStepActionHint) {
    const cleanedGoal = rawText.trim();
    const agentRes = await ctx.runAutonomousMission(cleanedGoal);
    return {
      replyText: `${agentRes.finalReport}\n\n_(${agentRes.providerUsed.toUpperCase()} · ${agentRes.stepsCount} ধাপ · ${agentRes.tokensUsed} টোকেন)_`,
      actionSummary: `Autonomous Agent (${agentRes.providerUsed}, ${agentRes.stepsCount} steps, ${agentRes.tokensUsed} tok)`,
      tokensUsed: agentRes.tokensUsed,
      nextPendingDraft: null,
    };
  }

  // 16. Advisory, Discussion & General Executive Chat
  return buildAdvisorConsultationReply(ctx);
}
