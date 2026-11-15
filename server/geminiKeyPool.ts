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
  private readonly cooldownUntil: number[];
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
    this.cooldownUntil = new Array(this.clients.length).fill(0);
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

  /**
   * Executes a Gemini API task using the current active key slot.
   * On any quota/rate-limit/API error, automatically rotates sequentially
   * through Key #1 -> #2 -> #3 -> #4 -> #5 and wraps back around to Key #1.
   * Skips keys currently in short failure cooldown unless all keys are cooled down,
   * and enforces a hard total time budget so replies never stall.
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

    const now = Date.now();
    const maxTotalMs = options?.maxTotalMs ?? 9_000;
    const deadline = now + maxTotalMs;

    // Build ordered candidate indices starting from activeIndex, prioritizing non-cooled-down slots
    const startIdx = this.activeIndex % total;
    const readyOrder: number[] = [];
    const cooledOrder: number[] = [];

    for (let offset = 0; offset < total; offset += 1) {
      const idx = (startIdx + offset) % total;
      if (this.cooldownUntil[idx] <= now) {
        readyOrder.push(idx);
      } else {
        cooledOrder.push(idx);
      }
    }

    const attemptOrder = readyOrder.length > 0 ? readyOrder : cooledOrder;
    let lastError: Error = new Error('Unknown Gemini API error');

    for (let i = 0; i < attemptOrder.length; i += 1) {
      if (i > 0 && Date.now() >= deadline) {
        break;
      }

      const idx = attemptOrder[i];
      const keySlot = idx + 1;

      try {
        const value = await task(this.clients[idx], keySlot);
        // Keep activeIndex pinned on the healthy key that succeeded and clear its cooldown
        this.activeIndex = idx;
        this.cooldownUntil[idx] = 0;
        return { value, keySlot };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(reason);

        // Apply short cooldown on failing key so subsequent messages don't stall re-testing it
        const lowerReason = reason.toLowerCase();
        const isHardAuthError =
          lowerReason.includes('api_key_invalid') ||
          lowerReason.includes('permission_denied') ||
          lowerReason.includes('403') ||
          lowerReason.includes('401');
        const cooldownMs = isHardAuthError ? 120_000 : 20_000;
        this.cooldownUntil[idx] = Date.now() + cooldownMs;

        const nextIdx = (idx + 1) % total;
        this.activeIndex = nextIdx;
        this.lastRotationReason = `Key #${keySlot}: ${reason.slice(0, 140)}`;
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

    // All attempted keys failed -> wrap cycle cleanly back to Key #1 for the next cycle
    this.activeIndex = 0;
    for (let i = 0; i < this.cooldownUntil.length; i += 1) {
      if (this.cooldownUntil[i] <= Date.now() + 20_000) {
        this.cooldownUntil[i] = 0;
      }
    }
    throw new Error(
      `All ${total} Gemini API key(s) failed in this rotation cycle. Last error: ${lastError.message}`
    );
  }
}
