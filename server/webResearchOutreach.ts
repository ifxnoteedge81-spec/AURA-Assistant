import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { ThinkingLevel } from '@google/genai';
import nodemailer from 'nodemailer';
import type { WASocket } from '@whiskeysockets/baileys';
import type { GeminiKeyPool } from './geminiKeyPool.ts';
import type { OpenRouterReader } from './openRouterReader.ts';
import type { TokenTelemetryTracker } from './tokenTelemetry.ts';
import { adminLoadDocument, adminSaveDocument } from './firestoreAdmin.ts';

export type OutreachEmailProvider = 'gmail_oauth' | 'smtp_profile' | 'resend_http' | 'brevo_http' | 'custom_http';

export interface PublicEmailSenderProfile {
  id: string;
  email: string;
  label: string;
  type: 'smtp_gmail' | 'smtp_custom';
  host: string;
  port: number;
  active: boolean;
  hasSecret: boolean;
  maskedSecret: string;
  createdAt: string;
}

interface StoredEmailSenderProfile extends PublicEmailSenderProfile {
  secret: string;
  secure: boolean;
}

export interface WebOutreachController {
  getSummary: () => {
    policy: OutreachSafetyPolicy;
    stats: PersistedOutreachStore['dailyStats'];
    totalLeads: number;
    verifiedLeadsCount: number;
    senders: PublicEmailSenderProfile[];
    leads: OutreachLeadItem[];
    recentResearch: WebResearchHistoryItem[];
    capabilities: ReturnType<() => Record<string, boolean>>;
  };
  runResearch: (params: {
    query: string;
    useAiSummary?: boolean;
    maxSites?: number;
  }) => Promise<{ research: WebResearchHistoryItem; leads: OutreachLeadItem[]; fromCache: boolean }>;
  scrapeUrls: (params: {
    urlsText: string;
    topic?: string;
  }) => Promise<{ research: WebResearchHistoryItem; leads: OutreachLeadItem[]; errors: string[] }>;
  verifyWhatsappLeads: (leadIds?: string[]) => Promise<{ checkedCount: number; activeFound: number }>;
  draftMessage: (params: {
    channel: 'email' | 'whatsapp';
    topic?: string;
    leadName?: string;
    useAi?: boolean;
  }) => Promise<{ subject: string; body: string; tokensSpent: number; providerUsed: string }>;
  addAndActivateEmailSender: (params: {
    email: string;
    secret: string;
    deletePrevious?: boolean;
    host?: string;
    port?: number;
  }) => {
    profile: PublicEmailSenderProfile;
    deletedCount: number;
    isLikelyAppPassword: boolean;
    warning?: string;
  };
  switchEmailSender: (emailOrId: string) => PublicEmailSenderProfile | null;
  deleteEmailSender: (emailOrIdOrAll: string) => { removedCount: number; remaining: PublicEmailSenderProfile[] };
  listEmailSenders: () => PublicEmailSenderProfile[];
  sendEmailOutreach: (params: {
    subject: string;
    body: string;
    directEmails?: string[];
    useCollectedLeads?: boolean;
    maxCount?: number;
    provider?: OutreachEmailProvider;
  }) => Promise<{ sentCount: number; failedCount: number; providerUsed: string; results: Array<{ email: string; status: string; error?: string }>; error?: string }>;
  sendWhatsappOutreach: (params: {
    body: string;
    excludePhones?: string[];
    directPhones?: string[];
    useCollectedLeads?: boolean;
    maxCount?: number;
  }) => Promise<{ queued: boolean; sentCount: number; totalTargets: number; skippedMuted: number; error?: string }>;
  updatePolicy: (patch: Partial<OutreachSafetyPolicy>) => OutreachSafetyPolicy;
  ingestExternalLead: (params: {
    name?: string;
    sourceUrl: string;
    topic?: string;
    emails?: string[];
    phones?: string[];
    snippet?: string;
  }) => OutreachLeadItem;
  clearLeads: () => number;
}

export interface OutreachSafetyPolicy {
  dailyEmailLimit: number;
  dailyWhatsappLimit: number;
  whatsappMinDelayMs: number;
  whatsappMaxDelayMs: number;
  emailDelayMs: number;
  preferredEmailProvider: OutreachEmailProvider;
  zeroTokenDraftDefault: boolean;
  defaultLanguage: 'bn' | 'en';
  defaultOfferPitch: string;
  crawlContactSubpages: boolean;
  maxSitesPerSearch: number;
}

export interface OutreachLeadItem {
  id: string;
  name: string;
  sourceUrl: string;
  domain: string;
  topic: string;
  emails: string[];
  phones: string[];
  whatsappVerifiedPhones: string[];
  whatsappCheckedAt: string | null;
  snippet: string;
  emailSentCount: number;
  lastEmailSentAt: string | null;
  whatsappSentCount: number;
  lastWhatsappSentAt: string | null;
  createdAt: string;
}

export interface WebResearchHistoryItem {
  id: string;
  query: string;
  providerUsed: 'tavily' | 'serper' | 'duckduckgo' | 'gemini_search' | 'direct_url';
  tokensSpent: number;
  summary: string;
  urls: { title: string; url: string; snippet: string }[];
  emailsFound: number;
  phonesFound: number;
  createdAt: string;
}

export interface OutreachDispatchLogItem {
  id: string;
  timestamp: string;
  channel: 'email' | 'whatsapp';
  provider: string;
  recipient: string;
  leadName: string;
  subject?: string;
  messagePreview: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
  tokensSpent: number;
}

interface PersistedOutreachStore {
  policy: OutreachSafetyPolicy;
  dailyStats: {
    date: string;
    emailsSentToday: number;
    whatsappSentToday: number;
  };
  leads: OutreachLeadItem[];
  researchHistory: WebResearchHistoryItem[];
  dispatchLogs: OutreachDispatchLogItem[];
}

export interface WebOutreachHostAdapters {
  geminiPool: GeminiKeyPool;
  openRouterReader: OpenRouterReader;
  tokenTelemetry: TokenTelemetryTracker;
  getBotConfig: () => {
    ownerName: string;
    ownerProfession: string;
    ownerLocation: string;
    ownerBio: string;
  };
  getSocket: () => WASocket | null;
  getBotStatus: () => string;
  sendTrackedMessage: (
    sock: WASocket,
    jid: string,
    content: { text: string; mentions?: string[] }
  ) => Promise<unknown>;
  pushLog: (
    category: 'system' | 'pairing' | 'gemini' | 'antilink' | 'autoreply' | 'simulator' | 'cloud',
    actor: string,
    summary: string,
    outcome?: 'success' | 'blocked' | 'info' | 'error'
  ) => void;
  onLeadWhatsAppSent?: (params: {
    phoneDigits: string;
    jid: string;
    leadName: string;
    messageText: string;
    sourceUrl: string;
  }) => void;
}

const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);
const RUNTIME_DIR = IS_SERVERLESS ? '/tmp' : '.';
const OUTREACH_FILE = path.resolve(RUNTIME_DIR, 'bot-outreach.json');
const OUTREACH_SENDERS_FILE = path.resolve(RUNTIME_DIR, 'bot-outreach-senders.json');
const MAX_LEADS = 300;
const MAX_RESEARCH_HISTORY = 40;
const MAX_DISPATCH_LOGS = 150;
const MAX_CACHE_ITEMS = 30;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function maskSecret(secret: string): string {
  const s = secret.trim();
  if (!s) return '****';
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, Math.min(12, s.length - 2)))}${s.slice(-2)}`;
}

function resolveSmtpDefaultsForEmail(email: string, explicitHost?: string, explicitPort?: number): {
  host: string;
  port: number;
  secure: boolean;
  type: 'smtp_gmail' | 'smtp_custom';
} {
  if (explicitHost?.trim()) {
    const port = explicitPort && explicitPort > 0 ? explicitPort : 465;
    return {
      host: explicitHost.trim(),
      port,
      secure: port === 465,
      type: explicitHost.includes('gmail') ? 'smtp_gmail' : 'smtp_custom',
    };
  }
  const domain = email.split('@')[1]?.toLowerCase() || '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'smtp.gmail.com', port: 465, secure: true, type: 'smtp_gmail' };
  }
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
    return { host: 'smtp-mail.outlook.com', port: 587, secure: false, type: 'smtp_custom' };
  }
  if (domain === 'yahoo.com') {
    return { host: 'smtp.mail.yahoo.com', port: 465, secure: true, type: 'smtp_custom' };
  }
  return { host: domain ? `smtp.${domain}` : 'smtp.gmail.com', port: 465, secure: true, type: 'smtp_custom' };
}

async function sendEmailViaSmtpProfile(params: {
  profile: StoredEmailSenderProfile;
  to: string;
  subject: string;
  bodyText: string;
  ownerName: string;
}): Promise<{ messageId: string }> {
  const cleanPass =
    params.profile.type === 'smtp_gmail'
      ? params.profile.secret.replace(/\s+/g, '')
      : params.profile.secret;
  const transporter = nodemailer.createTransport({
    host: params.profile.host,
    port: params.profile.port,
    secure: params.profile.secure,
    auth: {
      user: params.profile.email,
      pass: cleanPass,
    },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 16_000,
  });

  try {
    const info = await transporter.sendMail({
      from: params.ownerName
        ? `"${params.ownerName.replace(/["\r\n]/g, '')}" <${params.profile.email}>`
        : params.profile.email,
      to: params.to,
      subject: params.subject,
      text: params.bodyText,
    });
    return { messageId: info.messageId || 'smtp_sent' };
  } catch (err) {
    const rawMsg = (err as Error).message || String(err);
    if (/Username and Password not accepted|535|Invalid login|BadCredentials/i.test(rawMsg)) {
      throw new Error(
        'Gmail/SMTP লগইন রিজেক্ট হয়েছে: সাধারণ পাসওয়ার্ড Google ব্লক করে — দয়া করে Gmail 2-Step Verification চালু করে ১৬ সংখ্যার Google App Password ব্যবহার করুন।'
      );
    }
    throw err;
  }
}

const DEFAULT_OUTREACH_POLICY: OutreachSafetyPolicy = {
  dailyEmailLimit: 30,
  dailyWhatsappLimit: 20,
  whatsappMinDelayMs: 45_000,
  whatsappMaxDelayMs: 90_000,
  emailDelayMs: 1_800,
  preferredEmailProvider: 'gmail_oauth',
  zeroTokenDraftDefault: true,
  defaultLanguage: 'bn',
  defaultOfferPitch:
    'আমরা আপনার প্রতিষ্ঠানের জন্য আধুনিক অটোমেশন, কাস্টমার সাপোর্ট ও ডিজিটাল গ্রোথ সলিউশন নিয়ে কাজ করছি।',
  crawlContactSubpages: true,
  maxSitesPerSearch: 5,
};

function todayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function collectEnvKeyPool(prefix: string, singleVar: string, bulkVar: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (raw?: string) => {
    const val = (raw || '').trim();
    if (!val || val.length < 8 || val.startsWith('YOUR_') || val.startsWith('MY_')) return;
    if (!seen.has(val)) {
      seen.add(val);
      keys.push(val);
    }
  };
  for (let i = 1; i <= 5; i += 1) {
    push(process.env[`${prefix}_${i}`]);
  }
  push(process.env[singleVar]);
  const bulk = process.env[bulkVar];
  if (bulk) {
    for (const part of bulk.split(/[\s,;]+/)) {
      push(part);
    }
  }
  return keys;
}

function normalizePhoneDigits(raw: string): string {
  let digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('01') && digits.length === 11) {
    digits = `880${digits.slice(1)}`;
  } else if (digits.startsWith('88001') && digits.length === 14) {
    digits = `880${digits.slice(4)}`;
  }
  if (digits.length < 9 || digits.length > 15) return '';
  // Reject obvious date/year sequences like 20240101 or 000000000
  if (/^(\d)\1{6,}$/.test(digits)) return '';
  if (/^(19|20)\d{6}$/.test(digits)) return '';
  return digits;
}

function formatPhoneDisplay(digits: string): string {
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function assertSafePublicHttpUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS URLs are supported.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    host.startsWith('[::1]') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) {
    throw new Error(`Blocked non-public hostname: ${host}`);
  }
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      throw new Error(`Blocked private/reserved IP target: ${host}`);
    }
  }
  return parsed;
}

async function fetchSafeHtml(urlStr: string, timeoutMs = 8_000, maxBytes = 380_000): Promise<string> {
  const safeUrl = assertSafePublicHttpUrl(urlStr);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; WaNexusResearchBot/1.0; +https://github.com)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    // Check final URL after redirect against SSRF
    if (resp.url) {
      assertSafePublicHttpUrl(resp.url);
    }
    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    if (
      contentType &&
      !contentType.includes('text/') &&
      !contentType.includes('html') &&
      !contentType.includes('xml') &&
      !contentType.includes('json')
    ) {
      throw new Error(`Skipped non-text content-type: ${contentType}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) {
      return (await resp.text()).slice(0, maxBytes);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice = value.byteLength + total > maxBytes ? value.subarray(0, maxBytes - total) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= maxBytes) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaJinaReader(urlStr: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const safe = assertSafePublicHttpUrl(urlStr);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`https://r.jina.ai/${safe.toString()}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'text/plain',
          'X-Return-Format': 'markdown',
        },
      });
      if (!resp.ok) return null;
      const txt = (await resp.text()).slice(0, 260_000);
      return txt.trim().length >= 30 ? txt : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#64;|\[at\]|\(at\)/gi, '@')
    .replace(/&#46;/gi, '.');
}

function isLikelyJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.length > 100 || lower.length < 6) return true;
  if (
    /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|pdf|zip)$/i.test(lower)
  ) {
    return true;
  }
  if (
    lower.includes('sentry.io') ||
    lower.includes('wixpress.com') ||
    lower.includes('example.com') ||
    lower.includes('yourdomain.com') ||
    lower.includes('domain.com') ||
    lower.includes('email.com') ||
    lower.startsWith('noreply@') ||
    lower.startsWith('no-reply@') ||
    lower.startsWith('donotreply@')
  ) {
    return true;
  }
  return false;
}

interface ExtractedPageData {
  title: string;
  description: string;
  cleanText: string;
  emails: string[];
  phones: string[];
  contactLinks: string[];
}

function extractPageIntelligence(html: string, baseUrl: string): ExtractedPageData {
  const decoded = decodeHtmlEntities(html);

  const titleMatch = decoded.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

  const metaDescMatch =
    decoded.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i) ||
    decoded.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i);
  const description = (metaDescMatch?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 300);

  const emailsSet = new Set<string>();
  const mailtoRegex = /href=["']mailto:([^"'?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRegex.exec(decoded)) !== null) {
    const candidate = decodeURIComponent(m[1]).trim().toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/i.test(candidate) && !isLikelyJunkEmail(candidate)) {
      emailsSet.add(candidate);
    }
  }

  const phonesSet = new Set<string>();
  const telRegex = /href=["']tel:([^"'?#]+)/gi;
  while ((m = telRegex.exec(decoded)) !== null) {
    const digits = normalizePhoneDigits(decodeURIComponent(m[1]));
    if (digits) phonesSet.add(formatPhoneDisplay(digits));
  }

  // Extract WhatsApp wa.me / api.whatsapp.com links (zero-token goldmine!)
  const waLinkRegex = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"']*phone=)(\+?\d{9,15})/gi;
  while ((m = waLinkRegex.exec(decoded)) !== null) {
    const digits = normalizePhoneDigits(m[1]);
    if (digits) phonesSet.add(formatPhoneDisplay(digits));
  }

  // Discover up to 2 contact/about links on same origin
  const contactLinksSet = new Set<string>();
  try {
    const base = new URL(baseUrl);
    const hrefRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
    while ((m = hrefRegex.exec(decoded)) !== null) {
      const href = m[1].trim();
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
        continue;
      }
      if (/contact|about|reach|support|যোগাযোগ/i.test(href)) {
        try {
          const resolved = new URL(href, base);
          if (resolved.hostname === base.hostname && resolved.pathname !== base.pathname) {
            contactLinksSet.add(resolved.toString());
            if (contactLinksSet.size >= 2) break;
          }
        } catch {
          // ignore malformed href
        }
      }
    }
  } catch {
    // ignore URL parse failure
  }

  const textOnly = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const textEmailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,12}\b/g;
  const emailMatches = textOnly.match(textEmailRegex) || [];
  for (const raw of emailMatches) {
    const clean = raw.toLowerCase();
    if (!isLikelyJunkEmail(clean)) {
      emailsSet.add(clean);
      if (emailsSet.size >= 15) break;
    }
  }

  // BD & International phone patterns from clean visible text
  const bdPhoneRegex = /(?:\+?88[\s-]?)?01[3-9]\d{2}[\s-]?\d{6}\b/g;
  for (const raw of textOnly.match(bdPhoneRegex) || []) {
    const digits = normalizePhoneDigits(raw);
    if (digits) phonesSet.add(formatPhoneDisplay(digits));
  }

  const intlPhoneRegex = /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,5}\b/g;
  for (const raw of textOnly.match(intlPhoneRegex) || []) {
    const digits = normalizePhoneDigits(raw);
    if (digits) phonesSet.add(formatPhoneDisplay(digits));
    if (phonesSet.size >= 15) break;
  }

  return {
    title,
    description,
    cleanText: textOnly.slice(0, 3000),
    emails: Array.from(emailsSet).slice(0, 12),
    phones: Array.from(phonesSet).slice(0, 12),
    contactLinks: Array.from(contactLinksSet),
  };
}

async function searchWithTavily(
  query: string,
  maxResults: number
): Promise<{ title: string; url: string; snippet: string }[] | null> {
  const keys = collectEnvKeyPool('TAVILY_API_KEY', 'TAVILY_API_KEY', 'TAVILY_API_KEYS');
  if (keys.length === 0) return null;

  for (const apiKey of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9_000);
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: Math.max(3, Math.min(10, maxResults)),
          include_answer: false,
        }),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      if (Array.isArray(data.results) && data.results.length > 0) {
        return data.results
          .filter((r) => typeof r.url === 'string' && r.url.startsWith('http'))
          .map((r) => ({
            title: (r.title || r.url || '').slice(0, 140),
            url: r.url!,
            snippet: (r.content || '').slice(0, 280),
          }));
      }
    } catch {
      // try next key
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function searchWithSerper(
  query: string,
  maxResults: number
): Promise<{ title: string; url: string; snippet: string }[] | null> {
  const keys = collectEnvKeyPool('SERPER_API_KEY', 'SERPER_API_KEY', 'SERPER_API_KEYS');
  if (keys.length === 0) return null;

  for (const apiKey of keys) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9_000);
    try {
      const resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify({
          q: query,
          num: Math.max(3, Math.min(10, maxResults)),
        }),
      });
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };
      if (Array.isArray(data.organic) && data.organic.length > 0) {
        return data.organic
          .filter((r) => typeof r.link === 'string' && r.link.startsWith('http'))
          .map((r) => ({
            title: (r.title || r.link || '').slice(0, 140),
            url: r.link!,
            snippet: (r.snippet || '').slice(0, 280),
          }));
      }
    } catch {
      // try next key
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function searchWithDuckDuckGoLite(
  query: string,
  maxResults: number
): Promise<{ title: string; url: string; snippet: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_500);
  try {
    const resp = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
      }
    );
    if (!resp.ok) return [];
    const html = (await resp.text()).slice(0, 260_000);
    const items: { title: string; url: string; snippet: string }[] = [];
    const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRegex.exec(html)) !== null) {
      let rawHref = decodeHtmlEntities(m[1]);
      if (rawHref.includes('uddg=')) {
        try {
          const parsed = new URL(rawHref.startsWith('//') ? `https:${rawHref}` : rawHref);
          rawHref = parsed.searchParams.get('uddg') || rawHref;
        } catch {
          // ignore
        }
      }
      if (!/^https?:\/\//i.test(rawHref)) continue;
      if (rawHref.includes('duckduckgo.com')) continue;
      const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).trim().slice(0, 140);
      items.push({ title: title || rawHref, url: rawHref, snippet: '' });
      if (items.length >= maxResults) break;
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function encodeMimeHeaderUtf8(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function buildRawRfc2822Email(params: {
  to: string;
  subject: string;
  bodyText: string;
  fromName?: string;
}): string {
  const headers = [
    `To: ${params.to.replace(/[\r\n]+/g, '')}`,
    `Subject: ${encodeMimeHeaderUtf8(params.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (params.fromName) {
    headers.unshift(`From: ${encodeMimeHeaderUtf8(params.fromName)} <me>`);
  }
  const bodyBase64 = Buffer.from(params.bodyText, 'utf8').toString('base64');
  const raw = `${headers.join('\r\n')}\r\n\r\n${bodyBase64}`;
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmailViaGmailOAuth(params: {
  accessToken: string;
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ messageId: string }> {
  const raw = buildRawRfc2822Email({
    to: params.to,
    subject: params.subject,
    bodyText: params.bodyText,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!resp.ok) {
      throw new Error(data.error?.message || `Gmail API HTTP ${resp.status}`);
    }
    return { messageId: data.id || 'gmail_sent' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmailViaResend(params: {
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ messageId: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY env var is not configured on Render/server.');
  }
  const from = process.env.RESEND_FROM_EMAIL?.trim() || 'onboarding@resend.dev';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        text: params.bodyText,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };
    if (!resp.ok) {
      throw new Error(data.message || `Resend HTTP ${resp.status}`);
    }
    return { messageId: data.id || 'resend_sent' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmailViaBrevo(params: {
  to: string;
  subject: string;
  bodyText: string;
  ownerName: string;
}): Promise<{ messageId: string }> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const fromEmail = process.env.BREVO_FROM_EMAIL?.trim();
  if (!apiKey || !fromEmail) {
    throw new Error('BREVO_API_KEY and BREVO_FROM_EMAIL env vars are required on server.');
  }
  const fromName = process.env.BREVO_FROM_NAME?.trim() || params.ownerName || 'WaNexus';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email: params.to }],
        subject: params.subject,
        textContent: params.bodyText,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      messageId?: string;
      message?: string;
    };
    if (!resp.ok) {
      throw new Error(data.message || `Brevo HTTP ${resp.status}`);
    }
    return { messageId: data.messageId || 'brevo_sent' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendEmailViaCustomWebhook(params: {
  to: string;
  subject: string;
  bodyText: string;
}): Promise<{ messageId: string }> {
  const webhookUrl = process.env.CUSTOM_EMAIL_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    throw new Error('CUSTOM_EMAIL_WEBHOOK_URL env var is not configured on server.');
  }
  assertSafePublicHttpUrl(webhookUrl);
  const token = process.env.CUSTOM_EMAIL_WEBHOOK_TOKEN?.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        to: params.to,
        subject: params.subject,
        text: params.bodyText,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Custom Email HTTP ${resp.status}`);
    }
    return { messageId: `custom_${Date.now()}` };
  } finally {
    clearTimeout(timer);
  }
}

export function buildZeroTokenOutreachDraft(params: {
  channel: 'email' | 'whatsapp';
  leadName: string;
  domain?: string;
  topic?: string;
  language: 'bn' | 'en';
  ownerName: string;
  ownerProfession: string;
  offerPitch: string;
}): { subject: string; body: string } {
  const targetName = params.leadName || params.domain || 'Sir/Madam';
  const topicClean = (params.topic || '').trim();
  const pitch = (params.offerPitch || DEFAULT_OUTREACH_POLICY.defaultOfferPitch).trim();
  const sender = params.ownerName || 'Sir';
  const role = params.ownerProfession || 'Automation Specialist';

  if (params.channel === 'email') {
    if (params.language === 'en') {
      const subject = topicClean
        ? `Quick collaboration idea for ${targetName} (${topicClean.slice(0, 45)})`
        : `Collaboration & Automation Proposal for ${targetName}`;
      const body = [
        `Hello ${targetName} team,`,
        '',
        topicClean
          ? `I came across ${params.domain || targetName} while researching "${topicClean}" and wanted to reach out directly.`
          : `I came across ${params.domain || targetName} and wanted to connect regarding potential collaboration.`,
        '',
        pitch,
        '',
        `If this sounds relevant, just reply to this email and we can share a short tailored walkthrough.`,
        '',
        `Best regards,`,
        `${sender}`,
        `${role}`,
      ].join('\n');
      return { subject, body };
    }

    const subject = topicClean
      ? `${targetName}-এর জন্য সহযোগিতা ও অটোমেশন প্রস্তাব (${topicClean.slice(0, 40)})`
      : `${targetName}-এর জন্য একটি সংক্ষিপ্ত সহযোগিতা প্রস্তাব`;
    const body = [
      `আসসালামু আলাইকুম / শুভেচ্ছা ${targetName} টিম,`,
      '',
      topicClean
        ? `"${topicClean}" বিষয়ে রিসার্চ করার সময় আপনাদের ওয়েবসাইট (${params.domain || targetName}) দেখে সরাসরি যোগাযোগ করলাম।`
        : `আপনাদের ওয়েবসাইট (${params.domain || targetName}) দেখে সরাসরি একটি কাজের বিষয়ে যোগাযোগ করলাম।`,
      '',
      pitch,
      '',
      `আপনাদের প্রয়োজন থাকলে বা বিস্তারিত জানতে চাইলে এই ইমেইলেই ছোট একটি রিপ্লাই দিলে আমরা ডেমো ও প্ল্যান শেয়ার করবো।`,
      '',
      `ধন্যবাদান্তে,`,
      `${sender} (${role})`,
    ].join('\n');
    return { subject, body };
  }

  // WhatsApp short, polite, non-spammy opener
  if (params.language === 'en') {
    const body = [
      `Hello ${targetName} team!`,
      topicClean
        ? `I found ${params.domain || targetName} while researching "${topicClean}".`
        : `I came across ${params.domain || targetName} online.`,
      `${pitch}`,
      `Would you be open to a quick 2-minute overview? — ${sender}`,
    ].join(' ');
    return { subject: '', body };
  }

  const body = [
    `আসসালামু আলাইকুম ${targetName} টিম, আমি ${sender} বলছি।`,
    topicClean
      ? `"${topicClean}" নিয়ে খোঁজ করার সময় আপনাদের ওয়েবসাইট (${params.domain || targetName}) পেলাম।`
      : `আপনাদের ওয়েবসাইট (${params.domain || targetName}) দেখে নক দিলাম।`,
    `${pitch}`,
    `আগ্রহী থাকলে একটু জানাবেন, সংক্ষেপে বিস্তারিত শেয়ার করবো।`,
  ].join(' ');
  return { subject: '', body };
}

