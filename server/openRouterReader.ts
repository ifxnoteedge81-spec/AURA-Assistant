import { OpenRouterDynamicPool, type DynamicFreePoolStats } from './openRouterDynamicModels.ts';

export interface OpenRouterStats {
  configuredKeysCount: number;
  primaryModel: string;
  lastSummaryAt: string | null;
  lastFallbackAt: string | null;
  lastError: string | null;
  dynamicPool?: DynamicFreePoolStats;
}

export interface OpenRouterTurnInput {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

const DEFAULT_OPENROUTER_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
];

function isRealOpenRouterKey(raw: string | undefined | null): raw is string {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 15) return false;
  if (trimmed.startsWith('YOUR_') || trimmed === 'MY_OPENROUTER_API_KEY') return false;
  return true;
}

export function collectConfiguredOpenRouterKeys(): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const pushKey = (raw: string | undefined) => {
    if (!isRealOpenRouterKey(raw)) return;
    const cleaned = raw.trim();
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      ordered.push(cleaned);
    }
  };

  for (let i = 1; i <= 5; i += 1) {
    pushKey(process.env[`OPENROUTER_API_KEY_${i}`]);
  }
  pushKey(process.env.OPENROUTER_API_KEY);
  if (process.env.OPENROUTER_API_KEYS) {
    for (const part of process.env.OPENROUTER_API_KEYS.split(/[\s,;]+/)) {
      pushKey(part);
    }
  }

  return ordered;
}

