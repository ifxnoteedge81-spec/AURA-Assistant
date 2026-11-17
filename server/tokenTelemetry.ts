import fs from 'node:fs';
import path from 'node:path';

export type TokenCallCategory = 'group' | 'dm' | 'command' | 'summary';
export type TokenProviderName = 'gemini' | 'openrouter';

export interface RecordedUsageEvent {
  provider: TokenProviderName;
  model: string;
  keySlot?: number;
  category: TokenCallCategory;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CategoryTokenStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgTokensPerMsg: number;
}

export interface KeySlotTelemetry {
  slot: number;
  requestsToday: number;
  tokensToday: number;
  primaryCooldownSec: number;
  liteCooldownSec: number;
  dailyExhausted: boolean;
  lastError: string | null;
  status: 'ready' | 'cooldown' | 'daily_exhausted';
}

export interface OpenRouterKeyTelemetry {
  checkedAt: string | null;
  limitRemaining: number | null;
  usageDaily: number | null;
  isFreeTier: boolean | null;
}

export interface TokenTelemetrySnapshot {
  date: string;
  todayTotalTokens: number;
  todayPromptTokens: number;
  todayCompletionTokens: number;
  todayTotalCalls: number;
  lifetimeTotalTokens: number;
  lifetimeTotalCalls: number;
  byCategory: {
    group: CategoryTokenStats;
    dm: CategoryTokenStats;
    command: CategoryTokenStats;
    summary: CategoryTokenStats;
  };
  avgTokensPerGroupMsg: number | null;
  avgTokensPerDmMsg: number | null;
  avgTokensOverall: number | null;
  whatsappSafeCap: {
    usedToday: number;
    limit: number;
    remaining: number;
  };
  geminiPool: {
    configuredKeysCount: number;
    readyKeysCount: number;
    exhaustedKeysCount: number;
    estimatedRpdPerKey: number;
    totalRpdCapacity: number;
    usedRpdToday: number;
    remainingRpdToday: number;
    estimatedTpdCapacity: number;
    remainingTokensToday: number;
    estimatedGroupMsgsLeft: number;
    estimatedDmMsgsLeft: number;
    slots: KeySlotTelemetry[];
  };
  openRouter: {
    configuredKeysCount: number;
    discoveredFreeModelsCount: number;
    activeFreeModel: string;
    requestsToday: number;
    tokensToday: number;
    keyMeta: OpenRouterKeyTelemetry;
  };
  lastCall: {
    at: string;
    provider: TokenProviderName;
    model: string;
    category: TokenCallCategory;
    totalTokens: number;
    keySlot?: number;
  } | null;
}

interface PersistedTokenState {
  date: string;
  todayPromptTokens: number;
  todayCompletionTokens: number;
  todayTotalTokens: number;
  todayTotalCalls: number;
  lifetimeTotalTokens: number;
  lifetimeTotalCalls: number;
  openRouterRequestsToday: number;
  openRouterTokensToday: number;
  perKeyToday: Record<string, { requests: number; tokens: number; exhausted: boolean; lastError: string | null }>;
  categories: Record<
    TokenCallCategory,
    { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }
  >;
  lastCall: TokenTelemetrySnapshot['lastCall'];
}

// Conservative baseline per Gemini API key (free-tier Flash-Lite/Flash combined daily ceiling)
const GEMINI_ESTIMATED_RPD_PER_KEY = Number(process.env.GEMINI_RPD_PER_KEY || 1000);
const GEMINI_ESTIMATED_TPD_PER_KEY = Number(process.env.GEMINI_TPD_PER_KEY || 1_000_000);

