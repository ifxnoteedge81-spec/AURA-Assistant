import fs from 'node:fs';
import path from 'node:path';
import { ThinkingLevel, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { Express, Request, Response } from 'express';
import type { GeminiKeyPool } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';
import type { TokenTelemetryTracker } from './tokenTelemetry.ts';
import type { WebOutreachController } from './webResearchOutreach.ts';
import type { MobileOffloadQueueManager } from './mobileOffloadQueue.ts';
import type { SelfHealingWatchdog, WatchdogHealEvent } from './selfHealingWatchdog.ts';
import { adminLoadDocument, adminSaveDocument, getFirestoreAdminDiagnostics } from './firestoreAdmin.ts';
import type {
  AssistantConfigFields,
  AssistantTone,
  ChatMemoryRecord,
  ContactPolicyEntry,
  ContactPolicyMode,
  InboxNoteRecord,
} from './assistantEngine.ts';
import type { SelfChatDirectoryContact, SelfChatKnownGroup } from './selfChatCopilot.ts';
import {
  buildPatchFromInput,
  getFullControlSnapshot,
  type ControlPatchInput,
} from './autonomousControl.ts';

export interface AgentExecutionStep {
  stepNumber: number;
  toolName: string;
  argsPreview: string;
  outcome: 'ok' | 'error';
  resultSummary: string;
  timestamp: string;
}

export interface AgentRunRecord {
  id: string;
  source: 'self_chat' | 'dashboard' | 'schedule';
  goal: string;
  status: 'running' | 'completed' | 'failed';
  providerUsed: 'gemini' | 'openrouter' | 'hybrid' | 'zero_token';
  modelUsed: string;
  tokensUsed: number;
  steps: AgentExecutionStep[];
  finalReport: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AgentScheduleItem {
  id: string;
  title: string;
  goal: string;
  intervalMinutes: number;
  enabled: boolean;
  notifySelfChat: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  lastSummary: string | null;
  createdAt: string;
}

export interface AutonomousAgentAdapters {
  geminiPool: GeminiKeyPool;
  openRouterReader: OpenRouterReader;
  tokenTelemetry: TokenTelemetryTracker;
  outreach: WebOutreachController;
  offloadQueue: MobileOffloadQueueManager;
  getWatchdog: () => SelfHealingWatchdog | null;
  getBotConfig: () => AssistantConfigFields;
  getBotStatus: () => string;
  getMemoryRssMb: () => number;
  getDirectoryContacts: () => SelfChatDirectoryContact[];
  getKnownGroups: () => SelfChatKnownGroup[];
  getRecentMemories: () => ChatMemoryRecord[];
  getUnreadNotes: () => InboxNoteRecord[];
  getSelfPingStats: () => {
    enabled: boolean;
    targetUrl: string;
    lastPingAt: string | null;
    lastPingOk: boolean | null;
  };
  dispatchDirectDm: (params: {
    targets: Array<{ jid: string; phone: string; name: string }>;
    messageText: string;
    originalInstruction: string;
  }) => Promise<{ deliveredCount: number; draftCount: number; targetLabels: string[] }>;
  dispatchGroupMention: (params: {
    groupJid: string;
    groupName: string;
    members: Array<{ jid: string; phone: string; name: string }>;
    messageText: string;
    originalInstruction: string;
  }) => Promise<{ deliveredLive: boolean; groupName: string; mentionedCount: number }>;
  kickGroupMember: (params: {
    groupJid: string;
    groupName: string;
    targetPhoneOrName: string;
  }) => Promise<{ ok: boolean; kickedLabel?: string; reason: string }>;
  upsertContactPolicies: (
    entries: Array<{ jid: string; phone: string; name: string; mode: ContactPolicyMode; note?: string }>
  ) => Promise<ContactPolicyEntry[]>;
  updateSystemSettings: (patch: Partial<AssistantConfigFields>) => Promise<void>;
  sendOwnerSelfChatReport: (text: string) => Promise<boolean>;
  pushLog: (
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
const RUNS_FILE = path.resolve(RUNTIME_DIR, 'bot-agent-runs.json');
const SCHEDULES_FILE = path.resolve(RUNTIME_DIR, 'bot-agent-schedules.json');
const MAX_RUNS = 30;
const MAX_SCHEDULES = 20;
const MAX_AGENT_STEPS = 8;
const AGENT_WALL_CLOCK_MS = 55_000;

function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('01') && digits.length === 11) return `88${digits}`;
  if (digits.startsWith('1') && digits.length === 10) return `880${digits}`;
  return digits;
}

const AGENT_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'web_search',
    description:
      'Search the live web (Tavily / Serper / DuckDuckGo) for businesses, websites, contacts, emails, phone numbers, or research insights and save discovered leads into Lead Vault.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search query in English or Bangla.' },
        maxSites: { type: Type.NUMBER, description: 'Max sites to crawl (1-6). Default 4.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'smart_read_url',
    description:
      'Read and extract emails, phone numbers, title, and page text from specific URL(s). Automatically uses Jina Reader for JS-heavy sites and Mobile PWA Offload Worker when available.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        urls: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Array of http(s) URLs to scan.' },
        topic: { type: Type.STRING, description: 'Short topic label for Lead Vault.' },
        preferMobileOffload: {
          type: Type.BOOLEAN,
          description: 'Set true to offload fetching/DOM parsing onto connected Phone PWA browser first.',
        },
      },
      required: ['urls'],
    },
  },
  {
    name: 'verify_whatsapp_leads',
    description: 'Check collected phone numbers in Lead Vault against live WhatsApp to verify active accounts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        maxLeads: { type: Type.NUMBER, description: 'Optional max number of leads to verify.' },
      },
    },
  },
  {
    name: 'send_whatsapp_message',
    description:
      'Send WhatsApp message to specific phone numbers, saved contact names, or collected Lead Vault contacts. Supports excluding specific numbers (excluded numbers get muted automatically).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        messageText: { type: Type.STRING, description: 'Exact message text to send in Bangla or English.' },
        targetPhonesOrNames: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Specific phone numbers or contact names to message. Leave empty if targeting collected leads.',
        },
        useCollectedLeads: {
          type: Type.BOOLEAN,
          description: 'Set true to send via anti-ban queue to collected WhatsApp leads.',
        },
        excludePhones: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Phone numbers that MUST NEVER be messaged and will be added to mute_ai policy.',
        },
        maxCount: { type: Type.NUMBER, description: 'Max recipients when sending to leads (1-15).' },
      },
      required: ['messageText'],
    },
  },
  {
    name: 'send_email_outreach',
    description:
      'Send email to specific email addresses or collected Lead Vault emails using active SMTP App Password / Gmail OAuth / Resend / Brevo.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        subject: { type: Type.STRING, description: 'Concise email subject line.' },
        body: { type: Type.STRING, description: 'Email body text.' },
        targetEmails: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Specific recipient email addresses.',
        },
        useCollectedLeads: {
          type: Type.BOOLEAN,
          description: 'Set true to send to collected Lead Vault emails.',
        },
        maxCount: { type: Type.NUMBER, description: 'Max emails to send (1-15).' },
      },
      required: ['subject', 'body'],
    },
  },
  {
    name: 'manage_whatsapp_groups',
    description:
      'Inspect WhatsApp groups or perform group actions: list, kick_member, mute_member, set_antilink, set_group_ai, or group_mention.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: 'One of: list, kick_member, mute_member, set_antilink, set_group_ai, group_mention',
        },
        groupNameOrJid: { type: Type.STRING, description: 'Group name or JID.' },
        targetPhoneOrName: { type: Type.STRING, description: 'Member phone or name for kick/mute.' },
        enabled: { type: Type.BOOLEAN, description: 'true/false for set_antilink or set_group_ai.' },
        messageText: { type: Type.STRING, description: 'Text for group_mention.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_inbox_and_system',
    description:
      'Read unread WhatsApp inbox notes, recent contact memories, Lead Vault items/counts, active email profiles, Firestore match status, RAM usage, Self-Ping, and Watchdog health.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'Optional focus: all, inbox, leads, system, email_profiles',
        },
      },
    },
  },
  {
    name: 'configure_system_and_email',
    description:
      'Update ANY dashboard setting or toggle (ON/OFF booleans, speed delays, tones, limits, anti-link, group AI, media, story, self-chat, owner bio/rules, speed presets) or switch email sender profiles. Never refuse owner requests; warn once on risky changes unless confirmedOverride=true.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        autoreply: { type: Type.BOOLEAN },
        aiAssistantEnabled: { type: Type.BOOLEAN },
        fastReplyMode: { type: Type.BOOLEAN, description: 'true=1-5s fast instant reply; false=slower deep thinking' },
        telegramInlineInstantMode: { type: Type.BOOLEAN, description: 'true=reply inline <10s without queue delay' },
        humanTypingEnabled: { type: Type.BOOLEAN, description: 'false saves 2-3s per reply' },
        cooldownMs: { type: Type.NUMBER, description: 'DM reply cooldown milliseconds (0 = instant)' },
        takeoverPauseMs: { type: Type.NUMBER, description: 'Human takeover pause ms' },
        dailyReplyLimit: { type: Type.NUMBER, description: '1 to 5000' },
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
        confirmedOverride: { type: Type.BOOLEAN, description: 'Set true when owner already confirmed risky override (e.g. তারপরও করো)' },
        switchEmailSender: { type: Type.STRING, description: 'Email address of saved sender profile to activate.' },
      },
    },
  },
  {
    name: 'schedule_autonomous_mission',
    description:
      'Create a recurring or delayed autonomous background task (e.g. daily briefing or follow-up check).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: 'Short Bangla/English schedule title.' },
        goal: { type: Type.STRING, description: 'Autonomous mission instruction to execute on schedule.' },
        intervalMinutes: { type: Type.NUMBER, description: 'Repeat interval in minutes (minimum 15, e.g. 60 or 1440).' },
      },
      required: ['title', 'goal', 'intervalMinutes'],
    },
  },
  {
    name: 'run_self_heal_now',
    description: 'Run the 5-minute Self-Healing Watchdog immediately to free RAM, check WhatsApp socket, and repair stuck queues.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

export class AutonomousAgentEngine {
  private readonly adapters: AutonomousAgentAdapters;
  private runs: AgentRunRecord[] = [];
  private schedules: AgentScheduleItem[] = [];
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private activeRunId: string | null = null;

  constructor(adapters: AutonomousAgentAdapters) {
    this.adapters = adapters;
    this.loadFromDisk();
    void this.hydrateFromCloud();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(RUNS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8'));
        if (Array.isArray(parsed?.runs)) {
          this.runs = parsed.runs.slice(0, MAX_RUNS);
        }
      }
    } catch {
      this.runs = [];
    }
    try {
      if (fs.existsSync(SCHEDULES_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
        if (Array.isArray(parsed?.schedules)) {
          this.schedules = parsed.schedules.slice(0, MAX_SCHEDULES);
        }
      }
    } catch {
      this.schedules = [];
    }
  }

  private saveRuns() {
    this.runs = this.runs.slice(0, MAX_RUNS);
    try {
      fs.writeFileSync(
        RUNS_FILE,
        JSON.stringify({ runs: this.runs, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }
    void adminSaveDocument('bot_agent_runs', 'primary', {
      runs: this.runs.slice(0, 15),
    });
  }

  public async saveRunsAsync(): Promise<void> {
    this.runs = this.runs.slice(0, MAX_RUNS);
    try {
      fs.writeFileSync(
        RUNS_FILE,
        JSON.stringify({ runs: this.runs, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }
    await adminSaveDocument('bot_agent_runs', 'primary', {
      runs: this.runs.slice(0, 15),
    }).catch(() => false);
  }

  private saveSchedules() {
    this.schedules = this.schedules.slice(0, MAX_SCHEDULES);
    try {
      fs.writeFileSync(
        SCHEDULES_FILE,
        JSON.stringify({ schedules: this.schedules, updatedAt: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch {
      // ignore
    }
    void adminSaveDocument('bot_agent_schedules', 'primary', {
      schedules: this.schedules,
    });
  }

  public async hydrateFromCloud(forceRefresh = false) {
    try {
      const cloudRuns = await adminLoadDocument<{ runs?: AgentRunRecord[] }>('bot_agent_runs', 'primary');
      if (Array.isArray(cloudRuns?.runs) && cloudRuns.runs.length > 0 && (forceRefresh || this.runs.length === 0)) {
        const localActive = this.runs.filter((r) => r.status === 'running');
        const merged = [...cloudRuns.runs];
        for (const active of localActive) {
          if (!merged.some((r) => r.id === active.id)) {
            merged.unshift(active);
          }
        }
        this.runs = merged.slice(0, MAX_RUNS);
      }
      const cloudSched = await adminLoadDocument<{ schedules?: AgentScheduleItem[] }>('bot_agent_schedules', 'primary');
      if (Array.isArray(cloudSched?.schedules) && cloudSched.schedules.length > 0 && (forceRefresh || this.schedules.length === 0)) {
        this.schedules = cloudSched.schedules.slice(0, MAX_SCHEDULES);
      }
    } catch {
      // ignore
    }
  }

  public startScheduler() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = setInterval(() => {
      void this.tickSchedules();
    }, 60_000);
  }

  public stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private async tickSchedules() {
    if (this.activeRunId) return;
    const now = Date.now();
    const due = this.schedules.find((s) => s.enabled && Date.parse(s.nextRunAt) <= now);
    if (!due) return;

    due.lastRunAt = new Date(now).toISOString();
    due.nextRunAt = new Date(now + Math.max(15, due.intervalMinutes) * 60_000).toISOString();
    this.saveSchedules();

    const run = await this.executeMission({ goal: due.goal, source: 'schedule' });
    due.lastSummary = run.finalReport.slice(0, 260);
    this.saveSchedules();

    if (due.notifySelfChat) {
      await this.adapters
        .sendOwnerSelfChatReport(`⏰ *শিডিউলড এজেন্ট রিপোর্ট (${due.title}):*\n${run.finalReport}`)
        .catch(() => false);
    }
  }

  public healStuckRuns(): string[] {
    const healed: string[] = [];
    const now = Date.now();
    for (const run of this.runs) {
      if (run.status === 'running' && now - Date.parse(run.startedAt) > 4 * 60_000) {
        run.status = 'failed';
        run.error = 'Recovered stale running state during 5-min self-heal cycle.';
        run.completedAt = new Date().toISOString();
        if (this.activeRunId === run.id) {
          this.activeRunId = null;
        }
        healed.push(`Unlocked stale agent run ${run.id}`);
      }
    }
    if (healed.length > 0) this.saveRuns();
    return healed;
  }

  public createSchedule(params: {
    title: string;
    goal: string;
    intervalMinutes: number;
    notifySelfChat?: boolean;
  }): AgentScheduleItem {
    const interval = Math.max(15, Math.min(10080, Math.round(params.intervalMinutes || 60)));
    const item: AgentScheduleItem = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: String(params.title || params.goal).slice(0, 80),
      goal: String(params.goal).slice(0, 400),
      intervalMinutes: interval,
      enabled: true,
      notifySelfChat: params.notifySelfChat !== false,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() + interval * 60_000).toISOString(),
      lastSummary: null,
      createdAt: new Date().toISOString(),
    };
    this.schedules.unshift(item);
    this.saveSchedules();
    return item;
  }

  public toggleSchedule(id: string): AgentScheduleItem | null {
    const item = this.schedules.find((s) => s.id === id);
    if (!item) return null;
    item.enabled = !item.enabled;
    if (item.enabled && Date.parse(item.nextRunAt) <= Date.now()) {
      item.nextRunAt = new Date(Date.now() + item.intervalMinutes * 60_000).toISOString();
    }
    this.saveSchedules();
    return item;
  }

  public deleteSchedule(id: string): boolean {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    if (this.schedules.length !== before) {
      this.saveSchedules();
      return true;
    }
    return false;
  }

  public getSnapshot() {
    return {
      isRunning: Boolean(this.activeRunId),
      activeRunId: this.activeRunId,
      runs: this.runs.slice(0, 15),
      schedules: this.schedules,
      firestoreDiagnostics: getFirestoreAdminDiagnostics(),
    };
  }

  private async executeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; summary: string; data: Record<string, unknown> }> {
    try {
      switch (toolName) {
        case 'web_search': {
          const query = String(args.query || '').trim();
          const maxSites = Math.max(1, Math.min(6, Number(args.maxSites || 4)));
          const res = await this.adapters.outreach.runResearch({ query, maxSites });
          return {
            ok: true,
            summary: `${res.research.providerUsed}: ${res.leads.length} sites, ${res.research.emailsFound} emails, ${res.research.phonesFound} phones`,
            data: {
              providerUsed: res.research.providerUsed,
              summary: res.research.summary,
              leads: res.leads.slice(0, 8).map((l) => ({
                name: l.name,
                url: l.sourceUrl,
                emails: l.emails,
                phones: l.phones,
              })),
            },
          };
        }

        case 'smart_read_url': {
          const urls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean).slice(0, 5) : [];
          const topic = String(args.topic || 'Autonomous URL Read');
          const preferMobile = Boolean(args.preferMobileOffload);

          if (preferMobile && this.adapters.offloadQueue.hasActiveWorker() && urls.length > 0) {
            const mobileResults: unknown[] = [];
            for (const url of urls.slice(0, 2)) {
              const job = this.adapters.offloadQueue.enqueueJob('scrape_url', { url, topic });
              const done = await this.adapters.offloadQueue.waitForJob(job.id, 14_000);
              if (done?.status === 'completed' && done.result) {
                const lead = this.adapters.outreach.ingestExternalLead({
                  name: typeof done.result.title === 'string' ? done.result.title : url,
                  sourceUrl: url,
                  topic,
                  emails: Array.isArray(done.result.emails) ? done.result.emails.map(String) : [],
                  phones: Array.isArray(done.result.phones) ? done.result.phones.map(String) : [],
                  snippet: typeof done.result.snippet === 'string' ? done.result.snippet : '',
                });
                mobileResults.push({
                  source: 'mobile_pwa_offload',
                  url: lead.sourceUrl,
                  emails: lead.emails,
                  phones: lead.phones,
                });
              }
            }
            if (mobileResults.length > 0) {
              return {
                ok: true,
                summary: `Mobile PWA Offload scanned ${mobileResults.length} URL(s) using phone data.`,
                data: { leads: mobileResults },
              };
            }
          }

          const res = await this.adapters.outreach.scrapeUrls({ urlsText: urls.join('\n'), topic });
          // If server fetch yielded errors and Mobile PWA Worker is online, transparently retry failed URLs on phone!
          if (res.leads.length === 0 && res.errors.length > 0 && this.adapters.offloadQueue.hasActiveWorker()) {
            const recovered: unknown[] = [];
            for (const url of urls.slice(0, 2)) {
              const job = this.adapters.offloadQueue.enqueueJob('scrape_url', { url, topic });
              const done = await this.adapters.offloadQueue.waitForJob(job.id, 14_000);
              if (done?.status === 'completed' && done.result) {
                const lead = this.adapters.outreach.ingestExternalLead({
                  name: typeof done.result.title === 'string' ? done.result.title : url,
                  sourceUrl: url,
                  topic,
                  emails: Array.isArray(done.result.emails) ? done.result.emails.map(String) : [],
                  phones: Array.isArray(done.result.phones) ? done.result.phones.map(String) : [],
                  snippet: typeof done.result.snippet === 'string' ? done.result.snippet : '',
                });
                recovered.push(lead);
              }
            }
            if (recovered.length > 0) {
              return {
                ok: true,
                summary: `Recovered ${recovered.length} URL(s) via Mobile PWA Offload Worker.`,
                data: { leads: recovered },
              };
            }
          }

          return {
            ok: true,
            summary: `Scanned ${res.leads.length} URL(s): ${res.research.emailsFound} emails, ${res.research.phonesFound} phones`,
            data: {
              leads: res.leads.map((l) => ({
                name: l.name,
                url: l.sourceUrl,
                emails: l.emails,
                phones: l.phones,
              })),
              errors: res.errors,
            },
          };
        }

        case 'verify_whatsapp_leads': {
          const res = await this.adapters.outreach.verifyWhatsappLeads();
          return {
            ok: true,
            summary: `Checked ${res.checkedCount} numbers -> ${res.activeFound} active on WhatsApp`,
            data: res,
          };
        }

        case 'send_whatsapp_message': {
          const messageText = String(args.messageText || '').trim();
          const excludePhonesRaw = Array.isArray(args.excludePhones) ? args.excludePhones.map(String) : [];
          const normalizedExcludes = excludePhonesRaw.map(normalizePhone).filter((p) => p.length >= 7);

          if (normalizedExcludes.length > 0) {
            await this.adapters.upsertContactPolicies(
              normalizedExcludes.map((pn) => ({
                jid: `${pn}@s.whatsapp.net`,
                phone: pn,
                name: `+${pn}`,
                mode: 'mute_ai' as ContactPolicyMode,
                note: 'Excluded by Autonomous Agent command',
              }))
            );
          }

          const targetInputs = Array.isArray(args.targetPhonesOrNames)
            ? args.targetPhonesOrNames.map(String).filter(Boolean)
            : [];
          const useLeads = Boolean(args.useCollectedLeads);
          const maxCount = Math.max(1, Math.min(15, Number(args.maxCount || 8)));

          if (useLeads && targetInputs.length === 0) {
            const res = await this.adapters.outreach.sendWhatsappOutreach({
              body: messageText,
              excludePhones: normalizedExcludes,
              useCollectedLeads: true,
              maxCount,
            });
            return {
              ok: !res.error,
              summary: res.error || `WA Outreach: queued=${res.queued}, sent=${res.sentCount}, totalTargets=${res.totalTargets}, skippedMuted=${res.skippedMuted}`,
              data: res as unknown as Record<string, unknown>,
            };
          }

          const contacts = this.adapters.getDirectoryContacts();
          const targets: Array<{ jid: string; phone: string; name: string }> = [];
          const seen = new Set<string>();

          for (const rawTarget of targetInputs) {
            const norm = normalizePhone(rawTarget);
            if (norm.length >= 7) {
              const key = norm.slice(-10);
              if (normalizedExcludes.some((ex) => ex.slice(-10) === key) || seen.has(key)) continue;
              seen.add(key);
              const existing = contacts.find((c) => normalizePhone(c.phone || c.jid).slice(-10) === key);
              targets.push({
                jid: existing?.jid || `${norm}@s.whatsapp.net`,
                phone: norm,
                name: existing?.name || `+${norm}`,
              });
            } else {
              const lowerName = rawTarget.toLowerCase();
              const match = contacts.find((c) => c.name.toLowerCase().includes(lowerName));
              if (match) {
                const pn = normalizePhone(match.phone || match.jid);
                const key = pn.slice(-10) || match.jid;
                if (normalizedExcludes.some((ex) => ex.slice(-10) === key) || seen.has(key)) continue;
                seen.add(key);
                targets.push({ jid: match.jid, phone: pn, name: match.name });
              }
            }
          }

          if (targets.length === 0) {
            return {
              ok: false,
              summary: 'No matching non-excluded WhatsApp targets resolved.',
              data: { targetsCount: 0, excludedCount: normalizedExcludes.length },
            };
          }

          const dispatched = await this.adapters.dispatchDirectDm({
            targets: targets.slice(0, maxCount),
            messageText,
            originalInstruction: 'Autonomous Agent WhatsApp Dispatch',
          });
          return {
            ok: true,
            summary: `Delivered ${dispatched.deliveredCount}, drafted ${dispatched.draftCount} (${dispatched.targetLabels.join(', ')})`,
            data: dispatched as unknown as Record<string, unknown>,
          };
        }

        case 'send_email_outreach': {
          const subject = String(args.subject || '').trim();
          const body = String(args.body || '').trim();
          const directEmails = Array.isArray(args.targetEmails)
            ? args.targetEmails.map((e) => String(e).trim().toLowerCase()).filter((e) => e.includes('@'))
            : [];
          const useCollectedLeads = args.useCollectedLeads === true || directEmails.length === 0;
          const maxCount = Math.max(1, Math.min(15, Number(args.maxCount || 5)));

          const res = await this.adapters.outreach.sendEmailOutreach({
            subject,
            body,
            directEmails,
            useCollectedLeads,
            maxCount,
          });
          return {
            ok: res.sentCount > 0 && !res.error,
            summary: res.error || `Email (${res.providerUsed}): sent=${res.sentCount}, failed=${res.failedCount}`,
            data: res as unknown as Record<string, unknown>,
          };
        }

        case 'manage_whatsapp_groups': {
          const action = String(args.action || 'list');
          const groups = this.adapters.getKnownGroups();
          if (action === 'list') {
            return {
              ok: true,
              summary: `Found ${groups.length} WhatsApp group(s)`,
              data: { groups: groups.slice(0, 12).map((g) => ({ jid: g.jid, name: g.name, membersCount: g.members?.length || 0 })) },
            };
          }
          const groupQuery = String(args.groupNameOrJid || '').toLowerCase();
          const group = groups.find((g) => g.jid.toLowerCase() === groupQuery || g.name.toLowerCase().includes(groupQuery));
          if (!group) {
            return { ok: false, summary: `Group "${args.groupNameOrJid}" not found.`, data: {} };
          }
          if (action === 'kick_member') {
            const target = String(args.targetPhoneOrName || '').trim();
            const k = await this.adapters.kickGroupMember({ groupJid: group.jid, groupName: group.name, targetPhoneOrName: target });
            return { ok: k.ok, summary: k.reason, data: k as unknown as Record<string, unknown> };
          }
          if (action === 'mute_member') {
            const target = String(args.targetPhoneOrName || '').trim();
            const pn = normalizePhone(target);
            const matched = (group.members || []).find(
              (m) => (pn && normalizePhone(m.phone || m.jid).slice(-10) === pn.slice(-10)) || m.name.toLowerCase().includes(target.toLowerCase())
            );
            const finalPhone = normalizePhone(matched?.phone || pn);
            if (!finalPhone) return { ok: false, summary: 'Member not found for mute.', data: {} };
            await this.adapters.upsertContactPolicies([
              { jid: matched?.jid || `${finalPhone}@s.whatsapp.net`, phone: finalPhone, name: matched?.name || `+${finalPhone}`, mode: 'mute_ai', note: `Muted in ${group.name}` },
            ]);
            return { ok: true, summary: `Muted ${matched?.name || finalPhone} across DM & Group AI.`, data: { phone: finalPhone } };
          }
          if (action === 'set_antilink') {
            const cfg = this.adapters.getBotConfig();
            const enabled = args.enabled !== false;
            await this.adapters.updateSystemSettings({ antilinkGroups: { ...(cfg.antilinkGroups || {}), [group.jid]: enabled } });
            return { ok: true, summary: `Anti-Link in ${group.name} -> ${enabled ? 'ON' : 'OFF'}`, data: { groupName: group.name, enabled } };
          }
          if (action === 'set_group_ai') {
            const cfg = this.adapters.getBotConfig();
            const enabled = args.enabled !== false;
            await this.adapters.updateSystemSettings({ groupAiGroups: { ...(cfg.groupAiGroups || {}), [group.jid]: enabled } });
            return { ok: true, summary: `Group AI in ${group.name} -> ${enabled ? 'ON' : 'OFF'}`, data: { groupName: group.name, enabled } };
          }
          if (action === 'group_mention') {
            const msg = String(args.messageText || 'সবাই একটু খেয়াল করুন।');
            const res = await this.adapters.dispatchGroupMention({
              groupJid: group.jid,
              groupName: group.name,
              members: (group.members || []).slice(0, 15),
              messageText: msg,
              originalInstruction: 'Autonomous Group Mention',
            });
            return { ok: true, summary: `Mentioned ${res.mentionedCount} members in ${res.groupName}`, data: res as unknown as Record<string, unknown> };
          }
          return { ok: false, summary: `Unknown group action: ${action}`, data: {} };
        }

        case 'read_inbox_and_system': {
          const cfg = this.adapters.getBotConfig();
          const outreach = this.adapters.outreach.getSummary();
          const unread = this.adapters.getUnreadNotes();
          const memories = this.adapters.getRecentMemories();
          const ping = this.adapters.getSelfPingStats();
          const watchdog = this.adapters.getWatchdog()?.getStatus();
          const offload = this.adapters.offloadQueue.getStatusSnapshot();
          const firestore = getFirestoreAdminDiagnostics();
          const fullControls = getFullControlSnapshot(cfg as AssistantConfigFields & Record<string, unknown>, {
            geminiKeysCount: this.adapters.geminiPool.getStats().configuredKeysCount,
            openRouterKeysCount: this.adapters.openRouterReader.getStats().configuredKeysCount,
          });
          return {
            ok: true,
            summary: `Bot=${this.adapters.getBotStatus()}, ON=${fullControls.totalOn}, OFF=${fullControls.totalOff}, EstSpeed=${fullControls.estimatedInstantReplySec}, RAM=${this.adapters.getMemoryRssMb()}MB`,
            data: {
              botStatus: this.adapters.getBotStatus(),
              memoryRssMb: this.adapters.getMemoryRssMb(),
              controlsSummary: {
                totalOn: fullControls.totalOn,
                totalOff: fullControls.totalOff,
                onList: fullControls.onList,
                offList: fullControls.offList,
                estimatedInstantReplySec: fullControls.estimatedInstantReplySec,
                optimizedReplySec: fullControls.optimizedReplySec,
                potentialSavedSec: fullControls.potentialSavedSec,
                speedTipsBn: fullControls.speedTipsBn,
              },
              assistantTone: cfg.assistantTone,
              dailyReplyLimit: cfg.dailyReplyLimit,
              selfPing: ping,
              watchdog: watchdog ? { enabled: watchdog.enabled, cycleCount: watchdog.cycleCount, totalHealsApplied: watchdog.totalHealsApplied } : null,
              mobileOffloadWorkers: offload.activeWorkers.length,
              firestore,
              emailSenders: outreach.senders.map((s) => ({ email: s.email, active: s.active, type: s.type })),
              unreadNotes: unread.slice(0, 8).map((n) => ({ contactName: n.contactName, urgency: n.urgency, summary: n.summary })),
              recentMemories: memories.slice(0, 6).map((m) => ({ contactName: m.contactName, lastSummary: m.lastSummary })),
              leadsSample: outreach.leads.slice(0, 8).map((l) => ({ name: l.name, domain: l.domain, emails: l.emails, phones: l.phones, waVerified: l.whatsappVerifiedPhones })),
            },
          };
        }

        case 'configure_system_and_email': {
          const cfg = this.adapters.getBotConfig() as AssistantConfigFields & Record<string, unknown>;
          const { patch, warnings, changedLabels } = buildPatchFromInput(
            args as unknown as ControlPatchInput,
            cfg
          );

          if (warnings.length > 0 && args.confirmedOverride !== true) {
            return {
              ok: true,
              summary: `Tradeoff warning before applying (${changedLabels.join(', ')}): ${warnings.join(' | ')}`,
              data: {
                applied: false,
                needsConfirmation: true,
                warnings,
                proposedChanges: changedLabels,
                instruction: 'Explain these potential downsides briefly in Bengali, and tell the owner that replying "তারপরও করো" / "করো" will execute it immediately without resistance.',
              },
            };
          }

          if (Object.keys(patch).length > 0) {
            await this.adapters.updateSystemSettings(patch as Partial<AssistantConfigFields>);
          }
          let switched: string | null = null;
          if (typeof args.switchEmailSender === 'string' && args.switchEmailSender.trim()) {
            const p = this.adapters.outreach.switchEmailSender(args.switchEmailSender.trim());
            switched = p ? p.email : 'not_found';
          }
          const updatedSnapshot = getFullControlSnapshot({ ...cfg, ...patch });
          return {
            ok: true,
            summary: `Updated (${changedLabels.join(', ') || 'none'})${switched ? `, sender=${switched}` : ''}`,
            data: {
              applied: true,
              changedLabels,
              warningsNoted: warnings,
              switched,
              estimatedInstantReplySec: updatedSnapshot.estimatedInstantReplySec,
            },
          };
        }

        case 'schedule_autonomous_mission': {
          const title = String(args.title || 'Autonomous Task').trim();
          const goal = String(args.goal || '').trim();
          const intervalMinutes = Number(args.intervalMinutes || 60);
          const item = this.createSchedule({ title, goal, intervalMinutes, notifySelfChat: true });
          return {
            ok: true,
            summary: `Scheduled "${item.title}" every ${item.intervalMinutes} min`,
            data: { id: item.id, nextRunAt: item.nextRunAt },
          };
        }

        case 'run_self_heal_now': {
          const wd = this.adapters.getWatchdog();
          if (!wd) return { ok: false, summary: 'Watchdog not initialized', data: {} };
          const ev: WatchdogHealEvent = await wd.runHealCycle('manual');
          return {
            ok: ev.ok,
            summary: `Heal complete (${ev.rssBeforeMb}->${ev.rssAfterMb}MB): ${ev.actionsTaken.join(', ')}`,
            data: ev as unknown as Record<string, unknown>,
          };
        }

        default:
          return { ok: false, summary: `Unknown tool: ${toolName}`, data: {} };
      }
    } catch (err) {
      return {
        ok: false,
        summary: `Tool error: ${(err as Error).message.slice(0, 160)}`,
        data: { error: (err as Error).message },
      };
    }
  }

  public async executeMission(params: {
    goal: string;
    source: 'self_chat' | 'dashboard' | 'schedule';
    maxWallClockMs?: number;
    preassignedRunId?: string;
  }): Promise<AgentRunRecord> {
    await this.hydrateFromCloud(false);
    const cleanGoal = params.goal.trim().slice(0, 1200);
    const run: AgentRunRecord = {
      id: params.preassignedRunId || `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      source: params.source,
      goal: cleanGoal,
      status: 'running',
      providerUsed: 'hybrid',
      modelUsed: 'initializing',
      tokensUsed: 0,
      steps: [],
      finalReport: '',
      startedAt: new Date().toISOString(),
    };
    this.runs = [run, ...this.runs.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
    this.activeRunId = run.id;
    await this.saveRunsAsync();

    const effectiveWallClockMs = Math.max(4_000, params.maxWallClockMs ?? AGENT_WALL_CLOCK_MS);
    const deadline = Date.now() + effectiveWallClockMs;
    const cfg = this.adapters.getBotConfig();
    const systemPrompt = [
      `You are the Fully Autonomous Control Agent (Brain + Hands & Feet) for "${cfg.ownerName || 'Sir'}".`,
      'You have complete authority over ALL WaNexus dashboard controls, settings, speed optimization, research, and messaging.',
      'Rules:',
      '1. NEVER say "I cannot do that" or block the owner on any dashboard/bot control request. You obey the owner completely.',
      '2. Warn-Once -> Confirm-Override Rule: If a requested setting change has a tradeoff/risk (returned in tool warnings with needsConfirmation=true), explain the potential issue clearly in Bengali first and ask if they still want it; if the owner says "তারপরও করো" / "করো" / confirm / force, immediately call `configure_system_and_email` with `confirmedOverride: true` and execute it without hesitation.',
      '3. When asked what is ON/OFF or how to make replies faster, call `read_inbox_and_system` and give exact ON/OFF lists plus concrete speed advice showing how many seconds can be saved.',
      '4. Use tools sequentially and NEVER fabricate tool results. Write the final report in clear, helpful Bengali.',
    ].join('\n');

    try {
      // Strategy A: 5-Key Gemini Pool Native Function Calling (gemini-4-hydrogen -> gemini-3.1-flash-lite)
      let strategyAFailureReason = '';
      if (this.adapters.geminiPool.hasKeys()) {
        const geminiModels: Array<{ model: string; channel: string; useLowThinking: boolean }> = [
          { model: 'gemini-4-hydrogen', channel: 'primary', useLowThinking: true },
          { model: 'gemini-3.1-flash-lite', channel: 'lite', useLowThinking: false },
        ];

        for (const modelSpec of geminiModels) {
          try {
            const contents: Content[] = [
              {
                role: 'user',
                parts: [
                  {
                    text: `Owner Mission Goal:\n${cleanGoal}\n\nCurrent Bot Status: ${this.adapters.getBotStatus()}, RAM: ${this.adapters.getMemoryRssMb()}MB, Active Mobile Workers: ${this.adapters.offloadQueue.getActiveWorkers().length}`,
                  },
                ],
              },
            ];

            for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
              if (Date.now() > deadline) {
                run.finalReport = '⏱️ মিশনের সময়সীমা (55s) শেষ হয়েছে—এখন পর্যন্ত সম্পন্ন ধাপগুলোর রিপোর্ট উপরে সংরক্ষিত আছে।';
                break;
              }

              const execResult = await this.adapters.geminiPool.executeWithRotation(
                async (client) => {
                  return client.models.generateContent({
                    model: modelSpec.model,
                    contents,
                    config: {
                      systemInstruction: systemPrompt,
                      ...(modelSpec.useLowThinking
                        ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                        : {}),
                      tools: [{ functionDeclarations: AGENT_FUNCTION_DECLARATIONS }],
                    },
                  });
                },
                undefined,
                { maxTotalMs: 20_000, channel: modelSpec.channel }
              );

              const response = execResult.value;
              const usageTotal = Number(response.usageMetadata?.totalTokenCount || 0);
              const usagePrompt = Number(response.usageMetadata?.promptTokenCount || 0);
              const usageCompletion = Number(response.usageMetadata?.candidatesTokenCount || 0);
              run.tokensUsed += usageTotal;
              run.providerUsed = 'gemini';
              run.modelUsed = modelSpec.model;

              if (usageTotal > 0) {
                this.adapters.tokenTelemetry.recordUsage({
                  provider: 'gemini',
                  model: modelSpec.model,
                  category: 'command',
                  promptTokens: usagePrompt,
                  completionTokens: usageCompletion,
                  totalTokens: usageTotal,
                  keySlot: execResult.keySlot,
                });
              }

              const candidateContent = response.candidates?.[0]?.content;
              if (candidateContent) {
                contents.push(candidateContent);
              }

              const calls = response.functionCalls || [];
              if (calls.length === 0) {
                run.finalReport = (response.text || '').trim() || '✅ মিশন সম্পন্ন হয়েছে।';
                run.status = 'completed';
                run.completedAt = new Date().toISOString();
                this.saveRuns();
                return run;
              }

              const responseParts = [];
              for (const call of calls) {
                const argsObj = (call.args || {}) as Record<string, unknown>;
                const toolRes = await this.executeToolCall(call.name || '', argsObj);
                run.steps.push({
                  stepNumber: run.steps.length + 1,
                  toolName: call.name || 'unknown',
                  argsPreview: JSON.stringify(argsObj).slice(0, 160),
                  outcome: toolRes.ok ? 'ok' : 'error',
                  resultSummary: toolRes.summary,
                  timestamp: new Date().toISOString(),
                });
                responseParts.push({
                  functionResponse: {
                    id: call.id,
                    name: call.name || '',
                    response: toolRes.data,
                  },
                });
              }
              contents.push({ role: 'user', parts: responseParts });
              this.saveRuns();
            }

            if (!run.finalReport) {
              run.finalReport =
                run.steps.length > 0
                  ? `✅ *অটোনোমাস এজেন্ট ${run.steps.length}টি ধাপ সম্পন্ন করেছে:*\n` +
                    run.steps.map((s) => `${s.stepNumber}. [${s.toolName}] ${s.resultSummary}`).join('\n')
                  : '✅ মিশন সম্পন্ন হয়েছে।';
            }
            run.status = 'completed';
            run.completedAt = new Date().toISOString();
            this.saveRuns();
            return run;
          } catch (geminiErr) {
            strategyAFailureReason = (geminiErr as Error).message.slice(0, 140);
            this.adapters.pushLog(
              'gemini',
              'Autonomous Agent',
              `[${modelSpec.model}] failed -> falling back: ${strategyAFailureReason}`,
              'info'
            );
          }
        }
      }

      // Strategy B: OpenRouter Dynamic Free Pool ReAct Loop
      let strategyBFailureReason = '';
      if (this.adapters.openRouterReader.hasKeys()) {
        try {
          const toolCatalog = AGENT_FUNCTION_DECLARATIONS.map(
            (f) => `- ${f.name}: ${f.description} | args=${JSON.stringify((f.parameters as { properties?: unknown })?.properties || {})}`
          ).join('\n');
          const reactSystem = [
            systemPrompt,
            '',
            'Available Tools:',
            toolCatalog,
            '',
            'Respond ONLY with strict JSON:',
            'To invoke a tool: {"thought":"short plan","tool":"tool_name","args":{...}}',
            'To finish and reply to owner: {"thought":"done","finalAnswer":"Complete Bangla report"}',
          ].join('\n');

          const history: string[] = [`Owner Goal: ${cleanGoal}`];
          for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
            if (Date.now() > deadline) break;
            const planRes = await this.adapters.openRouterReader.generateAgentStepPlan({
              systemPrompt: reactSystem,
              transcript: history.join('\n\n'),
            });
            run.providerUsed = 'openrouter';
            run.modelUsed = planRes.modelUsed;
            run.tokensUsed += planRes.usage?.totalTokens || 0;

            const cleanedJson = planRes.content.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            let parsed: { thought?: string; tool?: string; args?: Record<string, unknown>; finalAnswer?: string } = {};
            try {
              const firstBrace = cleanedJson.indexOf('{');
              const lastBrace = cleanedJson.lastIndexOf('}');
              parsed = JSON.parse(
                firstBrace >= 0 && lastBrace > firstBrace ? cleanedJson.slice(firstBrace, lastBrace + 1) : cleanedJson
              );
            } catch {
              run.finalReport = planRes.content;
              run.status = 'completed';
              run.completedAt = new Date().toISOString();
              this.saveRuns();
              return run;
            }

            if (parsed.finalAnswer) {
              run.finalReport = parsed.finalAnswer;
              run.status = 'completed';
              run.completedAt = new Date().toISOString();
              this.saveRuns();
              return run;
            }

            if (parsed.tool) {
              const toolRes = await this.executeToolCall(parsed.tool, parsed.args || {});
              run.steps.push({
                stepNumber: run.steps.length + 1,
                toolName: parsed.tool,
                argsPreview: JSON.stringify(parsed.args || {}).slice(0, 160),
                outcome: toolRes.ok ? 'ok' : 'error',
                resultSummary: toolRes.summary,
                timestamp: new Date().toISOString(),
              });
              history.push(
                `Step ${step} Executed ${parsed.tool}: outcome=${toolRes.ok ? 'ok' : 'error'} | summary=${toolRes.summary} | data=${JSON.stringify(toolRes.data).slice(0, 1500)}`
              );
              this.saveRuns();
            } else {
              break;
            }
          }

          if (!run.finalReport) {
            run.finalReport =
              run.steps.length > 0
                ? `✅ *OpenRouter এজেন্ট (${run.modelUsed}) ${run.steps.length}টি ধাপ সম্পন্ন করেছে:*\n` +
                  run.steps.map((s) => `${s.stepNumber}. [${s.toolName}] ${s.resultSummary}`).join('\n')
                : '✅ মিশন সম্পন্ন হয়েছে।';
          }
          run.status = 'completed';
          run.completedAt = new Date().toISOString();
          this.saveRuns();
          return run;
        } catch (openRouterErr) {
          strategyBFailureReason = (openRouterErr as Error).message.slice(0, 140);
          this.adapters.pushLog(
            'system',
            'Autonomous Agent',
            `OpenRouter ReAct failed -> degrading to deterministic report: ${strategyBFailureReason}`,
            'error'
          );
          if (run.steps.length > 0) {
            run.finalReport =
              `⚠️ *আংশিক সম্পন্ন (${run.steps.length}টি ধাপ):*\n` +
              run.steps.map((s) => `${s.stepNumber}. [${s.toolName}] ${s.resultSummary}`).join('\n') +
              `\n\nকারণ: ${strategyBFailureReason}`;
            run.status = 'completed';
            run.completedAt = new Date().toISOString();
            this.saveRuns();
            return run;
          }
        }
      }

      // Strategy C: Zero-Token Deterministic Fallback Report
      run.providerUsed = 'zero_token';
      run.modelUsed = 'local_deterministic';
      const diagRes = await this.executeToolCall('read_inbox_and_system', {});
      run.steps.push({
        stepNumber: 1,
        toolName: 'read_inbox_and_system',
        argsPreview: '{}',
        outcome: 'ok',
        resultSummary: diagRes.summary,
        timestamp: new Date().toISOString(),
      });
      const reasonHint = strategyAFailureReason || strategyBFailureReason;
      run.finalReport = reasonHint
        ? `⚠️ Gemini/OpenRouter ব্রেইন এই মুহূর্তে রেসপন্স দেয়নি (${reasonHint})—তাই ০-টোকেন ডায়াগনস্টিক রিপোর্ট দেওয়া হলো।\nস্ট্যাটাস: ${diagRes.summary}`
        : '⚠️ এই মুহূর্তে কোনো Gemini বা OpenRouter API কী অ্যাক্টিভ পাওয়া যায়নি—তাই অটোনোমাস AI ব্রেইন এর বদলে ০-টোকেন সিস্টেম রিপোর্ট দেওয়া হলো।\n' +
          `স্ট্যাটাস: ${diagRes.summary}`;
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      this.saveRuns();
      return run;
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message.slice(0, 240);
      run.finalReport = `❌ অটোনোমাস এজেন্ট রান ব্যর্থ হয়েছে: ${run.error}`;
      run.completedAt = new Date().toISOString();
      this.saveRuns();
      return run;
    } finally {
      if (this.activeRunId === run.id) {
        this.activeRunId = null;
      }
      await this.saveRunsAsync();
      this.adapters.pushLog(
        'system',
        `Autonomous Agent (${run.providerUsed})`,
        `"${cleanGoal.slice(0, 45)}" -> ${run.steps.length} steps (${run.tokensUsed} tok)`,
        run.status === 'completed' ? 'success' : 'error'
      );
    }
  }
}

export function registerAutonomousAgentRoutes(
  app: Express,
  agent: AutonomousAgentEngine,
  getWatchdog: () => SelfHealingWatchdog | null,
  options?: {
    dispatchBackgroundMission?: (req: Request, goal: string) => Promise<AgentRunRecord | null>;
    syncWallClockMs?: number;
  }
) {
  app.get('/api/agent/state', async (_req: Request, res: Response) => {
    if (IS_SERVERLESS) {
      await agent.hydrateFromCloud(true);
    }
    const wd = getWatchdog();
    res.json({
      ...agent.getSnapshot(),
      watchdog: wd ? wd.getStatus() : null,
    });
  });

  app.post('/api/agent/run', async (req: Request, res: Response) => {
    const goal = String(req.body?.goal || '').trim();
    if (!goal || goal.length < 3) {
      res.status(400).json({ error: 'Please provide a valid mission goal.' });
      return;
    }
    if (options?.dispatchBackgroundMission) {
      const queuedRun = await options.dispatchBackgroundMission(req, goal).catch(() => null);
      if (queuedRun) {
        res.json({ ok: true, queuedBackground: true, run: queuedRun });
        return;
      }
    }
    const run = await agent.executeMission({
      goal,
      source: 'dashboard',
      maxWallClockMs: options?.syncWallClockMs,
    });
    res.json({ ok: run.status === 'completed', run });
  });

  app.post('/api/agent/schedules', (req: Request, res: Response) => {
    const title = String(req.body?.title || '').trim();
    const goal = String(req.body?.goal || '').trim();
    const intervalMinutes = Number(req.body?.intervalMinutes || 60);
    if (!goal || goal.length < 3) {
      res.status(400).json({ error: 'Schedule goal is required.' });
      return;
    }
    const schedule = agent.createSchedule({
      title: title || goal.slice(0, 40),
      goal,
      intervalMinutes,
      notifySelfChat: req.body?.notifySelfChat !== false,
    });
    res.json({ ok: true, schedule });
  });

  app.post('/api/agent/schedules/:id/toggle', (req: Request, res: Response) => {
    const updated = agent.toggleSchedule(req.params.id);
    if (!updated) {
      res.status(404).json({ error: 'Schedule not found.' });
      return;
    }
    res.json({ ok: true, schedule: updated });
  });

  app.delete('/api/agent/schedules/:id', (req: Request, res: Response) => {
    const removed = agent.deleteSchedule(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Schedule not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/watchdog/heal-now', async (_req: Request, res: Response) => {
    const wd = getWatchdog();
    if (!wd) {
      res.status(503).json({ error: 'Watchdog not initialized.' });
      return;
    }
    const event = await wd.runHealCycle('manual');
    res.json({ ok: true, event, status: wd.getStatus() });
  });
}
