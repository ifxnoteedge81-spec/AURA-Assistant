import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { ThinkingLevel } from '@google/genai';
import type { GeminiKeyPool } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';
import type { TokenTelemetryTracker } from './tokenTelemetry.ts';
import type { WebOutreachController } from './webResearchOutreach.ts';
import type { AutonomousAgentEngine } from './autonomousAgent.ts';
import { adminLoadDocument, adminSaveDocument, getFirestoreAdminDiagnostics } from './firestoreAdmin.ts';

export interface TelegramTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface TelegramMemoryStore {
  chats: Record<
    string,
    {
      chatId: string;
      title: string;
      antilinkEnabled: boolean;
      turns: TelegramTurn[];
      updatedAt: string;
    }
  >;
}

export interface TelegramBotAdapters {
  geminiPool: GeminiKeyPool;
  openRouterReader: OpenRouterReader;
  tokenTelemetry: TokenTelemetryTracker;
  outreach: WebOutreachController;
  getAutonomousAgent: () => AutonomousAgentEngine | null;
  getOwnerName: () => string;
  pushLog?: (
    category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
    actor: string,
    summary: string,
    outcome?: 'success' | 'blocked' | 'info' | 'error'
  ) => void;
}

const RUNTIME_DIR = process.env.VERCEL ? '/tmp' : '.';
const TG_MEM_FILE = path.resolve(RUNTIME_DIR, 'bot-telegram-memories.json');

interface TelegramMessageEntity {
  type?: string;
  offset?: number;
  length?: number;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export function getTelegramBotToken(): string {
  const tok = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!tok || tok.startsWith('YOUR_') || tok === 'MY_TELEGRAM_BOT_TOKEN') return '';
  return tok;
}

export function getTelegramWebhookSecret(): string {
  const explicit = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (explicit) return explicit;
  const tok = getTelegramBotToken();
  if (!tok) return '';
  return crypto.createHmac('sha256', tok).update('wanexus-tg-webhook').digest('hex').slice(0, 32);
}

function getOwnerIdList(): string[] {
  const raw = String(process.env.TELEGRAM_OWNER_ID || '').trim();
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function containsExternalLink(text: string): boolean {
  return /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|wa\.me\/|bit\.ly\/)/i.test(text);
}

export class TelegramBotController {
  private readonly adapters: TelegramBotAdapters;
  private store: TelegramMemoryStore = { chats: {} };
  private cachedBotUsername: string = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  private lastWebhookUrl: string | null = null;
  private lastWebhookAt: string | null = null;
  private lastError: string | null = null;
  private hydrated = false;

  constructor(adapters: TelegramBotAdapters) {
    this.adapters = adapters;
    this.loadLocal();
  }

  private loadLocal() {
    try {
      if (fs.existsSync(TG_MEM_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(TG_MEM_FILE, 'utf8')) as Partial<TelegramMemoryStore>;
        if (parsed?.chats && typeof parsed.chats === 'object') {
          this.store = { chats: parsed.chats };
        }
      }
    } catch {
      this.store = { chats: {} };
    }
  }

