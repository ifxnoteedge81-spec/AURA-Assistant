export interface OpenRouterModelPricing {
  prompt?: string | number | null;
  completion?: string | number | null;
  request?: string | number | null;
  image?: string | number | null;
}

export interface OpenRouterModelCatalogEntry {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: OpenRouterModelPricing;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

export interface DynamicFreePoolStats {
  discoveredFreeModelsCount: number;
  activeFreeModel: string;
  lastModelsSyncAt: string | null;
  lastModelRotationReason: string | null;
  freeModelsSample: string[];
}

export interface DynamicCompletionParams {
  keys: string[];
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  onModelRotate?: (info: {
    fromModel: string;
    toModel: string;
    reason: string;
    attempt: number;
    totalCandidates: number;
  }) => void;
}

export interface DynamicCompletionResult {
  content: string;
  modelUsed: string;
  keyIndexUsed: number;
  attemptsUsed: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CATALOG_CACHE_TTL_MS = 15 * 60_000; // Refresh free model catalog every 15 minutes

// Safe emergency seed list used only if /api/v1/models is unreachable on first call
const SEED_FREE_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-3-27b-it:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
];

const NON_CHAT_PATTERNS = [
  /embed/i,
  /whisper/i,
  /tts/i,
  /speech/i,
  /audio/i,
  /dall-e/i,
  /flux/i,
  /stable-diffusion/i,
  /imagen/i,
  /rerank/i,
  /moderation/i,
  /guard/i,
];

function isZeroPrice(raw: string | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'number') return raw === 0;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

export function isFreeChatModelEntry(entry: OpenRouterModelCatalogEntry): boolean {
  const id = String(entry?.id || '').trim();
  if (!id) return false;

  if (NON_CHAT_PATTERNS.some((pattern) => pattern.test(id))) {
    return false;
  }

  const outputModalities = entry.architecture?.output_modalities;
  if (Array.isArray(outputModalities) && outputModalities.length > 0 && !outputModalities.includes('text')) {
    return false;
  }

  const hasFreeSuffix = id.endsWith(':free') || id === 'openrouter/free';
  const promptFree = isZeroPrice(entry.pricing?.prompt);
  const completionFree = isZeroPrice(entry.pricing?.completion);
  const requestFree = entry.pricing?.request == null || isZeroPrice(entry.pricing.request);
  const imageFree = entry.pricing?.image == null || isZeroPrice(entry.pricing.image);

  return hasFreeSuffix || (promptFree && completionFree && requestFree && imageFree);
}

function scoreFreeModelPriority(modelId: string, preferredCustomModel?: string): number {
  const lower = modelId.toLowerCase();
  if (preferredCustomModel && lower === preferredCustomModel.toLowerCase()) return 1000;
  if (lower === 'openrouter/free') return 950;
  if (lower.includes('llama-3.3-70b')) return 900;
  if (lower.includes('qwen') && lower.includes('72b')) return 880;
  if (lower.includes('deepseek') && (lower.includes('chat') || lower.includes('v3'))) return 860;
  if (lower.includes('gemma-3-27b')) return 840;
  if (lower.includes('mistral-small') || lower.includes('nemo')) return 820;
  if (lower.includes('gemini')) return 810;
  if (lower.includes('llama-3.1') || lower.includes('llama-3.2') || lower.includes('llama-4')) return 790;
  if (lower.includes('qwen') || lower.includes('gemma') || lower.includes('glm') || lower.includes('kimi')) return 760;
  if (lower.endsWith(':free')) return 700;
  return 600;
}

export function filterAndSortFreeModels(
  catalog: OpenRouterModelCatalogEntry[],
  preferredCustomModel?: string
): string[] {
  const uniqueIds = new Set<string>();

  for (const item of catalog) {
    if (isFreeChatModelEntry(item)) {
      uniqueIds.add(item.id.trim());
    }
  }

  // Always include OpenRouter's native free router as a resilient safety entry
  uniqueIds.add('openrouter/free');

  const sorted = Array.from(uniqueIds).sort((a, b) => {
    const scoreDiff = scoreFreeModelPriority(b, preferredCustomModel) - scoreFreeModelPriority(a, preferredCustomModel);
    if (scoreDiff !== 0) return scoreDiff;
    return a.localeCompare(b);
  });

  return sorted;
}

export class OpenRouterDynamicPool {
  private cachedFreeModels: string[] = [...SEED_FREE_MODELS];
  private lastModelsSyncAtMs = 0;
  private lastModelsSyncIso: string | null = null;
  private refreshInFlight: Promise<string[]> | null = null;

