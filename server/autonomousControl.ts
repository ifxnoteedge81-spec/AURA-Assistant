import type {
  AssistantConfigFields,
  AssistantTone,
  GroupAiMode,
} from './assistantEngine.ts';

export interface ControlItemStatus {
  key: string;
  labelBn: string;
  labelEn: string;
  category: 'core' | 'speed' | 'group' | 'media' | 'telegram';
  enabled: boolean;
  valueDisplay: string;
  latencyImpactSec: number;
  recommendedState: 'on' | 'off' | 'depends';
  recommendationNoteBn: string;
}

export interface FullControlSnapshot {
  totalOn: number;
  totalOff: number;
  estimatedInstantReplySec: string;
  optimizedReplySec: string;
  potentialSavedSec: number;
  items: ControlItemStatus[];
  onList: string[];
  offList: string[];
  speedTipsBn: string[];
}

export interface ControlPatchInput {
  autoreply?: boolean;
  aiAssistantEnabled?: boolean;
  autoreplyMessage?: string;
  firstGreetingTemplate?: string;
  ownerName?: string;
  ownerProfession?: string;
  ownerLocation?: string;
  ownerBio?: string;
  ownerBoundaries?: string;
  strictLogicRules?: string;
  assistantTone?: AssistantTone;
  dailyReplyLimit?: number;
  cooldownMs?: number;
  takeoverPauseMs?: number;
  humanTypingEnabled?: boolean;
  groupAiEnabled?: boolean;
  groupAiMode?: GroupAiMode;
  groupReactionEnabled?: boolean;
  groupCooldownMs?: number;
  mediaIntelligenceEnabled?: boolean;
  mediaZeroTokenReplyMode?: boolean;
  storyAutoReadEnabled?: boolean;
  storyAutoReactEnabled?: boolean;
  storyAutoReplyEnabled?: boolean;
  storyCooldownMs?: number;
  storyWhitelistMode?: 'all' | 'selected_only';
  selfChatCopilotEnabled?: boolean;
  selfChatZeroTokenOnly?: boolean;
  fastReplyMode?: boolean;
  telegramInlineInstantMode?: boolean;
  telegramAntilinkDefault?: boolean;
  allGroupsAntilink?: boolean;
  allGroupsAi?: boolean;
  preset?: 'max_speed' | 'balanced' | 'ultra_safe';
  confirmedOverride?: boolean;
}

const VALID_TONES: AssistantTone[] = [
  'witty_flirty',
  'warm_polite',
  'executive_formal',
  'sharp_shut_down',
];

const VALID_GROUP_MODES: GroupAiMode[] = ['smart_blend', 'mention_only', 'active_chat'];