function getBdDateKey(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function emptyCategories(): PersistedTokenState['categories'] {
  return {
    group: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    dm: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    command: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    summary: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

function createFreshDayState(date: string, lifetimeTotalTokens = 0, lifetimeTotalCalls = 0): PersistedTokenState {
  return {
    date,
    todayPromptTokens: 0,
    todayCompletionTokens: 0,
    todayTotalTokens: 0,
    todayTotalCalls: 0,
    lifetimeTotalTokens,
    lifetimeTotalCalls,
    openRouterRequestsToday: 0,
    openRouterTokensToday: 0,
    perKeyToday: {},
    categories: emptyCategories(),
    lastCall: null,
  };
}

export class TokenTelemetryTracker {
  private readonly filePath: string;
  private state: PersistedTokenState;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private openRouterKeyMeta: OpenRouterKeyTelemetry = {
    checkedAt: null,
    limitRemaining: null,
    usageDaily: null,
    isFreeTier: null,
  };
  private lastOpenRouterKeyCheckMs = 0;

  constructor(filePath = './bot-token-usage.json') {
    this.filePath = path.resolve(filePath);
    this.state = this.loadState();
    this.rollDateIfNeeded();
  }

  private loadState(): PersistedTokenState {
    const today = getBdDateKey();
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PersistedTokenState>;
        if (parsed && typeof parsed === 'object') {
          const base = createFreshDayState(
            typeof parsed.date === 'string' ? parsed.date : today,
            Number(parsed.lifetimeTotalTokens || 0),
            Number(parsed.lifetimeTotalCalls || 0)
          );
          if (base.date === today) {
            base.todayPromptTokens = Number(parsed.todayPromptTokens || 0);
            base.todayCompletionTokens = Number(parsed.todayCompletionTokens || 0);
            base.todayTotalTokens = Number(parsed.todayTotalTokens || 0);
            base.todayTotalCalls = Number(parsed.todayTotalCalls || 0);
            base.openRouterRequestsToday = Number(parsed.openRouterRequestsToday || 0);
            base.openRouterTokensToday = Number(parsed.openRouterTokensToday || 0);
            base.perKeyToday = parsed.perKeyToday && typeof parsed.perKeyToday === 'object' ? parsed.perKeyToday : {};
            const cats = parsed.categories;
            if (cats) {
              for (const k of ['group', 'dm', 'command', 'summary'] as const) {
                if (cats[k]) {
                  base.categories[k] = {
                    calls: Number(cats[k].calls || 0),
                    promptTokens: Number(cats[k].promptTokens || 0),
                    completionTokens: Number(cats[k].completionTokens || 0),
                    totalTokens: Number(cats[k].totalTokens || 0),
                  };
                }
              }
            }
            base.lastCall = parsed.lastCall || null;
          }
          return base;
        }
      }
    } catch {
      // ignore corrupted file
    }
    return createFreshDayState(today);
  }

  private rollDateIfNeeded() {
    const today = getBdDateKey();
    if (this.state.date !== today) {
      this.state = createFreshDayState(today, this.state.lifetimeTotalTokens, this.state.lifetimeTotalCalls);
      this.schedulePersist();
    }
  }

  private schedulePersist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.promises.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8').catch(() => {});
    }, 1000);
    this.saveTimer.unref?.();
  }

  public recordUsage(event: RecordedUsageEvent) {
    this.rollDateIfNeeded();
    const prompt = Math.max(0, Math.round(event.promptTokens || 0));
    const completion = Math.max(0, Math.round(event.completionTokens || 0));
    const total = Math.max(prompt + completion, Math.round(event.totalTokens || 0));
    if (total <= 0) return;

    this.state.todayPromptTokens += prompt;
    this.state.todayCompletionTokens += completion;
    this.state.todayTotalTokens += total;
    this.state.todayTotalCalls += 1;
    this.state.lifetimeTotalTokens += total;
    this.state.lifetimeTotalCalls += 1;

    const cat = this.state.categories[event.category];
    cat.calls += 1;
    cat.promptTokens += prompt;
    cat.completionTokens += completion;
    cat.totalTokens += total;

    if (event.provider === 'gemini' && event.keySlot && event.keySlot > 0) {
      const k = String(event.keySlot);
      const slotRec = (this.state.perKeyToday[k] ||= {
        requests: 0,
        tokens: 0,
        exhausted: false,
        lastError: null,
      });
      slotRec.requests += 1;
      slotRec.tokens += total;
      slotRec.exhausted = false;
      slotRec.lastError = null;
    } else if (event.provider === 'openrouter') {
      this.state.openRouterRequestsToday += 1;
      this.state.openRouterTokensToday += total;
    }

    this.state.lastCall = {
      at: new Date().toISOString(),
      provider: event.provider,
      model: event.model,
      category: event.category,
      totalTokens: total,
      keySlot: event.keySlot,
    };

    this.schedulePersist();
  }

  public markGeminiSlotError(keySlot: number, reason: string) {
    this.rollDateIfNeeded();
    if (!keySlot || keySlot < 1) return;
    const k = String(keySlot);
    const slotRec = (this.state.perKeyToday[k] ||= {
      requests: 0,
      tokens: 0,
      exhausted: false,
      lastError: null,
    });
    const lower = reason.toLowerCase();
    const looksDailyLimit =
      lower.includes('per_day') ||
      lower.includes('daily') ||
      lower.includes('requests_per_day') ||
      lower.includes('rpd');
    if (looksDailyLimit) {
      slotRec.exhausted = true;
    }
    slotRec.lastError = reason.slice(0, 120);
    this.schedulePersist();
  }

  public async maybeRefreshOpenRouterKeyMeta(apiKey?: string): Promise<void> {
    if (!apiKey) return;
    const now = Date.now();
    if (now - this.lastOpenRouterKeyCheckMs < 60_000) return;
    this.lastOpenRouterKeyCheckMs = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/key', {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) return;
      const json = (await resp.json()) as {
        data?: {
          limit_remaining?: number | null;
          usage_daily?: number | null;
          is_free_tier?: boolean;
        };
      };
      if (json?.data) {
        this.openRouterKeyMeta = {
          checkedAt: new Date().toISOString(),
          limitRemaining:
            typeof json.data.limit_remaining === 'number' ? json.data.limit_remaining : null,
          usageDaily: typeof json.data.usage_daily === 'number' ? json.data.usage_daily : null,
          isFreeTier:
            typeof json.data.is_free_tier === 'boolean' ? json.data.is_free_tier : null,
        };
      }
    } catch {
      // ignore key meta poll errors
    } finally {
      clearTimeout(timer);
    }
  }

  public getSnapshot(params: {
    whatsappUsedToday: number;
    whatsappDailyLimit: number;
    configuredGeminiKeys: number;
    geminiSlotCooldowns: Array<{
      slot: number;
      primaryCooldownSec: number;
      liteCooldownSec: number;
    }>;
    openRouterConfiguredKeys: number;
    openRouterFreeModelsCount: number;
    openRouterActiveModel: string;
  }): TokenTelemetrySnapshot {
    this.rollDateIfNeeded();

    const toCatStats = (c: {
      calls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }): CategoryTokenStats => ({
      ...c,
      avgTokensPerMsg: c.calls > 0 ? Math.round(c.totalTokens / c.calls) : 0,
    });

    const groupStats = toCatStats(this.state.categories.group);
    const dmStats = toCatStats(this.state.categories.dm);
    const commandStats = toCatStats(this.state.categories.command);
    const summaryStats = toCatStats(this.state.categories.summary);

    const avgOverall =
      this.state.todayTotalCalls > 0
        ? Math.round(this.state.todayTotalTokens / this.state.todayTotalCalls)
        : null;
    const avgGroup = groupStats.calls > 0 ? groupStats.avgTokensPerMsg : avgOverall;
    const avgDm = dmStats.calls > 0 ? dmStats.avgTokensPerMsg : avgOverall;

    const slots: KeySlotTelemetry[] = [];
    let readyKeysCount = 0;
    let exhaustedKeysCount = 0;
    let geminiUsedReqs = 0;
    let geminiUsedTokens = 0;

    for (let s = 1; s <= params.configuredGeminiKeys; s += 1) {
      const cd = params.geminiSlotCooldowns.find((x) => x.slot === s) || {
        slot: s,
        primaryCooldownSec: 0,
        liteCooldownSec: 0,
      };
      const rec = this.state.perKeyToday[String(s)];
      const reqs = rec?.requests || 0;
      const toks = rec?.tokens || 0;
      geminiUsedReqs += reqs;
      geminiUsedTokens += toks;

      const exhausted = Boolean(rec?.exhausted) || reqs >= GEMINI_ESTIMATED_RPD_PER_KEY;
      const inCooldown = cd.primaryCooldownSec > 0 && cd.liteCooldownSec > 0;
      const status: KeySlotTelemetry['status'] = exhausted
        ? 'daily_exhausted'
        : inCooldown
          ? 'cooldown'
          : 'ready';
      if (status === 'ready') readyKeysCount += 1;
      if (status === 'daily_exhausted') exhaustedKeysCount += 1;

      slots.push({
        slot: s,
        requestsToday: reqs,
        tokensToday: toks,
        primaryCooldownSec: cd.primaryCooldownSec,
        liteCooldownSec: cd.liteCooldownSec,
        dailyExhausted: exhausted,
        lastError: rec?.lastError || null,
        status,
      });
    }

    const totalRpdCap = params.configuredGeminiKeys * GEMINI_ESTIMATED_RPD_PER_KEY;
    const remainingRpd = Math.max(0, totalRpdCap - geminiUsedReqs);
    const totalTpdCap = params.configuredGeminiKeys * GEMINI_ESTIMATED_TPD_PER_KEY;
    const remainingTokensToday = Math.max(0, totalTpdCap - geminiUsedTokens);

    // Compute remaining messages cleanly from real measured avg tokens (fallback 700 only as conservative ceiling when 0 calls measured yet)
    const groupCostBaseline = avgGroup && avgGroup > 0 ? avgGroup : 700;
    const dmCostBaseline = avgDm && avgDm > 0 ? avgDm : 750;
    const activeHeadroomRpd = Math.max(0, readyKeysCount * GEMINI_ESTIMATED_RPD_PER_KEY - geminiUsedReqs);
    const byTokensGroup = Math.floor(remainingTokensToday / groupCostBaseline);
    const byTokensDm = Math.floor(remainingTokensToday / dmCostBaseline);

    const estimatedGroupMsgsLeft =
      readyKeysCount > 0 ? Math.min(activeHeadroomRpd, byTokensGroup) : 0;
    const estimatedDmMsgsLeft =
      readyKeysCount > 0 ? Math.min(activeHeadroomRpd, byTokensDm) : 0;

    return {
      date: this.state.date,
      todayTotalTokens: this.state.todayTotalTokens,
      todayPromptTokens: this.state.todayPromptTokens,
      todayCompletionTokens: this.state.todayCompletionTokens,
      todayTotalCalls: this.state.todayTotalCalls,
      lifetimeTotalTokens: this.state.lifetimeTotalTokens,
      lifetimeTotalCalls: this.state.lifetimeTotalCalls,
      byCategory: {
        group: groupStats,
        dm: dmStats,
        command: commandStats,
        summary: summaryStats,
      },
      avgTokensPerGroupMsg: groupStats.calls > 0 ? groupStats.avgTokensPerMsg : null,
      avgTokensPerDmMsg: dmStats.calls > 0 ? dmStats.avgTokensPerMsg : null,
      avgTokensOverall: avgOverall,
      whatsappSafeCap: {
        usedToday: params.whatsappUsedToday,
        limit: params.whatsappDailyLimit,
        remaining: Math.max(0, params.whatsappDailyLimit - params.whatsappUsedToday),
      },
      geminiPool: {
        configuredKeysCount: params.configuredGeminiKeys,
        readyKeysCount,
        exhaustedKeysCount,
        estimatedRpdPerKey: GEMINI_ESTIMATED_RPD_PER_KEY,
        totalRpdCapacity: totalRpdCap,
        usedRpdToday: geminiUsedReqs,
        remainingRpdToday: remainingRpd,
        estimatedTpdCapacity: totalTpdCap,
        remainingTokensToday,
        estimatedGroupMsgsLeft,
        estimatedDmMsgsLeft,
        slots,
      },
      openRouter: {
        configuredKeysCount: params.openRouterConfiguredKeys,
        discoveredFreeModelsCount: params.openRouterFreeModelsCount,
        activeFreeModel: params.openRouterActiveModel,
        requestsToday: this.state.openRouterRequestsToday,
        tokensToday: this.state.openRouterTokensToday,
        keyMeta: this.openRouterKeyMeta,
      },
      lastCall: this.state.lastCall,
    };
  }
}