  private activeModelIndex = 0;
  private activeKeyIndex = 0;
  private readonly modelCooldownUntil = new Map<string, number>();
  private readonly keyCooldownUntil = new Map<string, number>();
  private lastModelRotationReason: string | null = null;
  private lastSucceededModel: string = SEED_FREE_MODELS[0];

  private readonly preferredCustomModel?: string;

  constructor(preferredCustomModel?: string) {
    const cleaned = preferredCustomModel?.trim();
    this.preferredCustomModel = cleaned || undefined;
    if (this.preferredCustomModel) {
      this.cachedFreeModels = [
        this.preferredCustomModel,
        ...SEED_FREE_MODELS.filter((m) => m !== this.preferredCustomModel),
      ];
      this.lastSucceededModel = this.preferredCustomModel;
    }
  }

  public getStats(): DynamicFreePoolStats {
    return {
      discoveredFreeModelsCount: this.cachedFreeModels.length,
      activeFreeModel: this.lastSucceededModel || this.cachedFreeModels[0] || 'openrouter/free',
      lastModelsSyncAt: this.lastModelsSyncIso,
      lastModelRotationReason: this.lastModelRotationReason,
      freeModelsSample: this.cachedFreeModels.slice(0, 8),
    };
  }

  /**
   * 1. Dynamically fetches all free models (pricing=0 or ending with :free)
   * from https://openrouter.ai/api/v1/models and caches them cleanly.
   */
  public async getFreeModels(apiKey?: string, forceRefresh = false): Promise<string[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.lastModelsSyncAtMs > 0 &&
      now - this.lastModelsSyncAtMs < CATALOG_CACHE_TTL_MS &&
      this.cachedFreeModels.length > 0
    ) {
      return this.cachedFreeModels;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const resp = await fetch(OPENROUTER_MODELS_URL, {
          method: 'GET',
          signal: controller.signal,
          headers,
        });

        if (!resp.ok) {
          throw new Error(`OpenRouter models catalog HTTP ${resp.status}`);
        }

        const payload = (await resp.json()) as { data?: OpenRouterModelCatalogEntry[] };
        const entries = Array.isArray(payload?.data) ? payload.data : [];
        const discovered = filterAndSortFreeModels(entries, this.preferredCustomModel);

        if (discovered.length > 0) {
          this.cachedFreeModels = discovered;
          this.lastModelsSyncAtMs = Date.now();
          this.lastModelsSyncIso = new Date().toISOString();
          if (this.activeModelIndex >= discovered.length) {
            this.activeModelIndex = 0;
          }
        }
        return this.cachedFreeModels;
      } catch (err) {
        this.lastModelRotationReason = `Models sync fallback: ${(err as Error).message.slice(0, 100)}`;
        return this.cachedFreeModels;
      } finally {
        clearTimeout(timer);
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  private pickHealthyKeyIndex(keys: string[], now: number): number {
    if (keys.length === 0) return -1;
    const start = this.activeKeyIndex % keys.length;
    for (let offset = 0; offset < keys.length; offset += 1) {
      const idx = (start + offset) % keys.length;
      const until = this.keyCooldownUntil.get(keys[idx]) || 0;
      if (until <= now) return idx;
    }
    return start;
  }

  private getModelCooldownMs(status: number, errMsg: string): number {
    const lower = errMsg.toLowerCase();
    if (status === 404 || lower.includes('no endpoints found') || lower.includes('not found')) {
      return 10 * 60_000; // 10 min skip for unavailable / data-policy blocked free models
    }
    if (status === 429 || lower.includes('rate limit') || lower.includes('quota')) {
      return 60_000; // 60 sec cooldown for rate-limited model
    }
    if (status === 400 || status === 402 || status === 422) {
      return 5 * 60_000;
    }
    return 30_000; // Transient 5xx / timeout / empty completion
  }

  /**
   * 2 & 3. Auto-Rotation & Fallback Execution Loop:
   * Tries the first active free model; on ANY 404, 429, 5xx, timeout, or empty output,
   * automatically rotates to the next free model in the dynamic catalog until one succeeds.
   */
  public async executeWithModelRotation(params: DynamicCompletionParams): Promise<DynamicCompletionResult> {
    const { keys } = params;
    if (!keys || keys.length === 0) {
      throw new Error('OPENROUTER_API_KEY is not configured.');
    }

    const now = Date.now();
    const initialKeyIdx = this.pickHealthyKeyIndex(keys, now);
    const models = await this.getFreeModels(keys[initialKeyIdx]);

    // Build ordered model list starting from activeModelIndex, prioritizing non-cooled-down models
    const totalModels = models.length;
    const startModelIdx = this.activeModelIndex % totalModels;
    const readyModels: string[] = [];
    const cooledModels: string[] = [];

    for (let offset = 0; offset < totalModels; offset += 1) {
      const candidate = models[(startModelIdx + offset) % totalModels];
      const cooledUntil = this.modelCooldownUntil.get(candidate) || 0;
      if (cooledUntil <= now) {
        readyModels.push(candidate);
      } else {
        cooledModels.push(candidate);
      }
    }

    // If all models happened to be in cooldown, still try top candidates instead of giving up
    const candidateModels = readyModels.length > 0 ? readyModels : models.slice(0, 8);
    const maxAttempts = Math.min(candidateModels.length, 12);
    const perAttemptTimeoutMs = Math.min(Math.max(params.timeoutMs ?? 5_500, 3_500), 8_500);
    const totalDeadline = Date.now() + Math.max(perAttemptTimeoutMs * 3.5, 19_000);

    let lastError: Error = new Error('All OpenRouter free models failed in this rotation cycle.');
    let keyIdx = initialKeyIdx;
    let attemptsUsed = 0;

    for (let i = 0; i < maxAttempts; i += 1) {
      if (i > 0 && Date.now() >= totalDeadline) {
        break;
      }

      const model = candidateModels[i];
      const apiKey = keys[keyIdx];
      attemptsUsed += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perAttemptTimeoutMs);

      try {
        const resp = await fetch(OPENROUTER_CHAT_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer':
              process.env.APP_URL ||
              (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : '') ||
              process.env.RENDER_EXTERNAL_URL ||
              'https://wanexus.app',
            'X-Title': 'Aura Assistant Executive Brain',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: params.systemPrompt },
              { role: 'user', content: params.userPrompt },
            ],
            max_tokens: params.maxTokens ?? 320,
            temperature: params.temperature ?? 0.75,
          }),
        });

        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          const errMsg = `OpenRouter HTTP ${resp.status} (${model}): ${errBody.slice(0, 140)}`;

          // Rotate API key immediately on key-level auth/credit failures (401/402/403/429)
          if ((resp.status === 401 || resp.status === 402 || resp.status === 403 || resp.status === 429) && keys.length > 1) {
            if (resp.status === 401 || resp.status === 403) {
              this.keyCooldownUntil.set(apiKey, Date.now() + 120_000);
            }
            keyIdx = (keyIdx + 1) % keys.length;
            this.activeKeyIndex = keyIdx;
          }

          const cooldownMs = this.getModelCooldownMs(resp.status, errBody);
          this.modelCooldownUntil.set(model, Date.now() + cooldownMs);

          const nextModel = candidateModels[i + 1] || candidateModels[0];
          this.lastModelRotationReason = `${model} -> ${nextModel} (HTTP ${resp.status})`;
          params.onModelRotate?.({
            fromModel: model,
            toModel: nextModel,
            reason: errMsg,
            attempt: attemptsUsed,
            totalCandidates: maxAttempts,
          });

          throw new Error(errMsg);
        }

        const data = (await resp.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const content = data?.choices?.[0]?.message?.content?.trim();
        if (!content) {
          this.modelCooldownUntil.set(model, Date.now() + 30_000);
          throw new Error(`OpenRouter (${model}) returned an empty completion.`);
        }

        // Success! Pin activeModelIndex & activeKeyIndex on the working pair
        const resolvedIdx = models.indexOf(model);
        if (resolvedIdx >= 0) {
          this.activeModelIndex = resolvedIdx;
        }
        this.activeKeyIndex = keyIdx;
        this.modelCooldownUntil.delete(model);
        this.lastSucceededModel = data?.model || model;

        const promptTokens = Number(data?.usage?.prompt_tokens || 0);
        const completionTokens = Number(data?.usage?.completion_tokens || 0);
        const totalTokens = Number(data?.usage?.total_tokens || promptTokens + completionTokens);

        return {
          content,
          modelUsed: this.lastSucceededModel,
          keyIndexUsed: keyIdx,
          attemptsUsed,
          usage: totalTokens > 0 ? { promptTokens, completionTokens, totalTokens } : undefined,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!lastError.message.includes('OpenRouter HTTP')) {
          this.modelCooldownUntil.set(model, Date.now() + 30_000);
          const nextModel = candidateModels[i + 1] || candidateModels[0];
          this.lastModelRotationReason = `${model} -> ${nextModel} (${lastError.message.slice(0, 60)})`;
        }
        const modelIdxInCatalog = models.indexOf(model);
        if (modelIdxInCatalog >= 0) {
          this.activeModelIndex = (modelIdxInCatalog + 1) % totalModels;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }
}
