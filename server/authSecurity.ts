import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const IS_SERVERLESS = Boolean(
  process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.LAMBDA_TASK_ROOT
);
const RUNTIME_DIR = IS_SERVERLESS ? '/tmp' : '.';
const SECURITY_FILE = path.resolve(RUNTIME_DIR, 'bot-security.json');
const CONFIG_JSON_PATH = path.resolve('./firebase-applet-config.json');

export const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'ifxnoteedge81@gmail.com').trim().toLowerCase();

interface StoredSecurityState {
  secretKey: string;
  pinHash?: string;
  pinUpdatedAt?: string;
}

interface RateLimitBucket {
  failures: number;
  lockedUntil: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();
const usedChallengeNonces = new Set<string>();

function loadSecurityState(): StoredSecurityState {
  try {
    if (fs.existsSync(SECURITY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8')) as Partial<StoredSecurityState>;
      if (parsed.secretKey && parsed.secretKey.length >= 32) {
        return {
          secretKey: parsed.secretKey,
          pinHash: parsed.pinHash,
          pinUpdatedAt: parsed.pinUpdatedAt,
        };
      }
    }
  } catch {
    // regenerate clean security state below
  }

  const fresh: StoredSecurityState = {
    secretKey: crypto.randomBytes(32).toString('hex'),
  };
  try {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(fresh, null, 2), 'utf8');
  } catch {
    // ignore read-only disk environments
  }
  return fresh;
}

let securityState: StoredSecurityState = loadSecurityState();

function persistSecurityState() {
  try {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(securityState, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AuthSecurity] Could not persist security file:', (err as Error).message);
  }
}

function getSigningSecret(): string {
  const explicit = process.env.DASHBOARD_AUTH_SECRET?.trim();
  if (explicit) return explicit;
  const seed =
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GEMINI_API_KEY_1?.trim();
  if (IS_SERVERLESS && seed) {
    return crypto.createHmac('sha256', seed).update('wanexus-serverless-auth-secret').digest('hex');
  }
  return securityState.secretKey;
}

function loadFirebaseWebApiKey(): string {
  try {
    if (fs.existsSync(CONFIG_JSON_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_JSON_PATH, 'utf8')) as { apiKey?: string };
      if (cfg.apiKey) return cfg.apiKey;
    }
  } catch {
    // ignore
  }
  return '';
}