export function getFullControlSnapshot(
  cfg: AssistantConfigFields & Record<string, unknown>,
  extras?: {
    telegramChatAntilink?: boolean;
    telegramBotConfigured?: boolean;
    geminiKeysCount?: number;
    openRouterKeysCount?: number;
  }
): FullControlSnapshot {
  const antilinkMap = (cfg.antilinkGroups || {}) as Record<string, boolean>;
  const antilinkOnCount = Object.values(antilinkMap).filter(Boolean).length;
  const groupAiMap = (cfg.groupAiGroups || {}) as Record<string, boolean>;
  const groupAiOnCount = Object.values(groupAiMap).filter(Boolean).length;

  const fastReplyMode = cfg.fastReplyMode !== false;
  const telegramInlineInstantMode = cfg.telegramInlineInstantMode !== false;
  const humanTypingEnabled = cfg.humanTypingEnabled !== false;
  const cooldownMs = Number(cfg.cooldownMs ?? 0);
  const groupCooldownMs = Number(cfg.groupCooldownMs ?? 6000);
  const takeoverPauseMs = Number(cfg.takeoverPauseMs ?? 1800000);
  const storyCooldownMs = Number(cfg.storyCooldownMs ?? 900000);

  const items: ControlItemStatus[] = [
    {
      key: 'aiAssistantEnabled',
      labelBn: 'AI অটো ব্রেইন (Gemini/OpenRouter)',
      labelEn: 'AI Assistant Brain',
      category: 'core',
      enabled: cfg.aiAssistantEnabled !== false,
      valueDisplay: cfg.aiAssistantEnabled !== false ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'স্মার্ট বাংলা/ইংরেজি রিপ্লাইয়ের জন্য ON রাখা উচিত।',
    },
    {
      key: 'autoreply',
      labelBn: 'প্রাইভেট ইনবক্স অটো-রিপ্লাই',
      labelEn: 'Auto-Reply',
      category: 'core',
      enabled: Boolean(cfg.autoreply),
      valueDisplay: cfg.autoreply ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'আপনি ব্যস্ত/অফলাইন থাকলে ইনবক্সে স্বয়ংক্রিয় উত্তর দেওয়ার জন্য ON রাখুন।',
    },
    {
      key: 'fastReplyMode',
      labelBn: 'ফাস্ট ইনস্ট্যান্ট রিপ্লাই মোড (Low Thinking)',
      labelEn: 'Fast Reply Mode',
      category: 'speed',
      enabled: fastReplyMode,
      valueDisplay: fastReplyMode ? 'ON (1-5s)' : 'OFF (Deep 10-25s)',
      latencyImpactSec: fastReplyMode ? 0 : 12,
      recommendedState: 'on',
      recommendationNoteBn: 'এটি ON রাখলে ইনস্ট্যান্ট রিপ্লাইয়ে ১০–১২ সেকেন্ড বাঁচে।',
    },
    {
      key: 'telegramInlineInstantMode',
      labelBn: 'টেলিগ্রাম ইনলাইন তাৎক্ষণিক উত্তর (No Queue Delay)',
      labelEn: 'Telegram Inline Instant Mode',
      category: 'telegram',
      enabled: telegramInlineInstantMode,
      valueDisplay: telegramInlineInstantMode ? 'ON (<10s inline)' : 'OFF (Background queue)',
      latencyImpactSec: telegramInlineInstantMode ? 0 : 15,
      recommendedState: 'on',
      recommendationNoteBn: 'সাধারণ চ্যাট ১০–১৫ মিনিটের বদলে ২–৬ সেকেন্ডে উত্তর দিতে এটি অবশ্যই ON রাখুন।',
    },
    {
      key: 'humanTypingEnabled',
      labelBn: 'হিউম্যান টাইপিং ডিলে (Typing Simulation)',
      labelEn: 'Human Typing Delay',
      category: 'speed',
      enabled: humanTypingEnabled,
      valueDisplay: humanTypingEnabled ? 'ON (+2-3s delay)' : 'OFF (0s instant)',
      latencyImpactSec: humanTypingEnabled ? 2.5 : 0,
      recommendedState: 'off',
      recommendationNoteBn: 'সুপার-ফাস্ট রেসপন্স চাইলে এটি OFF করলে প্রতি মেসেজে ২–৩ সেকেন্ড দ্রুত উত্তর যাবে।',
    },
    {
      key: 'cooldownMs',
      labelBn: 'প্রাইভেট চ্যাট কুলডাউন ডিলে',
      labelEn: 'DM Cooldown Delay',
      category: 'speed',
      enabled: cooldownMs > 0,
      valueDisplay: `${Math.round(cooldownMs / 1000)}s (${cooldownMs}ms)`,
      latencyImpactSec: Math.round(cooldownMs / 1000),
      recommendedState: 'off',
      recommendationNoteBn: '০ সেকেন্ড করলে কোনো অপেক্ষা ছাড়াই সাথে সাথে উত্তর যাবে।',
    },
    {
      key: 'groupAiEnabled',
      labelBn: 'গ্রুপ AI অটো-ক্লোন রিপ্লাই',
      labelEn: 'Group AI Reply',
      category: 'group',
      enabled: Boolean(cfg.groupAiEnabled),
      valueDisplay: `${cfg.groupAiEnabled ? 'ON' : 'OFF'} (${cfg.groupAiMode || 'smart_blend'}, ${groupAiOnCount} group)`,
      latencyImpactSec: 0,
      recommendedState: 'depends',
      recommendationNoteBn: 'গ্রুপে AI দিয়ে উত্তর দিতে চাইলে ON, নইলে OFF রাখুন।',
    },
    {
      key: 'groupReactionEnabled',
      labelBn: 'গ্রুপ অটো ইমোজি রিয়্যাকশন',
      labelEn: 'Group Emoji Reactions',
      category: 'group',
      enabled: cfg.groupReactionEnabled !== false,
      valueDisplay: cfg.groupReactionEnabled !== false ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'গ্রুপে হালকা রিয়্যাকশন দিতে চাইলে ON রাখুন; স্পিড বাড়াতে OFF করতে পারেন।',
    },
    {
      key: 'groupCooldownMs',
      labelBn: 'গ্রুপ রিপ্লাই কুলডাউন',
      labelEn: 'Group Cooldown',
      category: 'speed',
      enabled: groupCooldownMs > 3000,
      valueDisplay: `${Math.round(groupCooldownMs / 1000)}s`,
      latencyImpactSec: groupCooldownMs > 3000 ? Math.round((groupCooldownMs - 2000) / 1000) : 0,
      recommendedState: 'off',
      recommendationNoteBn: 'গ্রুপে দ্রুত উত্তর চাইলে এটি ২–৩ সেকেন্ডে নামিয়ে আনুন।',
    },
    {
      key: 'telegramAntilink',
      labelBn: 'টেলিগ্রাম গ্রুপ অ্যান্টি-লিংক প্রোটেকশন',
      labelEn: 'Telegram Anti-Link',
      category: 'telegram',
      enabled: Boolean(extras?.telegramChatAntilink ?? cfg.telegramAntilinkDefault),
      valueDisplay: extras?.telegramChatAntilink || cfg.telegramAntilinkDefault ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'গ্রুপে স্প্যাম লিংক ডিলিট করতে ON রাখা নিরাপদ।',
    },
    {
      key: 'whatsappAntilink',
      labelBn: 'হোয়াটসঅ্যাপ গ্রুপ অ্যান্টি-লিংক',
      labelEn: 'WhatsApp Anti-Link',
      category: 'group',
      enabled: antilinkOnCount > 0,
      valueDisplay: antilinkOnCount > 0 ? `ON (${antilinkOnCount} groups)` : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'হোয়াটসঅ্যাপ গ্রুপ সুরক্ষায় ON রাখতে পারেন।',
    },
    {
      key: 'mediaIntelligenceEnabled',
      labelBn: 'ছবি/অডিও/ভিডিও মিডিয়া রিডার',
      labelEn: 'Media Intelligence',
      category: 'media',
      enabled: cfg.mediaIntelligenceEnabled !== false,
      valueDisplay: cfg.mediaIntelligenceEnabled !== false ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: '০-টোকেনে ছবি/ভয়েস বুঝতে ON রাখুন।',
    },
    {
      key: 'mediaZeroTokenReplyMode',
      labelBn: 'মিডিয়া ০-টোকেন ইনস্ট্যান্ট মোড',
      labelEn: 'Media Zero-Token Fast Mode',
      category: 'speed',
      enabled: cfg.mediaZeroTokenReplyMode !== false,
      valueDisplay: cfg.mediaZeroTokenReplyMode !== false ? 'ON (Instant)' : 'OFF (Uses AI)',
      latencyImpactSec: cfg.mediaZeroTokenReplyMode !== false ? 0 : 3,
      recommendedState: 'on',
      recommendationNoteBn: 'ON থাকলে ছবি/স্টিকারের উত্তর ৩–৪ সেকেন্ড দ্রুত ও ০ টোকেনে যায়।',
    },
    {
      key: 'storyAutoReadEnabled',
      labelBn: 'হোয়াটসঅ্যাপ স্ট্যাটাস অটো-রিড',
      labelEn: 'Story Auto-Read',
      category: 'media',
      enabled: Boolean(cfg.storyAutoReadEnabled),
      valueDisplay: cfg.storyAutoReadEnabled ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'depends',
      recommendationNoteBn: 'দরকার না থাকলে OFF রাখলে ব্যাকগ্রাউন্ড লোড কমবে।',
    },
    {
      key: 'storyAutoReactEnabled',
      labelBn: 'স্ট্যাটাস অটো-রিয়্যাক্ট',
      labelEn: 'Story Auto-React',
      category: 'media',
      enabled: Boolean(cfg.storyAutoReactEnabled),
      valueDisplay: cfg.storyAutoReactEnabled ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'depends',
      recommendationNoteBn: 'প্রয়োজন না হলে OFF রাখা ভালো।',
    },
    {
      key: 'storyAutoReplyEnabled',
      labelBn: 'স্ট্যাটাস অটো-রিপ্লাই',
      labelEn: 'Story Auto-Reply',
      category: 'media',
      enabled: Boolean(cfg.storyAutoReplyEnabled),
      valueDisplay: cfg.storyAutoReplyEnabled ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'depends',
      recommendationNoteBn: 'দরকার না হলে OFF রাখলে অতিরিক্ত রিপ্লাই যাবে না।',
    },
    {
      key: 'selfChatCopilotEnabled',
      labelBn: 'সেলফ-চ্যাট কো-পাইলট',
      labelEn: 'Self-Chat Copilot',
      category: 'core',
      enabled: cfg.selfChatCopilotEnabled !== false,
      valueDisplay: cfg.selfChatCopilotEnabled !== false ? 'ON' : 'OFF',
      latencyImpactSec: 0,
      recommendedState: 'on',
      recommendationNoteBn: 'নিজের চ্যাটে কমান্ড চালাতে ON রাখুন।',
    },
    {
      key: 'selfChatZeroTokenOnly',
      labelBn: 'সেলফ-চ্যাট ০-টোকেন ফাস্ট মোড',
      labelEn: 'Self-Chat Zero-Token Mode',
      category: 'speed',
      enabled: Boolean(cfg.selfChatZeroTokenOnly),
      valueDisplay: cfg.selfChatZeroTokenOnly ? 'ON (Instant Local)' : 'OFF (Full AI)',
      latencyImpactSec: 0,
      recommendedState: 'depends',
      recommendationNoteBn: 'AI উত্তর চাইলে OFF আর ইনস্ট্যান্ট ০-টোকেন চাইলে ON রাখুন।',
    },
  ];

  const onList = items.filter((i) => i.enabled).map((i) => `${i.labelBn} (${i.valueDisplay})`);
  const offList = items.filter((i) => !i.enabled).map((i) => `${i.labelBn}`);

  const potentialSavedSec = Math.round(
    items.reduce((acc, item) => acc + item.latencyImpactSec, 0)
  );
  const currentLow = Math.max(2, 2 + potentialSavedSec);
  const currentHigh = Math.max(5, 5 + potentialSavedSec);
  const optimizedLow = 1;
  const optimizedHigh = 4;

  const speedTipsBn: string[] = [];
  if (!fastReplyMode) {
    speedTipsBn.push('`fastReplyMode` ON করুন — ইনস্ট্যান্ট রিপ্লাইয়ে ~১০–১২ সেকেন্ড কমবে।');
  }
  if (!telegramInlineInstantMode) {
    speedTipsBn.push('`telegramInlineInstantMode` ON করুন — সাধারণ চ্যাট ব্যাকগ্রাউন্ড কিউ ছাড়াই ২–৫ সেকেন্ডে উত্তর দেবে।');
  }
  if (humanTypingEnabled) {
    speedTipsBn.push('`humanTypingEnabled` OFF করলে প্রতি মেসেজে টাইপিং সিমুলেশনের ২–৩ সেকেন্ড বাঁচবে।');
  }
  if (cooldownMs > 0) {
    speedTipsBn.push(`DM \`cooldownMs\` (${Math.round(cooldownMs / 1000)}s) কমিয়ে 0 করলে আরও ${Math.round(cooldownMs / 1000)} সেকেন্ড দ্রুত হবে।`);
  }
  if (groupCooldownMs > 3000) {
    speedTipsBn.push(`গ্রুপ \`groupCooldownMs\` (${Math.round(groupCooldownMs / 1000)}s) কমিয়ে ২ সেকেন্ডে আনলে ~${Math.round((groupCooldownMs - 2000) / 1000)} সেকেন্ড বাঁচবে।`);
  }
  if (cfg.mediaZeroTokenReplyMode === false) {
    speedTipsBn.push('`mediaZeroTokenReplyMode` ON রাখলে মিডিয়া রিপ্লাইয়ে ৩ সেকেন্ড ও টোকেন দুটোই বাঁচবে।');
  }
  if (cfg.storyAutoReadEnabled || cfg.storyAutoReactEnabled || cfg.storyAutoReplyEnabled) {
    speedTipsBn.push('দরকার না থাকলে Story Auto-Read/React/Reply OFF রাখলে সার্ভার ও কিউ হালকা থাকবে।');
  }

  if (speedTipsBn.length === 0) {
    speedTipsBn.push('✅ আপনার সব স্পিড অপ্টিমাইজেশন এখনই সর্বোচ্চ দ্রুত মোডে (১–৪ সেকেন্ড) সেট করা আছে!');
  }

  // Extra metadata reference for callers
  void takeoverPauseMs;
  void storyCooldownMs;

  return {
    totalOn: onList.length,
    totalOff: offList.length,
    estimatedInstantReplySec: `${currentLow}–${currentHigh} সেকেন্ড`,
    optimizedReplySec: `${optimizedLow}–${optimizedHigh} সেকেন্ড`,
    potentialSavedSec,
    items,
    onList,
    offList,
    speedTipsBn,
  };
}

