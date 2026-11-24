import 'dotenv/config';
import express from 'express';
import { ThinkingLevel } from '@google/genai';
import {
  DEFAULT_FIRST_GREETING,
  DEFAULT_OWNER_BIO,
  DEFAULT_OWNER_BOUNDARIES,
  DEFAULT_STRICT_LOGIC_RULES,
  type AssistantConfigFields,
  type DictionaryEntry,
} from '../server/assistantEngine.ts';
import { GeminiKeyPool } from '../server/geminiKeyPool.ts';
import { OpenRouterReader } from '../server/openRouterReader.ts';
import { TokenTelemetryTracker } from '../server/tokenTelemetry.ts';
import { registerWebOutreachRoutes, type WebOutreachController } from '../server/webResearchOutreach.ts';
import { MobileOffloadQueueManager, registerMobileOffloadRoutes } from '../server/mobileOffloadQueue.ts';
import { AutonomousAgentEngine, registerAutonomousAgentRoutes } from '../server/autonomousAgent.ts';
import {
  adminLoadDocument,
  adminSaveDocument,
  getAdminFirestore,
  getFirestoreAdminDiagnostics,
} from '../server/firestoreAdmin.ts';
import {
  OWNER_EMAIL,
  checkRateLimit,
  clearCustomDashboardPin,
  clearRateLimit,
  createMathChallenge,
  getClientIp,
  getTelegramOwnerIds,
  isPinConfigured,
  issuePreAuthToken,
  issueSessionToken,
  recordAuthFailure,
  requireOwnerAuth,
  setCustomDashboardPin,
  verifyConfiguredPin,
  verifyGoogleFirebaseIdToken,
  verifyMathChallenge,
  verifyPreAuthToken,
  verifyTelegramWebAppInitData,
} from '../server/authSecurity.ts';
import {
  TelegramBotController,
  createInternalBgSignature,
  getTelegramBotToken,
  isNetlifyRuntime,
  registerTelegramRoutes,
} from '../server/telegramBot.ts';
import {
  ChromeBrowserAgent,
  registerChromeRoutes,
} from '../server/chromeBrowserAgent.ts';

const app = express();

