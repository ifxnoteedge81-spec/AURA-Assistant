import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { ThinkingLevel, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { GeminiKeyPool } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';
import type { TokenTelemetryTracker } from './tokenTelemetry.ts';
import type { WebOutreachController } from './webResearchOutreach.ts';
import type { AutonomousAgentEngine } from './autonomousAgent.ts';
import type { AssistantConfigFields } from './assistantEngine.ts';
import {
  buildPatchFromInput,
  getFullControlSnapshot,
  type ControlPatchInput,
} from './autonomousControl.ts';
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
  getBotConfig?: () => AssistantConfigFields & Record<string, unknown>;
  updateBotConfig?: (patch: Partial<AssistantConfigFields> & Record<string, unknown>) => Promise<void>;
  getMemoryRssMb?: () => number;
  pushLog?: (
    category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
    actor: string,
    summary: string,
    outcome?: 'success' | 'blocked' | 'info' | 'error'
  ) => void;
}

const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);
const RUNTIME_DIR = IS_SERVERLESS ? '/tmp' : '.';
const TG_MEM_FILE = path.resolve(RUNTIME_DIR, 'bot-telegram-memories.json');

export function isNetlifyRuntime(): boolean {
  return Boolean(process.env.NETLIFY || process.env.URL || process.env.DEPLOY_PRIME_URL);
}

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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface PendingConfirmationEntry {
  patchInput: ControlPatchInput;
  warnings: string[];
  changedLabels: string[];
  expiresAt: number;
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

export function createInternalBgSignature(rawBody: string): string {
  const key =
    getTelegramWebhookSecret() ||
    process.env.DASHBOARD_AUTH_SECRET?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    'wanexus-bg-worker';
  return crypto.createHmac('sha256', key).update(rawBody).digest('hex');
}

export function verifyInternalBgSignature(rawBody: string, sig: string): boolean {
  if (!sig) return false;
  const expected = createInternalBgSignature(rawBody);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function hasConfirmOverridePhrase(text: string): boolean {
  const clean = text.trim().toLowerCase();
  if (
    /^(?:তারপরও\s*(?:তুমি\s*)?করো|তাও\s*(?:করে\s*)?দাও|তাও\s*করো|হ্যাঁ\s*(?:করো|করে\s*দাও)|ঠিক\s*আছে\s*করো|ওকে\s*করো|করো|দাও|yes|confirm|do\s+it(?:\s+anyway)?|proceed|force|approve)[.!?।]*$/i.test(
      clean
    )
  ) {
    return true;
  }
  return /(?:তারপরও\s*(?:তুমি\s*)?করো|তাও\s*করো|যাই\s*হোক\s*করো|রিস্ক\s*নিলেও|জোর\s*করে|do\s+it\s+anyway|force\s+it|confirmedOverride)/i.test(
    clean
  );
}

const TELEGRAM_CONTROL_TOOLS: FunctionDeclaration[] = [
  {
    name: 'get_dashboard_status_and_advice',
    description:
      'Get complete live list of ALL dashboard controls currently ON vs OFF, speed/latency estimate in seconds, and concrete recommendations on which settings should be ON/OFF to make replies faster (e.g. saving 10-20 seconds).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        focus: {
          type: Type.STRING,
          description: 'all | status | speed_advice',
        },
      },
    },
  },
  {
    name: 'update_dashboard_controls',
    description:
      'Turn ANY dashboard setting ON or OFF, change numbers/cooldowns/limits/tone/bio/rules, or apply speed presets (max_speed, balanced, ultra_safe). NEVER refuse an owner request. Warn once on risky changes unless confirmedOverride=true.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        autoreply: { type: Type.BOOLEAN },
        aiAssistantEnabled: { type: Type.BOOLEAN },
        fastReplyMode: { type: Type.BOOLEAN },
        telegramInlineInstantMode: { type: Type.BOOLEAN },
        humanTypingEnabled: { type: Type.BOOLEAN },
        cooldownMs: { type: Type.NUMBER },
        takeoverPauseMs: { type: Type.NUMBER },
        dailyReplyLimit: { type: Type.NUMBER },
        assistantTone: {
          type: Type.STRING,
          description: 'witty_flirty | warm_polite | executive_formal | sharp_shut_down',
        },
        groupAiEnabled: { type: Type.BOOLEAN },
        groupAiMode: { type: Type.STRING, description: 'smart_blend | mention_only | active_chat' },
        groupReactionEnabled: { type: Type.BOOLEAN },
        groupCooldownMs: { type: Type.NUMBER },
        mediaIntelligenceEnabled: { type: Type.BOOLEAN },
        mediaZeroTokenReplyMode: { type: Type.BOOLEAN },
        storyAutoReadEnabled: { type: Type.BOOLEAN },
        storyAutoReactEnabled: { type: Type.BOOLEAN },
        storyAutoReplyEnabled: { type: Type.BOOLEAN },
        selfChatCopilotEnabled: { type: Type.BOOLEAN },
        selfChatZeroTokenOnly: { type: Type.BOOLEAN },
        telegramAntilinkDefault: { type: Type.BOOLEAN },
        allGroupsAntilink: { type: Type.BOOLEAN },
        allGroupsAi: { type: Type.BOOLEAN },
        ownerName: { type: Type.STRING },
        ownerProfession: { type: Type.STRING },
        ownerLocation: { type: Type.STRING },
        ownerBio: { type: Type.STRING },
        ownerBoundaries: { type: Type.STRING },
        strictLogicRules: { type: Type.STRING },
        autoreplyMessage: { type: Type.STRING },
        firstGreetingTemplate: { type: Type.STRING },
        preset: { type: Type.STRING, description: 'max_speed | balanced | ultra_safe' },
        confirmedOverride: { type: Type.BOOLEAN },
      },
    },
  },
  {
    name: 'run_autonomous_agent_task',
    description:
      'Execute an operational autonomous mission (e.g., schedule recurring job, check leads/inbox, trigger self-heal) right from Telegram chat.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        goal: { type: Type.STRING, description: 'Clear operational mission goal' },
      },
      required: ['goal'],
    },
  },
];

