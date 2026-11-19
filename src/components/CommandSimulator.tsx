import { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Send, Trash2 } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { BotConfig, KnownGroupItem } from '../types';

type ChatContext = 'private' | 'group_bot_admin' | 'group_bot_non_admin' | 'self' | 'story';

interface SimulatedMediaPayload {
  kind: 'photo' | 'video' | 'gif' | 'sticker' | 'story_photo' | 'story_video' | 'story_text' | 'reaction';
  caption?: string;
  visualPreset?: 'portrait_stunning' | 'scenery_beautiful' | 'dark_bad' | 'funny_meme' | 'logical_screenshot';
  stickerEmojis?: string[];
  stickerPackName?: string;
  reactionEmoji?: string;
  durationSec?: number;
  imageBase64?: string;
}

interface MediaInsightSummary {
  kind: string;
  isStory: boolean;
  sentiment: string;
  recommendedReaction: string;
  banglaSceneLabel: string;
  compactContextLine: string;
  tokensUsedForRead: 0;
}

interface SimulatedMsg {
  id: string;
  sender: 'user' | 'bot' | 'system';
  text: string;
  reaction?: string;
  deleted?: boolean;
  rule?: string;
  mediaBadge?: string;
  timestamp: string;
}

interface CommandSimulatorProps {
  config: BotConfig;
  onConfigUpdated: () => Promise<void>;
}

const CONTEXT_OPTIONS: { id: ChatContext; label: string }[] = [
  { id: 'private', label: 'প্রাইভেট ইনবক্স (DM)' },
  { id: 'group_bot_admin', label: 'গ্রুপ চ্যাট (বট অ্যাডমিন)' },
  { id: 'group_bot_non_admin', label: 'গ্রুপ চ্যাট (বট সাধারণ সদস্য)' },
  { id: 'story', label: 'হোয়াটসঅ্যাপ স্টোরি (Status)' },
  { id: 'self', label: 'নিজের নম্বরে মেসেজ' },
];

const QUICK_MEDIA_TESTS: Array<{ label: string; context?: ChatContext; media: SimulatedMediaPayload; text?: string }> = [
  {
    label: '📸 কারো সুন্দর পোর্ট্রেট ছবি (প্রশংসা)',
    context: 'story',
    media: { kind: 'story_photo', visualPreset: 'portrait_stunning', caption: '' },
  },
  {
    label: '🌅 প্রকৃতির সুন্দর স্টোরি ফটো (ভালো)',
    context: 'story',
    media: { kind: 'story_photo', visualPreset: 'scenery_beautiful', caption: 'সকালের আকাশটা আজ দারুণ ✨' },
  },
  {
    label: '🌑 অন্ধকার ও ঝাপসা ভিডিও (খারাপ/সমালোচনা)',
    media: { kind: 'video', visualPreset: 'dark_bad', durationSec: 9, caption: '' },
  },
  {
    label: '😂 মজার হাসির স্টিকার (স্টিকার রিড)',
    media: { kind: 'sticker', stickerEmojis: ['😂', '🤣'], stickerPackName: 'Bangla Funny Pack' },
  },
  {
    label: '🧠 যুক্তির স্ক্রিনশট/তর্ক (লজিক)',
    media: {
      kind: 'photo',
      visualPreset: 'logical_screenshot',
      caption: 'এই স্ক্রিনশট দেখো, প্রমাণ ছাড়া কথা বললে কি চলে?',
    },
  },
  {
    label: '❤️ মেসেজে লাভ রিয়্যাকশন',
    media: { kind: 'reaction', reactionEmoji: '❤️' },
  },
];

const QUICK_COMMANDS = [
  '.autoreply on',
  '.groupai on',
  'ভাই তুই নাকি সারাদিন ঘুমাছ? 😂',
  'আসসালামু আলাইকুম, স্যার কি আছেন?',
  'গুড নাইট, আমার এখনো সকাল হয় নাই!',
  'আমার একটা ফ্ল্যাট বা রুম ম্যানেজ করে দিতে পারবা?',
  'কেনে আছো ভাই? কিতা খবর?',
  '.ai একটি হোয়াটসঅ্যাপ গ্রুপ নিরাপদ রাখার ৩টি উপায় বলো',
  '.antilink delete on',
  'আমাদের চ্যানেলে জয়েন করুন https://t.me/example_channel',
];