// Normalize Netlify Function rewrite paths (/.netlify/functions/api/...) to Express routes (/api/... or /health)
app.use((req, _res, next) => {
  if (req.url.startsWith('/.netlify/functions/api')) {
    const rest = req.url.slice('/.netlify/functions/api'.length) || '/';
    req.url = rest.startsWith('/health') ? rest : `/api${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  next();
});

app.use(express.json({ limit: '4mb' }));

const geminiPool = new GeminiKeyPool();
const openRouterReader = new OpenRouterReader();
const tokenTelemetry = new TokenTelemetryTracker('/tmp/bot-token-usage.json');

openRouterReader.setUsageHook((info) => {
  tokenTelemetry.recordUsage({
    provider: 'openrouter',
    model: info.model,
    category: 'summary',
    promptTokens: info.promptTokens,
    completionTokens: info.completionTokens,
    totalTokens: info.totalTokens,
  });
});

let botConfig: AssistantConfigFields & Record<string, unknown> = {
  autoreply: true,
  aiAssistantEnabled: true,
  autoreplyMessage: 'স্বাগতম! আমি আপনার AI অ্যাসিস্ট্যান্ট।',
  assistantTone: 'warm_polite',
  ownerName: 'Sir',
  ownerProfession: 'Entrepreneur & Tech Operator',
  ownerLocation: 'Dhaka, Bangladesh',
  ownerBio: DEFAULT_OWNER_BIO,
  ownerBoundaries: DEFAULT_OWNER_BOUNDARIES,
  firstGreetingTemplate: DEFAULT_FIRST_GREETING,
  strictLogicRules: DEFAULT_STRICT_LOGIC_RULES,
  dailyReplyLimit: 200,
  cooldownMs: 3000,
  takeoverPauseMs: 1800000,
  groupAiEnabled: true,
  groupAiMode: 'smart_blend',
  groupReplyCooldownMs: 25000,
  groupMaxRepliesPerHour: 15,
  storyAutoReadEnabled: false,
  storyWhitelistMode: 'all',
  storyWhitelistPhones: [],
  humanTypingEnabled: true,
  minHumanDelayMs: 900,
  maxHumanDelayMs: 2200,
  selfChatCopilotEnabled: true,
  selfChatZeroTokenOnly: false,
  antilinkGroups: {},
  groupAiGroups: {},
  groupDirectives: {},
  contactPolicies: [],
  storyWhitelist: [],
  fastReplyMode: true,
  telegramInlineInstantMode: true,
  telegramAntilinkDefault: false,
};

const eventLogs: Array<{
  id: string;
  timestamp: string;
  category: string;
  actor: string;
  summary: string;
  outcome: string;
}> = [];

function pushLog(
  category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
  actor: string,
  summary: string,
  outcome: 'success' | 'blocked' | 'info' | 'error' = 'info'
) {
  eventLogs.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    category,
    actor,
    summary,
    outcome,
  });
  if (eventLogs.length > 60) eventLogs.length = 60;
}

// Public Owner Authentication Endpoints
app.get('/api/auth/status', (_req, res) => {
  res.json({
    ownerEmail: OWNER_EMAIL,
    pinConfigured: isPinConfigured(),
    telegramBotConfigured: Boolean(getTelegramBotToken()),
    telegramOwnerConfigured: getTelegramOwnerIds().length > 0,
  });
});

app.get('/api/auth/challenge', (_req, res) => {
  res.json(createMathChallenge());
});

app.post('/api/auth/google', async (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: `Too many failed attempts. Try again in ${limit.retryAfterSec}s.` });
    return;
  }
  try {
    const idToken = String(req.body?.idToken || '');
    const challengeToken = String(req.body?.challengeToken || '');
    const challengeAnswer = String(req.body?.challengeAnswer ?? '');

    if (!verifyMathChallenge(challengeToken, challengeAnswer)) {
      recordAuthFailure(ip);
      res.status(400).json({ error: 'Verification answer was incorrect or expired.' });
      return;
    }

    const identity = await verifyGoogleFirebaseIdToken(idToken);
    if (!identity.emailVerified || identity.email !== OWNER_EMAIL) {
      recordAuthFailure(ip);
      res.status(403).json({ error: `Access denied. Only authorized owner (${OWNER_EMAIL}) can unlock.` });
      return;
    }

    clearRateLimit(ip);
    if (isPinConfigured()) {
      res.json({
        requiresPin: true,
        preAuthToken: issuePreAuthToken(identity.email),
        email: identity.email,
      });
      return;
    }

    res.json({
      requiresPin: false,
      sessionToken: issueSessionToken(identity.email),
      email: identity.email,
      pinConfigured: false,
    });
  } catch (err) {
    recordAuthFailure(ip);
    res.status(401).json({ error: (err as Error).message || 'Google sign-in failed.' });
  }
});

app.post('/api/auth/verify-pin', (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: `Locked. Try again in ${limit.retryAfterSec}s.` });
    return;
  }
  const email = verifyPreAuthToken(String(req.body?.preAuthToken || ''));
  if (!email) {
    res.status(401).json({ error: 'Pre-auth session expired.' });
    return;
  }
  if (!verifyConfiguredPin(String(req.body?.pin || ''))) {
    const failure = recordAuthFailure(ip);
    res.status(401).json({ error: `Incorrect 2FA Security PIN (${failure.attemptsLeft} attempts remaining).` });
    return;
  }
  clearRateLimit(ip);
  res.json({ sessionToken: issueSessionToken(email), email, pinConfigured: true });
});

app.post('/api/auth/pin-unlock', (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: `Locked. Try again in ${limit.retryAfterSec}s.` });
    return;
  }
  if (!isPinConfigured()) {
    res.status(400).json({ error: 'No Security PIN set yet. Set DASHBOARD_PIN in Netlify Env Vars.' });
    return;
  }
  if (!verifyMathChallenge(String(req.body?.challengeToken || ''), String(req.body?.challengeAnswer ?? ''))) {
    recordAuthFailure(ip);
    res.status(400).json({ error: 'Verification math answer was incorrect or expired.' });
    return;
  }
  if (!verifyConfiguredPin(String(req.body?.pin || ''))) {
    const failure = recordAuthFailure(ip);
    res.status(401).json({ error: `Incorrect Security PIN (${failure.attemptsLeft} attempts remaining).` });
    return;
  }
  clearRateLimit(ip);
  res.json({ sessionToken: issueSessionToken(OWNER_EMAIL), email: OWNER_EMAIL, pinConfigured: true });
});

app.post('/api/auth/telegram-webapp', (req, res) => {
  const ip = getClientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: `Locked. Try again in ${limit.retryAfterSec}s.` });
    return;
  }

  try {
    const botToken = getTelegramBotToken();
    if (!botToken) {
      res.status(400).json({
        error: 'TELEGRAM_BOT_TOKEN is not set in Netlify Environment Variables yet.',
      });
      return;
    }

    const initData = String(req.body?.initData || '');
    const tgUser = verifyTelegramWebAppInitData(initData, botToken);
    const ownerIds = getTelegramOwnerIds();

    if (ownerIds.length === 0) {
      res.status(403).json({
        error: `TELEGRAM_OWNER_ID is not set in Netlify Environment Variables. Your Telegram User ID is ${tgUser.id} — add it as TELEGRAM_OWNER_ID, or use the 2FA PIN Unlock tab.`,
        telegramUserId: tgUser.id,
      });
      return;
    }

    if (!ownerIds.includes(tgUser.id)) {
      recordAuthFailure(ip);
      res.status(403).json({
        error: `Access denied. Telegram User ID ${tgUser.id} is not authorized in TELEGRAM_OWNER_ID.`,
        telegramUserId: tgUser.id,
      });
      return;
    }

    clearRateLimit(ip);

    if (isPinConfigured()) {
      const optionalPin = String(req.body?.pin || '').trim();
      if (optionalPin) {
        if (!verifyConfiguredPin(optionalPin)) {
          const failure = recordAuthFailure(ip);
          res.status(401).json({
            error: `Incorrect 2FA Security PIN (${failure.attemptsLeft} attempts remaining).`,
          });
          return;
        }
        res.json({
          requiresPin: false,
          sessionToken: issueSessionToken(OWNER_EMAIL),
          email: OWNER_EMAIL,
          pinConfigured: true,
          telegramUser: tgUser,
        });
        return;
      }

      res.json({
        requiresPin: true,
        preAuthToken: issuePreAuthToken(OWNER_EMAIL),
        email: OWNER_EMAIL,
        telegramUser: tgUser,
      });
      return;
    }

    res.json({
      requiresPin: false,
      sessionToken: issueSessionToken(OWNER_EMAIL),
      email: OWNER_EMAIL,
      pinConfigured: false,
      telegramUser: tgUser,
    });
  } catch (err) {
    recordAuthFailure(ip);
    res.status(401).json({ error: (err as Error).message || 'Telegram Mini App verification failed.' });
  }
});

// Protect authenticated /api/* routes (exempt /api/auth/*, Telegram Webhook, and token-authenticated Companion Chrome Bridge)
app.use('/api', (req, res, next) => {
  if (
    req.path.startsWith('/auth/') ||
    req.path === '/telegram/webhook' ||
    req.path === '/chrome/companion/poll' ||
    req.path === '/chrome/companion/report'
  ) {
    next();
    return;
  }
  requireOwnerAuth(req, res, next);
});

const mobileOffloadQueue = new MobileOffloadQueueManager();

const outreachController: WebOutreachController = registerWebOutreachRoutes(app, {
  geminiPool,
  openRouterReader,
  tokenTelemetry,
  getBotConfig: () => botConfig,
  getSocket: () => null,
  getBotStatus: () => 'disconnected',
  sendTrackedMessage: async () => undefined,
  pushLog,
});

registerMobileOffloadRoutes(app, mobileOffloadQueue, ({ url, emails, phones, title, snippet }) => {
  outreachController.ingestExternalLead({
    name: title || url,
    sourceUrl: url,
    topic: 'Mobile PWA Offload',
    emails,
    phones,
    snippet: snippet || '',
  });
});

let telegramBotRef: TelegramBotController | null = null;

const chromeBrowserAgent = new ChromeBrowserAgent({
  geminiPool,
  openRouterReader,
  tokenTelemetry,
  getOwnerName: () => botConfig.ownerName || 'Sir',
  notifyTelegramScreenshot: async (caption, jpegBase64) => {
    const ownerIds = getTelegramOwnerIds();
    const bot = telegramBotRef;
    if (!bot || ownerIds.length === 0 || !getTelegramBotToken()) return;
    if (jpegBase64) {
      await bot
        .sendPhotoBuffer(ownerIds[0], Buffer.from(jpegBase64, 'base64'), caption)
        .catch(() => bot.sendMessage(ownerIds[0], caption));
    } else {
      await bot.sendMessage(ownerIds[0], caption);
    }
  },
  pushLog,
});

const autonomousAgentEngine = new AutonomousAgentEngine({
  geminiPool,
  openRouterReader,
  tokenTelemetry,
  outreach: outreachController,
  offloadQueue: mobileOffloadQueue,
  getWatchdog: () => null,
  getChromeAgent: () => chromeBrowserAgent,
  getBotConfig: () => botConfig,
  getBotStatus: () => 'serverless_telegram_mode',
  getMemoryRssMb: () => Math.round(process.memoryUsage().rss / (1024 * 1024)),
  getDirectoryContacts: () => [],
  getKnownGroups: () => [],
  getRecentMemories: () => [],
  getUnreadNotes: () => [],
  getSelfPingStats: () => ({
    enabled: false,
    targetUrl: 'vercel_serverless',
    lastPingAt: null,
    lastPingOk: true,
  }),
  dispatchDirectDm: async ({ targets }) => ({
    deliveredCount: 0,
    draftCount: targets.length,
    targetLabels: targets.map((t) => t.name),
  }),
  dispatchGroupMention: async ({ groupName }) => ({
    deliveredLive: false,
    groupName,
    mentionedCount: 0,
  }),
  kickGroupMember: async () => ({
    ok: false,
    reason: 'WhatsApp group kick requires Node/Termux Baileys socket; Telegram groups use Telegram Bot API.',
  }),
  upsertContactPolicies: async () => [],
  updateSystemSettings: async (patch) => {
    botConfig = { ...botConfig, ...(patch as Record<string, unknown>) };
    await persistServerlessConfig();
  },
  sendOwnerSelfChatReport: async () => false,
  pushLog,
});

registerAutonomousAgentRoutes(app, autonomousAgentEngine, () => null, {
  syncWallClockMs: isNetlifyRuntime() ? 7_200 : undefined,
  dispatchBackgroundMission: isNetlifyRuntime()
    ? async (req, goal) => {
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        const origin = host ? `${proto}://${host}` : process.env.URL || process.env.DEPLOY_PRIME_URL || '';
        if (!origin.startsWith('http')) return null;

        const preassignedRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const bgPayload = JSON.stringify({
          kind: 'agent_run',
          goal,
          preassignedRunId,
          origin,
        });
        const bgResp = await fetch(`${origin.replace(/\/+$/, '')}/.netlify/functions/telegram-worker-background`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wanexus-bg-sig': createInternalBgSignature(bgPayload),
          },
          body: bgPayload,
          signal: AbortSignal.timeout(3_500),
        });
        if (!bgResp.ok && bgResp.status !== 202) return null;

        return {
          id: preassignedRunId,
          source: 'dashboard',
          goal: goal.slice(0, 1200),
          status: 'running',
          providerUsed: 'hybrid',
          modelUsed: 'netlify-15m-background',
          tokensUsed: 0,
          steps: [],
          finalReport: '⏳ Netlify ১৫-মিনিট ব্যাকগ্রাউন্ড ইঞ্জিনে মিশন চলছে... কয়েক সেকেন্ডের মধ্যে রিপোর্ট আপডেট হবে।',
          startedAt: new Date().toISOString(),
        };
      }
    : undefined,
});