export class TelegramBotController {
  private readonly adapters: TelegramBotAdapters;
  private store: TelegramMemoryStore = { chats: {} };
  private readonly pendingConfirmations = new Map<string, PendingConfirmationEntry>();
  private cachedBotUsername: string = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  private lastWebhookUrl: string | null = null;
  private lastWebhookAt: string | null = null;
  private lastError: string | null = null;
  private hydrated = false;

  constructor(adapters: TelegramBotAdapters) {
    this.adapters = adapters;
    this.loadLocal();
  }

  public isInlineInstantEnabled(): boolean {
    const cfg = this.adapters.getBotConfig?.();
    return cfg?.telegramInlineInstantMode !== false;
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
      const cloud = await Promise.race([
        adminLoadDocument<TelegramMemoryStore>('bot_telegram_state', 'primary'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_200)),
      ]);
      if (cloud?.chats && typeof cloud.chats === 'object') {
        this.store = {
          chats: { ...cloud.chats, ...this.store.chats },
        };
      }
    } catch {
      // ignore cloud hydration timeout/error so reply stays instant
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
      signal: AbortSignal.timeout(8_000),
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
      throw new Error('Telegram requires a public HTTPS URL (e.g. your Netlify site https://xxx.netlify.app).');
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
        { command: 'status', description: 'সব ON/OFF কন্ট্রোল ও স্পিড স্ট্যাটাস' },
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

  private getCurrentConfig(): AssistantConfigFields & Record<string, unknown> {
    if (this.adapters.getBotConfig) {
      return this.adapters.getBotConfig();
    }
    return {
      autoreply: true,
      aiAssistantEnabled: true,
      autoreplyMessage: 'স্বাগতম! আমি আপনার AI অ্যাসিস্ট্যান্ট।',
      firstGreetingTemplate: '',
      ownerName: this.adapters.getOwnerName() || 'Sir',
      ownerProfession: '',
      ownerLocation: '',
      ownerBio: '',
      ownerBoundaries: '',
      assistantTone: 'warm_polite',
      fastReplyMode: true,
      telegramInlineInstantMode: true,
      humanTypingEnabled: true,
    };
  }

  private async applyControlUpdate(
    chatIdStr: string,
    input: ControlPatchInput
  ): Promise<{
    applied: boolean;
    needsConfirmation: boolean;
    warnings: string[];
    changedLabels: string[];
    snapshot: ReturnType<typeof getFullControlSnapshot>;
  }> {
    const currentCfg = this.getCurrentConfig();
    const { patch, telegramAntilinkToggle, warnings, changedLabels } = buildPatchFromInput(
      input,
      currentCfg
    );

    if (warnings.length > 0 && input.confirmedOverride !== true) {
      this.pendingConfirmations.set(chatIdStr, {
        patchInput: { ...input, confirmedOverride: true },
        warnings,
        changedLabels,
        expiresAt: Date.now() + 10 * 60_000,
      });
      return {
        applied: false,
        needsConfirmation: true,
        warnings,
        changedLabels,
        snapshot: getFullControlSnapshot(currentCfg, {
          telegramChatAntilink: this.store.chats[chatIdStr]?.antilinkEnabled,
          telegramBotConfigured: Boolean(getTelegramBotToken()),
        }),
      };
    }

    if (typeof telegramAntilinkToggle === 'boolean' && this.store.chats[chatIdStr]) {
      this.store.chats[chatIdStr].antilinkEnabled = telegramAntilinkToggle;
      this.store.chats[chatIdStr].updatedAt = new Date().toISOString();
    }

    if (Object.keys(patch).length > 0 && this.adapters.updateBotConfig) {
      await this.adapters.updateBotConfig({
        ...patch,
        configUpdatedAt: new Date().toISOString(),
      });
    }

    this.pendingConfirmations.delete(chatIdStr);
    const updatedCfg = { ...currentCfg, ...patch };
    return {
      applied: true,
      needsConfirmation: false,
      warnings,
      changedLabels,
      snapshot: getFullControlSnapshot(updatedCfg, {
        telegramChatAntilink: this.store.chats[chatIdStr]?.antilinkEnabled,
        telegramBotConfigured: Boolean(getTelegramBotToken()),
      }),
    };
  }

  private async executeControlTool(
    chatIdStr: string,
    toolName: string,
    args: Record<string, unknown>,
    forceFromPrompt: boolean
  ): Promise<Record<string, unknown>> {
    if (toolName === 'get_dashboard_status_and_advice') {
      const cfg = this.getCurrentConfig();
      const snap = getFullControlSnapshot(cfg, {
        telegramChatAntilink: this.store.chats[chatIdStr]?.antilinkEnabled,
        telegramBotConfigured: Boolean(getTelegramBotToken()),
        geminiKeysCount: this.adapters.geminiPool.getStats().configuredKeysCount,
        openRouterKeysCount: this.adapters.openRouterReader.getStats().configuredKeysCount,
      });
      return {
        totalOn: snap.totalOn,
        totalOff: snap.totalOff,
        onControls: snap.onList,
        offControls: snap.offList,
        estimatedInstantReplySec: snap.estimatedInstantReplySec,
        optimizedReplySec: snap.optimizedReplySec,
        potentialSavedSec: snap.potentialSavedSec,
        speedTipsBn: snap.speedTipsBn,
        assistantTone: cfg.assistantTone,
        dailyReplyLimit: cfg.dailyReplyLimit ?? 200,
      };
    }

    if (toolName === 'update_dashboard_controls') {
      const input: ControlPatchInput = {
        ...(args as unknown as ControlPatchInput),
        confirmedOverride: args.confirmedOverride === true || forceFromPrompt,
      };
      const outcome = await this.applyControlUpdate(chatIdStr, input);
      if (outcome.needsConfirmation) {
        return {
          applied: false,
          needsConfirmation: true,
          warnings: outcome.warnings,
          proposedChanges: outcome.changedLabels,
          note: 'Warn owner clearly in Bengali about these potential risks, and say that replying "তারপরও করো" or "করো" will execute immediately without resistance.',
        };
      }
      return {
        applied: true,
        changedLabels: outcome.changedLabels,
        warningsNoted: outcome.warnings,
        estimatedInstantReplySec: outcome.snapshot.estimatedInstantReplySec,
        totalOn: outcome.snapshot.totalOn,
        totalOff: outcome.snapshot.totalOff,
      };
    }

    if (toolName === 'run_autonomous_agent_task') {
      const agent = this.adapters.getAutonomousAgent();
      if (!agent) {
        return { ok: false, error: 'Autonomous Agent engine is not initialized.' };
      }
      const run = await agent.executeMission({
        goal: String(args.goal || ''),
        source: 'self_chat',
        maxWallClockMs: 5_500,
      });
      return {
        ok: run.status === 'completed',
        report: run.finalReport,
        stepsCount: run.steps.length,
      };
    }

    return { ok: false, error: `Unknown tool: ${toolName}` };
  }

  private async generateSmartChatReply(params: {
    chatId: string;
    senderName: string;
    text: string;
    isOwner: boolean;
    backgroundMode?: boolean;
  }): Promise<{ replyText: string; provider: string }> {
    const cfg = this.getCurrentConfig();
    const fastMode = cfg.fastReplyMode !== false;
    const forceFromPrompt = hasConfirmOverridePhrase(params.text);
    const chatState = this.store.chats[params.chatId];
    const recentHistory = (chatState?.turns || [])
      .slice(-8)
      .map((t) => `${t.role === 'user' ? params.senderName : 'Assistant'}: ${t.text}`)
      .join('\n');

    const controlSnapshot = getFullControlSnapshot(cfg, {
      telegramChatAntilink: chatState?.antilinkEnabled,
      telegramBotConfigured: Boolean(getTelegramBotToken()),
      geminiKeysCount: this.adapters.geminiPool.getStats().configuredKeysCount,
      openRouterKeysCount: this.adapters.openRouterReader.getStats().configuredKeysCount,
    });

    const systemPrompt = [
      `You are the Fully Autonomous AI Executive Controller & Assistant for "${this.adapters.getOwnerName()}".`,
      'Reply naturally, fast, and concisely in the user’s language (Bengali, Banglish, or English).',
      params.isOwner
        ? [
            'OWNER AUTONOMOUS CONTROL RULES (CRITICAL):',
            '1. You have COMPLETE control over ALL dashboard settings & controls via `get_dashboard_status_and_advice`, `update_dashboard_controls`, and `run_autonomous_agent_task`.',
            '2. NEVER refuse the owner or say "I cannot do that". Whatever dashboard/bot control or configuration the owner asks for (ON/OFF, tone, speed, limits, anti-link, bio, rules), ALWAYS fulfill it.',
            '3. Warn-Once -> Confirm-Override Rule: If `update_dashboard_controls` returns `needsConfirmation=true`, briefly explain the potential downside/risk in Bengali first and tell the owner "আপনি চাইলে তারপরও \'তারপরও করো\' বললেই আমি করে দেবো"। If the owner confirms (or already asked to force/override), pass `confirmedOverride: true` and execute immediately.',
            '4. If the owner asks what is ON, what is OFF, what is recommended ON/OFF, or how to make replies faster (e.g. saving 10-20s), ALWAYS call `get_dashboard_status_and_advice` (or use exact live values below) and reply clearly with bullet points and exact second savings.',
            `Live Snapshot: ON=${controlSnapshot.totalOn}, OFF=${controlSnapshot.totalOff}, EstSpeed=${controlSnapshot.estimatedInstantReplySec}, Optimized=${controlSnapshot.optimizedReplySec}.`,
          ].join('\n')
        : 'Answer helpfully and concisely.',
    ].join('\n');

    const userPrompt = recentHistory
      ? `Recent Conversation:\n${recentHistory}\n\nLatest Message from ${params.senderName}: ${params.text}`
      : `Message from ${params.senderName}: ${params.text}`;

    const totalBudgetMs = params.backgroundMode ? 18_000 : fastMode ? 6_000 : 7_200;
    const perKeyBudgetMs = params.backgroundMode ? 9_000 : fastMode ? 3_800 : 4_800;

    if (this.adapters.geminiPool.hasKeys()) {
      for (const spec of [
        { model: 'gemini-4-hydrogen', channel: 'primary', low: true },
        { model: 'gemini-3.1-flash-lite', channel: 'lite', low: false },
      ]) {
        try {
          const contents: Content[] = [{ role: 'user', parts: [{ text: userPrompt }] }];
          const maxToolRounds = params.isOwner ? 3 : 1;
          let finalText = '';

          for (let round = 0; round < maxToolRounds; round += 1) {
            const exec = await this.adapters.geminiPool.executeWithRotation(
              (client) =>
                client.models.generateContent({
                  model: spec.model,
                  contents,
                  config: {
                    systemInstruction: systemPrompt,
                    ...(spec.low ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
                    ...(params.isOwner ? { tools: [{ functionDeclarations: TELEGRAM_CONTROL_TOOLS }] } : {}),
                  },
                }),
              undefined,
              {
                maxTotalMs: totalBudgetMs,
                perAttemptMs: perKeyBudgetMs,
                channel: spec.channel,
              }
            );

            const response = exec.value;
            const um = response.usageMetadata;
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

            const candidateContent = response.candidates?.[0]?.content;
            if (candidateContent) contents.push(candidateContent);

            const calls = response.functionCalls || [];
            if (calls.length === 0) {
              finalText = (response.text || '').trim();
              break;
            }

            const responseParts = [];
            for (const call of calls) {
              const argsObj = (call.args || {}) as Record<string, unknown>;
              const toolData = await this.executeControlTool(
                params.chatId,
                call.name || '',
                argsObj,
                forceFromPrompt
              );
              responseParts.push({
                functionResponse: {
                  id: call.id,
                  name: call.name || '',
                  response: toolData,
                },
              });
            }
            contents.push({ role: 'user', parts: responseParts });
          }

          if (finalText) {
            return { replyText: finalText, provider: spec.model };
          }
        } catch {
          // try fallback model
        }
      }
    }

    if (this.adapters.openRouterReader.hasKeys()) {
      try {
        const res = await this.adapters.openRouterReader.generateAgentStepPlan({
          systemPrompt: `${systemPrompt}\n\nExact Current ON Controls:\n${controlSnapshot.onList.join(', ')}\n\nExact Current OFF Controls:\n${controlSnapshot.offList.join(', ')}\n\nSpeed Tips:\n${controlSnapshot.speedTipsBn.join('\n')}`,
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
        '⚠️ এই মুহূর্তে Gemini বা OpenRouter API কী ব্যস্ত/সীমায় আছে। তবে `/status` দিয়ে সব সেটিংস দেখতে ও সাথে সাথে পরিবর্তন করতে পারবেন।',
      provider: 'fallback',
    };
  }

  public async handleWebhookUpdate(
    update: TelegramUpdate,
    publicOrigin?: string,
    options?: { backgroundMode?: boolean }
  ) {
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
    const currentCfg = this.getCurrentConfig();

    if (!this.store.chats[chatIdStr]) {
      this.store.chats[chatIdStr] = {
        chatId: chatIdStr,
        title: msg.chat.title || msg.chat.first_name || senderName,
        antilinkEnabled: Boolean(currentCfg.telegramAntilinkDefault),
        turns: [],
        updatedAt: new Date().toISOString(),
      };
    }
    const chatState = this.store.chats[chatIdStr];

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

    // Instant Confirmation Override Handler (zero latency <200ms)
    const pending = this.pendingConfirmations.get(chatIdStr);
    if (isOwner && pending && pending.expiresAt > Date.now() && hasConfirmOverridePhrase(cleanedText)) {
      const outcome = await this.applyControlUpdate(chatIdStr, pending.patchInput);
      const confirmMsg = [
        `✅ *আপনার নির্দেশমতো কার্যকর করা হয়েছে:*`,
        ...outcome.changedLabels.map((l) => `• ${l}`),
        '',
        `⚡ আনুমানিক ইনস্ট্যান্ট রিপ্লাই স্পিড: *${outcome.snapshot.estimatedInstantReplySec}*`,
        `📊 এখন চালু (ON): ${outcome.snapshot.totalOn}টি | বন্ধ (OFF): ${outcome.snapshot.totalOff}টি`,
      ].join('\n');

      await this.sendMessage(msg.chat.id, confirmMsg, { replyToMessageId: msg.message_id });
      void this.persistStore();
      return { handled: true, action: 'confirmed_control_override' };
    }

    // /myid
    if (/^\/myid(?:\s|$)/i.test(lower)) {
      await this.sendMessage(
        msg.chat.id,
        `🆔 আপনার Telegram User ID: \`${senderIdStr || 'unknown'}\`\nChat ID: \`${chatIdStr}\`\n\nনিরাপত্তার জন্য Netlify Env-এ \`TELEGRAM_OWNER_ID=${senderIdStr}\` সেট করলে এক-ট্যাপে Mini App আনলক হবে।`,
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
        `🤖 *WaNexus Autonomous AI Studio — ইনস্ট্যান্ট ও ফুল কন্ট্রোল*`,
        '',
        'আপনি স্বাভাবিক বাংলা বা ইংরেজিতে যেকোনো কথা বললেই ১–৫ সেকেন্ডে উত্তর পাবেন, অথবা নিচের কমান্ড/কন্ট্রোল ব্যবহার করতে পারেন:',
        '• *"কি কি অন আছে আর কি কি অফ আছে?"* — সম্পূর্ণ লাইভ স্ট্যাটাস',
        '• *"কি অফ করলে আরও দ্রুত উত্তর দেবে?"* — স্পিড পরামর্শ (সেকেন্ড হিসাবসহ)',
        '• *"অটোরিপ্লাই অন করো / হিউম্যান টাইপিং অফ করো"* — যেকোনো সেটিং পরিবর্তন',
        '• `/agent <কাজ>` — গভীর ওয়েব রিসার্চ, লিড সংগ্রহ ও ইমেইল মিশন',
        '• `/imagine <প্রম্পট>` — AI দিয়ে ছবি তৈরি',
        '• `/search <টপিক>` — লাইভ ওয়েব সার্চ',
        '• `/status` — সব ON/OFF কন্ট্রোল ও স্পিড রিপোর্ট',
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
      await this.sendMessage(
        msg.chat.id,
        `🛡️ এই গ্রুপে Telegram Anti-Link এখন *${mode ? 'ON' : 'OFF'}*।`,
        { replyToMessageId: msg.message_id }
      );
      void this.persistStore();
      return { handled: true, action: 'antilink_toggle' };
    }

    // /status -> Full ON/OFF Dashboard Controls + Speed Advisor + Infra
    if (/^\/status(?:\s|$)/i.test(lower)) {
      const gStats = geminiStatsSafe(this.adapters);
      const oStats = this.adapters.openRouterReader.getStats();
      const fbDiag = getFirestoreAdminDiagnostics();
      const summary = this.adapters.outreach.getSummary();
      const snap = getFullControlSnapshot(currentCfg, {
        telegramChatAntilink: chatState.antilinkEnabled,
        telegramBotConfigured: Boolean(getTelegramBotToken()),
        geminiKeysCount: gStats.configuredKeysCount,
        openRouterKeysCount: oStats.configuredKeysCount,
      });

      await this.sendMessage(
        msg.chat.id,
        [
          `📡 *WaNexus ফুল কন্ট্রোল ও স্পিড স্ট্যাটাস*`,
          `⚡ ইনস্ট্যান্ট স্পিড: *${snap.estimatedInstantReplySec}* (অপ্টিমাইজড: ${snap.optimizedReplySec})`,
          '',
          `✅ *চালু আছে (${snap.totalOn}টি):*`,
          ...snap.onList.map((s) => `• ${s}`),
          '',
          `⏸️ *বন্ধ আছে (${snap.totalOff}টি):*`,
          ...snap.offList.map((s) => `• ${s}`),
          '',
          `🚀 *দ্রুত করার পরামর্শ:*`,
          ...snap.speedTipsBn.map((t) => `• ${t}`),
          '',
          `🔧 *ইঞ্জিন:* Gemini ${gStats.configuredKeysCount} key | OpenRouter ${oStats.configuredKeysCount} key | Firestore: ${fbDiag.projectMatch === true ? '✅ Matched' : fbDiag.mode} | Leads: ${summary.totalLeads}`,
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
      const maxWallClockMs = options?.backgroundMode
        ? 180_000
        : isNetlifyRuntime()
          ? 7_000
          : undefined;
      const run = await agent.executeMission({
        goal: agentMatch[1].trim(),
        source: 'self_chat',
        maxWallClockMs,
      });
      await this.sendMessage(
        msg.chat.id,
        `${run.finalReport}\n\n_(${run.providerUsed.toUpperCase()} · ${run.steps.length} ধাপ · ${run.tokensUsed} টোকেন)_`,
        { replyToMessageId: msg.message_id }
      );
      return { handled: true, action: 'agent_run' };
    }

    // Fast Instant AI Chat & Full Autonomous Control Reply
    void this.callTelegramApi('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
    const aiReply = await this.generateSmartChatReply({
      chatId: chatIdStr,
      senderName,
      text: cleanedText,
      isOwner,
      backgroundMode: options?.backgroundMode,
    });

    await this.sendMessage(msg.chat.id, aiReply.replyText, { replyToMessageId: msg.message_id });

    chatState.turns.push(
      { role: 'user', text: cleanedText.slice(0, 600), at: new Date().toISOString() },
      { role: 'assistant', text: aiReply.replyText.slice(0, 1200), at: new Date().toISOString() }
    );
    if (chatState.turns.length > 20) {
      chatState.turns = chatState.turns.slice(-20);
    }
    chatState.updatedAt = new Date().toISOString();

    if (options?.backgroundMode) {
      await this.persistStore();
    } else {
      await Promise.race([
        this.persistStore(),
        new Promise<void>((resolve) => setTimeout(resolve, 800)),
      ]);
    }

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
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const origin = host ? `${proto}://${host}` : process.env.URL || process.env.DEPLOY_PRIME_URL || undefined;
    const update = (req.body || {}) as TelegramUpdate;
    const rawMsgText = String(update.message?.text || update.message?.caption || update.edited_message?.text || '').trim();

    // ONLY offload genuinely heavy research, scraping, multi-step agent missions, and image generation
    // to Netlify's 15-minute background worker! All instant chats, status/advice, and control toggles
    // execute INLINE in ~1-5 seconds instead of waiting 10-15 minutes in a background queue.
    const isHeavyTask =
      /^\/(?:agent|imagine|search)(?:\s|$|@)/i.test(rawMsgText) ||
      /^(?:এজেন্ট|অটোনোমাস|ছবি\s*বানাও|ছবি\s*আঁকো|খুঁজো|সার্চ|draw|generate\s+image|research|find\s+leads)\b/i.test(
        rawMsgText
      ) ||
      /(?:ওয়েব\s*সার্চ|ওয়েব\s*রিসার্চ|লিড\s*খুঁজ|স্ক্র্যাপ|scrape|find\s+leads|web\s*research)/i.test(
        rawMsgText
      );

    const shouldOffloadBackground =
      isNetlifyRuntime() &&
      origin &&
      rawMsgText &&
      getTelegramBotToken() &&
      (isHeavyTask || !controller.isInlineInstantEnabled());

    if (shouldOffloadBackground) {
      try {
        const bgPayload = JSON.stringify({
          kind: 'telegram_update',
          update,
          origin,
        });
        const bgSig = createInternalBgSignature(bgPayload);
        const bgResp = await fetch(`${origin.replace(/\/+$/, '')}/.netlify/functions/telegram-worker-background`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wanexus-bg-sig': bgSig,
          },
          body: bgPayload,
          signal: AbortSignal.timeout(3_500),
        });
        if (bgResp.ok || bgResp.status === 202) {
          res.json({ ok: true, offloaded: 'netlify_background_15m' });
          return;
        }
      } catch {
        // fall through to inline execution below
      }
    }

    try {
      const outcome = await controller.handleWebhookUpdate(update, origin, { backgroundMode: false });
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