export class OpenRouterReader {
  private readonly keys: string[];
  private readonly models: string[];
  private readonly dynamicPool: OpenRouterDynamicPool;
  private lastSummaryAt: string | null = null;
  private lastFallbackAt: string | null = null;
  private lastError: string | null = null;
  private onUsageHook?: (info: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => void;

  constructor(keys: string[] = collectConfiguredOpenRouterKeys()) {
    this.keys = keys;
    const customModel = process.env.OPENROUTER_MODEL?.trim();
    this.models = customModel
      ? [customModel, ...DEFAULT_OPENROUTER_MODELS.filter((m) => m !== customModel)]
      : DEFAULT_OPENROUTER_MODELS;
    this.dynamicPool = new OpenRouterDynamicPool(customModel);

    // Pre-warm live free model catalog from https://openrouter.ai/api/v1/models
    if (this.keys.length > 0) {
      void this.dynamicPool.getFreeModels(this.keys[0]);
    }
  }

  public setUsageHook(
    hook: (info: {
      model: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }) => void
  ) {
    this.onUsageHook = hook;
  }

  public getPrimaryKey(): string | undefined {
    return this.keys[0];
  }

  public hasKeys(): boolean {
    return this.keys.length > 0;
  }

  public getStats(): OpenRouterStats {
    const poolStats = this.dynamicPool.getStats();
    return {
      configuredKeysCount: this.keys.length,
      primaryModel: poolStats.activeFreeModel || this.models[0],
      lastSummaryAt: this.lastSummaryAt,
      lastFallbackAt: this.lastFallbackAt,
      lastError: this.lastError,
      dynamicPool: poolStats,
    };
  }

  public async refreshFreeModelsCatalog(): Promise<string[]> {
    return this.dynamicPool.getFreeModels(this.keys[0], true);
  }

  private async callChatCompletion(params: {
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
    maxTokens?: number;
  }): Promise<{
    content: string;
    modelUsed: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    if (this.keys.length === 0) {
      throw new Error('OPENROUTER_API_KEY is not configured.');
    }

    try {
      const result = await this.dynamicPool.executeWithModelRotation({
        keys: this.keys,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        timeoutMs: params.timeoutMs,
        maxTokens: params.maxTokens,
      });
      this.lastError = null;
      if (result.usage) {
        this.onUsageHook?.({
          model: result.modelUsed,
          ...result.usage,
        });
      }
      return {
        content: result.content,
        modelUsed: result.modelUsed,
        usage: result.usage,
      };
    } catch (err) {
      const lastErr = err instanceof Error ? err : new Error(String(err));
      this.lastError = lastErr.message.slice(0, 160);
      throw lastErr;
    }
  }

  /**
   * Background Reader Role:
   * Reads full recent inbox messages (including Sir's own manual replies + time-lapse history)
   * and distills a sharp Relationship, Debate & Emotion Profile Summary (< 900 chars)
   * so Gemini replies instantly with complete memory of who the contact is and what was discussed.
   */
  public async summarizeInboxMemory(params: {
    contactName: string;
    existingSummary: string;
    turns: OpenRouterTurnInput[];
    ownerName: string;
  }): Promise<string | null> {
    if (!this.hasKeys() || params.turns.length === 0) return null;

    const transcript = params.turns
      .slice(-20)
      .map((t) => {
        const speaker = t.role === 'user' ? params.contactName || 'Contact' : 'Sir/Assistant';
        const timeTag = t.timestamp ? t.timestamp.slice(0, 16).replace('T', ' ') : '';
        return `[${timeTag}] ${speaker}: ${t.text}`;
      })
      .join('\n');

    const systemPrompt = [
      `You are the silent Inbox Memory Reader & Emotional Strategist for "${params.ownerName || 'Sir'}".`,
      'Your ONLY job is to read the full WhatsApp inbox thread and write a compact, rich memory brief (max 750 characters) in clear English/Banglish/Bengali.',
      'Include: (1) Who this contact seems to be & relationship dynamic, (2) Key facts, promises, arguments/debates, or unresolved topics discussed (especially anything Sir himself said), (3) Contact current emotional mood & recommended emotional/logical reply angle next time.',
      'Output ONLY the concise summary text (no intro, no markdown headers, under 750 chars).',
    ].join('\n');

    const userPrompt = [
      params.existingSummary ? `Previous Summary:\n${params.existingSummary}` : '',
      `Full Recent Inbox Thread (${params.turns.slice(-20).length} messages):\n${transcript}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const { content: summary } = await this.callChatCompletion({
      systemPrompt,
      userPrompt,
      timeoutMs: 6_500,
      maxTokens: 240,
    });

    this.lastSummaryAt = new Date().toISOString();
    return summary.replace(/\s+/g, ' ').trim().slice(0, 900);
  }

  /**
   * Fail-Safe Responder Role:
   * Only runs if ALL 5 Gemini API keys fail or hit quota in the same cycle,
   * ensuring the user still receives a genuine AI emotional & logical reply.
   */
  public async generateFallbackReply(params: {
    systemInstruction: string;
    promptContent: string;
  }): Promise<string> {
    const detailed = await this.generateFallbackReplyDetailed(params);
    return detailed.content;
  }

  public async generateFallbackReplyDetailed(params: {
    systemInstruction: string;
    promptContent: string;
  }): Promise<{
    content: string;
    modelUsed: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const result = await this.callChatCompletion({
      systemPrompt: `${params.systemInstruction}\n\nRespond ONLY with valid JSON: {"replyText":"...","detectedDistrict":"Standard","noteSummary":"","noteUrgency":"normal"}`,
      userPrompt: params.promptContent,
      timeoutMs: 6_500,
      maxTokens: 280,
    });
    this.lastFallbackAt = new Date().toISOString();
    return result;
  }

  /**
   * Group Clone Fail-Safe Role:
   * Runs if Gemini keys fail during a group chat turn so the Owner Clone
   * can still decide smartly: reply, react, reply_and_react, or stay silent.
   */
  public async generateGroupFallbackReply(params: {
    systemInstruction: string;
    promptContent: string;
  }): Promise<string> {
    const detailed = await this.generateGroupFallbackReplyDetailed(params);
    return detailed.content;
  }

  public async generateGroupFallbackReplyDetailed(params: {
    systemInstruction: string;
    promptContent: string;
  }): Promise<{
    content: string;
    modelUsed: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const result = await this.callChatCompletion({
      systemPrompt: `${params.systemInstruction}\n\nRespond ONLY with valid JSON: {"action":"reply|react|reply_and_react|silent","replyText":"...","reactionEmoji":"😂","shouldQuote":false,"detectedDistrict":"Standard","reason":"short reason"}`,
      userPrompt: params.promptContent,
      timeoutMs: 6_500,
      maxTokens: 260,
    });
    this.lastFallbackAt = new Date().toISOString();
    return result;
  }
}
