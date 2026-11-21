import { GoogleGenAI } from '@google/genai';

export interface GeminiPoolStats {
  configuredKeysCount: number;
  activeKeySlot: number; // 1-based slot (0 if none configured)
  lastRotationReason: string | null;
  lastRotatedAt: string | null;
}

export interface GeminiExecutionResult<T> {
  value: T;
  keySlot: number; // 1-based slot that succeeded
}

export interface KeyRotationEvent {
  fromSlot: number;
  toSlot: number;
  totalSlots: number;
  reason: string;
}

export interface RotationOptions {
  maxTotalMs?: number;
  perAttemptMs?: number;
  channel?: string;
}

function isRealApiKey(candidate: string | undefined | null): candidate is string {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length < 15) return false;
  if (trimmed === 'MY_GEMINI_API_KEY' || trimmed.startsWith('YOUR_')) return false;
  return true;
}

export function collectConfiguredGeminiKeys(): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const pushKey = (raw: string | undefined) => {
    if (!isRealApiKey(raw)) return;
    const cleaned = raw.trim();
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      ordered.push(cleaned);
    }
  };

  // 1. Numbered keys first: GEMINI_API_KEY_1 ... GEMINI_API_KEY_10
  for (let i = 1; i <= 10; i += 1) {
    pushKey(process.env[`GEMINI_API_KEY_${i}`]);
  }

  // 2. Primary single key fallback: GEMINI_API_KEY
  pushKey(process.env.GEMINI_API_KEY);

  // 3. Optional comma/newline-separated list: GEMINI_API_KEYS="key1,key2,key3,key4,key5"
  const bulk = process.env.GEMINI_API_KEYS;
  if (bulk) {
    for (const part of bulk.split(/[\s,;]+/)) {
      pushKey(part);
    }
  }

  return ordered;
}

export class GeminiKeyPool {
  private readonly clients: GoogleGenAI[];
  private readonly cooldownsByChannel = new Map<string, number[]>();
  private activeIndex = 0;
  private lastRotationReason: string | null = null;
  private lastRotatedAt: string | null = null;