function signPayload(payloadObj: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySignedToken<T extends Record<string, unknown>>(token: string): T | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as T & {
      exp?: number;
    };
    if (typeof decoded.exp === 'number' && Date.now() > decoded.exp) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPinHash(pin: string, storedHash: string): boolean {
  const [salt, hexHash] = storedHash.split(':');
  if (!salt || !hexHash) return false;
  const derived = crypto.scryptSync(pin, salt, 64);
  const original = Buffer.from(hexHash, 'hex');
  if (derived.length !== original.length) return false;
  return crypto.timingSafeEqual(derived, original);
}

export function isPinConfigured(): boolean {
  return Boolean(process.env.DASHBOARD_PIN?.trim() || securityState.pinHash);
}

export function verifyConfiguredPin(candidatePin: string): boolean {
  const cleaned = candidatePin.trim();
  if (!cleaned) return false;
  if (securityState.pinHash) {
    return verifyPinHash(cleaned, securityState.pinHash);
  }
  const envPin = process.env.DASHBOARD_PIN?.trim();
  if (envPin) {
    const a = Buffer.from(cleaned, 'utf8');
    const b = Buffer.from(envPin, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}

export function setCustomDashboardPin(newPin: string) {
  const cleaned = newPin.trim();
  if (!/^\d{4,8}$/.test(cleaned)) {
    throw new Error('Security PIN must be 4 to 8 numeric digits.');
  }
  securityState.pinHash = hashPin(cleaned);
  securityState.pinUpdatedAt = new Date().toISOString();
  persistSecurityState();
}

export function clearCustomDashboardPin() {
  delete securityState.pinHash;
  securityState.pinUpdatedAt = new Date().toISOString();
  persistSecurityState();
}

export function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function pruneExpiredRateLimits() {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitMap.entries()) {
    if (bucket.lockedUntil > 0 && bucket.lockedUntil <= now) {
      rateLimitMap.delete(ip);
    }
  }
  if (rateLimitMap.size > 1000) {
    const excess = rateLimitMap.size - 500;
    let removed = 0;
    for (const key of rateLimitMap.keys()) {
      rateLimitMap.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }
}

export function checkRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const bucket = rateLimitMap.get(ip);
  if (!bucket) return { allowed: true, retryAfterSec: 0 };
  if (bucket.lockedUntil > Date.now()) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((bucket.lockedUntil - Date.now()) / 1000),
    };
  }
  if (bucket.lockedUntil > 0 && bucket.lockedUntil <= Date.now()) {
    rateLimitMap.delete(ip);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordAuthFailure(ip: string): { locked: boolean; attemptsLeft: number } {
  if (rateLimitMap.size > 500) {
    pruneExpiredRateLimits();
  }
  const existing = rateLimitMap.get(ip) || { failures: 0, lockedUntil: 0 };
  const failures = existing.failures + 1;
  if (failures >= 5) {
    rateLimitMap.set(ip, { failures, lockedUntil: Date.now() + 5 * 60 * 1000 });
    return { locked: true, attemptsLeft: 0 };
  }
  rateLimitMap.set(ip, { failures, lockedUntil: 0 });
  return { locked: false, attemptsLeft: 5 - failures };
}

export function clearRateLimit(ip: string) {
  rateLimitMap.delete(ip);
}

export function createMathChallenge(): { question: string; challengeToken: string } {
  const a = 3 + crypto.randomInt(15);
  const b = 2 + crypto.randomInt(12);
  const nonce = crypto.randomBytes(8).toString('hex');
  const challengeToken = signPayload({
    type: 'challenge',
    expected: a + b,
    nonce,
    exp: Date.now() + 5 * 60 * 1000,
  });
  return {
    question: `${a} + ${b} = ?`,
    challengeToken,
  };
}

export function verifyMathChallenge(challengeToken: string, answer: string | number): boolean {
  const decoded = verifySignedToken<{ type?: string; expected?: number; nonce?: string }>(challengeToken);
  if (!decoded || decoded.type !== 'challenge' || typeof decoded.expected !== 'number' || !decoded.nonce) {
    return false;
  }
  if (usedChallengeNonces.has(decoded.nonce)) {
    return false;
  }
  const numericAnswer = Number(String(answer).trim());
  if (!Number.isFinite(numericAnswer) || numericAnswer !== decoded.expected) {
    return false;
  }
  usedChallengeNonces.add(decoded.nonce);
  if (usedChallengeNonces.size > 500) {
    const first = usedChallengeNonces.values().next().value;
    if (first) usedChallengeNonces.delete(first);
  }
  return true;
}

export function issueSessionToken(email: string): string {
  return signPayload({
    type: 'session',
    email: email.toLowerCase(),
    exp: Date.now() + 12 * 60 * 60 * 1000, // 12 hours
  });
}

export function issuePreAuthToken(email: string): string {
  return signPayload({
    type: 'preauth',
    email: email.toLowerCase(),
    exp: Date.now() + 5 * 60 * 1000, // 5 minutes to complete 2FA PIN
  });
}

export function verifyPreAuthToken(token: string): string | null {
  const decoded = verifySignedToken<{ type?: string; email?: string }>(token);
  if (!decoded || decoded.type !== 'preauth' || !decoded.email) return null;
  if (decoded.email.toLowerCase() !== OWNER_EMAIL) return null;
  return decoded.email.toLowerCase();
}

export function verifySessionToken(token: string): { email: string } | null {
  const decoded = verifySignedToken<{ type?: string; email?: string }>(token);
  if (!decoded || decoded.type !== 'session' || !decoded.email) return null;
  if (decoded.email.toLowerCase() !== OWNER_EMAIL) return null;
  return { email: decoded.email.toLowerCase() };
}

export async function verifyGoogleFirebaseIdToken(
  idToken: string
): Promise<{ email: string; emailVerified: boolean }> {
  if (!idToken || idToken.length < 20) {
    throw new Error('Missing Google Firebase ID token.');
  }

  // 1. Prefer Firebase Admin Auth when initialized (loaded dynamically so jwks-rsa/jose never breaks startup)
  try {
    const { getApps } = await import('firebase-admin/app');
    if (getApps().length > 0) {
      const { getAuth } = await import('firebase-admin/auth');
      const decoded = await getAuth(getApps()[0]).verifyIdToken(idToken);
      const email = (decoded.email || '').toLowerCase();
      return {
        email,
        emailVerified: Boolean(decoded.email_verified),
      };
    }
  } catch {
    // fall back to Identity Toolkit REST lookup below
  }

  // 2. Fallback: Verify token directly against Google Identity Toolkit REST API
  const apiKey = loadFirebaseWebApiKey();
  if (!apiKey) {
    throw new Error('Firebase Web API key missing for Google token verification.');
  }

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );

  if (!resp.ok) {
    throw new Error('Invalid or expired Google sign-in token.');
  }

  const json = (await resp.json()) as {
    users?: Array<{ email?: string; emailVerified?: boolean }>;
  };
  const user = json.users?.[0];
  if (!user?.email) {
    throw new Error('Could not verify Google account identity.');
  }

  return {
    email: user.email.toLowerCase(),
    emailVerified: Boolean(user.emailVerified),
  };
}

export function requireOwnerAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verified = verifySessionToken(bearer);
  if (!verified) {
    res.status(401).json({
      error: 'Dashboard locked. Owner authentication required.',
      code: 'AUTH_REQUIRED',
    });
    return;
  }
  (req as Request & { ownerEmail?: string }).ownerEmail = verified.email;
  next();
}