export function registerWebOutreachRoutes(
  app: Express,
  adapters: WebOutreachHostAdapters
): WebOutreachController {
  let store: PersistedOutreachStore = {
    policy: { ...DEFAULT_OUTREACH_POLICY },
    dailyStats: {
      date: todayDateKey(),
      emailsSentToday: 0,
      whatsappSentToday: 0,
    },
    leads: [],
    researchHistory: [],
    dispatchLogs: [],
  };
  let emailSenders: StoredEmailSenderProfile[] = [];

  function loadSendersFromDisk() {
    try {
      if (fs.existsSync(OUTREACH_SENDERS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(OUTREACH_SENDERS_FILE, 'utf8')) as StoredEmailSenderProfile[];
        if (Array.isArray(parsed)) {
          emailSenders = parsed.filter((s) => s && typeof s.email === 'string' && typeof s.secret === 'string').slice(0, 15);
        }
      }
    } catch {
      emailSenders = [];
    }
  }

  function saveSendersToDisk() {
    try {
      fs.writeFileSync(OUTREACH_SENDERS_FILE, JSON.stringify(emailSenders.slice(0, 15), null, 2));
    } catch (err) {
      console.warn('[WebOutreach] Failed saving bot-outreach-senders.json:', (err as Error).message);
    }
  }

  function toPublicSender(s: StoredEmailSenderProfile): PublicEmailSenderProfile {
    return {
      id: s.id,
      email: s.email,
      label: s.label,
      type: s.type,
      host: s.host,
      port: s.port,
      active: s.active,
      hasSecret: Boolean(s.secret),
      maskedSecret: maskSecret(s.secret),
      createdAt: s.createdAt,
    };
  }

  function getActiveSmtpSender(): StoredEmailSenderProfile | null {
    return emailSenders.find((s) => s.active) || emailSenders[0] || null;
  }

  loadSendersFromDisk();

  // Bounded 30-item research cache (keeps repeat lookups at 0 AI tokens & low RAM)
  const researchCache = new Map<
    string,
    { cachedAt: number; payload: WebResearchHistoryItem; leads: OutreachLeadItem[] }
  >();

  let whatsappQueueState = {
    active: false,
    abortRequested: false,
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    currentRecipient: null as string | null,
    nextSendAt: null as string | null,
  };

  function ensureTodayStats() {
    const today = todayDateKey();
    if (store.dailyStats.date !== today) {
      store.dailyStats = {
        date: today,
        emailsSentToday: 0,
        whatsappSentToday: 0,
      };
    }
  }

  function loadStoreFromDisk() {
    try {
      if (fs.existsSync(OUTREACH_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(OUTREACH_FILE, 'utf8')) as Partial<PersistedOutreachStore>;
        store = {
          policy: { ...DEFAULT_OUTREACH_POLICY, ...(parsed.policy || {}) },
          dailyStats: parsed.dailyStats || { date: todayDateKey(), emailsSentToday: 0, whatsappSentToday: 0 },
          leads: Array.isArray(parsed.leads) ? parsed.leads.slice(0, MAX_LEADS) : [],
          researchHistory: Array.isArray(parsed.researchHistory)
            ? parsed.researchHistory.slice(0, MAX_RESEARCH_HISTORY)
            : [],
          dispatchLogs: Array.isArray(parsed.dispatchLogs)
            ? parsed.dispatchLogs.slice(0, MAX_DISPATCH_LOGS)
            : [],
        };
      }
    } catch {
      // start fresh on malformed file
    }
    ensureTodayStats();
  }

  function saveStoreToDisk() {
    ensureTodayStats();
    store.leads = store.leads.slice(0, MAX_LEADS);
    store.researchHistory = store.researchHistory.slice(0, MAX_RESEARCH_HISTORY);
    store.dispatchLogs = store.dispatchLogs.slice(0, MAX_DISPATCH_LOGS);
    try {
      fs.writeFileSync(OUTREACH_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.warn('[WebOutreach] Failed saving bot-outreach.json:', (err as Error).message);
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
      void adminSaveDocument('bot_outreach', 'primary', {
        policy: store.policy,
        dailyStats: store.dailyStats,
        leads: store.leads.slice(0, 120),
        researchHistory: store.researchHistory.slice(0, 20),
      }).catch(() => {});
    }
  }

  loadStoreFromDisk();
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    void adminLoadDocument<Partial<PersistedOutreachStore>>('bot_outreach', 'primary')
      .then((cloudDoc) => {
        if (!cloudDoc) return;
        if (store.leads.length === 0 && Array.isArray(cloudDoc.leads) && cloudDoc.leads.length > 0) {
          store.leads = cloudDoc.leads.slice(0, MAX_LEADS);
          if (cloudDoc.policy) {
            store.policy = { ...DEFAULT_OUTREACH_POLICY, ...cloudDoc.policy };
          }
          saveStoreToDisk();
        }
      })
      .catch(() => {});
  }

  function upsertLead(candidate: {
    name: string;
    sourceUrl: string;
    topic: string;
    emails: string[];
    phones: string[];
    snippet: string;
  }): OutreachLeadItem {
    let domain = 'manual';
    try {
      domain = new URL(candidate.sourceUrl).hostname.replace(/^www\./, '');
    } catch {
      domain = candidate.sourceUrl || 'manual';
    }

    const existing = store.leads.find(
      (l) =>
        (l.domain !== 'manual' && l.domain === domain) ||
        candidate.emails.some((e) => l.emails.includes(e)) ||
        candidate.phones.some((p) => l.phones.includes(p))
    );

    if (existing) {
      existing.emails = Array.from(new Set([...existing.emails, ...candidate.emails])).slice(0, 12);
      existing.phones = Array.from(new Set([...existing.phones, ...candidate.phones])).slice(0, 12);
      if (candidate.name && existing.name === existing.domain) {
        existing.name = candidate.name.slice(0, 120);
      }
      if (candidate.snippet && !existing.snippet) {
        existing.snippet = candidate.snippet.slice(0, 240);
      }
      return existing;
    }

    const item: OutreachLeadItem = {
      id: uid('lead'),
      name: (candidate.name || domain).slice(0, 120),
      sourceUrl: candidate.sourceUrl,
      domain,
      topic: candidate.topic.slice(0, 120),
      emails: candidate.emails.slice(0, 12),
      phones: candidate.phones.slice(0, 12),
      whatsappVerifiedPhones: [],
      whatsappCheckedAt: null,
      snippet: candidate.snippet.slice(0, 240),
      emailSentCount: 0,
      lastEmailSentAt: null,
      whatsappSentCount: 0,
      lastWhatsappSentAt: null,
      createdAt: new Date().toISOString(),
    };
    store.leads.unshift(item);
    return item;
  }

  function pushDispatchLog(entry: Omit<OutreachDispatchLogItem, 'id' | 'timestamp'>) {
    store.dispatchLogs.unshift({
      id: uid('out'),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    store.dispatchLogs = store.dispatchLogs.slice(0, MAX_DISPATCH_LOGS);
  }

  function getCapabilities() {
    return {
      tavilyConfigured:
        collectEnvKeyPool('TAVILY_API_KEY', 'TAVILY_API_KEY', 'TAVILY_API_KEYS').length > 0,
      serperConfigured:
        collectEnvKeyPool('SERPER_API_KEY', 'SERPER_API_KEY', 'SERPER_API_KEYS').length > 0,
      geminiSearchConfigured: adapters.geminiPool.hasKeys(),
      openRouterConfigured: adapters.openRouterReader.hasKeys(),
      smtpProfileConfigured: emailSenders.some((s) => Boolean(s.secret)),
      resendConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
      brevoConfigured: Boolean(
        process.env.BREVO_API_KEY?.trim() && process.env.BREVO_FROM_EMAIL?.trim()
      ),
      customEmailWebhookConfigured: Boolean(process.env.CUSTOM_EMAIL_WEBHOOK_URL?.trim()),
      whatsappConnected: adapters.getBotStatus() === 'connected' && Boolean(adapters.getSocket()),
    };
  }

  function buildStateResponse() {
    ensureTodayStats();
    const verifiedCount = store.leads.filter((l) => l.whatsappVerifiedPhones.length > 0).length;
    return {
      memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      policy: store.policy,
      stats: {
        date: store.dailyStats.date,
        emailsSentToday: store.dailyStats.emailsSentToday,
        whatsappSentToday: store.dailyStats.whatsappSentToday,
        totalLeads: store.leads.length,
        whatsappVerifiedCount: verifiedCount,
      },
      capabilities: getCapabilities(),
      emailSenders: emailSenders.map(toPublicSender),
      whatsappQueue: {
        active: whatsappQueueState.active,
        total: whatsappQueueState.total,
        processed: whatsappQueueState.processed,
        sent: whatsappQueueState.sent,
        failed: whatsappQueueState.failed,
        currentRecipient: whatsappQueueState.currentRecipient,
        nextSendAt: whatsappQueueState.nextSendAt,
      },
      leads: store.leads,
      researchHistory: store.researchHistory,
      dispatchLogs: store.dispatchLogs,
    };
  }

  app.get('/api/outreach/state', (_req: Request, res: Response) => {
    res.json(buildStateResponse());
  });

  app.get('/api/outreach/senders', (_req: Request, res: Response) => {
    res.json({ senders: emailSenders.map(toPublicSender) });
  });

  app.post('/api/outreach/senders/activate', (req: Request, res: Response) => {
    const idOrEmail = String(req.body?.id || req.body?.email || '').trim().toLowerCase();
    const match = emailSenders.find(
      (s) => s.id.toLowerCase() === idOrEmail || s.email.toLowerCase() === idOrEmail
    );
    if (!match) {
      res.status(404).json({ error: 'Sender email profile not found.' });
      return;
    }
    emailSenders = emailSenders.map((s) => ({ ...s, active: s.id === match.id }));
    store.policy.preferredEmailProvider = 'smtp_profile';
    saveSendersToDisk();
    saveStoreToDisk();
    res.json({ senders: emailSenders.map(toPublicSender), state: buildStateResponse() });
  });

  app.delete('/api/outreach/senders/:id', (req: Request, res: Response) => {
    const target = decodeURIComponent(String(req.params.id || '')).trim().toLowerCase();
    if (target === 'all') {
      emailSenders = [];
    } else {
      emailSenders = emailSenders.filter(
        (s) => s.id.toLowerCase() !== target && s.email.toLowerCase() !== target
      );
      if (emailSenders.length > 0 && !emailSenders.some((s) => s.active)) {
        emailSenders[0].active = true;
      }
    }
    if (emailSenders.length === 0 && store.policy.preferredEmailProvider === 'smtp_profile') {
      store.policy.preferredEmailProvider = 'gmail_oauth';
    }
    saveSendersToDisk();
    saveStoreToDisk();
    res.json({ senders: emailSenders.map(toPublicSender), state: buildStateResponse() });
  });

  app.post('/api/outreach/policy', (req: Request, res: Response) => {
    const raw = (req.body || {}) as Partial<OutreachSafetyPolicy>;
    const minDelay = Math.max(15_000, Math.min(300_000, Number(raw.whatsappMinDelayMs ?? store.policy.whatsappMinDelayMs)));
    const maxDelay = Math.max(minDelay, Math.min(360_000, Number(raw.whatsappMaxDelayMs ?? store.policy.whatsappMaxDelayMs)));

    store.policy = {
      dailyEmailLimit: Math.max(1, Math.min(300, Number(raw.dailyEmailLimit ?? store.policy.dailyEmailLimit))),
      dailyWhatsappLimit: Math.max(1, Math.min(40, Number(raw.dailyWhatsappLimit ?? store.policy.dailyWhatsappLimit))),
      whatsappMinDelayMs: minDelay,
      whatsappMaxDelayMs: maxDelay,
      emailDelayMs: Math.max(500, Math.min(30_000, Number(raw.emailDelayMs ?? store.policy.emailDelayMs))),
      preferredEmailProvider:
        raw.preferredEmailProvider &&
        ['gmail_oauth', 'smtp_profile', 'resend_http', 'brevo_http', 'custom_http'].includes(raw.preferredEmailProvider)
          ? raw.preferredEmailProvider
          : store.policy.preferredEmailProvider,
      zeroTokenDraftDefault:
        typeof raw.zeroTokenDraftDefault === 'boolean'
          ? raw.zeroTokenDraftDefault
          : store.policy.zeroTokenDraftDefault,
      defaultLanguage: raw.defaultLanguage === 'en' ? 'en' : 'bn',
      defaultOfferPitch:
        typeof raw.defaultOfferPitch === 'string'
          ? raw.defaultOfferPitch.trim().slice(0, 700)
          : store.policy.defaultOfferPitch,
      crawlContactSubpages:
        typeof raw.crawlContactSubpages === 'boolean'
          ? raw.crawlContactSubpages
          : store.policy.crawlContactSubpages,
      maxSitesPerSearch: Math.max(
        1,
        Math.min(8, Number(raw.maxSitesPerSearch ?? store.policy.maxSitesPerSearch))
      ),
    };
    saveStoreToDisk();
    adapters.pushLog(
      'system',
      'Outreach Policy',
      `Updated limits: ${store.policy.dailyEmailLimit} emails/day · ${store.policy.dailyWhatsappLimit} WA/day`,
      'info'
    );
    res.json({ policy: store.policy, state: buildStateResponse() });
  });

  app.post('/api/outreach/scrape-url', async (req: Request, res: Response) => {
    try {
      const rawInput = String(req.body?.urls || req.body?.url || '').trim();
      const topic = String(req.body?.topic || 'Direct Website Scrape').trim();
      if (!rawInput) {
        res.status(400).json({ error: 'Please provide at least one URL.' });
        return;
      }

      const urlList = rawInput
        .split(/[\n,\s]+/)
        .map((u) => u.trim())
        .filter(Boolean)
        .slice(0, 6);

      const savedLeads: OutreachLeadItem[] = [];
      const errors: string[] = [];
      const scannedUrls: { title: string; url: string; snippet: string }[] = [];

      for (const rawUrl of urlList) {
        try {
          const safe = assertSafePublicHttpUrl(rawUrl);
          const html = await fetchSafeHtml(safe.toString());
          const extracted = extractPageIntelligence(html, safe.toString());
          const allEmails = new Set(extracted.emails);
          const allPhones = new Set(extracted.phones);

          if (store.policy.crawlContactSubpages && extracted.contactLinks.length > 0) {
            for (const subUrl of extracted.contactLinks.slice(0, 2)) {
              try {
                const subHtml = await fetchSafeHtml(subUrl, 6_000, 250_000);
                const subData = extractPageIntelligence(subHtml, subUrl);
                subData.emails.forEach((e) => allEmails.add(e));
                subData.phones.forEach((p) => allPhones.add(p));
              } catch {
                // ignore failed subpage
              }
            }
          }

          const emailsArr = Array.from(allEmails);
          const phonesArr = Array.from(allPhones);
          scannedUrls.push({
            title: extracted.title || safe.hostname,
            url: safe.toString(),
            snippet: extracted.description || extracted.cleanText.slice(0, 200),
          });
          const lead = upsertLead({
            name: extracted.title || safe.hostname,
            sourceUrl: safe.toString(),
            topic,
            emails: emailsArr,
            phones: phonesArr,
            snippet: extracted.description || extracted.cleanText.slice(0, 220),
          });
          savedLeads.push(lead);
        } catch (err) {
          errors.push(`${rawUrl}: ${(err as Error).message}`);
        }
      }

      const totalEmails = savedLeads.reduce((acc, l) => acc + l.emails.length, 0);
      const totalPhones = savedLeads.reduce((acc, l) => acc + l.phones.length, 0);
      const historyItem: WebResearchHistoryItem = {
        id: uid('res'),
        query: urlList.join(', '),
        providerUsed: 'direct_url',
        tokensSpent: 0,
        summary: `০ টোকেনে ${scannedUrls.length}টি ওয়েবসাইট স্ক্যান সম্পন্ন হয়েছে। মোট ${totalEmails}টি ইমেইল এবং ${totalPhones}টি ফোন নম্বর পাওয়া গেছে।${
          errors.length > 0 ? ` (${errors.length}টি সাইট রিড করা যায়নি)` : ''
        }`,
        urls: scannedUrls,
        emailsFound: totalEmails,
        phonesFound: totalPhones,
        createdAt: new Date().toISOString(),
      };
      store.researchHistory.unshift(historyItem);
      saveStoreToDisk();

      adapters.pushLog(
        'system',
        'Web Extractor (0 Tokens)',
        `Scraped ${scannedUrls.length} URL(s) -> ${totalEmails} emails, ${totalPhones} phones`,
        scannedUrls.length > 0 ? 'success' : 'error'
      );

      res.json({
        research: historyItem,
        leads: savedLeads,
        errors,
        state: buildStateResponse(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/outreach/research', async (req: Request, res: Response) => {
    try {
      const query = String(req.body?.query || '').trim();
      const useAiSummary = Boolean(req.body?.useAiSummary);
      const forceFresh = Boolean(req.body?.forceFresh);
      const maxSites = Math.max(
        1,
        Math.min(8, Number(req.body?.maxSites || store.policy.maxSitesPerSearch || 5))
      );

      if (!query || query.length < 2) {
        res.status(400).json({ error: 'Search topic or question is required.' });
        return;
      }

      const cacheKey = `${query.toLowerCase()}::${useAiSummary ? 'ai' : 'zero'}`;
      const cached = !forceFresh ? researchCache.get(cacheKey) : undefined;
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        res.json({
          research: cached.payload,
          leads: cached.leads,
          fromCache: true,
          state: buildStateResponse(),
        });
        return;
      }

      let providerUsed: WebResearchHistoryItem['providerUsed'] = 'duckduckgo';
      let tokensSpent = 0;
      let discoveredUrls: { title: string; url: string; snippet: string }[] = [];
      let aiSynthesisText = '';

      // 1. Free Search APIs First (0 AI Tokens): Tavily -> Serper -> DuckDuckGo Lite
      const tavilyResults = await searchWithTavily(query, maxSites);
      if (tavilyResults && tavilyResults.length > 0) {
        discoveredUrls = tavilyResults;
        providerUsed = 'tavily';
      } else {
        const serperResults = await searchWithSerper(query, maxSites);
        if (serperResults && serperResults.length > 0) {
          discoveredUrls = serperResults;
          providerUsed = 'serper';
        } else {
          const ddgResults = await searchWithDuckDuckGoLite(query, maxSites);
          if (ddgResults.length > 0) {
            discoveredUrls = ddgResults;
            providerUsed = 'duckduckgo';
          }
        }
      }

      // 2. If zero results from free search OR explicit AI search requested + Gemini configured:
      if ((discoveredUrls.length === 0 || useAiSummary) && adapters.geminiPool.hasKeys()) {
        try {
          const { value: gResp, keySlot } = await adapters.geminiPool.executeWithRotation(
            (ai) =>
              ai.models.generateContent({
                model: 'gemini-4-hydrogen',
                contents:
                  discoveredUrls.length > 0
                    ? `নিচের টপিক ও ওয়েব রেজাল্টগুলো বিশ্লেষণ করে সংক্ষেপে (৪-৬ লাইনে) বাংলায় মূল তথ্য ও করণীয় লিখুন:\nTopic: ${query}\nSources:\n${discoveredUrls
                        .map((u, idx) => `${idx + 1}. ${u.title} (${u.url}): ${u.snippet}`)
                        .join('\n')}`
                    : `ওয়েব সার্চ করে "${query}" সম্পর্কে নির্ভরযোগ্য সংক্ষিপ্ত বাংলা সারাংশ ও অফিসিয়াল ওয়েবসাইট লিংক দিন।`,
                config: {
                  tools: [{ googleSearch: {} }],
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                },
              }),
            undefined,
            { maxTotalMs: 12_000, channel: 'primary' }
          );

          const usage = (gResp as {
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          })?.usageMetadata;
          const totalTok = Number(usage?.totalTokenCount || 0);
          tokensSpent += totalTok;
          adapters.tokenTelemetry.recordUsage({
            provider: 'gemini',
            model: 'gemini-4-hydrogen',
            keySlot,
            category: 'summary',
            promptTokens: Number(usage?.promptTokenCount || 0),
            completionTokens: Number(usage?.candidatesTokenCount || 0),
            totalTokens: totalTok,
          });

          aiSynthesisText = (gResp.text || '').trim().slice(0, 1600);
          if (discoveredUrls.length === 0) {
            providerUsed = 'gemini_search';
            const chunks = (gResp as {
              candidates?: Array<{
                groundingMetadata?: {
                  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
                };
              }>;
            })?.candidates?.[0]?.groundingMetadata?.groundingChunks;
            if (Array.isArray(chunks)) {
              for (const c of chunks) {
                if (c.web?.uri && /^https?:\/\//i.test(c.web.uri)) {
                  discoveredUrls.push({
                    title: (c.web.title || c.web.uri).slice(0, 140),
                    url: c.web.uri,
                    snippet: '',
                  });
                }
                if (discoveredUrls.length >= maxSites) break;
              }
            }
          }
        } catch (err) {
          adapters.pushLog(
            'gemini',
            'Web Research',
            `AI search/summary skipped: ${(err as Error).message.slice(0, 100)}`,
            'info'
          );
        }
      }

      // 3. Scrape discovered sites at 0 AI tokens for Emails & Phone numbers
      const savedLeads: OutreachLeadItem[] = [];
      const enrichedSummaries: string[] = [];

      for (const site of discoveredUrls.slice(0, maxSites)) {
        try {
          const html = await fetchSafeHtml(site.url, 7_000, 320_000);
          const extracted = extractPageIntelligence(html, site.url);
          const allEmails = new Set(extracted.emails);
          const allPhones = new Set(extracted.phones);

          if (
            store.policy.crawlContactSubpages &&
            allEmails.size === 0 &&
            allPhones.size === 0 &&
            extracted.contactLinks.length > 0
          ) {
            for (const subUrl of extracted.contactLinks.slice(0, 1)) {
              try {
                const subHtml = await fetchSafeHtml(subUrl, 5_500, 220_000);
                const sub = extractPageIntelligence(subHtml, subUrl);
                sub.emails.forEach((e) => allEmails.add(e));
                sub.phones.forEach((p) => allPhones.add(p));
              } catch {
                // ignore
              }
            }
          }

          const emails = Array.from(allEmails);
          const phones = Array.from(allPhones);
          if (extracted.title) site.title = extracted.title;
          if (!site.snippet && extracted.description) site.snippet = extracted.description;

          if (emails.length > 0 || phones.length > 0) {
            const lead = upsertLead({
              name: site.title || site.url,
              sourceUrl: site.url,
              topic: query,
              emails,
              phones,
              snippet: site.snippet || extracted.cleanText.slice(0, 200),
            });
            savedLeads.push(lead);
          } else {
            // Still record website as lead candidate if it had a useful snippet
            const lead = upsertLead({
              name: site.title || site.url,
              sourceUrl: site.url,
              topic: query,
              emails: [],
              phones: [],
              snippet: site.snippet || extracted.cleanText.slice(0, 200),
            });
            savedLeads.push(lead);
          }

          if (extracted.description || site.snippet) {
            enrichedSummaries.push(`• ${site.title}: ${(extracted.description || site.snippet).slice(0, 130)}`);
          }
        } catch {
          // Even if target website blocks raw fetch, keep search snippet as zero-token lead reference
          const lead = upsertLead({
            name: site.title || site.url,
            sourceUrl: site.url,
            topic: query,
            emails: [],
            phones: [],
            snippet: site.snippet,
          });
          savedLeads.push(lead);
        }
      }

      const emailsFound = savedLeads.reduce((acc, l) => acc + l.emails.length, 0);
      const phonesFound = savedLeads.reduce((acc, l) => acc + l.phones.length, 0);

      const summary =
        aiSynthesisText ||
        (discoveredUrls.length > 0
          ? `${providerUsed.toUpperCase()} দিয়ে ${discoveredUrls.length}টি ওয়েবসাইট রিসার্চ সম্পন্ন (${tokensSpent} AI টোকেন)। মোট ${emailsFound}টি ইমেইল ও ${phonesFound}টি নম্বর সংগ্রহ হয়েছে।\n${enrichedSummaries
              .slice(0, 4)
              .join('\n')}`
          : 'কোনো পাবলিক ওয়েবসাইট পাওয়া যায়নি। Render-এ TAVILY_API_KEY বা SERPER_API_KEY যুক্ত করলে সার্চ রেজাল্ট আরও নির্ভুল হবে, অথবা সরাসরি ওয়েবসাইট URL দিয়ে স্ক্র্যাপ করতে পারেন।');

      const historyItem: WebResearchHistoryItem = {
        id: uid('res'),
        query,
        providerUsed,
        tokensSpent,
        summary,
        urls: discoveredUrls,
        emailsFound,
        phonesFound,
        createdAt: new Date().toISOString(),
      };

      store.researchHistory.unshift(historyItem);
      saveStoreToDisk();

      researchCache.set(cacheKey, {
        cachedAt: Date.now(),
        payload: historyItem,
        leads: savedLeads,
      });
      if (researchCache.size > MAX_CACHE_ITEMS) {
        const oldestKey = researchCache.keys().next().value;
        if (oldestKey) researchCache.delete(oldestKey);
      }

      adapters.pushLog(
        'system',
        `Web Research (${providerUsed})`,
        `"${query.slice(0, 45)}" -> ${emailsFound} emails, ${phonesFound} phones (${tokensSpent} tokens)`,
        'success'
      );

      res.json({
        research: historyItem,
        leads: savedLeads,
        fromCache: false,
        state: buildStateResponse(),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/outreach/leads/add-manual', (req: Request, res: Response) => {
    const name = String(req.body?.name || 'Manual Lead').trim();
    const sourceUrl = String(req.body?.sourceUrl || 'manual://entry').trim();
    const topic = String(req.body?.topic || 'Manual Contact').trim();
    const rawEmails = String(req.body?.emails || '');
    const rawPhones = String(req.body?.phones || '');

    const emails = rawEmails
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/i.test(e));
    const phones = rawPhones
      .split(/[\s,;]+/)
      .map((p) => normalizePhoneDigits(p))
      .filter(Boolean)
      .map(formatPhoneDisplay);

    if (emails.length === 0 && phones.length === 0) {
      res.status(400).json({ error: 'Provide at least one valid email or phone number.' });
      return;
    }

    const lead = upsertLead({
      name,
      sourceUrl,
      topic,
      emails,
      phones,
      snippet: String(req.body?.snippet || '').trim(),
    });
    saveStoreToDisk();
    res.json({ lead, state: buildStateResponse() });
  });

  app.delete('/api/outreach/leads/:id', (req: Request, res: Response) => {
    const id = String(req.params.id || '');
    store.leads = store.leads.filter((l) => l.id !== id);
    saveStoreToDisk();
    res.json({ state: buildStateResponse() });
  });

  app.post('/api/outreach/leads/clear', (_req: Request, res: Response) => {
    store.leads = [];
    saveStoreToDisk();
    res.json({ state: buildStateResponse() });
  });

  app.post('/api/outreach/leads/verify-whatsapp', async (req: Request, res: Response) => {
    const sock = adapters.getSocket();
    if (!sock || adapters.getBotStatus() !== 'connected') {
      res.status(400).json({
        error: 'WhatsApp সকেট কানেক্টেড নেই। আগে Pairing & Status থেকে হোয়াটসঅ্যাপ কানেক্ট করুন।',
      });
      return;
    }

    const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as string[]) : [];
    const targets =
      leadIds.length > 0
        ? store.leads.filter((l) => leadIds.includes(l.id) && l.phones.length > 0)
        : store.leads.filter((l) => l.phones.length > 0 && !l.whatsappCheckedAt).slice(0, 25);

    let checkedCount = 0;
    let activeFound = 0;

    for (const lead of targets) {
      const verified: string[] = [];
      for (const phone of lead.phones.slice(0, 4)) {
        const digits = normalizePhoneDigits(phone);
        if (!digits) continue;
        try {
          const checkRes = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
          const exists = Array.isArray(checkRes) && checkRes.some((entry) => entry?.exists);
          if (exists) {
            verified.push(formatPhoneDisplay(digits));
            activeFound += 1;
          }
        } catch {
          // ignore individual lookup errors
        }
        checkedCount += 1;
      }
      lead.whatsappVerifiedPhones = Array.from(new Set(verified));
      lead.whatsappCheckedAt = new Date().toISOString();
    }

    saveStoreToDisk();
    adapters.pushLog(
      'system',
      'WA Lead Verifier (0 Tokens)',
      `Checked ${checkedCount} phone(s) -> ${activeFound} active on WhatsApp`,
      'success'
    );
    res.json({ checkedCount, activeFound, state: buildStateResponse() });
  });

  app.post('/api/outreach/draft', async (req: Request, res: Response) => {
    try {
      const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email';
      const useAi = Boolean(req.body?.useAi);
      const leadId = req.body?.leadId ? String(req.body.leadId) : '';
      const lead = store.leads.find((l) => l.id === leadId);
      const leadName = String(req.body?.leadName || lead?.name || 'Business Partner').trim();
      const domain = String(req.body?.domain || lead?.domain || '').trim();
      const topic = String(req.body?.topic || lead?.topic || '').trim();
      const offerPitch = String(req.body?.offerPitch || store.policy.defaultOfferPitch).trim();
      const language = req.body?.language === 'en' ? 'en' : store.policy.defaultLanguage;
      const cfg = adapters.getBotConfig();

      const zeroDraft = buildZeroTokenOutreachDraft({
        channel,
        leadName,
        domain,
        topic,
        language,
        ownerName: cfg.ownerName,
        ownerProfession: cfg.ownerProfession,
        offerPitch,
      });

      if (!useAi) {
        res.json({
          subject: zeroDraft.subject,
          body: zeroDraft.body,
          tokensSpent: 0,
          providerUsed: 'zero_token_template',
        });
        return;
      }

      if (!adapters.geminiPool.hasKeys()) {
        res.json({
          subject: zeroDraft.subject,
          body: zeroDraft.body,
          tokensSpent: 0,
          providerUsed: 'zero_token_template',
          note: 'Gemini API key unavailable — returned 0-token smart draft.',
        });
        return;
      }

      const { value: gResp, keySlot } = await adapters.geminiPool.executeWithRotation(
        (ai) =>
          ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents: `Write a short, respectful, human-sounding ${
              channel === 'email' ? 'business outreach email (with Subject and Body)' : 'WhatsApp intro message (max 3 lines, no spam)'
            } in ${language === 'en' ? 'English' : 'natural Bengali'}.\nSender: ${cfg.ownerName} (${
              cfg.ownerProfession
            })\nRecipient: ${leadName} (${domain})\nContext/Topic: ${topic}\nOffer: ${offerPitch}\nOutput strictly JSON: {"subject":"...","body":"..."}`,
            config: {
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            },
          }),
        undefined,
        { maxTotalMs: 10_000, channel: 'primary' }
      );

      const usage = (gResp as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      })?.usageMetadata;
      const tokensSpent = Number(usage?.totalTokenCount || 0);
      adapters.tokenTelemetry.recordUsage({
        provider: 'gemini',
        model: 'gemini-4-hydrogen',
        keySlot,
        category: 'command',
        promptTokens: Number(usage?.promptTokenCount || 0),
        completionTokens: Number(usage?.candidatesTokenCount || 0),
        totalTokens: tokensSpent,
      });

      let parsed = zeroDraft;
      try {
        const json = JSON.parse((gResp.text || '').trim()) as { subject?: string; body?: string };
        if (json.body?.trim()) {
          parsed = {
            subject: (json.subject || zeroDraft.subject).trim(),
            body: json.body.trim(),
          };
        }
      } catch {
        if (gResp.text?.trim()) {
          parsed = { subject: zeroDraft.subject, body: gResp.text.trim() };
        }
      }

      res.json({
        subject: parsed.subject,
        body: parsed.body,
        tokensSpent,
        providerUsed: `gemini_slot_${keySlot}`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/outreach/send-email', async (req: Request, res: Response) => {
    ensureTodayStats();
    const confirmedByUser = Boolean(req.body?.confirmedByUser);
    if (!confirmedByUser) {
      res.status(400).json({ error: 'Explicit user confirmation is required before sending emails.' });
      return;
    }

    const provider: OutreachEmailProvider =
      req.body?.provider &&
      ['gmail_oauth', 'smtp_profile', 'resend_http', 'brevo_http', 'custom_http'].includes(req.body.provider)
        ? req.body.provider
        : store.policy.preferredEmailProvider;

    const gmailToken =
      String(req.headers['x-gmail-access-token'] || req.body?.gmailAccessToken || '').trim();

    const activeSmtpSender = getActiveSmtpSender();
    if (provider === 'gmail_oauth' && !gmailToken) {
      res.status(401).json({
        error: 'Gmail Authorization টোকেন পাওয়া যায়নি। আগে "Connect Gmail" বাটনে ক্লিক করে অনুমতি দিন অথবা SMTP/App Password প্রোফাইল ব্যবহার করুন।',
      });
      return;
    }
    if (provider === 'smtp_profile' && !activeSmtpSender) {
      res.status(400).json({
        error: 'কোনো SMTP/Gmail App Password সেন্ডার অ্যাকাউন্ট সেট করা নেই। সেলফ-চ্যাটে ইমেইল ও ১৬ সংখ্যার App Password পাঠিয়ে যুক্ত করুন।',
      });
      return;
    }

    const subjectTemplate = String(req.body?.subject || '').trim();
    const bodyTemplate = String(req.body?.body || '').trim();
    if (!subjectTemplate || !bodyTemplate) {
      res.status(400).json({ error: 'Email Subject এবং Body উভয়ই প্রয়োজন।' });
      return;
    }

    const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as string[]) : [];
    const directEmail = String(req.body?.directEmail || '').trim().toLowerCase();

    const targets: Array<{ email: string; lead?: OutreachLeadItem }> = [];
    if (directEmail && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/i.test(directEmail)) {
      targets.push({ email: directEmail });
    }
    for (const lead of store.leads) {
      if (leadIds.length > 0 && !leadIds.includes(lead.id)) continue;
      for (const email of lead.emails) {
        if (!targets.some((t) => t.email === email)) {
          targets.push({ email, lead });
        }
      }
    }

    if (targets.length === 0) {
      res.status(400).json({ error: 'পাঠানোর জন্য কোনো বৈধ ইমেইল ঠিকানা সিলেক্ট করা হয়নি।' });
      return;
    }

    const remainingToday = Math.max(0, store.policy.dailyEmailLimit - store.dailyStats.emailsSentToday);
    if (remainingToday <= 0) {
      res.status(429).json({
        error: `আজকের দৈনিক ইমেইল সেফটি লিমিট (${store.policy.dailyEmailLimit}) পূর্ণ হয়ে গেছে।`,
      });
      return;
    }

    const batch = targets.slice(0, Math.min(remainingToday, 30));
    const cfg = adapters.getBotConfig();
    let sentCount = 0;
    let failedCount = 0;
    const results: Array<{ email: string; status: string; error?: string }> = [];

    for (let i = 0; i < batch.length; i += 1) {
      const target = batch[i];
      const leadName = target.lead?.name || target.email.split('@')[0];
      const domain = target.lead?.domain || target.email.split('@')[1] || '';
      const personalizedSubject = subjectTemplate
        .replace(/\{\{name\}\}/gi, leadName)
        .replace(/\{\{domain\}\}/gi, domain);
      const personalizedBody = bodyTemplate
        .replace(/\{\{name\}\}/gi, leadName)
        .replace(/\{\{domain\}\}/gi, domain);

      try {
        if (provider === 'gmail_oauth') {
          await sendEmailViaGmailOAuth({
            accessToken: gmailToken,
            to: target.email,
            subject: personalizedSubject,
            bodyText: personalizedBody,
          });
        } else if (provider === 'smtp_profile' && activeSmtpSender) {
          await sendEmailViaSmtpProfile({
            profile: activeSmtpSender,
            to: target.email,
            subject: personalizedSubject,
            bodyText: personalizedBody,
            ownerName: cfg.ownerName,
          });
        } else if (provider === 'resend_http') {
          await sendEmailViaResend({
            to: target.email,
            subject: personalizedSubject,
            bodyText: personalizedBody,
          });
        } else if (provider === 'brevo_http') {
          await sendEmailViaBrevo({
            to: target.email,
            subject: personalizedSubject,
            bodyText: personalizedBody,
            ownerName: cfg.ownerName,
          });
        } else {
          await sendEmailViaCustomWebhook({
            to: target.email,
            subject: personalizedSubject,
            bodyText: personalizedBody,
          });
        }

        sentCount += 1;
        store.dailyStats.emailsSentToday += 1;
        if (target.lead) {
          target.lead.emailSentCount += 1;
          target.lead.lastEmailSentAt = new Date().toISOString();
        }
        pushDispatchLog({
          channel: 'email',
          provider,
          recipient: target.email,
          leadName,
          subject: personalizedSubject.slice(0, 120),
          messagePreview: personalizedBody.slice(0, 140),
          status: 'sent',
          tokensSpent: 0,
        });
        results.push({ email: target.email, status: 'sent' });
      } catch (err) {
        const msg = (err as Error).message;
        failedCount += 1;
        pushDispatchLog({
          channel: 'email',
          provider,
          recipient: target.email,
          leadName,
          subject: personalizedSubject.slice(0, 120),
          messagePreview: personalizedBody.slice(0, 140),
          status: 'failed',
          error: msg.slice(0, 180),
          tokensSpent: 0,
        });
        results.push({ email: target.email, status: 'failed', error: msg });
      }

      if (i < batch.length - 1) {
        await new Promise((r) => setTimeout(r, Math.min(5000, store.policy.emailDelayMs)));
      }
    }

    saveStoreToDisk();
    adapters.pushLog(
      'system',
      `Email Outreach (${provider})`,
      `Sent ${sentCount}, Failed ${failedCount} (0 AI tokens)`,
      failedCount === 0 ? 'success' : 'info'
    );

    res.json({
      sentCount,
      failedCount,
      results,
      state: buildStateResponse(),
    });
  });

  app.post('/api/outreach/send-whatsapp', async (req: Request, res: Response) => {
    ensureTodayStats();
    const confirmedByUser = Boolean(req.body?.confirmedByUser);
    if (!confirmedByUser) {
      res.status(400).json({ error: 'Explicit user confirmation is required before WhatsApp outreach.' });
      return;
    }

    const sock = adapters.getSocket();
    if (!sock || adapters.getBotStatus() !== 'connected') {
      res.status(400).json({
        error: 'WhatsApp কানেক্টেড নেই। আগে Pairing & Status থেকে আপনার হোয়াটসঅ্যাপ পেয়ার করুন।',
      });
      return;
    }

    if (whatsappQueueState.active) {
      res.status(409).json({ error: 'একটি WhatsApp Outreach কিউ ইতিমধ্যেই চলছে। শেষ হওয়া পর্যন্ত অপেক্ষা করুন বা থামান।' });
      return;
    }

    const bodyTemplate = String(req.body?.body || '').trim();
    if (!bodyTemplate) {
      res.status(400).json({ error: 'WhatsApp message text cannot be empty.' });
      return;
    }

    const remainingToday = Math.max(
      0,
      store.policy.dailyWhatsappLimit - store.dailyStats.whatsappSentToday
    );
    if (remainingToday <= 0) {
      res.status(429).json({
        error: `আজকের দৈনিক WhatsApp অ্যান্টি-ব্যান লিমিট (${store.policy.dailyWhatsappLimit}) পূর্ণ হয়ে গেছে।`,
      });
      return;
    }

    const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as string[]) : [];
    const directPhone = normalizePhoneDigits(String(req.body?.directPhone || ''));
    const targets: Array<{ digits: string; lead?: OutreachLeadItem }> = [];

    if (directPhone) {
      targets.push({ digits: directPhone });
    }
    for (const lead of store.leads) {
      if (leadIds.length > 0 && !leadIds.includes(lead.id)) continue;
      const preferredList =
        lead.whatsappVerifiedPhones.length > 0 ? lead.whatsappVerifiedPhones : lead.phones;
      for (const phone of preferredList.slice(0, 1)) {
        const digits = normalizePhoneDigits(phone);
        if (digits && !targets.some((t) => t.digits === digits)) {
          targets.push({ digits, lead });
        }
      }
    }

    if (targets.length === 0) {
      res.status(400).json({ error: 'পাঠানোর জন্য কোনো বৈধ ফোন নম্বর সিলেক্ট করা হয়নি।' });
      return;
    }

    const queue = targets.slice(0, remainingToday);

    // Single target sends immediately; multi-target runs via anti-ban paced background queue
    if (queue.length === 1) {
      const target = queue[0];
      const leadName = target.lead?.name || formatPhoneDisplay(target.digits);
      const domain = target.lead?.domain || '';
      const messageText = bodyTemplate
        .replace(/\{\{name\}\}/gi, leadName)
        .replace(/\{\{domain\}\}/gi, domain);
      const jid = `${target.digits}@s.whatsapp.net`;

      try {
        await adapters.sendTrackedMessage(sock, jid, { text: messageText });
        store.dailyStats.whatsappSentToday += 1;
        if (target.lead) {
          target.lead.whatsappSentCount += 1;
          target.lead.lastWhatsappSentAt = new Date().toISOString();
          if (!target.lead.whatsappVerifiedPhones.includes(formatPhoneDisplay(target.digits))) {
            target.lead.whatsappVerifiedPhones.push(formatPhoneDisplay(target.digits));
          }
        }
        adapters.onLeadWhatsAppSent?.({
          phoneDigits: target.digits,
          jid,
          leadName,
          messageText,
          sourceUrl: target.lead?.sourceUrl || '',
        });
        pushDispatchLog({
          channel: 'whatsapp',
          provider: 'baileys_direct',
          recipient: formatPhoneDisplay(target.digits),
          leadName,
          messagePreview: messageText.slice(0, 140),
          status: 'sent',
          tokensSpent: 0,
        });
        saveStoreToDisk();
        res.json({ queued: false, sentCount: 1, state: buildStateResponse() });
      } catch (err) {
        const msg = (err as Error).message;
        pushDispatchLog({
          channel: 'whatsapp',
          provider: 'baileys_direct',
          recipient: formatPhoneDisplay(target.digits),
          leadName,
          messagePreview: messageText.slice(0, 140),
          status: 'failed',
          error: msg.slice(0, 180),
          tokensSpent: 0,
        });
        saveStoreToDisk();
        res.status(500).json({ error: msg, state: buildStateResponse() });
      }
      return;
    }

    // Background Anti-Ban Queue for multiple leads
    whatsappQueueState = {
      active: true,
      abortRequested: false,
      total: queue.length,
      processed: 0,
      sent: 0,
      failed: 0,
      currentRecipient: null,
      nextSendAt: null,
    };

    void (async () => {
      for (let i = 0; i < queue.length; i += 1) {
        if (whatsappQueueState.abortRequested) break;
        const liveSock = adapters.getSocket();
        if (!liveSock || adapters.getBotStatus() !== 'connected') break;

        const target = queue[i];
        const leadName = target.lead?.name || formatPhoneDisplay(target.digits);
        const domain = target.lead?.domain || '';
        const messageText = bodyTemplate
          .replace(/\{\{name\}\}/gi, leadName)
          .replace(/\{\{domain\}\}/gi, domain);
        const jid = `${target.digits}@s.whatsapp.net`;

        whatsappQueueState.currentRecipient = formatPhoneDisplay(target.digits);
        try {
          await adapters.sendTrackedMessage(liveSock, jid, { text: messageText });
          store.dailyStats.whatsappSentToday += 1;
          whatsappQueueState.sent += 1;
          if (target.lead) {
            target.lead.whatsappSentCount += 1;
            target.lead.lastWhatsappSentAt = new Date().toISOString();
          }
          adapters.onLeadWhatsAppSent?.({
            phoneDigits: target.digits,
            jid,
            leadName,
            messageText,
            sourceUrl: target.lead?.sourceUrl || '',
          });
          pushDispatchLog({
            channel: 'whatsapp',
            provider: 'baileys_antiban_queue',
            recipient: formatPhoneDisplay(target.digits),
            leadName,
            messagePreview: messageText.slice(0, 140),
            status: 'sent',
            tokensSpent: 0,
          });
        } catch (err) {
          whatsappQueueState.failed += 1;
          pushDispatchLog({
            channel: 'whatsapp',
            provider: 'baileys_antiban_queue',
            recipient: formatPhoneDisplay(target.digits),
            leadName,
            messagePreview: messageText.slice(0, 140),
            status: 'failed',
            error: (err as Error).message.slice(0, 180),
            tokensSpent: 0,
          });
        }

        whatsappQueueState.processed += 1;
        saveStoreToDisk();

        if (i < queue.length - 1 && !whatsappQueueState.abortRequested) {
          const minMs = store.policy.whatsappMinDelayMs;
          const maxMs = store.policy.whatsappMaxDelayMs;
          const delayMs = minMs + Math.floor(Math.random() * Math.max(1000, maxMs - minMs));
          whatsappQueueState.nextSendAt = new Date(Date.now() + delayMs).toISOString();
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      whatsappQueueState.active = false;
      whatsappQueueState.currentRecipient = null;
      whatsappQueueState.nextSendAt = null;
      adapters.pushLog(
        'system',
        'WA Outreach Queue',
        `Completed: ${whatsappQueueState.sent} sent, ${whatsappQueueState.failed} failed (0 tokens)`,
        'success'
      );
    })();

    res.json({
      queued: true,
      totalQueued: queue.length,
      state: buildStateResponse(),
    });
  });

  app.post('/api/outreach/whatsapp-queue/stop', (_req: Request, res: Response) => {
    if (whatsappQueueState.active) {
      whatsappQueueState.abortRequested = true;
    }
    res.json({ state: buildStateResponse() });
  });

  // Programmatic Outreach Controller for WhatsApp Self-Chat A-to-Z Remote Control
  const controller: WebOutreachController = {
    getSummary: () => {
      ensureTodayStats();
      return {
        policy: store.policy,
        stats: { ...store.dailyStats },
        totalLeads: store.leads.length,
        verifiedLeadsCount: store.leads.filter((l) => l.whatsappVerifiedPhones.length > 0).length,
        senders: emailSenders.map(toPublicSender),
        leads: store.leads.slice(0, 40),
        recentResearch: store.researchHistory.slice(0, 10),
        capabilities: getCapabilities(),
      };
    },
    runResearch: async ({ query, useAiSummary = false, maxSites }) => {
      const cleanQuery = query.trim();
      const limit = Math.max(1, Math.min(8, maxSites || store.policy.maxSitesPerSearch || 5));
      const cacheKey = `${cleanQuery.toLowerCase()}::${useAiSummary ? 'ai' : 'zero'}`;
      const cached = researchCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return { research: cached.payload, leads: cached.leads, fromCache: true };
      }

      let providerUsed: WebResearchHistoryItem['providerUsed'] = 'duckduckgo';
      let tokensSpent = 0;
      let discoveredUrls: { title: string; url: string; snippet: string }[] = [];
      let aiSynthesisText = '';

      const tavilyResults = await searchWithTavily(cleanQuery, limit);
      if (tavilyResults && tavilyResults.length > 0) {
        discoveredUrls = tavilyResults;
        providerUsed = 'tavily';
      } else {
        const serperResults = await searchWithSerper(cleanQuery, limit);
        if (serperResults && serperResults.length > 0) {
          discoveredUrls = serperResults;
          providerUsed = 'serper';
        } else {
          const ddgResults = await searchWithDuckDuckGoLite(cleanQuery, limit);
          if (ddgResults.length > 0) {
            discoveredUrls = ddgResults;
            providerUsed = 'duckduckgo';
          }
        }
      }

      if ((discoveredUrls.length === 0 || useAiSummary) && adapters.geminiPool.hasKeys()) {
        try {
          const { value: gResp, keySlot } = await adapters.geminiPool.executeWithRotation(
            (ai) =>
              ai.models.generateContent({
                model: 'gemini-4-hydrogen',
                contents:
                  discoveredUrls.length > 0
                    ? `নিচের টপিক ও ওয়েব রেজাল্টগুলো বিশ্লেষণ করে সংক্ষেপে (৪-৬ লাইনে) বাংলায় মূল তথ্য লিখুন:\nTopic: ${cleanQuery}\nSources:\n${discoveredUrls
                        .map((u, idx) => `${idx + 1}. ${u.title} (${u.url}): ${u.snippet}`)
                        .join('\n')}`
                    : `ওয়েব সার্চ করে "${cleanQuery}" সম্পর্কে নির্ভরযোগ্য সংক্ষিপ্ত বাংলা সারাংশ ও অফিসিয়াল ওয়েবসাইট লিংক দিন।`,
                config: {
                  tools: [{ googleSearch: {} }],
                  thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                },
              }),
            undefined,
            { maxTotalMs: 12_000, channel: 'primary' }
          );
          const usage = (gResp as {
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
          })?.usageMetadata;
          const totalTok = Number(usage?.totalTokenCount || 0);
          tokensSpent += totalTok;
          adapters.tokenTelemetry.recordUsage({
            provider: 'gemini',
            model: 'gemini-4-hydrogen',
            keySlot,
            category: 'summary',
            promptTokens: Number(usage?.promptTokenCount || 0),
            completionTokens: Number(usage?.candidatesTokenCount || 0),
            totalTokens: totalTok,
          });
          aiSynthesisText = (gResp.text || '').trim().slice(0, 1400);
          if (discoveredUrls.length === 0) {
            providerUsed = 'gemini_search';
            const chunks = (gResp as {
              candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> } }>;
            })?.candidates?.[0]?.groundingMetadata?.groundingChunks;
            if (Array.isArray(chunks)) {
              for (const c of chunks) {
                if (c.web?.uri && /^https?:\/\//i.test(c.web.uri)) {
                  discoveredUrls.push({
                    title: (c.web.title || c.web.uri).slice(0, 140),
                    url: c.web.uri,
                    snippet: '',
                  });
                }
                if (discoveredUrls.length >= limit) break;
              }
            }
          }
        } catch {
          // keep zero-token fallback
        }
      }

      const savedLeads: OutreachLeadItem[] = [];
      const enrichedSummaries: string[] = [];
      for (const site of discoveredUrls.slice(0, limit)) {
        try {
          const html = await fetchSafeHtml(site.url, 6_500, 300_000);
          const extracted = extractPageIntelligence(html, site.url);
          const allEmails = new Set(extracted.emails);
          const allPhones = new Set(extracted.phones);
          if (
            store.policy.crawlContactSubpages &&
            allEmails.size === 0 &&
            allPhones.size === 0 &&
            extracted.contactLinks.length > 0
          ) {
            for (const subUrl of extracted.contactLinks.slice(0, 1)) {
              try {
                const subHtml = await fetchSafeHtml(subUrl, 5_000, 200_000);
                const sub = extractPageIntelligence(subHtml, subUrl);
                sub.emails.forEach((e) => allEmails.add(e));
                sub.phones.forEach((p) => allPhones.add(p));
              } catch {
                // ignore
              }
            }
          }
          if (extracted.title) site.title = extracted.title;
          const lead = upsertLead({
            name: site.title || site.url,
            sourceUrl: site.url,
            topic: cleanQuery,
            emails: Array.from(allEmails),
            phones: Array.from(allPhones),
            snippet: extracted.description || site.snippet || extracted.cleanText.slice(0, 180),
          });
          savedLeads.push(lead);
          if (extracted.description || site.snippet) {
            enrichedSummaries.push(`• ${site.title}: ${(extracted.description || site.snippet).slice(0, 120)}`);
          }
        } catch {
          const lead = upsertLead({
            name: site.title || site.url,
            sourceUrl: site.url,
            topic: cleanQuery,
            emails: [],
            phones: [],
            snippet: site.snippet,
          });
          savedLeads.push(lead);
        }
      }

      const emailsFound = savedLeads.reduce((acc, l) => acc + l.emails.length, 0);
      const phonesFound = savedLeads.reduce((acc, l) => acc + l.phones.length, 0);
      const summary =
        aiSynthesisText ||
        (discoveredUrls.length > 0
          ? `${providerUsed.toUpperCase()} দিয়ে ${discoveredUrls.length}টি সাইট রিসার্চ সম্পন্ন (${tokensSpent} টোকেন)। মোট ${emailsFound}টি ইমেইল ও ${phonesFound}টি নম্বর পাওয়া গেছে।\n${enrichedSummaries.slice(0, 3).join('\n')}`
          : 'কোনো পাবলিক ওয়েবসাইট পাওয়া যায়নি। সরাসরি URL দিয়ে স্ক্যান করে দেখতে পারেন।');

      const research: WebResearchHistoryItem = {
        id: uid('res'),
        query: cleanQuery,
        providerUsed,
        tokensSpent,
        summary,
        urls: discoveredUrls,
        emailsFound,
        phonesFound,
        createdAt: new Date().toISOString(),
      };
      store.researchHistory.unshift(research);
      saveStoreToDisk();
      researchCache.set(cacheKey, { cachedAt: Date.now(), payload: research, leads: savedLeads });
      if (researchCache.size > MAX_CACHE_ITEMS) {
        const oldestKey = researchCache.keys().next().value;
        if (oldestKey) researchCache.delete(oldestKey);
      }
      adapters.pushLog('system', `Self-Chat Web Research (${providerUsed})`, `"${cleanQuery.slice(0, 40)}" -> ${emailsFound} emails, ${phonesFound} phones`, 'success');
      return { research, leads: savedLeads, fromCache: false };
    },
    scrapeUrls: async ({ urlsText, topic = 'Self-Chat URL Extract' }) => {
      const urlList = urlsText.split(/[\n,\s]+/).map((u) => u.trim()).filter(Boolean).slice(0, 6);
      const savedLeads: OutreachLeadItem[] = [];
      const errors: string[] = [];
      const scannedUrls: { title: string; url: string; snippet: string }[] = [];

      for (const rawUrl of urlList) {
        try {
          const safe = assertSafePublicHttpUrl(rawUrl);
          let html = '';
          let fetchedViaJina = false;
          try {
            html = await fetchSafeHtml(safe.toString());
          } catch (directErr) {
            const jinaText = await fetchViaJinaReader(safe.toString());
            if (!jinaText) throw directErr;
            html = jinaText;
            fetchedViaJina = true;
          }
          let extracted = extractPageIntelligence(html, safe.toString());
          const allEmails = new Set(extracted.emails);
          const allPhones = new Set(extracted.phones);
          // Fallback to Jina Reader for JS-rendered React/Next SPAs that returned empty shell
          if (!fetchedViaJina && allEmails.size === 0 && allPhones.size === 0 && extracted.cleanText.length < 180) {
            const jinaText = await fetchViaJinaReader(safe.toString());
            if (jinaText) {
              const jinaExtracted = extractPageIntelligence(jinaText, safe.toString());
              jinaExtracted.emails.forEach((e) => allEmails.add(e));
              jinaExtracted.phones.forEach((p) => allPhones.add(p));
              if (jinaExtracted.cleanText.length > extracted.cleanText.length) {
                extracted = {
                  ...extracted,
                  cleanText: jinaExtracted.cleanText,
                  title: extracted.title || jinaExtracted.title,
                  description: extracted.description || jinaExtracted.description,
                };
              }
            }
          }
          if (store.policy.crawlContactSubpages && extracted.contactLinks.length > 0) {
            for (const subUrl of extracted.contactLinks.slice(0, 2)) {
              try {
                const subHtml = await fetchSafeHtml(subUrl, 5_500, 220_000);
                const subData = extractPageIntelligence(subHtml, subUrl);
                subData.emails.forEach((e) => allEmails.add(e));
                subData.phones.forEach((p) => allPhones.add(p));
              } catch {
                // ignore
              }
            }
          }
          scannedUrls.push({
            title: extracted.title || safe.hostname,
            url: safe.toString(),
            snippet: extracted.description || extracted.cleanText.slice(0, 180),
          });
          savedLeads.push(
            upsertLead({
              name: extracted.title || safe.hostname,
              sourceUrl: safe.toString(),
              topic,
              emails: Array.from(allEmails),
              phones: Array.from(allPhones),
              snippet: extracted.description || extracted.cleanText.slice(0, 200),
            })
          );
        } catch (err) {
          errors.push(`${rawUrl}: ${(err as Error).message}`);
        }
      }

      const emailsFound = savedLeads.reduce((acc, l) => acc + l.emails.length, 0);
      const phonesFound = savedLeads.reduce((acc, l) => acc + l.phones.length, 0);
      const research: WebResearchHistoryItem = {
        id: uid('res'),
        query: urlList.join(', '),
        providerUsed: 'direct_url',
        tokensSpent: 0,
        summary: `০ টোকেনে ${scannedUrls.length}টি ওয়েবসাইট স্ক্যান সম্পন্ন: ${emailsFound}টি ইমেইল ও ${phonesFound}টি নম্বর সংগ্রহ হয়েছে।`,
        urls: scannedUrls,
        emailsFound,
        phonesFound,
        createdAt: new Date().toISOString(),
      };
      store.researchHistory.unshift(research);
      saveStoreToDisk();
      return { research, leads: savedLeads, errors };
    },
    verifyWhatsappLeads: async (leadIds = []) => {
      const sock = adapters.getSocket();
      if (!sock || adapters.getBotStatus() !== 'connected') {
        return { checkedCount: 0, activeFound: 0 };
      }
      const targets =
        leadIds.length > 0
          ? store.leads.filter((l) => leadIds.includes(l.id) && l.phones.length > 0)
          : store.leads.filter((l) => l.phones.length > 0 && !l.whatsappCheckedAt).slice(0, 20);
      let checkedCount = 0;
      let activeFound = 0;
      for (const lead of targets) {
        const verified: string[] = [];
        for (const phone of lead.phones.slice(0, 3)) {
          const digits = normalizePhoneDigits(phone);
          if (!digits) continue;
          try {
            const checkRes = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
            if (Array.isArray(checkRes) && checkRes.some((e) => e?.exists)) {
              verified.push(formatPhoneDisplay(digits));
              activeFound += 1;
            }
          } catch {
            // ignore
          }
          checkedCount += 1;
        }
        lead.whatsappVerifiedPhones = Array.from(new Set(verified));
        lead.whatsappCheckedAt = new Date().toISOString();
      }
      saveStoreToDisk();
      return { checkedCount, activeFound };
    },
    draftMessage: async ({ channel, topic = '', leadName = '', useAi = false }) => {
      const cfg = adapters.getBotConfig();
      const lead = store.leads[0];
      const finalLeadName = leadName || lead?.name || (channel === 'email' ? '{{name}}' : 'ভাইয়া/স্যার');
      const zeroDraft = buildZeroTokenOutreachDraft({
        channel,
        leadName: finalLeadName,
        domain: lead?.domain || '',
        topic: topic || lead?.topic || '',
        language: store.policy.defaultLanguage,
        ownerName: cfg.ownerName,
        ownerProfession: cfg.ownerProfession,
        offerPitch: store.policy.defaultOfferPitch,
      });

      if (!useAi || !adapters.geminiPool.hasKeys()) {
        return { ...zeroDraft, tokensSpent: 0, providerUsed: 'zero_token_template' };
      }

      try {
        const { value: gResp, keySlot } = await adapters.geminiPool.executeWithRotation(
          (ai) =>
            ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: `Write a natural, concise ${channel === 'email' ? 'business email (with Subject and Body)' : 'WhatsApp intro message (max 3 lines)'} in Bengali for topic "${topic || 'business offer'}".\nSender: ${cfg.ownerName} (${cfg.ownerProfession})\nOffer: ${store.policy.defaultOfferPitch}\nReturn strictly JSON: {"subject":"...","body":"..."}`,
              config: {
                responseMimeType: 'application/json',
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              },
            }),
          undefined,
          { maxTotalMs: 9_000, channel: 'primary' }
        );
        const usage = (gResp as {
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
        })?.usageMetadata;
        const tok = Number(usage?.totalTokenCount || 0);
        adapters.tokenTelemetry.recordUsage({
          provider: 'gemini',
          model: 'gemini-4-hydrogen',
          keySlot,
          category: 'command',
          promptTokens: Number(usage?.promptTokenCount || 0),
          completionTokens: Number(usage?.candidatesTokenCount || 0),
          totalTokens: tok,
        });
        const json = JSON.parse((gResp.text || '').trim()) as { subject?: string; body?: string };
        return {
          subject: (json.subject || zeroDraft.subject).trim(),
          body: (json.body || zeroDraft.body).trim(),
          tokensSpent: tok,
          providerUsed: `gemini_slot_${keySlot}`,
        };
      } catch {
        return { ...zeroDraft, tokensSpent: 0, providerUsed: 'zero_token_template' };
      }
    },
    addAndActivateEmailSender: ({ email, secret, deletePrevious = false, host, port }) => {
      const cleanEmail = email.trim().toLowerCase();
      const cleanSecret = secret.trim();
      const smtpDefaults = resolveSmtpDefaultsForEmail(cleanEmail, host, port);
      const compactPass = cleanSecret.replace(/\s+/g, '');
      const isLikelyAppPassword =
        smtpDefaults.type !== 'smtp_gmail' || compactPass.length === 16;

      let deletedCount = 0;
      if (deletePrevious) {
        deletedCount = emailSenders.filter((s) => s.email !== cleanEmail).length;
        emailSenders = [];
      } else {
        emailSenders = emailSenders
          .filter((s) => s.email !== cleanEmail)
          .map((s) => ({ ...s, active: false }));
      }

      const newProfile: StoredEmailSenderProfile = {
        id: uid('snd'),
        email: cleanEmail,
        label: cleanEmail,
        type: smtpDefaults.type,
        host: smtpDefaults.host,
        port: smtpDefaults.port,
        secure: smtpDefaults.secure,
        secret: smtpDefaults.type === 'smtp_gmail' ? compactPass : cleanSecret,
        active: true,
        hasSecret: true,
        maskedSecret: maskSecret(compactPass),
        createdAt: new Date().toISOString(),
      };
      emailSenders.unshift(newProfile);
      store.policy.preferredEmailProvider = 'smtp_profile';
      saveSendersToDisk();
      saveStoreToDisk();

      adapters.pushLog(
        'system',
        'Self-Chat Email Profile',
        `Activated sender ${cleanEmail}${deletedCount > 0 ? ` (removed ${deletedCount} previous)` : ''}`,
        'success'
      );

      return {
        profile: toPublicSender(newProfile),
        deletedCount,
        isLikelyAppPassword,
        warning:
          !isLikelyAppPassword
            ? 'সতর্কতা: আপনার দেওয়া পাসওয়ার্ডটি ১৬ অক্ষরের Google App Password নয় বলে মনে হচ্ছে। সাধারণ জিমেইল পাসওয়ার্ড Google ব্লক করে — কাজ না করলে Google Account -> Security -> App Passwords থেকে ১৬ সংখ্যার কোড দিন।'
            : undefined,
      };
    },
    switchEmailSender: (emailOrId: string) => {
      const q = emailOrId.trim().toLowerCase();
      const match = emailSenders.find(
        (s) => s.id.toLowerCase() === q || s.email.toLowerCase() === q
      );
      if (!match) return null;
      emailSenders = emailSenders.map((s) => ({ ...s, active: s.id === match.id }));
      store.policy.preferredEmailProvider = 'smtp_profile';
      saveSendersToDisk();
      saveStoreToDisk();
      return toPublicSender({ ...match, active: true });
    },
    deleteEmailSender: (emailOrIdOrAll: string) => {
      const q = emailOrIdOrAll.trim().toLowerCase();
      const before = emailSenders.length;
      if (q === 'all') {
        emailSenders = [];
      } else if (q === 'previous' || q === 'old') {
        const active = getActiveSmtpSender();
        emailSenders = active ? [active] : [];
      } else {
        emailSenders = emailSenders.filter(
          (s) => s.id.toLowerCase() !== q && s.email.toLowerCase() !== q
        );
      }
      if (emailSenders.length > 0 && !emailSenders.some((s) => s.active)) {
        emailSenders[0].active = true;
      }
      if (emailSenders.length === 0 && store.policy.preferredEmailProvider === 'smtp_profile') {
        store.policy.preferredEmailProvider = 'gmail_oauth';
      }
      saveSendersToDisk();
      saveStoreToDisk();
      return {
        removedCount: Math.max(0, before - emailSenders.length),
        remaining: emailSenders.map(toPublicSender),
      };
    },
    listEmailSenders: () => emailSenders.map(toPublicSender),
    sendEmailOutreach: async ({
      subject,
      body,
      directEmails = [],
      useCollectedLeads = true,
      maxCount = 15,
      provider,
    }) => {
      ensureTodayStats();
      const activeSmtp = getActiveSmtpSender();
      let selectedProvider: OutreachEmailProvider = provider || store.policy.preferredEmailProvider;
      if (selectedProvider === 'gmail_oauth') {
        if (activeSmtp) selectedProvider = 'smtp_profile';
        else if (process.env.RESEND_API_KEY?.trim()) selectedProvider = 'resend_http';
        else if (process.env.BREVO_API_KEY?.trim() && process.env.BREVO_FROM_EMAIL?.trim()) selectedProvider = 'brevo_http';
        else if (process.env.CUSTOM_EMAIL_WEBHOOK_URL?.trim()) selectedProvider = 'custom_http';
      }

      if (selectedProvider === 'gmail_oauth') {
        return {
          sentCount: 0,
          failedCount: 0,
          providerUsed: 'none',
          results: [],
          error:
            'সেলফ-চ্যাট থেকে ব্যাকগ্রাউন্ডে ইমেইল পাঠাতে আপনার ইমেইল ও ১৬ সংখ্যার Google App Password দিন (উদাহরণ: "আমার ইমেইল abc@gmail.com পাসওয়ার্ড xxxx xxxx xxxx xxxx দিয়ে সেট করো"), অথবা ড্যাশবোর্ডে Gmail Connect / Resend ব্যবহার করুন।',
        };
      }
      if (selectedProvider === 'smtp_profile' && !activeSmtp) {
        return {
          sentCount: 0,
          failedCount: 0,
          providerUsed: 'smtp_profile',
          results: [],
          error: 'কোনো অ্যাক্টিভ ইমেইল সেন্ডার প্রোফাইল নেই। আগে ইমেইল ও App Password দিয়ে সেট করুন।',
        };
      }

      const targets: Array<{ email: string; lead?: OutreachLeadItem }> = [];
      for (const rawE of directEmails) {
        const e = rawE.trim().toLowerCase();
        if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,12}$/i.test(e) && !targets.some((t) => t.email === e)) {
          targets.push({ email: e });
        }
      }
      if (useCollectedLeads) {
        for (const lead of store.leads) {
          for (const email of lead.emails) {
            if (!targets.some((t) => t.email === email)) {
              targets.push({ email, lead });
            }
          }
        }
      }
      if (targets.length === 0) {
        return {
          sentCount: 0,
          failedCount: 0,
          providerUsed: selectedProvider,
          results: [],
          error: 'পাঠানোর জন্য কোনো টার্গেট ইমেইল পাওয়া যায়নি। আগে "ওয়েব সার্চ করো ..." দিয়ে লিড সংগ্রহ করুন অথবা প্রাপকের ইমেইল উল্লেখ করুন।',
        };
      }

      const remainingToday = Math.max(0, store.policy.dailyEmailLimit - store.dailyStats.emailsSentToday);
      if (remainingToday <= 0) {
        return {
          sentCount: 0,
          failedCount: 0,
          providerUsed: selectedProvider,
          results: [],
          error: `আজকের দৈনিক ইমেইল সেফটি লিমিট (${store.policy.dailyEmailLimit}) পূর্ণ হয়ে গেছে।`,
        };
      }

      const batch = targets.slice(0, Math.min(remainingToday, maxCount));
      const cfg = adapters.getBotConfig();
      let sentCount = 0;
      let failedCount = 0;
      const results: Array<{ email: string; status: string; error?: string }> = [];

      for (let i = 0; i < batch.length; i += 1) {
        const target = batch[i];
        const leadName = target.lead?.name || target.email.split('@')[0];
        const domain = target.lead?.domain || target.email.split('@')[1] || '';
        const pSubject = subject.replace(/\{\{name\}\}/gi, leadName).replace(/\{\{domain\}\}/gi, domain);
        const pBody = body.replace(/\{\{name\}\}/gi, leadName).replace(/\{\{domain\}\}/gi, domain);

        try {
          if (selectedProvider === 'smtp_profile' && activeSmtp) {
            await sendEmailViaSmtpProfile({
              profile: activeSmtp,
              to: target.email,
              subject: pSubject,
              bodyText: pBody,
              ownerName: cfg.ownerName,
            });
          } else if (selectedProvider === 'resend_http') {
            await sendEmailViaResend({ to: target.email, subject: pSubject, bodyText: pBody });
          } else if (selectedProvider === 'brevo_http') {
            await sendEmailViaBrevo({
              to: target.email,
              subject: pSubject,
              bodyText: pBody,
              ownerName: cfg.ownerName,
            });
          } else {
            await sendEmailViaCustomWebhook({ to: target.email, subject: pSubject, bodyText: pBody });
          }
          sentCount += 1;
          store.dailyStats.emailsSentToday += 1;
          if (target.lead) {
            target.lead.emailSentCount += 1;
            target.lead.lastEmailSentAt = new Date().toISOString();
          }
          pushDispatchLog({
            channel: 'email',
            provider: selectedProvider === 'smtp_profile' ? `smtp:${activeSmtp?.email}` : selectedProvider,
            recipient: target.email,
            leadName,
            subject: pSubject.slice(0, 120),
            messagePreview: pBody.slice(0, 140),
            status: 'sent',
            tokensSpent: 0,
          });
          results.push({ email: target.email, status: 'sent' });
        } catch (err) {
          const msg = (err as Error).message;
          failedCount += 1;
          pushDispatchLog({
            channel: 'email',
            provider: selectedProvider,
            recipient: target.email,
            leadName,
            subject: pSubject.slice(0, 120),
            messagePreview: pBody.slice(0, 140),
            status: 'failed',
            error: msg.slice(0, 180),
            tokensSpent: 0,
          });
          results.push({ email: target.email, status: 'failed', error: msg });
        }

        if (i < batch.length - 1) {
          await new Promise((r) => setTimeout(r, Math.min(2500, store.policy.emailDelayMs)));
        }
      }
      saveStoreToDisk();
      return {
        sentCount,
        failedCount,
        providerUsed: activeSmtp && selectedProvider === 'smtp_profile' ? activeSmtp.email : selectedProvider,
        results,
      };
    },
    sendWhatsappOutreach: async ({
      body,
      excludePhones = [],
      directPhones = [],
      useCollectedLeads = true,
      maxCount = 15,
    }) => {
      ensureTodayStats();
      const sock = adapters.getSocket();
      if (!sock || adapters.getBotStatus() !== 'connected') {
        return {
          queued: false,
          sentCount: 0,
          totalTargets: 0,
          skippedMuted: 0,
          error: 'WhatsApp কানেক্টেড নেই। আগে হোয়াটসঅ্যাপ কানেক্ট করুন।',
        };
      }
      if (whatsappQueueState.active) {
        return {
          queued: false,
          sentCount: 0,
          totalTargets: 0,
          skippedMuted: 0,
          error: 'আগে থেকেই একটি WhatsApp Queue চলছে।',
        };
      }
      const excludeSuffixes = new Set(
        excludePhones.map((p) => normalizePhoneDigits(p).slice(-10)).filter((s) => s.length >= 7)
      );
      let skippedMuted = 0;
      const targets: Array<{ digits: string; lead?: OutreachLeadItem }> = [];

      for (const dp of directPhones) {
        const digits = normalizePhoneDigits(dp);
        if (!digits) continue;
        if (excludeSuffixes.has(digits.slice(-10))) {
          skippedMuted += 1;
          continue;
        }
        if (!targets.some((t) => t.digits === digits)) {
          targets.push({ digits });
        }
      }

      if (useCollectedLeads) {
        for (const lead of store.leads) {
          const preferred = lead.whatsappVerifiedPhones.length > 0 ? lead.whatsappVerifiedPhones : lead.phones;
          for (const ph of preferred.slice(0, 1)) {
            const digits = normalizePhoneDigits(ph);
            if (!digits) continue;
            if (excludeSuffixes.has(digits.slice(-10))) {
              skippedMuted += 1;
              continue;
            }
            if (!targets.some((t) => t.digits === digits)) {
              targets.push({ digits, lead });
            }
          }
        }
      }

      if (targets.length === 0) {
        return {
          queued: false,
          sentCount: 0,
          totalTargets: 0,
          skippedMuted,
          error: 'পাঠানোর মতো কোনো বৈধ (এবং নন-এক্সক্লুডেড) ফোন নাম্বার পাওয়া যায়নি।',
        };
      }

      const remaining = Math.max(0, store.policy.dailyWhatsappLimit - store.dailyStats.whatsappSentToday);
      if (remaining <= 0) {
        return {
          queued: false,
          sentCount: 0,
          totalTargets: targets.length,
          skippedMuted,
          error: `আজকের WhatsApp ডেইলি সেফটি লিমিট (${store.policy.dailyWhatsappLimit}) পূর্ণ হয়েছে।`,
        };
      }

      const queue = targets.slice(0, Math.min(remaining, maxCount));
      if (queue.length === 1) {
        const t = queue[0];
        const leadName = t.lead?.name || formatPhoneDisplay(t.digits);
        const msg = body.replace(/\{\{name\}\}/gi, leadName).replace(/\{\{domain\}\}/gi, t.lead?.domain || '');
        const jid = `${t.digits}@s.whatsapp.net`;
        await adapters.sendTrackedMessage(sock, jid, { text: msg });
        store.dailyStats.whatsappSentToday += 1;
        if (t.lead) {
          t.lead.whatsappSentCount += 1;
          t.lead.lastWhatsappSentAt = new Date().toISOString();
        }
        adapters.onLeadWhatsAppSent?.({
          phoneDigits: t.digits,
          jid,
          leadName,
          messageText: msg,
          sourceUrl: t.lead?.sourceUrl || '',
        });
        pushDispatchLog({
          channel: 'whatsapp',
          provider: 'self_chat_outreach',
          recipient: formatPhoneDisplay(t.digits),
          leadName,
          messagePreview: msg.slice(0, 140),
          status: 'sent',
          tokensSpent: 0,
        });
        saveStoreToDisk();
        return { queued: false, sentCount: 1, totalTargets: 1, skippedMuted };
      }

      whatsappQueueState = {
        active: true,
        abortRequested: false,
        total: queue.length,
        processed: 0,
        sent: 0,
        failed: 0,
        currentRecipient: null,
        nextSendAt: null,
      };
      void (async () => {
        for (let i = 0; i < queue.length; i += 1) {
          if (whatsappQueueState.abortRequested) break;
          const liveSock = adapters.getSocket();
          if (!liveSock || adapters.getBotStatus() !== 'connected') break;
          const t = queue[i];
          const leadName = t.lead?.name || formatPhoneDisplay(t.digits);
          const msg = body.replace(/\{\{name\}\}/gi, leadName).replace(/\{\{domain\}\}/gi, t.lead?.domain || '');
          const jid = `${t.digits}@s.whatsapp.net`;
          whatsappQueueState.currentRecipient = formatPhoneDisplay(t.digits);
          try {
            await adapters.sendTrackedMessage(liveSock, jid, { text: msg });
            store.dailyStats.whatsappSentToday += 1;
            whatsappQueueState.sent += 1;
            if (t.lead) {
              t.lead.whatsappSentCount += 1;
              t.lead.lastWhatsappSentAt = new Date().toISOString();
            }
            pushDispatchLog({
              channel: 'whatsapp',
              provider: 'self_chat_antiban_queue',
              recipient: formatPhoneDisplay(t.digits),
              leadName,
              messagePreview: msg.slice(0, 140),
              status: 'sent',
              tokensSpent: 0,
            });
          } catch (err) {
            whatsappQueueState.failed += 1;
            pushDispatchLog({
              channel: 'whatsapp',
              provider: 'self_chat_antiban_queue',
              recipient: formatPhoneDisplay(t.digits),
              leadName,
              messagePreview: msg.slice(0, 140),
              status: 'failed',
              error: (err as Error).message.slice(0, 180),
              tokensSpent: 0,
            });
          }
          whatsappQueueState.processed += 1;
          saveStoreToDisk();
          if (i < queue.length - 1 && !whatsappQueueState.abortRequested) {
            const minMs = store.policy.whatsappMinDelayMs;
            const maxMs = store.policy.whatsappMaxDelayMs;
            const delayMs = minMs + Math.floor(Math.random() * Math.max(1000, maxMs - minMs));
            whatsappQueueState.nextSendAt = new Date(Date.now() + delayMs).toISOString();
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        whatsappQueueState.active = false;
        whatsappQueueState.currentRecipient = null;
        whatsappQueueState.nextSendAt = null;
      })();

      return { queued: true, sentCount: 0, totalTargets: queue.length, skippedMuted };
    },
    updatePolicy: (patch) => {
      store.policy = { ...store.policy, ...patch };
      saveStoreToDisk();
      return store.policy;
    },
    ingestExternalLead: (params) => {
      return upsertLead({
        name: params.name || params.sourceUrl,
        sourceUrl: params.sourceUrl,
        topic: params.topic || 'Mobile PWA Offload',
        emails: params.emails || [],
        phones: params.phones || [],
        snippet: params.snippet || '',
      });
    },
    clearLeads: () => {
      const count = store.leads.length;
      store.leads = [];
      saveStoreToDisk();
      return count;
    },
  };

  return controller;
}