  private async ensureHydrated() {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const cloud = await adminLoadDocument<TelegramMemoryStore>('bot_telegram_state', 'primary');
      if (cloud?.chats && typeof cloud.chats === 'object') {
        this.store = {
          chats: { ...cloud.chats, ...this.store.chats },
        };
      }
    } catch {
      // ignore cloud hydration error
    }
  }

  private async persistStore() {
    try {
      fs.writeFileSync(TG_MEM_FILE, JSON.stringify(this.store, null, 2), 'utf8');
    } catch {
      // ignore read-only error
    }
    await adminSaveDocument('bot_telegram_state', 'primary', {
      chats: this.store.chats,
    }).catch(() => false);
  }

  private async callTelegramApi<T = unknown>(
    method: string,
    payload?: Record<string, unknown>
  ): Promise<{ ok: boolean; result?: T; description?: string }> {
    const token = getTelegramBotToken();
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured in environment variables.');
    }
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = (await resp.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      this.lastError = data.description || `Telegram API ${method} HTTP ${resp.status}`;
    }
    return data;
  }

  private async sendMessage(
    chatId: number | string,
    text: string,
    options?: { replyToMessageId?: number; replyMarkup?: Record<string, unknown> }
  ) {
    const safeText = text.trim().slice(0, 4000) || '...';
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: safeText,
    };
    if (options?.replyToMessageId) {
      payload.reply_to_message_id = options.replyToMessageId;
    }
    if (options?.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }
    return this.callTelegramApi('sendMessage', payload);
  }

  public async getBotStatusSnapshot() {
    const token = getTelegramBotToken();
    let botInfo: TelegramUser | null = null;
    let webhookInfo: { url?: string; pending_update_count?: number; last_error_message?: string } | null = null;

    if (token) {
      try {
        const me = await this.callTelegramApi<TelegramUser>('getMe');
        if (me.ok && me.result) {
          botInfo = me.result;
          if (me.result.username) {
            this.cachedBotUsername = me.result.username;
          }
        }
        const wh = await this.callTelegramApi<{
          url?: string;
          pending_update_count?: number;
          last_error_message?: string;
        }>('getWebhookInfo');
        if (wh.ok && wh.result) {
          webhookInfo = wh.result;
          if (wh.result.url) {
            this.lastWebhookUrl = wh.result.url;
          }
        }
      } catch (err) {
        this.lastError = (err as Error).message.slice(0, 160);
      }
    }

    return {
      configured: Boolean(token),
      botUsername: this.cachedBotUsername || botInfo?.username || null,
      botName: botInfo?.first_name || null,
      ownerIdsCount: getOwnerIdList().length,
      webhookUrl: webhookInfo?.url || this.lastWebhookUrl,
      pendingUpdates: webhookInfo?.pending_update_count ?? 0,
      lastWebhookError: webhookInfo?.last_error_message || this.lastError,
      lastSetupAt: this.lastWebhookAt,
      trackedChatsCount: Object.keys(this.store.chats).length,
      imageGenerationReady: true,
    };
  }

  public async setupWebhookAndMenu(baseUrl: string) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    if (!cleanBase.startsWith('https://')) {
      throw new Error('Telegram requires a public HTTPS URL (e.g. your Vercel deployment https://xxx.vercel.app).');
    }
    const webhookUrl = `${cleanBase}/api/telegram/webhook`;
    const secretToken = getTelegramWebhookSecret();

    const setWh = await this.callTelegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message'],
      drop_pending_updates: false,
    });

    if (!setWh.ok) {
      throw new Error(setWh.description || 'Failed to register Telegram webhook.');
    }

    await this.callTelegramApi('setMyCommands', {
      commands: [
        { command: 'start', description: 'শুরু ও কন্ট্রোল ড্যাশবোর্ড খুলুন' },
        { command: 'agent', description: 'Autonomous AI মিশন চালান' },
        { command: 'imagine', description: 'AI দিয়ে যেকোনো ছবি তৈরি করুন' },
        { command: 'search', description: 'ওয়েব সার্চ ও লিড খুঁজুন' },
        { command: 'status', description: 'সিস্টেম, Gemini ও Firestore স্ট্যাটাস' },
        { command: 'myid', description: 'আপনার Telegram User ID জানুন' },
        { command: 'help', description: 'সব কমান্ডের তালিকা' },
      ],
    }).catch(() => {});

    await this.callTelegramApi('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Control Studio',
        web_app: { url: cleanBase },
      },
    }).catch(() => {});

    this.lastWebhookUrl = webhookUrl;
    this.lastWebhookAt = new Date().toISOString();
    this.lastError = null;
    this.adapters.pushLog?.('cloud', 'Telegram Webhook', `Registered ${webhookUrl}`, 'success');
    return this.getBotStatusSnapshot();
  }

  public async generateImageBuffer(prompt: string): Promise<{
    buffer: Buffer;
    provider: string;
    mimeType: string;
  }> {
    const cleanPrompt = prompt.trim().slice(0, 600);
    if (!cleanPrompt) {
      throw new Error('Please provide a prompt to generate an image.');
    }

    // 1. Optional Hugging Face Free Inference API (FLUX.1-schnell) when HF_TOKEN is configured
    const hfToken = String(process.env.HF_TOKEN || '').trim();
    if (hfToken) {
      try {
        const hfResp = await fetch(
          'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${hfToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ inputs: cleanPrompt }),
            signal: AbortSignal.timeout(25_000),
          }
        );
        if (hfResp.ok) {
          const arr = await hfResp.arrayBuffer();
          if (arr.byteLength > 1000) {
            return {
              buffer: Buffer.from(arr),
              provider: 'HuggingFace FLUX.1-schnell',
              mimeType: hfResp.headers.get('content-type') || 'image/jpeg',
            };
          }
        }
      } catch {
        // fall through to Pollinations
      }
    }

    // 2. Zero-key Free Fallback via Pollinations Image Endpoint
    const seed = Math.floor(Math.random() * 999_999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;
    const imgResp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(25_000),
      headers: { 'User-Agent': 'WaNexus-Telegram-Studio/1.0' },
    });
    if (!imgResp.ok) {
      throw new Error(`Image service HTTP ${imgResp.status}. Add HF_TOKEN in env for faster HuggingFace FLUX generation.`);
    }
    const buf = Buffer.from(await imgResp.arrayBuffer());
    if (buf.byteLength < 800) {
      throw new Error('Image service returned empty payload.');
    }
    return {
      buffer: buf,
      provider: 'Pollinations Free AI',
      mimeType: imgResp.headers.get('content-type') || 'image/jpeg',
    };
  }

  private async sendPhotoBuffer(
    chatId: number | string,
    buffer: Buffer,
    caption: string,
    replyToMessageId?: number
  ) {
    const token = getTelegramBotToken();
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured.');

    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption.slice(0, 950));
    if (replyToMessageId) {
      form.append('reply_to_message_id', String(replyToMessageId));
    }
    const blob = new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' });
    form.append('photo', blob, 'generated.jpg');

    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    const data = (await resp.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      throw new Error(data.description || 'Failed to send photo to Telegram.');
    }
  }

  private async generateSmartChatReply(params: {
    chatId: string;
    senderName: string;
    text: string;
  }): Promise<{ replyText: string; provider: string }> {
    const chatState = this.store.chats[params.chatId];
    const recentHistory = (chatState?.turns || [])
      .slice(-10)
      .map((t) => `${t.role === 'user' ? params.senderName : 'Assistant'}: ${t.text}`)
      .join('\n');

    const systemPrompt = [
      `You are the smart Telegram & Web AI Executive Assistant for "${this.adapters.getOwnerName()}".`,
      'Reply naturally, concisely, and helpfully in the user’s language (Bengali, Banglish, or English).',
      'If the user asks for multi-step web research, lead finding, or emailing, mention they can also prefix with `/agent <goal>` or `/imagine <prompt>` for images.',
    ].join('\n');

    const userPrompt = recentHistory
      ? `Recent Conversation:\n${recentHistory}\n\nLatest Message from ${params.senderName}: ${params.text}`
      : `Message from ${params.senderName}: ${params.text}`;

    if (this.adapters.geminiPool.hasKeys()) {
      for (const spec of [
        { model: 'gemini-4-hydrogen', channel: 'primary', low: true },
        { model: 'gemini-3.1-flash-lite', channel: 'lite', low: false },
      ]) {
        try {
          const exec = await this.adapters.geminiPool.executeWithRotation(
            (client) =>
              client.models.generateContent({
                model: spec.model,
                contents: userPrompt,
                config: {
                  systemInstruction: systemPrompt,
                  ...(spec.low ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
                },
              }),
            undefined,
            { maxTotalMs: 12_000, channel: spec.channel }
          );
          const reply = (exec.value.text || '').trim();
          const um = exec.value.usageMetadata;
          if (um?.totalTokenCount) {
            this.adapters.tokenTelemetry.recordUsage({
              provider: 'gemini',
              model: spec.model,
              category: 'dm',
              promptTokens: Number(um.promptTokenCount || 0),
              completionTokens: Number(um.candidatesTokenCount || 0),
              totalTokens: Number(um.totalTokenCount || 0),
              keySlot: exec.keySlot,
            });
          }
          if (reply) return { replyText: reply, provider: spec.model };
        } catch {
          // try fallback model
        }
      }
    }

    if (this.adapters.openRouterReader.hasKeys()) {
      try {
        const res = await this.adapters.openRouterReader.generateAgentStepPlan({
          systemPrompt,
          transcript: `${userPrompt}\n\nReply directly with helpful natural text (not JSON).`,
        });
        if (res.content?.trim()) {
          return { replyText: res.content.trim(), provider: res.modelUsed };
        }
      } catch {
        // fall through
      }
    }

    return {
      replyText:
        '⚠️ এই মুহূর্তে Gemini বা OpenRouter API কী অ্যাক্টিভ নেই বা রেট লিমিটে আছে। Vercel Environment Variables চেক করে আবার চেষ্টা করুন, অথবা `/status` দিয়ে অবস্থা দেখুন।',
      provider: 'fallback',
    };
  }

  public async handleWebhookUpdate(update: TelegramUpdate, publicOrigin?: string) {
    await this.ensureHydrated();
    const msg = update.message || update.edited_message;
    if (!msg || msg.from?.is_bot) return { handled: false };

    const rawText = String(msg.text || msg.caption || '').trim();
    if (!rawText) return { handled: false };

    const chatIdStr = String(msg.chat.id);
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const senderName = msg.from?.first_name || msg.from?.username || 'User';
    const senderIdStr = msg.from?.id ? String(msg.from.id) : '';
    const ownerIds = getOwnerIdList();
    const isOwner = ownerIds.length === 0 || (Boolean(senderIdStr) && ownerIds.includes(senderIdStr));

    if (!this.store.chats[chatIdStr]) {
      this.store.chats[chatIdStr] = {
        chatId: chatIdStr,
        title: msg.chat.title || msg.chat.first_name || senderName,
        antilinkEnabled: false,
        turns: [],
        updatedAt: new Date().toISOString(),
      };
    }
    const chatState = this.store.chats[chatIdStr];

    // Ensure bot username is known for @mention check in groups
    if (isGroup && !this.cachedBotUsername && getTelegramBotToken()) {
      const me = await this.callTelegramApi<TelegramUser>('getMe').catch(() => null);
      if (me?.ok && me.result?.username) {
        this.cachedBotUsername = me.result.username;
      }
    }

    // Group Anti-Link auto-delete
    if (isGroup && chatState.antilinkEnabled && !isOwner && containsExternalLink(rawText)) {
      const del = await this.callTelegramApi('deleteMessage', {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
      }).catch(() => ({ ok: false }));
      if (del.ok) {
        await this.sendMessage(
          msg.chat.id,
          `🚫 *Anti-Link:* ${senderName}, এই গ্রুপে লিংক শেয়ার করা নিষেধ। আপনার মেসেজ ডিলিট করা হয়েছে।`
        );
        this.adapters.pushLog?.('antilink', senderName, `Deleted link in TG group ${chatState.title}`, 'blocked');
        return { handled: true, action: 'group_antilink_deleted' };
      }
    }

    // In groups, only respond to explicit commands, @mentions, or replies to the bot
    if (isGroup) {
      const mentioned =
        this.cachedBotUsername &&
        rawText.toLowerCase().includes(`@${this.cachedBotUsername.toLowerCase()}`);
      const repliedToBot = Boolean(msg.reply_to_message?.from?.is_bot);
      const isCmd = rawText.startsWith('/');
      if (!mentioned && !repliedToBot && !isCmd) {
        return { handled: false, reason: 'group_idle_ignored' };
      }
    }

    const cleanedText = this.cachedBotUsername
      ? rawText.replace(new RegExp(`@${this.cachedBotUsername}\\b`, 'ig'), '').trim()
      : rawText;
    const lower = cleanedText.toLowerCase();

    // /myid
    if (/^\/myid(?:\s|$)/i.test(lower)) {
      await this.sendMessage(
        msg.chat.id,
        `🆔 আপনার Telegram User ID: \`${senderIdStr || 'unknown'}\`\nChat ID: \`${chatIdStr}\`\n\nনিরাপত্তার জন্য Vercel Env-এ \`TELEGRAM_OWNER_ID=${senderIdStr}\` সেট করতে পারেন।`,
        { replyToMessageId: msg.message_id }
      );
      return { handled: true, action: 'myid' };
    }

    // /start or /help
    if (/^\/(?:start|help)(?:\s|$)/i.test(lower)) {
      const miniAppUrl =
        publicOrigin && publicOrigin.startsWith('https://')
          ? publicOrigin
          : this.lastWebhookUrl
            ? this.lastWebhookUrl.replace(/\/api\/telegram\/webhook$/, '')
            : '';

      const helpText = [
        `🤖 *WaNexus & Telegram AI Studio — ২৪/৭ ফ্রি ক্লাউড অ্যাসিস্ট্যান্ট*`,
        '',
        'আপনি সরাসরি যেকোনো প্রশ্ন করতে পারেন, অথবা নিচের কমান্ডগুলো চালাতে পারেন:',
        '• `/agent <কাজ>` বা `এজেন্ট ...` — ওয়েব সার্চ, লিড সংগ্রহ ও ইমেইল মিশন',
        '• `/imagine <প্রম্পট>` বা `ছবি বানাও: ...` — AI দিয়ে ছবি তৈরি',
        '• `/search <টপিক>` — লাইভ ওয়েব থেকে তথ্য ও কন্টাক্ট খোঁজা',
        '• `/status` — Gemini কী, OpenRouter, Firestore ও সিস্টেম স্ট্যাটাস',
        '• `/myid` — আপনার Telegram Owner ID দেখা',
        isGroup ? '• `/antilink on` | `/antilink off` — গ্রুপ লিংক প্রটেকশন' : '',
      ]
        .filter(Boolean)
        .join('\n');

      await this.sendMessage(msg.chat.id, helpText, {
        replyToMessageId: msg.message_id,
        replyMarkup: miniAppUrl
          ? {
              inline_keyboard: [
                [{ text: '🚀 Open Control Dashboard (Mini App)', web_app: { url: miniAppUrl } }],
              ],
            }
          : undefined,
      });
      return { handled: true, action: 'start_help' };
    }

    // /antilink on|off in groups
    if (isGroup && /^\/antilink(?:\s+(on|off))?/i.test(lower)) {
      if (!isOwner) {
        await this.sendMessage(msg.chat.id, '⛔ শুধু ওনার Anti-Link পরিবর্তন করতে পারবেন।', {
          replyToMessageId: msg.message_id,
        });
        return { handled: true, action: 'antilink_denied' };
      }
      const mode = lower.includes('on') ? true : lower.includes('off') ? false : !chatState.antilinkEnabled;
      chatState.antilinkEnabled = mode;
      chatState.updatedAt = new Date().toISOString();
      await this.persistStore();
      await this.sendMessage(
        msg.chat.id,
        `🛡️ এই গ্রুপে Telegram Anti-Link এখন *${mode ? 'ON' : 'OFF'}*।`,
        { replyToMessageId: msg.message_id }
      );
      return { handled: true, action: 'antilink_toggle' };
    }

    // /status
    if (/^\/status(?:\s|$)/i.test(lower)) {
      const gStats = geminiStatsSafe(this.adapters);
      const oStats = this.adapters.openRouterReader.getStats();
      const fbDiag = getFirestoreAdminDiagnostics();
      const summary = this.adapters.outreach.getSummary();
      await this.sendMessage(
        msg.chat.id,
        [
          '📡 *24/7 Cloud System Status*',
          `• Mode: ${process.env.VERCEL ? 'Vercel Serverless (24/7 Free)' : 'Node Server'}`,
          `• Gemini Pool: ${gStats.configuredKeysCount} key(s) active`,
          `• OpenRouter: ${oStats.configuredKeysCount} key(s) (${oStats.primaryModel})`,
          `• Firestore (${fbDiag.configuredProjectId || '—'}): ${fbDiag.projectMatch === true ? '✅ Matched' : fbDiag.mode}`,
          `• Lead Vault: ${summary.totalLeads} leads | Image Gen: ✅ Active`,
        ].join('\n'),
        { replyToMessageId: msg.message_id }
      );
      return { handled: true, action: 'status' };
    }

    // /imagine or Bengali image prompt
    const imagineMatch = cleanedText.match(
      /^(?:\/imagine|imagine|ছবি\s*বানাও|ছবি\s*আঁকো|draw|generate\s+image)\s*[:\-—]?\s*(.+)$/iu
    );
    if (imagineMatch?.[1]) {
      const prompt = imagineMatch[1].trim();
      await this.callTelegramApi('sendChatAction', { chat_id: msg.chat.id, action: 'upload_photo' }).catch(() => {});
      try {
        const img = await this.generateImageBuffer(prompt);
        await this.sendPhotoBuffer(
          msg.chat.id,
          img.buffer,
          `🎨 Prompt: "${prompt.slice(0, 140)}"\n⚙️ Engine: ${img.provider}`,
          msg.message_id
        );
        this.adapters.pushLog?.('gemini', 'Telegram Image', `Generated image via ${img.provider}`, 'success');
      } catch (err) {
        await this.sendMessage(msg.chat.id, `❌ ছবি তৈরি করা যায়নি: ${(err as Error).message}`, {
          replyToMessageId: msg.message_id,
        });
      }
      return { handled: true, action: 'imagine' };
    }

    // /search <query>
    const searchMatch = cleanedText.match(/^(?:\/search|খুঁজো|সার্চ)\s+(.+)$/iu);
    if (searchMatch?.[1]) {
      const query = searchMatch[1].trim();
      await this.callTelegramApi('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
      const res = await this.adapters.outreach.runResearch({ query, maxSites: 4, useAiSummary: true });
      const lines = [
        `🔎 *ওয়েব সার্চ রেজাল্ট (${res.research.providerUsed}):*`,
        res.research.summary.slice(0, 800),
        '',
        ...res.leads.slice(0, 5).map(
          (l, idx) =>
            `${idx + 1}. ${l.name}\n   🌐 ${l.sourceUrl}${l.emails.length ? `\n   📧 ${l.emails.join(', ')}` : ''}${l.phones.length ? `\n   📞 ${l.phones.join(', ')}` : ''}`
        ),
      ];
      await this.sendMessage(msg.chat.id, lines.join('\n'), { replyToMessageId: msg.message_id });
      return { handled: true, action: 'search' };
    }

    // /agent <goal> or Bengali agent command
    const agentMatch = cleanedText.match(
      /^(?:\/agent|এজেন্ট(?:\s*দিয়ে)?|অটোনোমাস(?:ভাবে)?|agent|mission)\s*[:\-—,]?\s*(.+)$/iu
    );
    if (agentMatch?.[1]) {
      if (!isOwner) {
        await this.sendMessage(msg.chat.id, '⛔ Autonomous Agent শুধু অনুমোদিত ওনার চালাতে পারবেন।', {
          replyToMessageId: msg.message_id,
        });
        return { handled: true, action: 'agent_denied' };
      }
      const agent = this.adapters.getAutonomousAgent();
      if (!agent) {
        await this.sendMessage(msg.chat.id, '⚠️ Autonomous Agent ইঞ্জিন প্রস্তুত নয়।', {
          replyToMessageId: msg.message_id,
        });
        return { handled: true, action: 'agent_unavailable' };
      }
      await this.callTelegramApi('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
      const run = await agent.executeMission({ goal: agentMatch[1].trim(), source: 'self_chat' });
      await this.sendMessage(
        msg.chat.id,
        `${run.finalReport}\n\n_(${run.providerUsed.toUpperCase()} · ${run.steps.length} ধাপ · ${run.tokensUsed} টোকেন)_`,
        { replyToMessageId: msg.message_id }
      );
      return { handled: true, action: 'agent_run' };
    }

    // Standard Conversational AI Reply
    await this.callTelegramApi('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
    const aiReply = await this.generateSmartChatReply({
      chatId: chatIdStr,
      senderName,
      text: cleanedText,
    });

    chatState.turns.push(
      { role: 'user', text: cleanedText.slice(0, 600), at: new Date().toISOString() },
      { role: 'assistant', text: aiReply.replyText.slice(0, 1200), at: new Date().toISOString() }
    );
    if (chatState.turns.length > 20) {
      chatState.turns = chatState.turns.slice(-20);
    }
    chatState.updatedAt = new Date().toISOString();
    await this.persistStore();

    await this.sendMessage(msg.chat.id, aiReply.replyText, { replyToMessageId: msg.message_id });
    this.adapters.pushLog?.('autoreply', `TG:${senderName}`, `Replied via ${aiReply.provider}`, 'success');
    return { handled: true, action: 'chat_reply', provider: aiReply.provider };
  }
}

function geminiStatsSafe(adapters: TelegramBotAdapters) {
  return adapters.geminiPool.getStats();
}

export function registerTelegramRoutes(
  app: Express,
  controller: TelegramBotController,
  requireOwnerAuth: (req: Request, res: Response, next: () => void) => void
) {
  // Public Telegram Webhook endpoint (verified via secret token when configured)
  app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
    const expectedSecret = getTelegramWebhookSecret();
    const receivedSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (expectedSecret && receivedSecret && receivedSecret !== expectedSecret) {
      res.status(401).json({ ok: false, error: 'Invalid Telegram webhook secret.' });
      return;
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const origin = host ? `${proto}://${host}` : undefined;

    try {
      const outcome = await controller.handleWebhookUpdate((req.body || {}) as TelegramUpdate, origin);
      res.json({ ok: true, ...outcome });
    } catch (err) {
      console.error('[Telegram Webhook] Error:', (err as Error).message);
      // Return 200 so Telegram does not repeatedly redeliver a poison update
      res.json({ ok: false, error: (err as Error).message.slice(0, 140) });
    }
  });

  app.get('/api/telegram/status', requireOwnerAuth, async (_req: Request, res: Response) => {
    const snapshot = await controller.getBotStatusSnapshot();
    res.json(snapshot);
  });

  app.post('/api/telegram/setup-webhook', requireOwnerAuth, async (req: Request, res: Response) => {
    try {
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const baseUrl = String(req.body?.baseUrl || (host ? `${proto}://${host}` : '')).trim();
      const snapshot = await controller.setupWebhookAndMenu(baseUrl);
      res.json({ ok: true, status: snapshot });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/telegram/imagine', requireOwnerAuth, async (req: Request, res: Response) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      const img = await controller.generateImageBuffer(prompt);
      res.json({
        ok: true,
        provider: img.provider,
        mimeType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.buffer.toString('base64')}`,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });
}