export function CommandSimulator({ config, onConfigUpdated }: CommandSimulatorProps) {
  const [chatType, setChatType] = useState<ChatContext>('private');
  const [senderIsAdmin, setSenderIsAdmin] = useState(false);
  const [knownGroups, setKnownGroups] = useState<KnownGroupItem[]>([]);
  const [selectedGroupJid, setSelectedGroupJid] = useState<string>('');
  const [senderNameInput, setSenderNameInput] = useState<string>('Normal Member');
  const [senderJidInput, setSenderJidInput] = useState<string>('8801700000000@s.whatsapp.net');
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [messages, setMessages] = useState<SimulatedMsg[]>([
    {
      id: 'init-1',
      sender: 'system',
      text: 'সিমুলেটর সার্ভার-সাইড জিরো-টোকেন মিডিয়া রিডার, স্টোরি কমেন্ট ও AI ব্রেইনের সাথে যুক্ত। টেক্সট কমান্ড অথবা নিচের ছবি/স্টিকার/ভিডিও/স্টোরি বাটন কিংবা আসল ছবি আপলোড করে ০ টোকেন টেস্ট করুন!',
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);

  useEffect(() => {
    let active = true;
    authFetch('/api/groups')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && Array.isArray(data?.groups)) {
          setKnownGroups(data.groups);
        }
      })
      .catch(() => {
        // ignore group fetch errors during simulation
      });
    return () => {
      active = false;
    };
  }, [config.groupAiGroups, config.antilinkGroups, config.groupDirectives]);

  const selectableGroups = useMemo(() => {
    const byJid = new Map<string, KnownGroupItem>();
    for (const grp of knownGroups) {
      byJid.set(grp.jid, grp);
    }
    const configJids = new Set([
      ...Object.keys(config.groupAiGroups || {}),
      ...Object.keys(config.antilinkGroups || {}),
      ...Object.keys(config.groupDirectives || {}),
    ]);
    for (const jid of configJids) {
      if (!byJid.has(jid)) {
        byJid.set(jid, {
          jid,
          name: jid,
          participantCount: 0,
          antilinkEnabled: Boolean(config.antilinkGroups?.[jid]),
          groupAiEnabled: Boolean(config.groupAiGroups?.[jid]),
        });
      }
    }
    if (byJid.size === 0) {
      byJid.set('120363041928374655@g.us', {
        jid: '120363041928374655@g.us',
        name: 'Demo Simulation Group',
        participantCount: 0,
        antilinkEnabled: Boolean(config.antilinkGroups?.['120363041928374655@g.us']),
        groupAiEnabled: Boolean(config.groupAiGroups?.['120363041928374655@g.us']),
      });
    }
    return Array.from(byJid.values());
  }, [knownGroups, config.groupAiGroups, config.antilinkGroups, config.groupDirectives]);

  const activeGroupJid = useMemo(() => {
    if (selectedGroupJid && selectableGroups.some((g) => g.jid === selectedGroupJid)) {
      return selectedGroupJid;
    }
    const aiEnabledGroup = selectableGroups.find((g) => config.groupAiGroups?.[g.jid]);
    return aiEnabledGroup?.jid || selectableGroups[0]?.jid || '120363041928374655@g.us';
  }, [selectedGroupJid, selectableGroups, config.groupAiGroups]);

  const activeGroupDirective = config.groupDirectives?.[activeGroupJid];
  const activeGroupObj = selectableGroups.find((g) => g.jid === activeGroupJid);

  async function sendSimulatedMessage(
    rawText: string,
    mediaOverride?: SimulatedMediaPayload,
    chatTypeOverride?: ChatContext,
    displayLabel?: string
  ) {
    const text = rawText.trim();
    const effectiveChatType = chatTypeOverride || chatType;
    if ((!text && !mediaOverride && effectiveChatType !== 'story') || isSending) return;

    const userMsgId = `u-${Date.now()}`;
    const now = new Date().toLocaleTimeString();
    const shownUserText = displayLabel || text || `[Media: ${mediaOverride?.kind}]`;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, sender: 'user', text: shownUserText, timestamp: now },
    ]);
    if (!mediaOverride) setInput('');
    setIsSending(true);

    try {
      const cleanSenderName = senderNameInput.trim() || 'Simulator Contact';
      const cleanSenderJid = senderJidInput.trim() || '8801700000000@s.whatsapp.net';
      const res = await authFetch('/api/simulator/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          chatType: effectiveChatType,
          senderIsGroupAdmin: senderIsAdmin,
          groupJid: activeGroupJid,
          contactName: cleanSenderName,
          contactJid: cleanSenderJid,
          senderJid: cleanSenderJid,
          ...(mediaOverride ? { media: mediaOverride } : {}),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            sender: 'system',
            text: data.error || 'Request failed.',
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
        return;
      }

      if (data.deleted) {
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, deleted: true } : m))
        );
      }

      if (data.reactionEmoji) {
        setMessages((prev) =>
          prev.map((m) => (m.id === userMsgId ? { ...m, reaction: data.reactionEmoji } : m))
        );
      }

      const insight = data.mediaInsight as MediaInsightSummary | undefined;
      const mediaBadge = insight
        ? `0 Tokens Read · ${insight.banglaSceneLabel} (${insight.sentiment})`
        : undefined;

      if (data.reply) {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            sender: 'bot',
            text: data.reply,
            rule: data.ruleTriggered,
            mediaBadge,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
      } else if (data.note) {
        setMessages((prev) => [
          ...prev,
          {
            id: `s-${Date.now()}`,
            sender: 'system',
            text: data.note,
            rule: data.ruleTriggered,
            mediaBadge,
            timestamp: new Date().toLocaleTimeString(),
          },
        ]);
      }

      await onConfigUpdated();
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          sender: 'system',
          text: (err as Error).message,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  function handleImageUploadTest(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 4.5 * 1024 * 1024) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          sender: 'system',
          text: 'ছবির সাইজ ৪.৫ এমবি-র নিচে হতে হবে।',
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      const isStoryMode = chatType === 'story';
      void sendSimulatedMessage(
        input,
        {
          kind: isStoryMode ? 'story_photo' : 'photo',
          caption: input.trim(),
          imageBase64: dataUrl,
        },
        chatType,
        `📷 Uploaded ${file.name}${input.trim() ? `: ${input.trim()}` : ''}`
      );
      setInput('');
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      {/* Left: Chat Context & Quick Test Prompts */}
      <div className="lg:col-span-4 space-y-6">
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Chat Environment</h2>
            <p className="mt-1 text-xs text-slate-600">
              Switch contexts to verify DM replies, Group AI, WhatsApp Stories, and 0-token Media recognition.
            </p>
          </div>

          <div className="space-y-1.5">
            {CONTEXT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setChatType(opt.id)}
                className={`w-full text-left px-3.5 py-2.5 text-sm font-medium rounded-lg border transition-colors cursor-pointer ${
                  chatType === opt.id
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {(chatType === 'group_bot_admin' || chatType === 'group_bot_non_admin') && (
            <div className="pt-3 border-t border-slate-200 space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Target Group
                </label>
                <select
                  value={activeGroupJid}
                  onChange={(e) => setSelectedGroupJid(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                >
                  {selectableGroups.map((g) => (
                    <option key={g.jid} value={g.jid}>
                      {g.name !== g.jid ? g.name : g.jid}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Simulated Sender (Test Targeted vs Normal Member)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={senderNameInput}
                    onChange={(e) => setSenderNameInput(e.target.value)}
                    placeholder="Sender name"
                    className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                  <input
                    type="text"
                    value={senderJidInput}
                    onChange={(e) => setSenderJidInput(e.target.value)}
                    placeholder="Phone or JID"
                    className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-900"
                  />
                </div>
                {(activeGroupDirective?.targets?.length || activeGroupObj?.members?.length) ? (
                  <select
                    value=""
                    onChange={(e) => {
                      const val = e.target.value;
                      if (!val) return;
                      if (val === '__normal__') {
                        setSenderNameInput('Normal Member');
                        setSenderJidInput('8801799999999@s.whatsapp.net');
                        return;
                      }
                      try {
                        const parsed = JSON.parse(val) as { name: string; jid: string };
                        setSenderNameInput(parsed.name);
                        setSenderJidInput(parsed.jid);
                      } catch {
                        // ignore
                      }
                    }}
                    className="mt-1.5 w-full px-2.5 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg text-slate-700"
                  >
                    <option value="">Quick pick a member preset...</option>
                    <option value="__normal__">Normal Un-targeted Member (8801799999999)</option>
                    {(activeGroupDirective?.targets || []).map((t) => (
                      <option
                        key={`t-${t.id}`}
                        value={JSON.stringify({
                          name: t.targetName,
                          jid: t.targetJid || (t.targetPhone ? `${t.targetPhone}@s.whatsapp.net` : t.targetName),
                        })}
                      >
                        [Target] @{t.targetName} ({t.targetPhone || t.targetJid || 'Name match'})
                      </option>
                    ))}
                    {(activeGroupObj?.members || []).slice(0, 30).map((m) => (
                      <option
                        key={`m-${m.jid}`}
                        value={JSON.stringify({ name: m.name, jid: m.jid })}
                      >
                        Member: {m.name} {m.phone ? `(+${m.phone})` : '(LID)'}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              <label className="flex items-center gap-2.5 pt-1 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={senderIsAdmin}
                  onChange={(e) => setSenderIsAdmin(e.target.checked)}
                  className="w-4 h-4 accent-emerald-600 rounded"
                />
                Simulate sender as Group Admin
              </label>
            </div>
          )}

          <div className="pt-3 border-t border-slate-200 text-xs text-slate-600 space-y-1">
            <div className="flex justify-between">
              <span>Zero-Token Media Reader</span>
              <span className="font-mono font-medium text-emerald-700">
                {config.mediaIntelligenceEnabled !== false ? 'ON (0 Tok Read)' : 'OFF'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Auto-Reply Mode</span>
              <span className="font-mono font-medium text-slate-900">
                {config.autoreply ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Group AI Clone</span>
              <span className="font-mono font-medium text-slate-900">
                {config.groupAiEnabled && config.groupAiGroups?.[activeGroupJid]
                  ? `ON (${config.groupAiMode || 'smart_blend'})`
                  : 'OFF'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Group Anti-Link</span>
              <span className="font-mono font-medium text-slate-900">
                {config.antilinkGroups[activeGroupJid] ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900">Zero-Token Media &amp; Story Tests</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">
            ০ টোকেনে ছবি, ভিডিও, স্টিকার ও স্টোরি পড়ে শুধু টেক্সট SMS-এ রিপ্লাই দিবে:
          </p>
          <div className="mt-3 space-y-1.5">
            {QUICK_MEDIA_TESTS.map((sample) => (
              <button
                key={sample.label}
                type="button"
                disabled={isSending}
                onClick={() =>
                  void sendSimulatedMessage(
                    sample.media.caption || sample.text || '',
                    sample.media,
                    sample.context || chatType,
                    sample.label
                  )
                }
                className="w-full text-left px-3 py-2 text-xs font-medium text-slate-800 bg-emerald-50/70 hover:bg-emerald-100/70 border border-emerald-200 rounded-lg transition-colors truncate cursor-pointer"
              >
                {sample.label}
              </button>
            ))}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900">Sample Text Commands</h3>
          <div className="mt-3 space-y-2">
            {QUICK_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                type="button"
                disabled={isSending}
                onClick={() => void sendSimulatedMessage(cmd)}
                className="w-full text-left px-3 py-2 text-xs font-mono text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors truncate cursor-pointer"
                title={cmd}
              >
                {cmd}
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Right: Interactive WhatsApp Message Viewport */}
      <section className="lg:col-span-8 bg-white border border-slate-200 rounded-xl flex flex-col min-h-[560px] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4 bg-white">
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {CONTEXT_OPTIONS.find((c) => c.id === chatType)?.label}
            </div>
            <div className="text-xs text-slate-500 font-mono truncate max-w-md">
              {chatType.startsWith('group')
                ? `${activeGroupObj?.name || activeGroupJid} · Sender: ${senderNameInput}`
                : chatType === 'story'
                  ? `status@broadcast · Poster: ${senderNameInput}`
                  : '8801700000000@s.whatsapp.net'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMessages([])}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear Chat
          </button>
        </div>

        <div className="flex-1 p-5 space-y-3 overflow-y-auto bg-slate-50">
          {messages.length === 0 && (
            <div className="h-full flex items-center justify-center text-sm text-slate-500">
              বটের কমান্ড, স্টোরি কমেন্ট ও ছবি/ভিডিও/স্টিকার টেস্ট করতে নিচে মেসেজ বা ছবি পাঠান।
            </div>
          )}

          {messages.map((m) => {
            if (m.sender === 'system') {
              return (
                <div key={m.id} className="flex justify-center">
                  <div className="max-w-lg px-3.5 py-2 text-xs text-slate-600 bg-white border border-slate-200 rounded-lg text-center">
                    {m.text}
                  </div>
                </div>
              );
            }

            const isUser = m.sender === 'user';
            return (
              <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-xl px-4 py-2.5 rounded-xl border text-sm whitespace-pre-wrap ${
                    isUser
                      ? m.deleted
                        ? 'bg-red-50 border-red-200 text-red-700'
                        : 'bg-emerald-600 border-emerald-600 text-white'
                      : 'bg-white border-slate-200 text-slate-900'
                  }`}
                >
                  {m.mediaBadge && (
                    <div className="mb-1.5 text-[11px] font-mono font-semibold text-emerald-700">
                      [{m.mediaBadge}]
                    </div>
                  )}
                  {m.deleted ? (
                    <div className="italic text-xs">
                      অ্যান্টি-লিংক প্রোটেকশনের মাধ্যমে এই মেসেজটি ডিলিট করা হয়েছে ({m.text})
                    </div>
                  ) : (
                    <div>
                      {m.text}
                      {m.reaction && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 text-xs bg-white text-slate-900 rounded-md border border-slate-200">
                          {m.reaction}
                        </span>
                      )}
                    </div>
                  )}
                  <div
                    className={`mt-1.5 text-[11px] font-mono tabular-nums flex items-center justify-between gap-4 ${
                      isUser && !m.deleted ? 'text-emerald-100' : 'text-slate-400'
                    }`}
                  >
                    <span>{m.rule || (isUser ? 'প্রেরিত মেসেজ' : 'বটের SMS উত্তর')}</span>
                    <span>{m.timestamp}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendSimulatedMessage(input);
          }}
          className="p-4 border-t border-slate-200 bg-white flex items-center gap-2.5"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUploadTest}
            className="hidden"
          />
          <button
            type="button"
            disabled={isSending}
            onClick={() => fileInputRef.current?.click()}
            title="আসল ছবি আপলোড করে ০ টোকেন টেস্ট করুন"
            className="px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ImagePlus className="w-4 h-4 text-emerald-600" />
            ছবি টেস্ট
          </button>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              chatType === 'story'
                ? 'স্টোরির ক্যাপশন লিখুন বা ছবি টেস্ট করুন...'
                : '.ai <প্রশ্ন>, .antilink delete on, .autoreply on অথবা যেকোনো মেসেজ লিখুন...'
            }
            className="flex-1 px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
          />
          <button
            type="submit"
            disabled={isSending || (!input.trim() && chatType !== 'story')}
            className="px-4 py-2.5 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Send className="w-4 h-4" />
            {isSending ? 'পাঠানো হচ্ছে...' : 'পাঠান'}
          </button>
        </form>
      </section>
    </div>
  );
}
