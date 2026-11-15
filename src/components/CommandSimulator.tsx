import { useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { BotConfig } from '../types';

type ChatContext = 'private' | 'group_bot_admin' | 'group_bot_non_admin' | 'self';

interface SimulatedMsg {
  id: string;
  sender: 'user' | 'bot' | 'system';
  text: string;
  deleted?: boolean;
  rule?: string;
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
  { id: 'self', label: 'নিজের নম্বরে মেসেজ' },
];

const QUICK_COMMANDS = [
  '.autoreply on',
  'আসসালামু আলাইকুম, স্যার কি আছেন?',
  'গুড নাইট, আমার এখনো সকাল হয় নাই!',
  'তুমি ওনার অ্যাসিস্ট্যান্ট, কেমন আছো? তোমার স্যার কী করেন, কোথায় থাকেন?',
  'আমার একটা ফ্ল্যাট বা রুম ম্যানেজ করে দিতে পারবা?',
  'কেনে আছো ভাই? কিতা খবর?',
  '.ai একটি হোয়াটসঅ্যাপ গ্রুপ নিরাপদ রাখার ৩টি উপায় বলো',
  '.antilink delete on',
  'আমাদের চ্যানেলে জয়েন করুন https://t.me/example_channel',
];

export function CommandSimulator({ config, onConfigUpdated }: CommandSimulatorProps) {
  const [chatType, setChatType] = useState<ChatContext>('private');
  const [senderIsAdmin, setSenderIsAdmin] = useState(false);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<SimulatedMsg[]>([
    {
      id: 'init-1',
      sender: 'system',
      text: 'সিমুলেটর সার্ভার-সাইড @google/genai এবং বট কমান্ড রাউটারের সাথে যুক্ত আছে। উপরের চ্যাট মোড বেছে নিয়ে .ai, .antilink delete on অথবা .autoreply on টেস্ট করুন।',
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);

  const defaultGroupJid = Object.keys(config.antilinkGroups)[0] || '120363041928374655@g.us';

  async function sendSimulatedMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || isSending) return;

    const userMsgId = `u-${Date.now()}`;
    const now = new Date().toLocaleTimeString();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, sender: 'user', text, timestamp: now },
    ]);
    setInput('');
    setIsSending(true);

    try {
      const res = await authFetch('/api/simulator/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          chatType,
          senderIsGroupAdmin: senderIsAdmin,
          groupJid: defaultGroupJid,
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

      if (data.reply) {
        setMessages((prev) => [
          ...prev,
          {
            id: `b-${Date.now()}`,
            sender: 'bot',
            text: data.reply,
            rule: data.ruleTriggered,
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

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
      {/* Left: Chat Context & Quick Test Prompts */}
      <div className="lg:col-span-4 space-y-6">
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Chat Environment</h2>
            <p className="mt-1 text-xs text-slate-600">
              Switch contexts to verify group admin permissions, link deletion, and private-only Bengali auto-replies.
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
            <label className="flex items-center gap-2.5 pt-2 border-t border-slate-200 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={senderIsAdmin}
                onChange={(e) => setSenderIsAdmin(e.target.checked)}
                className="w-4 h-4 accent-emerald-600 rounded"
              />
              Simulate sender as Group Admin
            </label>
          )}

          <div className="pt-3 border-t border-slate-200 text-xs text-slate-600 space-y-1">
            <div className="flex justify-between">
              <span>Auto-Reply Mode</span>
              <span className="font-mono font-medium text-slate-900">
                {config.autoreply ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Group Anti-Link</span>
              <span className="font-mono font-medium text-slate-900">
                {config.antilinkGroups[defaultGroupJid] ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900">Sample Commands</h3>
          <div className="mt-3 space-y-2">
            {QUICK_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                type="button"
                disabled={isSending}
                onClick={() => sendSimulatedMessage(cmd)}
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
            <div className="text-xs text-slate-500 font-mono">
              {chatType.startsWith('group') ? defaultGroupJid : '8801700000000@s.whatsapp.net'}
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
            বটের কমান্ড ও প্রোটেকশন নিয়ম টেস্ট করতে নিচে একটি মেসেজ পাঠান।
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
                  {m.deleted ? (
                    <div className="italic text-xs">
                      অ্যান্টি-লিংক প্রোটেকশনের মাধ্যমে এই মেসেজটি ডিলিট করা হয়েছে ({m.text})
                    </div>
                  ) : (
                    <div>{m.text}</div>
                  )}
                  <div
                    className={`mt-1.5 text-[11px] font-mono tabular-nums flex items-center justify-between gap-4 ${
                      isUser && !m.deleted ? 'text-emerald-100' : 'text-slate-400'
                    }`}
                  >
                    <span>{m.rule || (isUser ? 'প্রেরিত মেসেজ' : 'বটের উত্তর')}</span>
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
            sendSimulatedMessage(input);
          }}
          className="p-4 border-t border-slate-200 bg-white flex items-center gap-3"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder=".ai <প্রশ্ন>, .antilink delete on, .autoreply on অথবা যেকোনো মেসেজ লিখুন..."
            className="flex-1 px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600/20 focus:border-emerald-600"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim()}
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