const telegramBotController = new TelegramBotController({
  geminiPool,
  openRouterReader,
  tokenTelemetry,
  outreach: outreachController,
  getAutonomousAgent: () => autonomousAgentEngine,
  getChromeAgent: () => chromeBrowserAgent,
  getOwnerName: () => botConfig.ownerName || 'Sir',
  getBotConfig: () => botConfig,
  updateBotConfig: async (patch) => {
    botConfig = { ...botConfig, ...(patch as Record<string, unknown>) };
    await persistServerlessConfig();
  },
  getMemoryRssMb: () => Math.round(process.memoryUsage().rss / (1024 * 1024)),
  pushLog,
});
telegramBotRef = telegramBotController;

registerTelegramRoutes(app, telegramBotController, requireOwnerAuth);

registerChromeRoutes(app, chromeBrowserAgent, requireOwnerAuth, {
  dispatchBackgroundChromeRun: isNetlifyRuntime()
    ? async (req, payload) => {
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
        const origin = host ? `${proto}://${host}` : process.env.URL || process.env.DEPLOY_PRIME_URL || '';
        if (!origin.startsWith('http')) return false;

        const bgPayload = JSON.stringify({
          kind: 'chrome_run',
          ...payload,
          origin,
        });
        const bgResp = await fetch(`${origin.replace(/\/+$/, '')}/.netlify/functions/telegram-worker-background`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wanexus-bg-sig': createInternalBgSignature(bgPayload),
          },
          body: bgPayload,
          signal: AbortSignal.timeout(3_500),
        });
        return bgResp.ok || bgResp.status === 202;
      }
    : undefined,
});

