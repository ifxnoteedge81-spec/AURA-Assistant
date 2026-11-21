import 'dotenv/config';
import express from 'express';
import {
  DEFAULT_FIRST_GREETING,
  DEFAULT_OWNER_BIO,
  DEFAULT_OWNER_BOUNDARIES,
  DEFAULT_STRICT_LOGIC_RULES,
  type AssistantConfigFields,
} from '../server/assistantEngine.ts';
import { GeminiKeyPool } from '../server/geminiKeyPool.ts';
import { OpenRouterReader } from '../server/openRouterReader.ts';
import { TokenTelemetryTracker } from '../server/tokenTelemetry.ts';
import { registerWebOutreachRoutes, type WebOutreachController } from '../server/webResearchOutreach.ts';
import { MobileOffloadQueueManager, registerMobileOffloadRoutes } from '../server/mobileOffloadQueue.ts';
import { AutonomousAgentEngine, registerAutonomousAgentRoutes } from '../server/autonomousAgent.ts';
import { getAdminFirestore, getFirestoreAdminDiagnostics } from '../server/firestoreAdmin.ts';
import {
  OWNER_EMAIL,
  checkRateLimit,
  clearCustomDashboardPin,
  clearRateLimit,
  createMathChallenge,
  getClientIp,
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
} from '../server/authSecurity.ts';
import {
  TelegramBotController,
  createInternalBgSignature,
  getTelegramBotToken,
  isNetlifyRuntime,
  registerTelegramRoutes,
} from '../server/telegramBot.ts';

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
    res.status(400).json({ error: 'No Security PIN set yet. Set DASHBOARD_PIN in Vercel Env Vars.' });
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

// Protect authenticated /api/* routes (exempt /api/auth/* & public Telegram Webhook)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/telegram/webhook') {
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

const autonomousAgentEngine = new AutonomousAgentEngine({
  geminiPool,
  openRouterReader,
  tokenTelemetry,
  outreach: outreachController,
  offloadQueue: mobileOffloadQueue,
  getWatchdog: () => null,
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
  getOwnerName: () => botConfig.ownerName || 'Sir',
  pushLog,
});

registerTelegramRoutes(app, telegramBotController, requireOwnerAuth);

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
    ],
  });
});

app.get('/api/bot/status', (_req, res) => {
  const { mode: firestoreAdminMode } = getAdminFirestore();
  const geminiStats = geminiPool.getStats();
  const openRouterStats = openRouterReader.getStats();
  res.json({
    status: 'disconnected',
    connectedUser: null,
    pairingCode: null,
    pairingPhone: null,
    sessionExists: false,
    lastError: 'Vercel Serverless runs 24/7 Telegram AI + Web Studio (Baileys WhatsApp requires persistent Termux/Docker).',
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
    dictionaryCount: 0,
    memoryCount: 0,
    unreadNotesCount: 0,
    dailyReplyStats: { count: 0, limit: botConfig.dailyReplyLimit },
    activeTakeoversCount: 0,
  });
});

app.post('/api/bot/config', (req, res) => {
  if (req.body && typeof req.body === 'object') {
    botConfig = { ...botConfig, ...(req.body as Record<string, unknown>) };
  }
  res.json({ config: botConfig });
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

export { app, autonomousAgentEngine, telegramBotController };
export default app;