export function buildPatchFromInput(
  input: ControlPatchInput,
  currentConfig: AssistantConfigFields & Record<string, unknown>
): {
  patch: Partial<AssistantConfigFields> & Record<string, unknown>;
  telegramAntilinkToggle?: boolean;
  warnings: string[];
  changedLabels: string[];
} {
  const patch: Partial<AssistantConfigFields> & Record<string, unknown> = {};
  const warnings: string[] = [];
  const changedLabels: string[] = [];
  let telegramAntilinkToggle: boolean | undefined;

  if (input.preset === 'max_speed') {
    patch.fastReplyMode = true;
    patch.telegramInlineInstantMode = true;
    patch.humanTypingEnabled = false;
    patch.cooldownMs = 0;
    patch.groupCooldownMs = 1000;
    patch.mediaZeroTokenReplyMode = true;
    changedLabels.push('Max Speed Preset (Fast Reply ON, Inline ON, Human Typing OFF, Cooldown 0s)');
    warnings.push('Human Typing OFF ও Cooldown 0s করলে টেলিগ্রাম সুপার-ফাস্ট হবে, তবে WhatsApp-এ খুব দ্রুত একটানা রিপ্লাই গেলে স্প্যাম রিস্ক একটু বাড়তে পারে।');
  } else if (input.preset === 'balanced') {
    patch.fastReplyMode = true;
    patch.telegramInlineInstantMode = true;
    patch.humanTypingEnabled = true;
    patch.cooldownMs = 1500;
    patch.groupCooldownMs = 4000;
    changedLabels.push('Balanced Speed + Safety Preset');
  } else if (input.preset === 'ultra_safe') {
    patch.humanTypingEnabled = true;
    patch.cooldownMs = 3500;
    patch.groupCooldownMs = 10000;
    patch.dailyReplyLimit = 120;
    changedLabels.push('Ultra Safe Anti-Ban Preset');
  }

  if (typeof input.autoreply === 'boolean') {
    patch.autoreply = input.autoreply;
    changedLabels.push(`Auto-Reply -> ${input.autoreply ? 'ON' : 'OFF'}`);
  }
  if (typeof input.aiAssistantEnabled === 'boolean') {
    patch.aiAssistantEnabled = input.aiAssistantEnabled;
    changedLabels.push(`AI Brain -> ${input.aiAssistantEnabled ? 'ON' : 'OFF'}`);
    if (input.aiAssistantEnabled === false) {
      warnings.push('AI Brain OFF করলে নতুন মেসেজে স্মার্ট AI উত্তর বন্ধ হয়ে যাবে (শুধু ফিক্সড মেসেজ/কমান্ড কাজ করবে)।');
    }
  }
  if (typeof input.fastReplyMode === 'boolean') {
    patch.fastReplyMode = input.fastReplyMode;
    changedLabels.push(`Fast Reply Mode -> ${input.fastReplyMode ? 'ON' : 'OFF'}`);
    if (input.fastReplyMode === false) {
      warnings.push('Fast Reply Mode OFF করলে গভীর চিন্তা করার জন্য ইনস্ট্যান্ট রিপ্লাইয়ে ১০–২০ সেকেন্ড বেশি সময় লাগতে পারে।');
    }
  }
  if (typeof input.telegramInlineInstantMode === 'boolean') {
    patch.telegramInlineInstantMode = input.telegramInlineInstantMode;
    changedLabels.push(`Telegram Inline Instant -> ${input.telegramInlineInstantMode ? 'ON' : 'OFF'}`);
    if (input.telegramInlineInstantMode === false) {
      warnings.push('Telegram Inline Instant OFF করলে সাধারণ মেসেজও ব্যাকগ্রাউন্ড কিউ দিয়ে যাবে, ফলে উত্তর আসতে দেরি হতে পারে।');
    }
  }
  if (typeof input.humanTypingEnabled === 'boolean') {
    patch.humanTypingEnabled = input.humanTypingEnabled;
    changedLabels.push(`Human Typing Delay -> ${input.humanTypingEnabled ? 'ON' : 'OFF'}`);
    if (input.humanTypingEnabled === false) {
      warnings.push('Human Typing Delay OFF করলে উত্তর আরও ২–৩ সেকেন্ড দ্রুত যাবে, তবে WhatsApp-এ রোবোটিক মনে হওয়ার ঝুঁকি একটু বাড়তে পারে।');
    }
  }
  if (typeof input.cooldownMs === 'number' && Number.isFinite(input.cooldownMs)) {
    const val = Math.max(0, Math.min(300_000, Math.round(input.cooldownMs)));
    patch.cooldownMs = val;
    changedLabels.push(`DM Cooldown -> ${Math.round(val / 1000)}s`);
    if (val === 0) {
      warnings.push('DM Cooldown 0s করলে একটানা অনেক মেসেজ এলে WhatsApp-এ রেট-লিমিটের ঝুঁকি একটু বাড়তে পারে (টেলিগ্রামে কোনো সমস্যা নেই)।');
    }
  }
  if (typeof input.takeoverPauseMs === 'number' && Number.isFinite(input.takeoverPauseMs)) {
    const val = Math.max(0, Math.min(86_400_000, Math.round(input.takeoverPauseMs)));
    patch.takeoverPauseMs = val;
    changedLabels.push(`Takeover Pause -> ${Math.round(val / 60000)} min`);
  }
  if (typeof input.dailyReplyLimit === 'number' && Number.isFinite(input.dailyReplyLimit)) {
    const val = Math.max(1, Math.min(5000, Math.round(input.dailyReplyLimit)));
    patch.dailyReplyLimit = val;
    changedLabels.push(`Daily Reply Limit -> ${val}`);
    if (val > 500) {
      warnings.push(`Daily Limit ${val} করা হলে অতিরিক্ত অটো-রিপ্লাইয়ের কারণে WhatsApp নম্বরে রেস্ট্রিকশন আসার ঝুঁকি থাকতে পারে।`);
    }
  }
  if (input.assistantTone && VALID_TONES.includes(input.assistantTone)) {
    patch.assistantTone = input.assistantTone;
    changedLabels.push(`Assistant Tone -> ${input.assistantTone}`);
  }
  if (typeof input.groupAiEnabled === 'boolean') {
    patch.groupAiEnabled = input.groupAiEnabled;
    changedLabels.push(`Group AI -> ${input.groupAiEnabled ? 'ON' : 'OFF'}`);
  }
  if (input.groupAiMode && VALID_GROUP_MODES.includes(input.groupAiMode)) {
    patch.groupAiMode = input.groupAiMode;
    changedLabels.push(`Group AI Mode -> ${input.groupAiMode}`);
  }
  if (typeof input.groupReactionEnabled === 'boolean') {
    patch.groupReactionEnabled = input.groupReactionEnabled;
    changedLabels.push(`Group Reactions -> ${input.groupReactionEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.groupCooldownMs === 'number' && Number.isFinite(input.groupCooldownMs)) {
    const val = Math.max(0, Math.min(3_600_000, Math.round(input.groupCooldownMs)));
    patch.groupCooldownMs = val;
    changedLabels.push(`Group Cooldown -> ${Math.round(val / 1000)}s`);
  }
  if (typeof input.mediaIntelligenceEnabled === 'boolean') {
    patch.mediaIntelligenceEnabled = input.mediaIntelligenceEnabled;
    changedLabels.push(`Media Reader -> ${input.mediaIntelligenceEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.mediaZeroTokenReplyMode === 'boolean') {
    patch.mediaZeroTokenReplyMode = input.mediaZeroTokenReplyMode;
    changedLabels.push(`Media Zero-Token Mode -> ${input.mediaZeroTokenReplyMode ? 'ON' : 'OFF'}`);
  }
  if (typeof input.storyAutoReadEnabled === 'boolean') {
    patch.storyAutoReadEnabled = input.storyAutoReadEnabled;
    changedLabels.push(`Story Auto-Read -> ${input.storyAutoReadEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.storyAutoReactEnabled === 'boolean') {
    patch.storyAutoReactEnabled = input.storyAutoReactEnabled;
    changedLabels.push(`Story Auto-React -> ${input.storyAutoReactEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.storyAutoReplyEnabled === 'boolean') {
    patch.storyAutoReplyEnabled = input.storyAutoReplyEnabled;
    changedLabels.push(`Story Auto-Reply -> ${input.storyAutoReplyEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.storyCooldownMs === 'number' && Number.isFinite(input.storyCooldownMs)) {
    patch.storyCooldownMs = Math.max(0, Math.min(86_400_000, Math.round(input.storyCooldownMs)));
    changedLabels.push(`Story Cooldown -> ${Math.round(Number(patch.storyCooldownMs) / 60000)}m`);
  }
  if (input.storyWhitelistMode === 'all' || input.storyWhitelistMode === 'selected_only') {
    patch.storyWhitelistMode = input.storyWhitelistMode;
    changedLabels.push(`Story Whitelist -> ${input.storyWhitelistMode}`);
  }
  if (typeof input.selfChatCopilotEnabled === 'boolean') {
    patch.selfChatCopilotEnabled = input.selfChatCopilotEnabled;
    changedLabels.push(`Self-Chat Copilot -> ${input.selfChatCopilotEnabled ? 'ON' : 'OFF'}`);
  }
  if (typeof input.selfChatZeroTokenOnly === 'boolean') {
    patch.selfChatZeroTokenOnly = input.selfChatZeroTokenOnly;
    changedLabels.push(`Self-Chat 0-Token Only -> ${input.selfChatZeroTokenOnly ? 'ON' : 'OFF'}`);
  }
  if (typeof input.telegramAntilinkDefault === 'boolean') {
    patch.telegramAntilinkDefault = input.telegramAntilinkDefault;
    telegramAntilinkToggle = input.telegramAntilinkDefault;
    changedLabels.push(`Telegram Anti-Link -> ${input.telegramAntilinkDefault ? 'ON' : 'OFF'}`);
    if (input.telegramAntilinkDefault === false) {
      warnings.push('Anti-Link OFF করলে গ্রুপের সদস্যরা যেকোনো বাহিরের বা স্প্যাম লিংক পাঠাতে পারবে।');
    }
  }
  if (typeof input.allGroupsAntilink === 'boolean') {
    const existing = (currentConfig.antilinkGroups || {}) as Record<string, boolean>;
    const updated: Record<string, boolean> = {};
    for (const k of Object.keys(existing)) updated[k] = input.allGroupsAntilink;
    patch.antilinkGroups = updated;
    telegramAntilinkToggle = input.allGroupsAntilink;
    changedLabels.push(`All Groups Anti-Link -> ${input.allGroupsAntilink ? 'ON' : 'OFF'}`);
    if (input.allGroupsAntilink === false) {
      warnings.push('সব গ্রুপের Anti-Link OFF করলে অবাঞ্ছিত প্রমোশনাল/স্ক্যাম লিংক ডিলিট হবে না।');
    }
  }
  if (typeof input.allGroupsAi === 'boolean') {
    const existing = (currentConfig.groupAiGroups || {}) as Record<string, boolean>;
    const updated: Record<string, boolean> = {};
    for (const k of Object.keys(existing)) updated[k] = input.allGroupsAi;
    patch.groupAiGroups = updated;
    patch.groupAiEnabled = input.allGroupsAi;
    changedLabels.push(`All Groups AI -> ${input.allGroupsAi ? 'ON' : 'OFF'}`);
  }

  for (const textKey of [
    'autoreplyMessage',
    'firstGreetingTemplate',
    'ownerName',
    'ownerProfession',
    'ownerLocation',
    'ownerBio',
    'ownerBoundaries',
    'strictLogicRules',
  ] as const) {
    if (typeof input[textKey] === 'string' && input[textKey]!.trim()) {
      patch[textKey] = input[textKey]!.trim().slice(0, 4000);
      changedLabels.push(`${textKey} updated`);
    }
  }

  return { patch, telegramAntilinkToggle, warnings, changedLabels };
}
