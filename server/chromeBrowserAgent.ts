import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { ThinkingLevel, Type, type Content } from '@google/genai';
import type { GeminiKeyPool } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';
import type { TokenTelemetryTracker } from './tokenTelemetry.ts';
import { adminLoadDocument, adminSaveDocument } from './firestoreAdmin.ts';

export type ChromeBackendMode = 'remote_cdp' | 'local_chrome' | 'companion_bridge' | 'unconfigured';

export interface ChromeDomElement {
  id: number;
  tag: string;
  type: string;
  role: string;
  name: string;
  placeholder: string;
  ariaLabel: string;
  text: string;
  href: string;
  valuePreview: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface ChromeStepRecord {
  stepNumber: number;
  action: string;
  targetDescription: string;
  reasonBn: string;
  outcome: 'ok' | 'paused' | 'error';
  urlAfter: string;
  timestamp: string;
}

export interface ChromeTaskRecord {
  id: string;
  source: 'dashboard' | 'telegram' | 'agent';
  goal: string;
  startUrl?: string;
  status: 'running' | 'waiting_human_input' | 'completed' | 'failed' | 'stopped';
  pauseReasonBn?: string;
  pauseKind?: 'otp' | 'captcha' | '2fa' | 'manual_confirm';
  currentUrl: string;
  currentTitle: string;
  backendUsed: ChromeBackendMode;
  steps: ChromeStepRecord[];
  finalSummary: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SavedAccountStored {
  id: string;
  label: string;
  domain: string;
  loginUrl: string;
  username: string;
  passwordEnc: string;
  totpHint?: string;
  notes?: string;
  autoUseInTasks: boolean;
  updatedAt: string;
}

export interface SavedAccountPublic {
  id: string;
  label: string;
  domain: string;
  loginUrl: string;
  username: string;
  hasPassword: boolean;
  passwordPreview: string;
  totpHint?: string;
  notes?: string;
  autoUseInTasks: boolean;
  updatedAt: string;
}

export interface SignupIdentityStored {
  fullName: string;
  defaultEmail: string;
  defaultPhone: string;
  usernamePrefix: string;
  country: string;
  dateOfBirth: string;
  defaultSignupPasswordEnc: string;
}

export interface SignupIdentityPublic {
  fullName: string;
  defaultEmail: string;
  defaultPhone: string;
  usernamePrefix: string;
  country: string;
  dateOfBirth: string;
  hasDefaultPassword: boolean;
}

interface ChromeVaultStore {
  accounts: SavedAccountStored[];
  identity: SignupIdentityStored;
  customWsEndpointEnc?: string;
  companionBridgeToken?: string;
  headless: boolean;
  updatedAt: string;
}

export interface CompanionPendingCmd {
  id: string;
  type:
    | 'goto'
    | 'click_element'
    | 'click_xy'
    | 'fill_element'
    | 'select_element'
    | 'press_key'
    | 'scroll'
    | 'back'
    | 'reload'
    | 'snapshot';
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CompanionWorkerState {
  workerId: string;
  deviceLabel: string;
  lastHeartbeatAt: number;
  currentUrl: string;
  currentTitle: string;
}

export interface ChromeBrowserAdapters {
  geminiPool: GeminiKeyPool;
  openRouterReader: OpenRouterReader;
  tokenTelemetry: TokenTelemetryTracker;
  getOwnerName: () => string;
  notifyTelegramScreenshot?: (caption: string, jpegBase64?: string) => Promise<void>;
  pushLog?: (
    category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
    actor: string,
    summary: string,
    outcome?: 'success' | 'blocked' | 'info' | 'error'
  ) => void;
}

interface BrowserPlannedAction {
  action:
    | 'goto'
    | 'click'
    | 'type'
    | 'select'
    | 'press'
    | 'scroll'
    | 'wait'
    | 'ask_human'
    | 'complete'
    | 'fail';
  url?: string;
  elementId?: number;
  x?: number;
  y?: number;
  text?: string;
  value?: string;
  key?: string;
  submitEnter?: boolean;
  direction?: 'up' | 'down';
  waitMs?: number;
  pauseKind?: 'otp' | 'captcha' | '2fa' | 'manual_confirm';
  reasonBn: string;
  saveAccountLabel?: string;
  saveAccountUsername?: string;
  saveAccountPasswordToken?: string;
}

const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);
const RUNTIME_DIR = IS_SERVERLESS ? '/tmp' : '.';
const VAULT_FILE = path.resolve(RUNTIME_DIR, 'bot-chrome-vault.enc.json');
const TASKS_FILE = path.resolve(RUNTIME_DIR, 'bot-chrome-tasks.json');
const CHROME_PROFILE_DIR = path.resolve(RUNTIME_DIR, 'bot-chrome-profile');
const COMPANION_TTL_MS = 35_000;
const EPHEMERAL_FALLBACK_KEY = crypto.randomBytes(32).toString('hex');

function getVaultMasterKey(): Buffer {
  const secret =
    process.env.CHROME_VAULT_SECRET?.trim() ||
    process.env.DASHBOARD_AUTH_SECRET?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    EPHEMERAL_FALLBACK_KEY;
  return crypto.scryptSync(secret, 'wanexus-chrome-vault-v1', 32);
}

function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const key = getVaultMasterKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(encoded: string): string {
  if (!encoded || !encoded.includes(':')) return '';
  try {
    const parts = encoded.split(':');
    if (parts.length !== 3) return '';
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const key = getVaultMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function isPrivateIpOrHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  if (net.isIPv6(host)) {
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host === '::1') {
      return true;
    }
  }
  return false;
}

export function assertSafeBrowserUrl(rawUrl: string): URL {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('Website URL is required.');
  }
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  if (hasExplicitScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Blocked unsafe protocol in URL: ${trimmed.split(':')[0]}:`);
  }
  const normalized = hasExplicitScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid website URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked unsafe protocol: ${parsed.protocol}`);
  }
  if (isPrivateIpOrHost(parsed.hostname)) {
    throw new Error(`Blocked internal/private address navigation: ${parsed.hostname}`);
  }
  return parsed;
}

function assertSafeCdpWsUrl(rawWsUrl: string): string {
  const trimmed = String(rawWsUrl || '').trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid Chrome WebSocket endpoint URL.');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chrome CDP URL must use wss://, ws://, https://, or http://.');
  }
  if (IS_SERVERLESS && isPrivateIpOrHost(parsed.hostname)) {
    throw new Error('Serverless runtime cannot reach localhost/private CDP URLs directly — use wss:// tunnel or Companion PC Bridge.');
  }
  return parsed.toString();
}

function maskEndpointUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.slice(0, 12)}•••`;
  } catch {
    return 'configured (masked)';
  }
}

function findLocalChromeExecutable(): string {
  const envPath = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore permission check failures
    }
  }
  return '';
}

const INTERACTIVE_DOM_SCRIPT = `(() => {
  const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selectors));
  const elements = [];
  let idx = 0;
  for (const el of nodes) {
    if (idx >= 75) break;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 4 || rect.height < 4 || style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight + 250) continue;
    el.setAttribute('data-wanexus-el-id', String(idx));
    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute('type') || '').toLowerCase();
    const isSecret = inputType === 'password';
    const rawVal = 'value' in el ? String(el.value || '') : '';
    elements.push({
      id: idx,
      tag,
      type: inputType,
      role: el.getAttribute('role') || '',
      name: (el.getAttribute('name') || '').slice(0, 50),
      placeholder: (el.getAttribute('placeholder') || '').slice(0, 70),
      ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 70),
      text: (el.innerText || el.textContent || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 120) : '',
      valuePreview: isSecret ? (rawVal ? '••••••' : '') : rawVal.slice(0, 40),
      rect: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }
    });
    idx += 1;
  }
  const pageText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1400);
  return {
    url: window.location.href,
    title: document.title || '',
    elements,
    pageText,
  };
})()`;

export class ChromeBrowserAgent {
  private readonly adapters: ChromeBrowserAdapters;
  private vault: ChromeVaultStore = {
    accounts: [],
    identity: {
      fullName: '',
      defaultEmail: '',
      defaultPhone: '',
      usernamePrefix: '',
      country: 'Bangladesh',
      dateOfBirth: '',
      defaultSignupPasswordEnc: '',
    },
    headless: true,
    updatedAt: '',
  };
  private tasks: ChromeTaskRecord[] = [];
  private hydrated = false;
  private abortRequestedTaskIds = new Set<string>();

  // Active Playwright session (when local_chrome or remote_cdp is used)
  private activeBrowser: unknown = null;
  private activeContext: unknown = null;
  private activePage: unknown = null;
  private lastScreenshotBase64 = '';
  private lastScreenshotAt = '';
  private lastKnownUrl = '';
  private lastKnownTitle = '';
  private lastElements: ChromeDomElement[] = [];
  private lastPageText = '';

  // Companion Bridge state (when user connects their own PC/Android Chrome)
  private companionWorker: CompanionWorkerState | null = null;
  private companionQueue: CompanionPendingCmd[] = [];
  private companionWaiters = new Map<
    string,
    { resolve: (res: { ok: boolean; error?: string; url?: string; title?: string; elements?: ChromeDomElement[]; pageText?: string; screenshotBase64?: string }) => void }
  >();

  constructor(adapters: ChromeBrowserAdapters) {
    this.adapters = adapters;
    this.loadLocalDisk();
    if (!this.vault.companionBridgeToken) {
      this.vault.companionBridgeToken = crypto.randomBytes(24).toString('hex');
      this.saveLocalDisk();
    }
  }

  private loadLocalDisk() {
    try {
      if (fs.existsSync(VAULT_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) as Partial<ChromeVaultStore>;
        this.vault = {
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
          identity: {
            fullName: String(parsed.identity?.fullName || ''),
            defaultEmail: String(parsed.identity?.defaultEmail || ''),
            defaultPhone: String(parsed.identity?.defaultPhone || ''),
            usernamePrefix: String(parsed.identity?.usernamePrefix || ''),
            country: String(parsed.identity?.country || 'Bangladesh'),
            dateOfBirth: String(parsed.identity?.dateOfBirth || ''),
            defaultSignupPasswordEnc: String(parsed.identity?.defaultSignupPasswordEnc || ''),
          },
          customWsEndpointEnc: parsed.customWsEndpointEnc,
          companionBridgeToken: parsed.companionBridgeToken,
          headless: parsed.headless !== false,
          updatedAt: String(parsed.updatedAt || ''),
        };
      }
    } catch {
      // ignore disk read failure
    }
    try {
      if (fs.existsSync(TASKS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
        if (Array.isArray(parsed)) {
          this.tasks = parsed.slice(0, 15);
        }
      }
    } catch {
      // ignore
    }
  }

  private saveLocalDisk() {
    try {
      fs.writeFileSync(VAULT_FILE, JSON.stringify(this.vault, null, 2), 'utf8');
    } catch {
      // ignore
    }
    try {
      fs.writeFileSync(TASKS_FILE, JSON.stringify(this.tasks.slice(0, 15), null, 2), 'utf8');
    } catch {
      // ignore
    }
  }

  public async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const [rawVault, rawTasks] = await Promise.all([
        adminLoadDocument('bot_chrome_vault', 'primary'),
        adminLoadDocument('bot_chrome_tasks', 'primary'),
      ]);
      const cloudVault = rawVault as Record<string, unknown> | null;
      const cloudTasks = rawTasks as Record<string, unknown> | null;
      if (cloudVault && typeof cloudVault === 'object') {
        const cloudTs = Date.parse(String(cloudVault.updatedAt || '')) || 0;
        const localTs = Date.parse(this.vault.updatedAt || '') || 0;
        if (cloudTs > localTs) {
          this.vault = {
            accounts: Array.isArray(cloudVault.accounts)
              ? (cloudVault.accounts as SavedAccountStored[])
              : this.vault.accounts,
            identity: (cloudVault.identity as SignupIdentityStored) || this.vault.identity,
            customWsEndpointEnc:
              typeof cloudVault.customWsEndpointEnc === 'string'
                ? cloudVault.customWsEndpointEnc
                : this.vault.customWsEndpointEnc,
            companionBridgeToken:
              typeof cloudVault.companionBridgeToken === 'string'
                ? cloudVault.companionBridgeToken
                : this.vault.companionBridgeToken || crypto.randomBytes(24).toString('hex'),
            headless: cloudVault.headless !== false,
            updatedAt: String(cloudVault.updatedAt || new Date().toISOString()),
          };
          this.saveLocalDisk();
        }
      }
      if (cloudTasks && Array.isArray(cloudTasks.tasks) && this.tasks.length === 0) {
        this.tasks = (cloudTasks.tasks as ChromeTaskRecord[]).slice(0, 15);
      }
    } catch {
      // continue smoothly with local disk state
    }
  }

  private async persistVault(): Promise<void> {
    this.vault.updatedAt = new Date().toISOString();
    this.saveLocalDisk();
    const cleanVault = JSON.parse(JSON.stringify(this.vault)) as Record<string, unknown>;
    const cleanTasks = JSON.parse(JSON.stringify(this.tasks.slice(0, 15)));
    await Promise.allSettled([
      adminSaveDocument('bot_chrome_vault', 'primary', cleanVault),
      adminSaveDocument('bot_chrome_tasks', 'primary', {
        tasks: cleanTasks,
        updatedAt: new Date().toISOString(),
      }),
    ]);
  }

  private async persistTasksOnly(): Promise<void> {
    this.saveLocalDisk();
    const cleanTasks = JSON.parse(JSON.stringify(this.tasks.slice(0, 15)));
    await adminSaveDocument('bot_chrome_tasks', 'primary', {
      tasks: cleanTasks,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  private getEffectiveWsEndpoint(): string {
    const fromEnv = process.env.CHROME_WS_ENDPOINT?.trim() || process.env.BROWSERLESS_WS_URL?.trim() || '';
    if (fromEnv) return fromEnv;
    if (this.vault.customWsEndpointEnc) {
      return decryptSecret(this.vault.customWsEndpointEnc);
    }
    return '';
  }

  public isCompanionOnline(): boolean {
    return Boolean(this.companionWorker && Date.now() - this.companionWorker.lastHeartbeatAt <= COMPANION_TTL_MS);
  }

  public getActiveBackendMode(): ChromeBackendMode {
    if (this.getEffectiveWsEndpoint()) return 'remote_cdp';
    if (findLocalChromeExecutable()) return 'local_chrome';
    if (this.isCompanionOnline()) return 'companion_bridge';
    return 'unconfigured';
  }

  public getPublicAccounts(): SavedAccountPublic[] {
    return this.vault.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      domain: a.domain,
      loginUrl: a.loginUrl,
      username: a.username,
      hasPassword: Boolean(a.passwordEnc),
      passwordPreview: a.passwordEnc ? '••••••••' : '',
      totpHint: a.totpHint,
      notes: a.notes,
      autoUseInTasks: a.autoUseInTasks,
      updatedAt: a.updatedAt,
    }));
  }

  public getPublicIdentity(): SignupIdentityPublic {
    return {
      fullName: this.vault.identity.fullName,
      defaultEmail: this.vault.identity.defaultEmail,
      defaultPhone: this.vault.identity.defaultPhone,
      usernamePrefix: this.vault.identity.usernamePrefix,
      country: this.vault.identity.country || 'Bangladesh',
      dateOfBirth: this.vault.identity.dateOfBirth,
      hasDefaultPassword: Boolean(this.vault.identity.defaultSignupPasswordEnc),
    };
  }

  public async getStatusSnapshot() {
    await this.ensureHydrated();
    if (IS_SERVERLESS) {
      await this.pullCompanionStateFromCloud().catch(() => {});
    }
    const ws = this.getEffectiveWsEndpoint();
    const localExe = findLocalChromeExecutable();
    const backendMode = this.getActiveBackendMode();
    return {
      backendMode,
      remoteCdpConfigured: Boolean(ws),
      remoteCdpMasked: ws ? maskEndpointUrl(ws) : '',
      localChromePath: localExe || null,
      companionOnline: this.isCompanionOnline(),
      companionWorker: this.isCompanionOnline() ? this.companionWorker : null,
      headless: this.vault.headless,
      isServerless: IS_SERVERLESS,
      currentUrl: this.lastKnownUrl || this.companionWorker?.currentUrl || '',
      currentTitle: this.lastKnownTitle || this.companionWorker?.currentTitle || '',
      screenshotDataUrl: this.lastScreenshotBase64 ? `data:image/jpeg;base64,${this.lastScreenshotBase64}` : '',
      lastScreenshotAt: this.lastScreenshotAt,
      elementsCount: this.lastElements.length,
      tasks: this.tasks.slice(0, 12),
      activeTask: this.tasks.find((t) => t.status === 'running' || t.status === 'waiting_human_input') || null,
      accounts: this.getPublicAccounts(),
      identity: this.getPublicIdentity(),
    };
  }

  public async saveConfig(input: { customWsEndpoint?: string; clearWsEndpoint?: boolean; headless?: boolean }) {
    await this.ensureHydrated();
    if (input.clearWsEndpoint) {
      this.vault.customWsEndpointEnc = '';
    } else if (typeof input.customWsEndpoint === 'string' && input.customWsEndpoint.trim()) {
      const safe = assertSafeCdpWsUrl(input.customWsEndpoint.trim());
      this.vault.customWsEndpointEnc = encryptSecret(safe);
    }
    if (typeof input.headless === 'boolean') {
      this.vault.headless = input.headless;
    }
    await this.persistVault();
    return this.getStatusSnapshot();
  }

  public async upsertAccount(input: {
    id?: string;
    label: string;
    loginUrl: string;
    username: string;
    password?: string;
    totpHint?: string;
    notes?: string;
    autoUseInTasks?: boolean;
  }): Promise<SavedAccountPublic> {
    await this.ensureHydrated();
    const safeUrl = assertSafeBrowserUrl(input.loginUrl);
    const id = input.id?.trim() || `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const existing = this.vault.accounts.find((a) => a.id === id);
    const passwordEnc =
      typeof input.password === 'string' && input.password.length > 0
        ? encryptSecret(input.password)
        : existing?.passwordEnc || '';

    const next: SavedAccountStored = {
      id,
      label: String(input.label || safeUrl.hostname).trim().slice(0, 80),
      domain: safeUrl.hostname,
      loginUrl: safeUrl.toString(),
      username: String(input.username || '').trim().slice(0, 160),
      passwordEnc,
      totpHint: String(input.totpHint || '').trim().slice(0, 120),
      notes: String(input.notes || '').trim().slice(0, 300),
      autoUseInTasks: input.autoUseInTasks !== false,
      updatedAt: new Date().toISOString(),
    };

    const idx = this.vault.accounts.findIndex((a) => a.id === id);
    if (idx >= 0) this.vault.accounts[idx] = next;
    else this.vault.accounts.unshift(next);
    this.vault.accounts = this.vault.accounts.slice(0, 50);
    await this.persistVault();

    return {
      id: next.id,
      label: next.label,
      domain: next.domain,
      loginUrl: next.loginUrl,
      username: next.username,
      hasPassword: Boolean(next.passwordEnc),
      passwordPreview: next.passwordEnc ? '••••••••' : '',
      totpHint: next.totpHint,
      notes: next.notes,
      autoUseInTasks: next.autoUseInTasks,
      updatedAt: next.updatedAt,
    };
  }

  public async deleteAccount(id: string): Promise<void> {
    await this.ensureHydrated();
    this.vault.accounts = this.vault.accounts.filter((a) => a.id !== id);
    await this.persistVault();
  }

  public async saveIdentity(input: {
    fullName?: string;
    defaultEmail?: string;
    defaultPhone?: string;
    usernamePrefix?: string;
    country?: string;
    dateOfBirth?: string;
    defaultSignupPassword?: string;
  }): Promise<SignupIdentityPublic> {
    await this.ensureHydrated();
    this.vault.identity = {
      fullName: String(input.fullName ?? this.vault.identity.fullName).trim().slice(0, 100),
      defaultEmail: String(input.defaultEmail ?? this.vault.identity.defaultEmail).trim().slice(0, 160),
      defaultPhone: String(input.defaultPhone ?? this.vault.identity.defaultPhone).trim().slice(0, 40),
      usernamePrefix: String(input.usernamePrefix ?? this.vault.identity.usernamePrefix).trim().slice(0, 60),
      country: String(input.country ?? this.vault.identity.country ?? 'Bangladesh').trim().slice(0, 60),
      dateOfBirth: String(input.dateOfBirth ?? this.vault.identity.dateOfBirth).trim().slice(0, 40),
      defaultSignupPasswordEnc:
        typeof input.defaultSignupPassword === 'string' && input.defaultSignupPassword.length > 0
          ? encryptSecret(input.defaultSignupPassword)
          : this.vault.identity.defaultSignupPasswordEnc,
    };
    await this.persistVault();
    return this.getPublicIdentity();
  }

  /** Resolves safe {{VAULT:...}} or {{IDENTITY:...}} placeholders strictly inside server memory right before typing */
  private resolveCredentialTokens(rawText: string): { text: string; isSensitive: boolean } {
    let text = String(rawText || '');
    let isSensitive = false;

    text = text.replace(/\{\{VAULT:([^:}]+):(username|password)\}\}/gi, (_match, accId, field) => {
      const acc = this.vault.accounts.find((a) => a.id === accId);
      if (!acc) return '';
      if (String(field).toLowerCase() === 'password') {
        isSensitive = true;
        return decryptSecret(acc.passwordEnc);
      }
      return acc.username;
    });

    text = text.replace(/\{\{IDENTITY:(fullName|email|phone|username|dob|country|password)\}\}/gi, (_m, field) => {
      const f = String(field).toLowerCase();
      if (f === 'fullname') return this.vault.identity.fullName || this.adapters.getOwnerName() || 'User';
      if (f === 'email') return this.vault.identity.defaultEmail || '';
      if (f === 'phone') return this.vault.identity.defaultPhone || '';
      if (f === 'username') {
        const base = (this.vault.identity.usernamePrefix || 'wanexus_user').replace(/[^a-zA-Z0-9_]/g, '');
        return `${base}_${Math.floor(100 + Math.random() * 899)}`;
      }
      if (f === 'dob') return this.vault.identity.dateOfBirth || '1999-05-15';
      if (f === 'country') return this.vault.identity.country || 'Bangladesh';
      if (f === 'password') {
        isSensitive = true;
        return decryptSecret(this.vault.identity.defaultSignupPasswordEnc) || `WaN#${crypto.randomBytes(5).toString('hex')}!`;
      }
      return '';
    });

    return { text, isSensitive };
  }

  // ===================== PLAYWRIGHT / COMPANION SESSION HELPERS =====================

  private async ensurePlaywrightPage(): Promise<{
    mode: ChromeBackendMode;
    page: {
      goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
      goBack: (opts?: Record<string, unknown>) => Promise<unknown>;
      reload: (opts?: Record<string, unknown>) => Promise<unknown>;
      evaluate: <T>(fn: string) => Promise<T>;
      screenshot: (opts?: Record<string, unknown>) => Promise<Buffer>;
      locator: (sel: string) => {
        first: () => {
          click: (opts?: Record<string, unknown>) => Promise<void>;
          fill: (val: string, opts?: Record<string, unknown>) => Promise<void>;
          selectOption: (val: string) => Promise<unknown>;
        };
      };
      mouse: { click: (x: number, y: number) => Promise<void>; wheel: (dx: number, dy: number) => Promise<void> };
      keyboard: { press: (key: string) => Promise<void>; type: (txt: string, opts?: Record<string, unknown>) => Promise<void> };
      url: () => string;
      title: () => Promise<string>;
      waitForTimeout: (ms: number) => Promise<void>;
      isClosed: () => boolean;
    };
  }> {
    const existing = this.activePage as { isClosed?: () => boolean } | null;
    if (existing && typeof existing.isClosed === 'function' && !existing.isClosed()) {
      return {
        mode: this.getEffectiveWsEndpoint() ? 'remote_cdp' : 'local_chrome',
        page: existing as never,
      };
    }

    const wsEndpoint = this.getEffectiveWsEndpoint();
    const localExe = findLocalChromeExecutable();
    const pw = await import('playwright-core');

    if (wsEndpoint) {
      let browser: unknown;
      try {
        browser = await pw.chromium.connectOverCDP(wsEndpoint, { timeout: 15_000 });
      } catch {
        browser = await pw.chromium.connect(wsEndpoint, { timeout: 15_000 });
      }
      const b = browser as {
        contexts: () => Array<{
          pages: () => unknown[];
          newPage: () => Promise<unknown>;
        }>;
        newContext: (opts?: Record<string, unknown>) => Promise<{ newPage: () => Promise<unknown> }>;
      };
      const contexts = b.contexts();
      const ctx = contexts[0] || (await b.newContext({ viewport: { width: 1280, height: 720 } }));
      const pages = 'pages' in ctx ? ctx.pages() : [];
      const page = pages[0] || (await ctx.newPage());
      this.activeBrowser = browser;
      this.activeContext = ctx;
      this.activePage = page;
      return { mode: 'remote_cdp', page: page as never };
    }

    if (localExe) {
      fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
      const ctx = await pw.chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
        executablePath: localExe,
        headless: this.vault.headless,
        viewport: { width: 1280, height: 720 },
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      const pages = ctx.pages();
      const page = pages[0] || (await ctx.newPage());
      this.activeBrowser = null;
      this.activeContext = ctx;
      this.activePage = page;
      return { mode: 'local_chrome', page: page as never };
    }

    throw new Error(
      'Chrome ব্রাউজার কানেক্ট করা নেই। সমাধান: (১) Chrome Hands ট্যাবে আপনার পিসি/VPS-এ `chrome-companion.mjs` চালান, অথবা (২) Netlify/Settings-এ Browserless/Remote Chrome `CHROME_WS_ENDPOINT` দিন।'
    );
  }

  private async pullCompanionStateFromCloud(): Promise<{
    pendingCommand?: CompanionPendingCmd | null;
    lastResult?: {
      cmdId?: string;
      ok: boolean;
      error?: string;
      url?: string;
      title?: string;
      elements?: ChromeDomElement[];
      pageText?: string;
      screenshotBase64?: string;
    } | null;
  } | null> {
    if (!IS_SERVERLESS) return null;
    const rawDoc = await adminLoadDocument('bot_chrome_companion', 'primary').catch(() => null);
    const doc = rawDoc as Record<string, unknown> | null;
    if (!doc) return null;
    if (doc.worker && typeof doc.worker === 'object') {
      const w = doc.worker as CompanionWorkerState;
      if (!this.companionWorker || w.lastHeartbeatAt > this.companionWorker.lastHeartbeatAt) {
        this.companionWorker = w;
      }
    }
    if (typeof doc.lastScreenshotBase64 === 'string' && doc.lastScreenshotBase64) {
      this.lastScreenshotBase64 = doc.lastScreenshotBase64;
      this.lastScreenshotAt = String(doc.lastScreenshotAt || '');
    }
    if (typeof doc.lastKnownUrl === 'string' && doc.lastKnownUrl) this.lastKnownUrl = doc.lastKnownUrl;
    if (typeof doc.lastKnownTitle === 'string') this.lastKnownTitle = doc.lastKnownTitle;
    if (Array.isArray(doc.lastElements)) this.lastElements = doc.lastElements as ChromeDomElement[];
    return doc as never;
  }

  private async dispatchCompanionCommand(
    type: CompanionPendingCmd['type'],
    payload: Record<string, unknown>,
    timeoutMs = 24_000
  ): Promise<{
    ok: boolean;
    error?: string;
    url?: string;
    title?: string;
    elements?: ChromeDomElement[];
    pageText?: string;
    screenshotBase64?: string;
  }> {
    if (IS_SERVERLESS) {
      await this.pullCompanionStateFromCloud().catch(() => {});
    }
    if (!this.isCompanionOnline()) {
      throw new Error('Companion PC Chrome Bridge offline. পিসিতে chrome-companion.mjs চালু করুন।');
    }
    const id = `ccmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const cmd: CompanionPendingCmd = { id, type, payload, createdAt: Date.now() };
    this.companionQueue.push(cmd);

    if (IS_SERVERLESS) {
      await adminSaveDocument('bot_chrome_companion', 'primary', {
        worker: this.companionWorker,
        pendingCommand: cmd,
        lastScreenshotBase64: this.lastScreenshotBase64,
        lastScreenshotAt: this.lastScreenshotAt,
        lastKnownUrl: this.lastKnownUrl,
        lastKnownTitle: this.lastKnownTitle,
        lastElements: this.lastElements.slice(0, 50),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      let cloudPollTimer: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (cloudPollTimer) clearInterval(cloudPollTimer);
        this.companionWaiters.delete(id);
      };

      const finish = (res: {
        ok: boolean;
        error?: string;
        url?: string;
        title?: string;
        elements?: ChromeDomElement[];
        pageText?: string;
        screenshotBase64?: string;
      }) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (res.screenshotBase64) {
          this.lastScreenshotBase64 = res.screenshotBase64;
          this.lastScreenshotAt = new Date().toISOString();
        }
        if (res.url) this.lastKnownUrl = res.url;
        if (res.title !== undefined) this.lastKnownTitle = res.title;
        if (Array.isArray(res.elements)) this.lastElements = res.elements;
        if (res.pageText !== undefined) this.lastPageText = res.pageText;
        resolve(res);
      };

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(new Error(`Companion Chrome command timed out (${type})`));
      }, timeoutMs);

      this.companionWaiters.set(id, { resolve: finish });

      if (IS_SERVERLESS) {
        cloudPollTimer = setInterval(async () => {
          if (finished) return;
          const doc = await this.pullCompanionStateFromCloud().catch(() => null);
          if (doc?.lastResult && doc.lastResult.cmdId === id) {
            finish(doc.lastResult);
          }
        }, 850);
      }
    });
  }

  private async captureSnapshot(): Promise<{
    url: string;
    title: string;
    elements: ChromeDomElement[];
    pageText: string;
    screenshotBase64: string;
    mode: ChromeBackendMode;
  }> {
    const mode = this.getActiveBackendMode();
    if (mode === 'companion_bridge') {
      const res = await this.dispatchCompanionCommand('snapshot', {});
      return {
        url: res.url || this.lastKnownUrl,
        title: res.title || this.lastKnownTitle,
        elements: res.elements || this.lastElements,
        pageText: res.pageText || this.lastPageText,
        screenshotBase64: res.screenshotBase64 || this.lastScreenshotBase64,
        mode,
      };
    }

    const { page } = await this.ensurePlaywrightPage();
    const dom = await page
      .evaluate<{ url: string; title: string; elements: ChromeDomElement[]; pageText: string }>(
        INTERACTIVE_DOM_SCRIPT
      )
      .catch(() => ({ url: page.url(), title: '', elements: [], pageText: '' }));
    const buf = await page
      .screenshot({ type: 'jpeg', quality: 62 })
      .catch(() => Buffer.alloc(0));
    const b64 = buf.length > 0 ? buf.toString('base64') : this.lastScreenshotBase64;

    this.lastKnownUrl = dom.url || page.url();
    this.lastKnownTitle = dom.title || (await page.title().catch(() => ''));
    this.lastElements = Array.isArray(dom.elements) ? dom.elements : [];
    this.lastPageText = dom.pageText || '';
    if (b64) {
      this.lastScreenshotBase64 = b64;
      this.lastScreenshotAt = new Date().toISOString();
    }

    return {
      url: this.lastKnownUrl,
      title: this.lastKnownTitle,
      elements: this.lastElements,
      pageText: this.lastPageText,
      screenshotBase64: b64,
      mode,
    };
  }

  private async performRawAction(action: BrowserPlannedAction, mode: ChromeBackendMode): Promise<string> {
    if (mode === 'companion_bridge') {
      switch (action.action) {
        case 'goto': {
          const safe = assertSafeBrowserUrl(action.url || '');
          await this.dispatchCompanionCommand('goto', { url: safe.toString() });
          return `Navigated to ${safe.toString()}`;
        }
        case 'click': {
          if (typeof action.elementId === 'number') {
            await this.dispatchCompanionCommand('click_element', { elementId: action.elementId });
            return `Clicked element #${action.elementId}`;
          }
          await this.dispatchCompanionCommand('click_xy', { x: Number(action.x || 640), y: Number(action.y || 360) });
          return `Clicked (${action.x}, ${action.y})`;
        }
        case 'type': {
          const resolved = this.resolveCredentialTokens(action.text || '');
          await this.dispatchCompanionCommand('fill_element', {
            elementId: action.elementId,
            x: action.x,
            y: action.y,
            text: resolved.text,
            submitEnter: Boolean(action.submitEnter),
          });
          return resolved.isSensitive
            ? `Typed encrypted secret into element #${action.elementId ?? '?'}`
            : `Typed "${resolved.text.slice(0, 32)}" into element #${action.elementId ?? '?'}`;
        }
        case 'select': {
          await this.dispatchCompanionCommand('select_element', {
            elementId: action.elementId,
            value: action.value || '',
          });
          return `Selected "${action.value}" in #${action.elementId}`;
        }
        case 'press': {
          await this.dispatchCompanionCommand('press_key', { key: action.key || 'Enter' });
          return `Pressed ${action.key || 'Enter'}`;
        }
        case 'scroll': {
          await this.dispatchCompanionCommand('scroll', { direction: action.direction || 'down' });
          return `Scrolled ${action.direction || 'down'}`;
        }
        case 'wait': {
          await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(400, Number(action.waitMs || 1500)))));
          return 'Waited for page load';
        }
        default:
          return 'No-op';
      }
    }

    const { page } = await this.ensurePlaywrightPage();
    switch (action.action) {
      case 'goto': {
        const safe = assertSafeBrowserUrl(action.url || '');
        await page.goto(safe.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForTimeout(800);
        return `Navigated to ${safe.toString()}`;
      }
      case 'click': {
        if (typeof action.elementId === 'number') {
          try {
            await page.locator(`[data-wanexus-el-id="${action.elementId}"]`).first().click({ timeout: 6_000 });
            await page.waitForTimeout(700);
            return `Clicked element #${action.elementId}`;
          } catch {
            const el = this.lastElements.find((e) => e.id === action.elementId);
            if (el) {
              await page.mouse.click(el.rect.x, el.rect.y);
              await page.waitForTimeout(700);
              return `Clicked element #${action.elementId} at (${el.rect.x}, ${el.rect.y})`;
            }
            throw new Error(`Element #${action.elementId} not clickable`);
          }
        }
        const x = Number(action.x || 640);
        const y = Number(action.y || 360);
        await page.mouse.click(x, y);
        await page.waitForTimeout(700);
        return `Clicked (${x}, ${y})`;
      }
      case 'type': {
        const resolved = this.resolveCredentialTokens(action.text || '');
        if (typeof action.elementId === 'number') {
          const loc = page.locator(`[data-wanexus-el-id="${action.elementId}"]`).first();
          try {
            await loc.fill(resolved.text, { timeout: 6_000 });
          } catch {
            const el = this.lastElements.find((e) => e.id === action.elementId);
            if (el) await page.mouse.click(el.rect.x, el.rect.y);
            await page.keyboard.type(resolved.text, { delay: 18 });
          }
        } else {
          if (typeof action.x === 'number' && typeof action.y === 'number') {
            await page.mouse.click(action.x, action.y);
          }
          await page.keyboard.type(resolved.text, { delay: 18 });
        }
        if (action.submitEnter) {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(900);
        }
        return resolved.isSensitive
          ? `Typed encrypted secret into element #${action.elementId ?? '?'}`
          : `Typed "${resolved.text.slice(0, 32)}"`;
      }
      case 'select': {
        if (typeof action.elementId === 'number') {
          await page.locator(`[data-wanexus-el-id="${action.elementId}"]`).first().selectOption(action.value || '');
        }
        return `Selected "${action.value}"`;
      }
      case 'press': {
        await page.keyboard.press(action.key || 'Enter');
        await page.waitForTimeout(700);
        return `Pressed ${action.key || 'Enter'}`;
      }
      case 'scroll': {
        const dy = action.direction === 'up' ? -520 : 520;
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(500);
        return `Scrolled ${action.direction || 'down'}`;
      }
      case 'wait': {
        const ms = Math.min(5000, Math.max(400, Number(action.waitMs || 1500)));
        await page.waitForTimeout(ms);
        return `Waited ${ms}ms`;
      }
      default:
        return 'No-op';
    }
  }

  public async performManualAction(input: {
    type: 'goto' | 'click_xy' | 'type' | 'press' | 'scroll' | 'back' | 'reload' | 'screenshot';
    url?: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    submitEnter?: boolean;
    direction?: 'up' | 'down';
  }) {
    await this.ensureHydrated();
    const mode = this.getActiveBackendMode();
    if (mode === 'unconfigured') {
      throw new Error('কোনো Chrome ইঞ্জিন কানেক্ট করা নেই। Chrome WebSocket URL বা পিসির Companion Script চালু করুন।');
    }

    if (mode === 'companion_bridge') {
      if (input.type === 'goto' && input.url) {
        const safe = assertSafeBrowserUrl(input.url);
        await this.dispatchCompanionCommand('goto', { url: safe.toString() });
      } else if (input.type === 'click_xy') {
        await this.dispatchCompanionCommand('click_xy', { x: Number(input.x || 640), y: Number(input.y || 360) });
      } else if (input.type === 'type') {
        await this.dispatchCompanionCommand('fill_element', {
          text: String(input.text || ''),
          submitEnter: Boolean(input.submitEnter),
        });
      } else if (input.type === 'press') {
        await this.dispatchCompanionCommand('press_key', { key: String(input.key || 'Enter') });
      } else if (input.type === 'scroll') {
        await this.dispatchCompanionCommand('scroll', { direction: input.direction || 'down' });
      } else if (input.type === 'back') {
        await this.dispatchCompanionCommand('back', {});
      } else if (input.type === 'reload') {
        await this.dispatchCompanionCommand('reload', {});
      } else {
        await this.dispatchCompanionCommand('snapshot', {});
      }
      return this.getStatusSnapshot();
    }

    const { page } = await this.ensurePlaywrightPage();
    if (input.type === 'goto' && input.url) {
      const safe = assertSafeBrowserUrl(input.url);
      await page.goto(safe.toString(), { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(600);
    } else if (input.type === 'click_xy') {
      await page.mouse.click(Number(input.x || 640), Number(input.y || 360));
      await page.waitForTimeout(450);
    } else if (input.type === 'type') {
      await page.keyboard.type(String(input.text || ''), { delay: 15 });
      if (input.submitEnter) await page.keyboard.press('Enter');
      await page.waitForTimeout(450);
    } else if (input.type === 'press') {
      await page.keyboard.press(String(input.key || 'Enter'));
      await page.waitForTimeout(450);
    } else if (input.type === 'scroll') {
      await page.mouse.wheel(0, input.direction === 'up' ? -480 : 480);
      await page.waitForTimeout(400);
    } else if (input.type === 'back') {
      await page.goBack({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(500);
    } else if (input.type === 'reload') {
      await page.reload({ timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(600);
    }

    await this.captureSnapshot();
    return this.getStatusSnapshot();
  }

  private async planNextBrowserAction(params: {
    goal: string;
    snap: { url: string; title: string; elements: ChromeDomElement[]; pageText: string; screenshotBase64: string };
    steps: ChromeStepRecord[];
    humanNote?: string;
  }): Promise<BrowserPlannedAction> {
    const accountsHint = this.vault.accounts
      .filter((a) => a.autoUseInTasks)
      .map(
        (a) =>
          `- id="${a.id}" label="${a.label}" domain="${a.domain}" url="${a.loginUrl}" usernameToken="{{VAULT:${a.id}:username}}" passwordToken="{{VAULT:${a.id}:password}}"${a.totpHint ? ` hint="${a.totpHint}"` : ''}`
      )
      .join('\n');

    const identityHint = [
      `fullNameToken="{{IDENTITY:fullName}}" (actual name configured: ${Boolean(this.vault.identity.fullName)})`,
      `emailToken="{{IDENTITY:email}}" (actual email configured: ${Boolean(this.vault.identity.defaultEmail)})`,
      `phoneToken="{{IDENTITY:phone}}" (actual phone configured: ${Boolean(this.vault.identity.defaultPhone)})`,
      `usernameToken="{{IDENTITY:username}}"`,
      `dobToken="{{IDENTITY:dob}}"`,
      `countryToken="{{IDENTITY:country}}"`,
      `passwordToken="{{IDENTITY:password}}"`,
    ].join('\n');

    const compactElements = params.snap.elements
      .slice(0, 55)
      .map(
        (e) =>
          `[${e.id}] <${e.tag}${e.type ? ` type=${e.type}` : ''}${e.role ? ` role=${e.role}` : ''}> name="${e.name}" placeholder="${e.placeholder}" aria="${e.ariaLabel}" text="${e.text}" val="${e.valuePreview}" xy=(${e.rect.x},${e.rect.y})`
      )
      .join('\n');

    const historyText = params.steps
      .slice(-6)
      .map((s) => `Step ${s.stepNumber}: ${s.action} (${s.targetDescription}) -> ${s.outcome} | ${s.urlAfter}`)
      .join('\n');

    const promptText = [
      `Goal: ${params.goal}`,
      params.humanNote ? `Owner just provided OTP / confirmation / instruction: "${params.humanNote}"` : '',
      `Current URL: ${params.snap.url || 'about:blank'}`,
      `Page Title: ${params.snap.title}`,
      `Available Saved Login Tokens (NEVER invent passwords—use exact {{VAULT:...}} or {{IDENTITY:...}} tokens in "text" field):`,
      accountsHint || '(none)',
      `Owner Signup Identity Tokens:`,
      identityHint,
      `Previous Steps:\n${historyText || '(none yet)'}`,
      `Visible Interactive Elements:\n${compactElements || '(empty page — use goto to open a URL)'}`,
      `Visible Page Text:\n${params.snap.pageText.slice(0, 900)}`,
      '',
      'Choose the SINGLE best next Chrome action.',
      'Rules:',
      '1. If URL is empty/about:blank, use action="goto" with the target https URL.',
      '2. For account login or signup forms, fill using the matching elementId and {{VAULT:...}} or {{IDENTITY:...}} token.',
      '3. If a page asks for Phone/Email OTP, Google Authenticator 2FA, image CAPTCHA, or human card/payment confirmation that you cannot bypass safely, immediately return action="ask_human" with clear pauseKind ("otp"|"captcha"|"2fa"|"manual_confirm") and Bengali explanation in reasonBn.',
      '4. When the login/signup/task is clearly finished and verified on screen, return action="complete" with a clear Bengali summary in reasonBn.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const systemInstruction =
      'You are WaNexus Chrome Autonomous Hands & Feet Operator. Respond ONLY with strict JSON deciding the exact next browser action from the screenshot and interactive DOM map.';

    if (this.adapters.geminiPool.hasKeys()) {
      const models = [
        { model: 'gemini-4-hydrogen', channel: 'chrome_primary', lowThinking: true },
        { model: 'gemini-3.1-flash-lite', channel: 'chrome_lite', lowThinking: false },
      ];
      for (const spec of models) {
        try {
          const parts: Array<Record<string, unknown>> = [{ text: promptText }];
          if (params.snap.screenshotBase64) {
            parts.unshift({
              inlineData: {
                mimeType: 'image/jpeg',
                data: params.snap.screenshotBase64,
              },
            });
          }

          const exec = await this.adapters.geminiPool.executeWithRotation(
            (client) =>
              client.models.generateContent({
                model: spec.model,
                contents: [{ role: 'user', parts } as unknown as Content],
                config: {
                  systemInstruction,
                  ...(spec.lowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
                  responseMimeType: 'application/json',
                  responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: 'goto | click | type | select | press | scroll | wait | ask_human | complete | fail',
                      },
                      url: { type: Type.STRING },
                      elementId: { type: Type.INTEGER },
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      text: { type: Type.STRING },
                      value: { type: Type.STRING },
                      key: { type: Type.STRING },
                      submitEnter: { type: Type.BOOLEAN },
                      direction: { type: Type.STRING },
                      waitMs: { type: Type.INTEGER },
                      pauseKind: { type: Type.STRING },
                      reasonBn: { type: Type.STRING },
                    },
                    required: ['action', 'reasonBn'],
                  },
                },
              }),
            undefined,
            { maxTotalMs: 12_000, perAttemptMs: 8_500, channel: spec.channel }
          );

          const rawJson = (exec.value.text || '{}').trim();
          const um = exec.value.usageMetadata;
          if (um?.totalTokenCount) {
            this.adapters.tokenTelemetry.recordUsage({
              provider: 'gemini',
              model: spec.model,
              category: 'command',
              promptTokens: Number(um.promptTokenCount || 0),
              completionTokens: Number(um.candidatesTokenCount || 0),
              totalTokens: Number(um.totalTokenCount || 0),
              keySlot: exec.keySlot,
            });
          }
          const parsed = JSON.parse(rawJson) as BrowserPlannedAction;
          if (parsed?.action) return parsed;
        } catch {
          // try next model
        }
      }
    }

    if (this.adapters.openRouterReader.hasKeys()) {
      const or = await this.adapters.openRouterReader.generateAgentStepPlan({
        systemPrompt: systemInstruction,
        transcript: `${promptText}\n\nReturn strict JSON object with keys: action, url, elementId, text, key, submitEnter, direction, pauseKind, reasonBn.`,
      });
      const jsonMatch = or.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as BrowserPlannedAction;
          if (parsed?.action) return parsed;
        } catch {
          // ignore
        }
      }
    }

    return {
      action: 'fail',
      reasonBn: 'AI ব্রাউজার প্ল্যানার (Gemini/OpenRouter) এই মুহূর্তে সাড়া দিচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।',
    };
  }

  public async executeBrowserTask(params: {
    goal: string;
    startUrl?: string;
    source: 'dashboard' | 'telegram' | 'agent';
    maxSteps?: number;
    maxWallClockMs?: number;
    resumeTaskId?: string;
    humanReply?: string;
    preassignedTaskId?: string;
  }): Promise<ChromeTaskRecord> {
    await this.ensureHydrated();

    let task: ChromeTaskRecord;
    if (params.resumeTaskId) {
      const found = this.tasks.find((t) => t.id === params.resumeTaskId);
      if (!found) {
        throw new Error('Resumable Chrome task not found.');
      }
      task = found;
      task.status = 'running';
      task.pauseReasonBn = undefined;
      task.updatedAt = new Date().toISOString();
    } else {
      task = {
        id: params.preassignedTaskId || `ctask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        source: params.source,
        goal: String(params.goal || '').trim().slice(0, 1000),
        startUrl: params.startUrl ? assertSafeBrowserUrl(params.startUrl).toString() : undefined,
        status: 'running',
        currentUrl: this.lastKnownUrl || '',
        currentTitle: this.lastKnownTitle || '',
        backendUsed: this.getActiveBackendMode(),
        steps: [],
        finalSummary: '',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.tasks = [task, ...this.tasks.filter((t) => t.id !== task.id)].slice(0, 15);
    }

    await this.persistTasksOnly();

    const mode = this.getActiveBackendMode();
    task.backendUsed = mode;
    if (mode === 'unconfigured') {
      task.status = 'failed';
      task.finalSummary =
        '❌ Chrome ব্রাউজার এখনও কানেক্ট করা নেই।\n\nসমাধান (যেকোনো ১টি বেছে নিন):\n১) ড্যাশবোর্ডের **Chrome Hands & Feet** ট্যাব থেকে `chrome-companion.mjs` নামিয়ে পিসি/ল্যাপটপে `node chrome-companion.mjs` চালান (বিনা খরচে আসল Chrome!)\n২) অথবা Browserless / Remote Chrome `CHROME_WS_ENDPOINT` সেট করুন।';
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      await this.persistTasksOnly();
      return task;
    }

    const maxSteps = Math.max(2, Math.min(18, params.maxSteps ?? 12));
    const deadline = Date.now() + Math.max(5_000, params.maxWallClockMs ?? 110_000);
    let pendingHumanNote = params.humanReply;

    try {
      if (task.startUrl && !params.resumeTaskId) {
        const navSummary = await this.performRawAction(
          { action: 'goto', url: task.startUrl, reasonBn: 'শুরুতে টার্গেট ওয়েবসাইটে যাওয়া হচ্ছে' },
          mode
        );
        task.steps.push({
          stepNumber: task.steps.length + 1,
          action: 'goto',
          targetDescription: navSummary,
          reasonBn: 'টার্গেট ওয়েবসাইট ওপেন করা হয়েছে',
          outcome: 'ok',
          urlAfter: task.startUrl,
          timestamp: new Date().toISOString(),
        });
      }

      for (let i = 0; i < maxSteps; i += 1) {
        if (this.abortRequestedTaskIds.has(task.id)) {
          this.abortRequestedTaskIds.delete(task.id);
          task.status = 'stopped';
          task.finalSummary = '⏹️ ব্যবহারকারীর নির্দেশে Chrome কাজটি থামানো হয়েছে।';
          task.completedAt = new Date().toISOString();
          break;
        }
        if (Date.now() > deadline) {
          task.status = 'completed';
          task.finalSummary =
            '⏱️ নির্ধারিত সময়সীমার কারণে বর্তমান ধাপ পর্যন্ত Chrome কাজটি সংরক্ষণ করা হয়েছে। চাইলে আবার Resume/Continue চালাতে পারেন।';
          task.completedAt = new Date().toISOString();
          break;
        }

        const snap = await this.captureSnapshot();
        task.currentUrl = snap.url;
        task.currentTitle = snap.title;

        const plan = await this.planNextBrowserAction({
          goal: task.goal,
          snap,
          steps: task.steps,
          humanNote: pendingHumanNote,
        });
        pendingHumanNote = undefined;

        if (plan.action === 'ask_human') {
          task.status = 'waiting_human_input';
          task.pauseKind = plan.pauseKind || 'otp';
          task.pauseReasonBn = plan.reasonBn;
          task.finalSummary = `⏸️ আপনার হস্তক্ষেপ প্রয়োজন (${task.pauseKind.toUpperCase()}): ${plan.reasonBn}`;
          task.steps.push({
            stepNumber: task.steps.length + 1,
            action: 'ask_human',
            targetDescription: task.pauseKind,
            reasonBn: plan.reasonBn,
            outcome: 'paused',
            urlAfter: snap.url,
            timestamp: new Date().toISOString(),
          });
          task.updatedAt = new Date().toISOString();
          await this.persistTasksOnly();

          if (this.adapters.notifyTelegramScreenshot) {
            await this.adapters
              .notifyTelegramScreenshot(
                `🖐️ *Chrome Hands & Feet আপনার সাহায্যের জন্য অপেক্ষা করছে (${task.pauseKind.toUpperCase()})*\n\n${plan.reasonBn}\n\n🔗 ${snap.url}\n\nOTP/কোড থাকলে এখানেই লিখে পাঠান অথবা ড্যাশবোর্ডের Live Chrome Screen-এ সমাধান করে Resume দিন।`,
                snap.screenshotBase64
              )
              .catch(() => {});
          }
          return task;
        }

        if (plan.action === 'complete') {
          task.status = 'completed';
          task.finalSummary = `✅ সম্পন্ন হয়েছে:\n${plan.reasonBn}`;
          task.steps.push({
            stepNumber: task.steps.length + 1,
            action: 'complete',
            targetDescription: snap.url,
            reasonBn: plan.reasonBn,
            outcome: 'ok',
            urlAfter: snap.url,
            timestamp: new Date().toISOString(),
          });
          task.completedAt = new Date().toISOString();
          break;
        }

        if (plan.action === 'fail') {
          task.status = 'failed';
          task.finalSummary = `❌ ব্যর্থ হয়েছে: ${plan.reasonBn}`;
          task.steps.push({
            stepNumber: task.steps.length + 1,
            action: 'fail',
            targetDescription: snap.url,
            reasonBn: plan.reasonBn,
            outcome: 'error',
            urlAfter: snap.url,
            timestamp: new Date().toISOString(),
          });
          task.completedAt = new Date().toISOString();
          break;
        }

        try {
          const outcomeMsg = await this.performRawAction(plan, mode);
          const afterSnap = await this.captureSnapshot().catch(() => snap);
          task.currentUrl = afterSnap.url;
          task.currentTitle = afterSnap.title;
          task.steps.push({
            stepNumber: task.steps.length + 1,
            action: plan.action,
            targetDescription: outcomeMsg,
            reasonBn: plan.reasonBn,
            outcome: 'ok',
            urlAfter: afterSnap.url,
            timestamp: new Date().toISOString(),
          });
          task.updatedAt = new Date().toISOString();
          await this.persistTasksOnly();
        } catch (stepErr) {
          task.steps.push({
            stepNumber: task.steps.length + 1,
            action: plan.action,
            targetDescription: `Error: ${(stepErr as Error).message.slice(0, 120)}`,
            reasonBn: plan.reasonBn,
            outcome: 'error',
            urlAfter: task.currentUrl,
            timestamp: new Date().toISOString(),
          });
          task.updatedAt = new Date().toISOString();
        }
      }

      if (task.status === 'running') {
        task.status = 'completed';
        task.finalSummary = `✅ ${task.steps.length}টি ধাপ সম্পন্ন হয়েছে (${task.currentUrl})।`;
        task.completedAt = new Date().toISOString();
      }
      task.updatedAt = new Date().toISOString();
      await this.persistTasksOnly();

      this.adapters.pushLog?.(
        'simulator',
        'ChromeHands',
        `Chrome task (${task.status}): ${task.goal.slice(0, 60)}`,
        task.status === 'failed' ? 'error' : 'success'
      );
      return task;
    } catch (err) {
      task.status = 'failed';
      task.finalSummary = `❌ Chrome ত্রুটি: ${(err as Error).message}`;
      task.completedAt = new Date().toISOString();
      task.updatedAt = task.completedAt;
      await this.persistTasksOnly();
      return task;
    }
  }

  public stopTask(taskId?: string): boolean {
    const target = taskId
      ? this.tasks.find((t) => t.id === taskId)
      : this.tasks.find((t) => t.status === 'running' || t.status === 'waiting_human_input');
    if (!target) return false;
    this.abortRequestedTaskIds.add(target.id);
    if (target.status === 'waiting_human_input') {
      target.status = 'stopped';
      target.finalSummary = '⏹️ ম্যানুয়ালি বন্ধ করা হয়েছে।';
      target.completedAt = new Date().toISOString();
      void this.persistTasksOnly();
    }
    return true;
  }

  public getWaitingTask(): ChromeTaskRecord | null {
    return this.tasks.find((t) => t.status === 'waiting_human_input') || null;
  }

  // ===================== COMPANION BRIDGE ENDPOINTS LOGIC =====================

  public verifyCompanionToken(token: string): boolean {
    const clean = String(token || '').trim();
    const expected = this.vault.companionBridgeToken || '';
    if (!clean || !expected) return false;
    const a = Buffer.from(clean, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  public async pollCompanionQueue(input: {
    workerId: string;
    deviceLabel: string;
    currentUrl?: string;
    currentTitle?: string;
  }) {
    this.companionWorker = {
      workerId: String(input.workerId || 'pc-chrome').slice(0, 64),
      deviceLabel: String(input.deviceLabel || 'Owner Chrome Bridge').slice(0, 80),
      lastHeartbeatAt: Date.now(),
      currentUrl: String(input.currentUrl || this.lastKnownUrl || ''),
      currentTitle: String(input.currentTitle || this.lastKnownTitle || ''),
    };
    let nextCmd = this.companionQueue.shift() || null;

    if (IS_SERVERLESS) {
      const doc = await this.pullCompanionStateFromCloud().catch(() => null);
      if (!nextCmd && doc?.pendingCommand) {
        nextCmd = doc.pendingCommand;
      }
      await adminSaveDocument('bot_chrome_companion', 'primary', {
        worker: this.companionWorker,
        pendingCommand: null,
        lastScreenshotBase64: this.lastScreenshotBase64,
        lastScreenshotAt: this.lastScreenshotAt,
        lastKnownUrl: this.lastKnownUrl,
        lastKnownTitle: this.lastKnownTitle,
        lastElements: this.lastElements.slice(0, 50),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    return { ok: true, command: nextCmd };
  }

  public async reportCompanionResult(input: {
    cmdId?: string;
    ok: boolean;
    error?: string;
    url?: string;
    title?: string;
    elements?: ChromeDomElement[];
    pageText?: string;
    screenshotBase64?: string;
  }) {
    if (this.companionWorker) {
      this.companionWorker.lastHeartbeatAt = Date.now();
      if (input.url) this.companionWorker.currentUrl = input.url;
      if (input.title !== undefined) this.companionWorker.currentTitle = input.title;
    }
    if (input.screenshotBase64) {
      this.lastScreenshotBase64 = input.screenshotBase64;
      this.lastScreenshotAt = new Date().toISOString();
    }
    if (input.url) this.lastKnownUrl = input.url;
    if (input.title !== undefined) this.lastKnownTitle = input.title;
    if (Array.isArray(input.elements)) this.lastElements = input.elements;
    if (input.pageText !== undefined) this.lastPageText = input.pageText;

    if (input.cmdId && this.companionWaiters.has(input.cmdId)) {
      const waiter = this.companionWaiters.get(input.cmdId)!;
      this.companionWaiters.delete(input.cmdId);
      waiter.resolve(input);
    }

    if (IS_SERVERLESS) {
      await adminSaveDocument('bot_chrome_companion', 'primary', {
        worker: this.companionWorker,
        pendingCommand: null,
        lastResult: input,
        lastScreenshotBase64: this.lastScreenshotBase64,
        lastScreenshotAt: this.lastScreenshotAt,
        lastKnownUrl: this.lastKnownUrl,
        lastKnownTitle: this.lastKnownTitle,
        lastElements: this.lastElements.slice(0, 50),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }
    return { ok: true };
  }

  public buildCompanionScript(originUrl: string): string {
    const token = this.vault.companionBridgeToken || '';
    const safeOrigin = originUrl.replace(/\/+$/, '');
    return `// WaNexus Local Chrome Companion Bridge ("হাত-পা")
// Run on your PC / Laptop / VPS where Google Chrome is installed:
//   npm install playwright-core
//   node chrome-companion.mjs
// It launches YOUR real Chrome (keeps your cookies/logins saved!) and connects securely to ${safeOrigin}.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const SERVER_URL = ${JSON.stringify(safeOrigin)};
const BRIDGE_TOKEN = ${JSON.stringify(token)};
const PROFILE_DIR = path.join(os.homedir(), '.wanexus-chrome-profile');
const WORKER_ID = os.hostname() + '-' + process.pid;

const CHROME_PATHS = [
  process.env.CHROME_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
  'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
].filter(Boolean);

const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
console.log('[WaNexus Chrome Companion] Launching Chrome...', executablePath || '(Playwright channel chrome)');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: process.env.HEADLESS === 'true',
  viewport: { width: 1280, height: 720 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const page = context.pages()[0] || (await context.newPage());

const DOM_SCRIPT = ${JSON.stringify(INTERACTIVE_DOM_SCRIPT)};

async function snap() {
  const dom = await page.evaluate(DOM_SCRIPT).catch(() => ({ url: page.url(), title: '', elements: [], pageText: '' }));
  const buf = await page.screenshot({ type: 'jpeg', quality: 62 }).catch(() => Buffer.alloc(0));
  return {
    url: dom.url || page.url(),
    title: dom.title || (await page.title().catch(() => '')),
    elements: dom.elements || [],
    pageText: dom.pageText || '',
    screenshotBase64: buf.toString('base64'),
  };
}

async function execCmd(cmd) {
  const p = cmd.payload || {};
  if (cmd.type === 'goto' && p.url) {
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(700);
  } else if (cmd.type === 'click_element') {
    await page.locator('[data-wanexus-el-id="' + p.elementId + '"]').first().click({ timeout: 6000 });
    await page.waitForTimeout(700);
  } else if (cmd.type === 'click_xy') {
    await page.mouse.click(Number(p.x || 640), Number(p.y || 360));
    await page.waitForTimeout(600);
  } else if (cmd.type === 'fill_element') {
    if (typeof p.elementId === 'number') {
      await page.locator('[data-wanexus-el-id="' + p.elementId + '"]').first().fill(String(p.text || ''));
    } else {
      await page.keyboard.type(String(p.text || ''), { delay: 18 });
    }
    if (p.submitEnter) await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
  } else if (cmd.type === 'select_element') {
    await page.locator('[data-wanexus-el-id="' + p.elementId + '"]').first().selectOption(String(p.value || ''));
  } else if (cmd.type === 'press_key') {
    await page.keyboard.press(String(p.key || 'Enter'));
    await page.waitForTimeout(600);
  } else if (cmd.type === 'scroll') {
    await page.mouse.wheel(0, p.direction === 'up' ? -520 : 520);
    await page.waitForTimeout(450);
  } else if (cmd.type === 'back') {
    await page.goBack({ timeout: 10000 }).catch(() => {});
  } else if (cmd.type === 'reload') {
    await page.reload({ timeout: 15000 }).catch(() => {});
  }
  return snap();
}

// Initial screenshot push
await fetch(SERVER_URL + '/api/chrome/companion/report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-chrome-bridge-token': BRIDGE_TOKEN },
  body: JSON.stringify({ ok: true, ...(await snap()) }),
}).catch(() => {});

console.log('[WaNexus Chrome Companion] Connected! Listening for AI & Owner commands...');
while (true) {
  try {
    const res = await fetch(SERVER_URL + '/api/chrome/companion/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-chrome-bridge-token': BRIDGE_TOKEN },
      body: JSON.stringify({
        workerId: WORKER_ID,
        deviceLabel: os.hostname() + ' Chrome',
        currentUrl: page.url(),
      }),
    });
    const data = await res.json();
    if (data?.command) {
      console.log(' -> Executing:', data.command.type);
      try {
        const result = await execCmd(data.command);
        await fetch(SERVER_URL + '/api/chrome/companion/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-chrome-bridge-token': BRIDGE_TOKEN },
          body: JSON.stringify({ cmdId: data.command.id, ok: true, ...result }),
        });
      } catch (err) {
        await fetch(SERVER_URL + '/api/chrome/companion/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-chrome-bridge-token': BRIDGE_TOKEN },
          body: JSON.stringify({ cmdId: data.command.id, ok: false, error: err.message }),
        });
      }
    }
  } catch (e) {
    // brief retry pause on transient network blip
  }
  await new Promise((r) => setTimeout(r, 900));
}
`;
  }
}

export function registerChromeRoutes(
  app: Express,
  chromeAgent: ChromeBrowserAgent,
  requireOwnerAuth: (req: Request, res: Response, next: () => void) => void,
  options?: {
    dispatchBackgroundChromeRun?: (
      req: Request,
      payload: { goal: string; startUrl?: string; preassignedTaskId: string; resumeTaskId?: string; humanReply?: string }
    ) => Promise<boolean>;
  }
) {
  app.get('/api/chrome/status', requireOwnerAuth, async (_req, res) => {
    const snapshot = await chromeAgent.getStatusSnapshot();
    res.json(snapshot);
  });

  app.post('/api/chrome/run', requireOwnerAuth, async (req, res) => {
    try {
      const goal = String(req.body?.goal || '').trim();
      const startUrl = typeof req.body?.startUrl === 'string' && req.body.startUrl.trim() ? req.body.startUrl.trim() : undefined;
      if (!goal) {
        res.status(400).json({ error: 'Chrome task goal is required.' });
        return;
      }

      if (options?.dispatchBackgroundChromeRun && chromeAgent.getActiveBackendMode() !== 'unconfigured') {
        const preassignedTaskId = `ctask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const queued = await options.dispatchBackgroundChromeRun(req, { goal, startUrl, preassignedTaskId });
        if (queued) {
          res.json({ ok: true, queuedBackground: true, taskId: preassignedTaskId });
          return;
        }
      }

      const task = await chromeAgent.executeBrowserTask({
        goal,
        startUrl,
        source: 'dashboard',
      });
      res.json({ ok: task.status !== 'failed', task, status: await chromeAgent.getStatusSnapshot() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chrome/resume', requireOwnerAuth, async (req, res) => {
    try {
      const taskId = String(req.body?.taskId || '').trim();
      const humanReply = String(req.body?.humanReply || '').trim() || undefined;
      if (!taskId) {
        res.status(400).json({ error: 'taskId is required.' });
        return;
      }

      if (options?.dispatchBackgroundChromeRun) {
        const queued = await options.dispatchBackgroundChromeRun(req, {
          goal: 'resume',
          preassignedTaskId: taskId,
          resumeTaskId: taskId,
          humanReply,
        });
        if (queued) {
          res.json({ ok: true, queuedBackground: true, taskId });
          return;
        }
      }

      const task = await chromeAgent.executeBrowserTask({
        goal: 'resume',
        source: 'dashboard',
        resumeTaskId: taskId,
        humanReply,
      });
      res.json({ ok: true, task, status: await chromeAgent.getStatusSnapshot() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chrome/stop', requireOwnerAuth, (req, res) => {
    const stopped = chromeAgent.stopTask(typeof req.body?.taskId === 'string' ? req.body.taskId : undefined);
    res.json({ ok: stopped });
  });

  app.post('/api/chrome/manual', requireOwnerAuth, async (req, res) => {
    try {
      const status = await chromeAgent.performManualAction(req.body || {});
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chrome/config', requireOwnerAuth, async (req, res) => {
    try {
      const status = await chromeAgent.saveConfig(req.body || {});
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/chrome/vault/account', requireOwnerAuth, async (req, res) => {
    try {
      const account = await chromeAgent.upsertAccount(req.body || {});
      res.json({ ok: true, account, accounts: chromeAgent.getPublicAccounts() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/chrome/vault/account/:id', requireOwnerAuth, async (req, res) => {
    await chromeAgent.deleteAccount(req.params.id);
    res.json({ ok: true, accounts: chromeAgent.getPublicAccounts() });
  });

  app.post('/api/chrome/vault/identity', requireOwnerAuth, async (req, res) => {
    try {
      const identity = await chromeAgent.saveIdentity(req.body || {});
      res.json({ ok: true, identity });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/chrome/companion-script', requireOwnerAuth, async (req, res) => {
    await chromeAgent.ensureHydrated();
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const origin = host ? `${proto}://${host}` : process.env.URL || 'https://auraai-project.netlify.app';
    res.json({ ok: true, script: chromeAgent.buildCompanionScript(origin) });
  });

  // Companion Bridge Worker Endpoints (authenticated strictly via HMAC-length-checked bridge token)
  app.post('/api/chrome/companion/poll', async (req, res) => {
    await chromeAgent.ensureHydrated();
    const tok = String(req.headers['x-chrome-bridge-token'] || '');
    if (!chromeAgent.verifyCompanionToken(tok)) {
      res.status(401).json({ ok: false, error: 'Unauthorized companion bridge token.' });
      return;
    }
    res.json(await chromeAgent.pollCompanionQueue(req.body || {}));
  });

  app.post('/api/chrome/companion/report', async (req, res) => {
    await chromeAgent.ensureHydrated();
    const tok = String(req.headers['x-chrome-bridge-token'] || '');
    if (!chromeAgent.verifyCompanionToken(tok)) {
      res.status(401).json({ ok: false, error: 'Unauthorized companion bridge token.' });
      return;
    }
    res.json(await chromeAgent.reportCompanionResult(req.body || {}));
  });
}