app.post('/api/security/pin', (req, res) => {
  try {
    const action = String(req.body?.action || 'set');
    if (action === 'clear') {
      clearCustomDashboardPin();
      res.json({ pinConfigured: isPinConfigured() });
      return;
    }
    setCustomDashboardPin(String(req.body?.pin || ''));
    res.json({ pinConfigured: isPinConfigured() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Invalid PIN.' });
  }
});

app.get('/api/system/env-status', (_req, res) => {
  const isSet = (name: string) => {
    const val = String(process.env[name] || '').trim();
    return Boolean(val && val !== 'MY_GEMINI_API_KEY' && val !== 'MY_APP_URL' && !val.startsWith('YOUR_'));
  };
  const geminiStats = geminiPool.getStats();
  const openRouterStats = openRouterReader.getStats();

  res.json({
    runtime: {
      platform: isNetlifyRuntime() ? 'netlify_serverless' : 'vercel_serverless',
      isTermux: false,
      isVercel: Boolean(process.env.VERCEL),
      isNetlify: isNetlifyRuntime(),
      nodeVersion: process.version,
      port: 443,
      nodeEnv: process.env.NODE_ENV || 'production',
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      uptimeSec: Math.round(process.uptime()),
      selfPingEnabled: false,
      ownerEmail: OWNER_EMAIL,
      telegramBotConfigured: Boolean(getTelegramBotToken()),
    },
    geminiKeysCount: geminiStats.configuredKeysCount,
    openRouterKeysCount: openRouterStats.configuredKeysCount,
    firestore: getFirestoreAdminDiagnostics(),
    envItems: [
      {
        key: 'TELEGRAM_BOT_TOKEN',
        category: 'Telegram 24/7',
        configured: Boolean(getTelegramBotToken()),
        detail: Boolean(getTelegramBotToken()) ? 'Bot token ready' : 'Add @BotFather token in Netlify Env',
      },
      {
        key: 'GEMINI_API_KEY_1..5',
        category: 'AI Brain',
        configured: geminiStats.configuredKeysCount > 0,
        detail: `${geminiStats.configuredKeysCount} key slot(s) active`,
      },
      {
        key: 'OPENROUTER_API_KEY',
        category: 'AI Brain',
        configured: openRouterStats.configuredKeysCount > 0,
        detail: `${openRouterStats.configuredKeysCount} key(s) active`,
      },
      {
        key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
        category: 'Database',
        configured: isSet('FIREBASE_SERVICE_ACCOUNT_JSON'),
        detail: getFirestoreAdminDiagnostics().mode,
      },
      {
        key: 'DASHBOARD_PIN',
        category: 'Security',
        configured: isPinConfigured(),
        detail: isSet('DASHBOARD_PIN') ? 'Set via Env' : isPinConfigured() ? 'Configured' : 'Not Set',
      },
      {
        key: 'HF_TOKEN',
        category: 'Image Gen',
        configured: isSet('HF_TOKEN'),
        detail: isSet('HF_TOKEN') ? 'FLUX.1-schnell active' : 'Optional (Pollinations free fallback active)',
      },
      {
        key: 'CHROME_WS_ENDPOINT',
        category: 'Chrome Hands',
        configured: isSet('CHROME_WS_ENDPOINT') || chromeBrowserAgent.getActiveBackendMode() !== 'unconfigured',
        detail: `Mode: ${chromeBrowserAgent.getActiveBackendMode()}`,
      },
    ],
  });
});

let dictionaryEntries: DictionaryEntry[] = [];
let lastHydratedAtMs = 0;

async function ensureServerlessHydrated(force = false) {
  const now = Date.now();
  if (!force && now - lastHydratedAtMs < 10_000) return;
  lastHydratedAtMs = now;
  try {
    const cloud = await adminLoadDocument<{
      config?: Partial<AssistantConfigFields> & Record<string, unknown>;
      dictionary?: DictionaryEntry[];
    }>('bot_serverless_config', 'primary');
    if (cloud?.config && typeof cloud.config === 'object') {
      const localTs = Date.parse(String(botConfig.configUpdatedAt || '')) || 0;
      const cloudTs = Date.parse(String(cloud.config.configUpdatedAt || '')) || 0;
      if (cloudTs >= localTs || localTs === 0) {
        botConfig = { ...botConfig, ...cloud.config };
      }
    }
    if (Array.isArray(cloud?.dictionary)) {
      dictionaryEntries = cloud.dictionary.slice(0, 500);
    }
  } catch {
    // ignore hydration errors
  }
}

async function persistServerlessConfig() {
  await adminSaveDocument('bot_serverless_config', 'primary', {
    config: botConfig,
    dictionary: dictionaryEntries.slice(0, 500),
  }).catch(() => false);
}

app.get('/api/bot/status', async (_req, res) => {
  await ensureServerlessHydrated();
  const { mode: firestoreAdminMode } = getAdminFirestore();
  const geminiStats = geminiPool.getStats();
  const openRouterStats = openRouterReader.getStats();
  res.json({
    status: 'disconnected',
    connectedUser: null,
    pairingCode: null,
    pairingPhone: null,
    sessionExists: false,
    lastError: isNetlifyRuntime()
      ? 'Netlify 24/7 + 15m Background Worker runs Telegram AI, Mini App & Web Studio (WhatsApp Baileys requires persistent Node/Termux).'
      : 'Serverless mode runs 24/7 Telegram AI & Web Studio.',
    geminiConfigured: geminiPool.hasKeys(),
    geminiKeyPool: geminiStats,
    openRouterConfigured: openRouterReader.hasKeys(),
    openRouterStats,
    tokenTelemetry: tokenTelemetry.getSnapshot({
      whatsappUsedToday: 0,
      whatsappDailyLimit: botConfig.dailyReplyLimit ?? 200,
      configuredGeminiKeys: geminiStats.configuredKeysCount,
      geminiSlotCooldowns: geminiPool.getSlotCooldownStats(),
      openRouterConfiguredKeys: openRouterStats.configuredKeysCount,
      openRouterFreeModelsCount: openRouterStats.dynamicPool?.discoveredFreeModelsCount || 0,
      openRouterActiveModel: openRouterStats.dynamicPool?.activeFreeModel || openRouterStats.primaryModel,
    }),
    postgres: { configured: false, connected: false },
    firestoreAdminMode,
    config: botConfig,
    logs: eventLogs,
    dictionaryCount: dictionaryEntries.length,
    memoryCount: 0,
    unreadNotesCount: 0,
    dailyReplyStats: { count: 0, limit: botConfig.dailyReplyLimit ?? 200 },
    activeTakeoversCount: 0,
  });
});

app.post('/api/bot/config', async (req, res) => {
  await ensureServerlessHydrated();
  if (req.body && typeof req.body === 'object') {
    botConfig = { ...botConfig, ...(req.body as Record<string, unknown>) };
    await persistServerlessConfig();
  }
  res.json({ config: botConfig });
});

app.post('/api/cloud/sync', async (req, res) => {
  await ensureServerlessHydrated();
  if (req.body?.config && typeof req.body.config === 'object') {
    botConfig = { ...botConfig, ...(req.body.config as Record<string, unknown>) };
  }
  if (Array.isArray(req.body?.dictionary)) {
    dictionaryEntries = (req.body.dictionary as DictionaryEntry[]).slice(0, 500);
  }
  await persistServerlessConfig();
  res.json({ ok: true, config: botConfig, dictionaryCount: dictionaryEntries.length });
});

app.get('/api/security/stats', (_req, res) => {
  res.json({
    ownerEmail: OWNER_EMAIL,
    pinConfigured: isPinConfigured(),
    envPinActive: Boolean(process.env.DASHBOARD_PIN?.trim()),
    dailyReplyStats: { count: 0, limit: botConfig.dailyReplyLimit ?? 200 },
    activeTakeovers: [],
    humanTypingEnabled: Boolean(botConfig.humanTypingEnabled),
    dailyReplyLimit: botConfig.dailyReplyLimit ?? 200,
    markOnlineOnConnect: false,
  });
});

app.post('/api/security/resume-takeover', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/assistant/inbox', (_req, res) => {
  res.json({ notes: [], memories: [], totalArchivedCount: 0 });
});

app.post('/api/notes/:id/toggle', (_req, res) => res.json({ ok: true }));
app.delete('/api/notes/:id', (_req, res) => res.json({ ok: true }));
app.delete('/api/memories/:chatId', (_req, res) => res.json({ ok: true }));
app.get('/api/memories/:chatId/archive', (_req, res) => res.json({ messages: [] }));

app.get('/api/dictionary', async (req, res) => {
  await ensureServerlessHydrated();
  const q = String(req.query.search || req.query.q || '').trim().toLowerCase();
  const district = String(req.query.district || 'ALL').trim();
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limit = Math.max(10, Math.min(100, Number(req.query.limit || 50) || 50));

  let filtered = dictionaryEntries;
  if (district && district !== 'ALL') {
    filtered = filtered.filter((d) => d.district.toLowerCase() === district.toLowerCase());
  }
  if (q) {
    filtered = filtered.filter(
      (d) =>
        d.term.toLowerCase().includes(q) ||
        d.meaning.toLowerCase().includes(q) ||
        d.district.toLowerCase().includes(q)
    );
  }
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const start = (page - 1) * limit;
  res.json({
    entries: filtered.slice(start, start + limit),
    page,
    totalPages,
    totalCount,
    total: dictionaryEntries.length,
    storageMode: 'firestore',
  });
});

app.post('/api/dictionary', async (req, res) => {
  await ensureServerlessHydrated();
  const term = String(req.body?.term || '').trim();
  const meaning = String(req.body?.meaning || '').trim();
  if (!term || !meaning) {
    res.status(400).json({ error: 'Term and meaning are required.' });
    return;
  }
  const entry: DictionaryEntry = {
    id: `dict_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    term,
    meaning,
    district: String(req.body?.district || 'Dhaka').trim(),
    language: (req.body?.language as DictionaryEntry['language']) || 'bn_dialect',
    replyStyleHint: String(req.body?.replyStyleHint || '').trim() || undefined,
  };
  dictionaryEntries.unshift(entry);
  await persistServerlessConfig();
  res.json({ ok: true, entry });
});

app.post('/api/dictionary/starter', async (_req, res) => {
  await ensureServerlessHydrated();
  res.json({ ok: true, added: 0, total: dictionaryEntries.length });
});

app.post('/api/dictionary/import-chunk', async (req, res) => {
  await ensureServerlessHydrated();
  const items = Array.isArray(req.body?.entries) ? (req.body.entries as DictionaryEntry[]) : [];
  dictionaryEntries = [...items, ...dictionaryEntries].slice(0, 500);
  await persistServerlessConfig();
  res.json({ ok: true, added: items.length, total: dictionaryEntries.length });
});

app.delete('/api/dictionary/:id', async (req, res) => {
  await ensureServerlessHydrated();
  dictionaryEntries = dictionaryEntries.filter((d) => d.id !== req.params.id);
  await persistServerlessConfig();
  res.json({ ok: true });
});

app.delete('/api/dictionary', async (_req, res) => {
  dictionaryEntries = [];
  await persistServerlessConfig();
  res.json({ ok: true });
});

app.get('/api/groups', (_req, res) => res.json({ groups: [] }));
app.get('/api/contacts', (_req, res) => res.json({ connected: false, contacts: [] }));
app.get('/api/media/stories', (_req, res) => {
  const geminiStats = geminiPool.getStats();
  const openRouterStats = openRouterReader.getStats();
  const snap = tokenTelemetry.getSnapshot({
    whatsappUsedToday: 0,
    whatsappDailyLimit: botConfig.dailyReplyLimit ?? 200,
    configuredGeminiKeys: geminiStats.configuredKeysCount,
    geminiSlotCooldowns: geminiPool.getSlotCooldownStats(),
    openRouterConfiguredKeys: openRouterStats.configuredKeysCount,
    openRouterFreeModelsCount: openRouterStats.dynamicPool?.discoveredFreeModelsCount || 0,
    openRouterActiveModel: openRouterStats.dynamicPool?.activeFreeModel || openRouterStats.primaryModel,
  });
  res.json({ stories: [], stats: snap.zeroTokenMedia });
});
app.get('/api/assistant/direct-commands', (_req, res) => res.json({ commands: [] }));
app.post('/api/assistant/direct-command', (_req, res) =>
  res.status(400).json({ error: 'WhatsApp direct messaging requires active WhatsApp socket; use Telegram Bot /agent instead.' })
);
app.get('/api/assistant/self-chat', (_req, res) =>
  res.json({
    enabled: botConfig.selfChatCopilotEnabled !== false,
    zeroTokenOnly: Boolean(botConfig.selfChatZeroTokenOnly),
    connectedPhone: '',
    botStatus: 'disconnected',
    memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    history: [],
    contactPolicies: botConfig.contactPolicies || [],
  })
);
app.post('/api/assistant/self-chat', (_req, res) =>
  res.json({
    ok: true,
    history: [],
    memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  })
);
app.get('/api/client-bots', (_req, res) => res.json({ bots: [] }));
app.get('/api/source-files', (_req, res) => res.json({ files: [] }));

app.post('/api/antilink/test', (req, res) => {
  const text = String(req.body?.message || req.body?.text || '');
  const matches = text.match(/(?:https?:\/\/[^\s]+|www\.[^\s]+|(?:t\.me|telegram\.me|wa\.me|bit\.ly)\/[^\s]+)/gi) || [];
  res.json({
    hasLink: matches.length > 0,
    matches,
  });
});

app.post('/api/simulator/message', async (req, res) => {
  await ensureServerlessHydrated();
  const messageText = String(req.body?.text || req.body?.message || '').trim();
  if (!messageText) {
    res.status(400).json({ error: 'Message text is required.' });
    return;
  }

  let reply = '';
  let providerUsed = 'fallback';
  const sysPrompt = `You are "${botConfig.ownerName || 'Sir'}"'s AI Executive Assistant (${botConfig.assistantTone}). Reply naturally in Bengali/Banglish/English matching the sender.`;

  if (geminiPool.hasKeys()) {
    try {
      const exec = await geminiPool.executeWithRotation(
        (client) =>
          client.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: messageText,
            config: {
              systemInstruction: sysPrompt,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
          }),
        undefined,
        { maxTotalMs: 7_000, channel: 'simulator' }
      );
      reply = (exec.value.text || '').trim();
      providerUsed = 'gemini-4-hydrogen';
    } catch {
      // fall through to OpenRouter
    }
  }

  if (!reply && openRouterReader.hasKeys()) {
    try {
      const orRes = await openRouterReader.generateAgentStepPlan({
        systemPrompt: sysPrompt,
        transcript: `${messageText}\n\nReply naturally (not JSON).`,
      });
      reply = (orRes.content || '').trim();
      providerUsed = orRes.modelUsed;
    } catch {
      // fall through
    }
  }

  if (!reply) {
    reply = String(botConfig.autoreplyMessage || 'স্বাগতম! আমি আপনার AI অ্যাসিস্ট্যান্ট।');
    providerUsed = 'autoreply_fallback';
  }

  res.json({
    ok: true,
    deleted: false,
    reply,
    note: `Provider: ${providerUsed}`,
    tokensSpent: 0,
    ruleTriggered: providerUsed,
    config: botConfig,
  });
});

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    mode: isNetlifyRuntime() ? 'netlify_serverless_15m_bg' : 'vercel_serverless',
    telegramBotConfigured: Boolean(getTelegramBotToken()),
    geminiKeyPool: geminiPool.getStats(),
    openRouter: openRouterReader.getStats(),
    firestore: getFirestoreAdminDiagnostics(),
    memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  });
});

app.all('/api/*', (_req, res) => {
  res.status(404).json({ error: 'Endpoint unavailable in serverless mode.' });
});

export { app, autonomousAgentEngine, telegramBotController, chromeBrowserAgent };
export default app;