  constructor(keys: string[] = collectConfiguredGeminiKeys()) {
    this.clients = keys.map(
      (apiKey) =>
        new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        })
    );
  }

  private getCooldownArray(channel: string): number[] {
    let arr = this.cooldownsByChannel.get(channel);
    if (!arr || arr.length !== this.clients.length) {
      arr = new Array(this.clients.length).fill(0);
      this.cooldownsByChannel.set(channel, arr);
    }
    return arr;
  }

  public hasKeys(): boolean {
    return this.clients.length > 0;
  }

  public getStats(): GeminiPoolStats {
    return {
      configuredKeysCount: this.clients.length,
      activeKeySlot: this.clients.length > 0 ? this.activeIndex + 1 : 0,
      lastRotationReason: this.lastRotationReason,
      lastRotatedAt: this.lastRotatedAt,
    };
  }

  public getSlotCooldownStats(): Array<{
    slot: number;
    primaryCooldownSec: number;
    liteCooldownSec: number;
  }> {
    const now = Date.now();
    const primaryArr = this.getCooldownArray('primary');
    const liteArr = this.getCooldownArray('lite');
    const results: Array<{ slot: number; primaryCooldownSec: number; liteCooldownSec: number }> = [];
    for (let i = 0; i < this.clients.length; i += 1) {
      results.push({
        slot: i + 1,
        primaryCooldownSec: Math.max(0, Math.ceil((primaryArr[i] - now) / 1000)),
        liteCooldownSec: Math.max(0, Math.ceil((liteArr[i] - now) / 1000)),
      });
    }
    return results;
  }

  /**
   * Executes a Gemini API task using the current active key slot for a given model channel.
   * On any quota/rate-limit/API error, automatically rotates sequentially
   * through Key #1 -> #2 -> #3 -> #4 -> #5 and wraps back around to Key #1.
   * Preserves per-channel cooldowns so exhausted models fail over in 0ms.
   */
  public async executeWithRotation<T>(
    task: (ai: GoogleGenAI, keySlot: number) => Promise<T>,
    onRotate?: (event: KeyRotationEvent) => void,
    options?: RotationOptions
  ): Promise<GeminiExecutionResult<T>> {
    const total = this.clients.length;
    if (total === 0) {
      throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
    }

    const channel = options?.channel || 'primary';
    const cooldownUntil = this.getCooldownArray(channel);
    const now = Date.now();
    const maxTotalMs = options?.maxTotalMs ?? 9_000;
    const deadline = now + maxTotalMs;

    // Build ordered candidate indices starting from activeIndex, prioritizing non-cooled-down slots
    const startIdx = this.activeIndex % total;
    const readyOrder: number[] = [];

    for (let offset = 0; offset < total; offset += 1) {
      const idx = (startIdx + offset) % total;
      if (cooldownUntil[idx] <= now) {
        readyOrder.push(idx);
      }
    }

    if (readyOrder.length === 0) {
      const earliestUnlockMs = Math.min(...cooldownUntil);
      const waitSec = Math.max(1, Math.ceil((earliestUnlockMs - now) / 1000));
      throw new Error(
        `All ${total} Gemini API key(s) on [${channel}] are in cooldown (~${waitSec}s left); instant fail-over.`
      );
    }

    const attemptOrder = readyOrder;
    let lastError: Error = new Error('Unknown Gemini API error');

    for (let i = 0; i < attemptOrder.length; i += 1) {
      if (i > 0 && Date.now() >= deadline) {
        break;
      }

      const idx = attemptOrder[i];
      const keySlot = idx + 1;

      try {
        const remainingMs = Math.max(1_500, deadline - Date.now());
        const attemptBudgetMs = Math.min(options?.perAttemptMs ?? 12_000, remainingMs);
        const value = await new Promise<T>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Gemini Key #${keySlot} timed out after ${attemptBudgetMs}ms`)),
            attemptBudgetMs
          );
          task(this.clients[idx], keySlot).then(
            (res) => {
              clearTimeout(timer);
              resolve(res);
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            }
          );
        });
        // Keep activeIndex pinned on the healthy key that succeeded and clear its cooldown on this channel
        this.activeIndex = idx;
        cooldownUntil[idx] = 0;
        return { value, keySlot };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(reason);

        // Apply accurate cooldown per error type so exhausted/rate-limited keys are skipped quickly
        const lowerReason = reason.toLowerCase();
        const isHardAuthError =
          lowerReason.includes('api_key_invalid') ||
          lowerReason.includes('permission_denied') ||
          lowerReason.includes('403') ||
          lowerReason.includes('401');
        const isQuotaError =
          lowerReason.includes('429') ||
          lowerReason.includes('resource_exhausted') ||
          lowerReason.includes('quota') ||
          lowerReason.includes('rate limit');
        const isTimeoutError = lowerReason.includes('timed out') || lowerReason.includes('timeout');
        const cooldownMs = isHardAuthError
          ? 120_000
          : isQuotaError
            ? 45_000
            : isTimeoutError
              ? 25_000
              : 20_000;
        cooldownUntil[idx] = Date.now() + cooldownMs;

        const nextIdx = (idx + 1) % total;
        this.activeIndex = nextIdx;
        this.lastRotationReason = `[${channel}] Key #${keySlot}: ${reason.slice(0, 130)}`;
        this.lastRotatedAt = new Date().toISOString();

        if (total > 1) {
          onRotate?.({
            fromSlot: keySlot,
            toSlot: nextIdx + 1,
            totalSlots: total,
            reason,
          });
        }
      }
    }

    // Keep cooldown timestamps intact so the next message fails over in 0ms until keys recover
    this.activeIndex = 0;
    throw new Error(
      `All ${total} Gemini API key(s) failed on [${channel}]. Last error: ${lastError.message}`
    );
  }
}
