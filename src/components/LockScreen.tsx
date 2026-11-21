import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, KeyRound, Lock, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { signInWithGoogle, signOutFirebase } from '../lib/firebase';
import { setStoredSession } from '../lib/api';

interface LockScreenProps {
  onUnlocked: (email: string) => void;
}

interface TelegramWebAppApi {
  initData?: string;
  initDataUnsafe?: {
    user?: {
      id?: number;
      first_name?: string;
      username?: string;
    };
  };
  ready?: () => void;
  expand?: () => void;
  openLink?: (url: string) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppApi;
    };
    TelegramWebviewProxy?: unknown;
  }
}

type AuthMode = 'telegram' | 'pin' | 'google';

export function LockScreen({ onUnlocked }: LockScreenProps) {
  const [ownerEmailHint, setOwnerEmailHint] = useState('ifxnoteedge81@gmail.com');
  const [pinConfigured, setPinConfigured] = useState(false);
  const [telegramBotConfigured, setTelegramBotConfigured] = useState(false);
  const [telegramOwnerConfigured, setTelegramOwnerConfigured] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('google');
  const userSelectedModeRef = useRef(false);

  const [tgInitData, setTgInitData] = useState('');
  const [tgUserLabel, setTgUserLabel] = useState('');
  const [isTelegramContext, setIsTelegramContext] = useState(false);

  const [challengeQuestion, setChallengeQuestion] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [challengeAnswer, setChallengeAnswer] = useState('');

  const [preAuthToken, setPreAuthToken] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    try {
      webApp?.ready?.();
      webApp?.expand?.();
    } catch {
      // ignore non-Telegram environments
    }

    const initData = String(webApp?.initData || '').trim();
    const inTgBrowser = Boolean(
      initData ||
        window.TelegramWebviewProxy ||
        /Telegram/i.test(navigator.userAgent || '')
    );
    setTgInitData(initData);
    setIsTelegramContext(inTgBrowser);

    const tgUser = webApp?.initDataUnsafe?.user;
    if (tgUser?.first_name || tgUser?.username || tgUser?.id) {
      const handle = tgUser.username ? `@${tgUser.username}` : `ID ${tgUser.id}`;
      setTgUserLabel(`${tgUser.first_name || 'Owner'} (${handle})`);
    }
  }, []);

  const loadChallengeAndStatus = useCallback(async () => {
    try {
      const [statusRes, challengeRes] = await Promise.all([
        fetch('/api/auth/status'),
        fetch('/api/auth/challenge'),
      ]);

      let nextPinConfigured = false;
      let nextTgBot = false;
      let nextTgOwner = false;

      if (statusRes.ok) {
        const sData = await statusRes.json().catch(() => ({}));
        if (sData.ownerEmail) setOwnerEmailHint(sData.ownerEmail);
        nextPinConfigured = Boolean(sData.pinConfigured);
        nextTgBot = Boolean(sData.telegramBotConfigured);
        nextTgOwner = Boolean(sData.telegramOwnerConfigured);
        setPinConfigured(nextPinConfigured);
        setTelegramBotConfigured(nextTgBot);
        setTelegramOwnerConfigured(nextTgOwner);
      }

      const initData = String(window.Telegram?.WebApp?.initData || '').trim();
      const inTg = Boolean(
        initData ||
          window.TelegramWebviewProxy ||
          /Telegram/i.test(navigator.userAgent || '')
      );

      if (!userSelectedModeRef.current && inTg) {
        if (initData && nextTgBot && nextTgOwner) {
          setAuthMode('telegram');
        } else if (nextPinConfigured) {
          setAuthMode('pin');
        } else if (initData) {
          setAuthMode('telegram');
        }
      }

      if (challengeRes.ok) {
        const cData = await challengeRes.json().catch(() => ({}));
        if (cData.question && cData.challengeToken) {
          setChallengeQuestion(cData.question);
          setChallengeToken(cData.challengeToken);
          setChallengeAnswer('');
          setError(null);
        } else {
          setError('Security challenge response was invalid. Tap Refresh to retry.');
        }
      } else if (challengeRes.status === 401) {
        setError(
          'HTTP 401 from hosting edge: Netlify Visitor Access / Site Protection is enabled and blocking /api/*. Set Visitor Access to Public in Netlify -> Site configuration -> Access & security -> Visitor access.'
        );
      } else {
        setError(`Security server returned HTTP ${challengeRes.status}. Tap Refresh to retry.`);
      }
    } catch {
      setError('Could not connect to security verification server.');
    }
  }, []);

  useEffect(() => {
    void loadChallengeAndStatus();
  }, [loadChallengeAndStatus]);

  async function refreshChallengeOnly() {
    try {
      const res = await fetch('/api/auth/challenge');
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.question && data.challengeToken) {
          setChallengeQuestion(data.question);
          setChallengeToken(data.challengeToken);
          setChallengeAnswer('');
          setError(null);
          return;
        }
      }
      if (res.status === 401) {
        setError(
          'HTTP 401: Netlify Visitor Access is still turned ON and blocking API calls. Set Visitor Access to Public in Netlify Dashboard.'
        );
        return;
      }
      setError(`Verification refresh failed (HTTP ${res.status}).`);
    } catch {
      setError('Could not connect to security verification server.');
    }
  }

  function handleOpenInExternalBrowser() {
    const targetUrl = window.location.href;
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(targetUrl);
      return;
    }
    window.location.assign(targetUrl);
  }

  async function handleTelegramUnlock(e: React.FormEvent) {
    e.preventDefault();
    const liveInitData = tgInitData || String(window.Telegram?.WebApp?.initData || '').trim();
    if (!liveInitData) {
      setError('Telegram Mini App session data missing. Reopen this Mini App from your Telegram bot or use 2FA PIN Unlock.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/telegram-webapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: liveInitData,
          pin: pinInput.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Telegram verification failed (HTTP ${res.status}).`);
        return;
      }
      if (data.requiresPin && data.preAuthToken) {
        setPreAuthToken(data.preAuthToken);
        setPinInput('');
        return;
      }
      if (data.sessionToken) {
        setStoredSession(data.sessionToken, data.email || ownerEmailHint);
        onUnlocked(data.email || ownerEmailHint);
      }
    } catch (err) {
      setError((err as Error).message || 'Telegram Mini App authentication failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeAnswer.trim()) {
      setError('Please solve the human verification check first.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const user = await signInWithGoogle();
      const idToken = await user.getIdToken();

      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          challengeToken,
          challengeAnswer: challengeAnswer.trim(),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403) {
          await signOutFirebase().catch(() => {});
        }
        setError(data.error || 'Authentication failed.');
        await refreshChallengeOnly();
        return;
      }

      if (data.requiresPin && data.preAuthToken) {
        setPreAuthToken(data.preAuthToken);
        setPinInput('');
        return;
      }

      if (data.sessionToken) {
        setStoredSession(data.sessionToken, data.email || ownerEmailHint);
        onUnlocked(data.email || ownerEmailHint);
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('unauthorized-domain')) {
        setError(
          `Google Sign-In domain not authorized in Firebase Console. Add "${window.location.hostname}" under Firebase Auth -> Settings -> Authorized domains, or unlock via 2FA PIN / Telegram.`
        );
      } else if (
        isTelegramContext ||
        msg.includes('popup-blocked') ||
        msg.includes('operation-not-supported') ||
        msg.includes('popup-closed-by-user')
      ) {
        setError(
          'Google popup cannot complete inside Telegram in-app browser. Switch to the "2FA PIN" or "Telegram" tab above, or tap "Open in Browser" below.'
        );
      } else {
        setError(msg || 'Google sign-in cancelled or failed.');
      }
      await refreshChallengeOnly();
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify2faPin(e: React.FormEvent) {
    e.preventDefault();
    if (!preAuthToken || !pinInput.trim()) return;

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preAuthToken,
          pin: pinInput.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Invalid 2FA PIN.');
        return;
      }
      setStoredSession(data.sessionToken, data.email || ownerEmailHint);
      onUnlocked(data.email || ownerEmailHint);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDirectPinUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeAnswer.trim() || !pinInput.trim()) {
      setError('Enter both the Security PIN and the verification answer.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/pin-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: pinInput.trim(),
          challengeToken,
          challengeAnswer: challengeAnswer.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Incorrect PIN.');
        await refreshChallengeOnly();
        return;
      }
      setStoredSession(data.sessionToken, data.email || ownerEmailHint);
      onUnlocked(data.email || ownerEmailHint);
    } catch (err) {
      setError((err as Error).message);
      await refreshChallengeOnly();
    } finally {
      setLoading(false);
    }
  }

  const availableModes: { id: AuthMode; label: string }[] = [];
  if (tgInitData) {
    availableModes.push({ id: 'telegram', label: 'Telegram' });
  }
  if (pinConfigured) {
    availableModes.push({ id: 'pin', label: '2FA PIN' });
  }
  availableModes.push({ id: 'google', label: 'Google' });

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-lg bg-slate-900 text-white flex items-center justify-center">
              <Lock className="w-5 h-5" />
            </div>
            <span className="text-xs font-mono text-slate-500">
              {isTelegramContext ? 'Telegram Mini App' : 'WaNexus Studio'}
            </span>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 pt-1">
            Owner Security Lock
          </h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            This control panel is protected. Only the verified owner (<span className="font-mono text-slate-800">{ownerEmailHint}</span>) can unlock WhatsApp pairing, AI Brain settings, and chat memories.
          </p>
        </div>

        {isTelegramContext && !preAuthToken && (
          <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-900 space-y-2">
            <div className="font-medium">
              Opened inside Telegram Mini App{tgUserLabel ? ` — ${tgUserLabel}` : ''}
            </div>
            <p className="text-[11px] text-sky-800 leading-relaxed">
              Telegram&apos;s in-app browser blocks Google login popups. Use <strong>{tgInitData ? 'Telegram / 2FA PIN' : '2FA PIN'}</strong> here, or open in Chrome/Safari for Google login.
            </p>
            <button
              type="button"
              onClick={handleOpenInExternalBrowser}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-sky-800 underline hover:text-sky-950 cursor-pointer"
            >
              <ExternalLink className="w-3 h-3" />
              Open in External Browser
            </button>
          </div>
        )}

        {!preAuthToken && availableModes.length > 1 && (
          <div
            className={`grid gap-1.5 p-1 bg-slate-100 rounded-lg text-xs font-medium ${
              availableModes.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
            }`}
          >
            {availableModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => {
                  userSelectedModeRef.current = true;
                  setAuthMode(mode.id);
                  setError(null);
                }}
                className={`py-2 px-2 rounded-md transition-colors cursor-pointer ${
                  authMode === mode.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 leading-relaxed">
            {error}
          </div>
        )}

        {preAuthToken ? (
          <form onSubmit={handleVerify2faPin} className="space-y-4">
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Owner identity verified. Enter your 2FA Security PIN to finish unlocking.</span>
            </div>

            <div>
              <label htmlFor="twofa-pin" className="block text-xs font-medium text-slate-700">
                2FA Security PIN (4–8 digits)
              </label>
              <input
                id="twofa-pin"
                type="password"
                inputMode="numeric"
                autoFocus
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="Enter your Security PIN"
                className="mt-1.5 w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreAuthToken(null);
                  setPinInput('');
                  void refreshChallengeOnly();
                }}
                className="px-3.5 py-2.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || !pinInput.trim()}
                className="flex-1 py-2.5 px-4 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
              >
                {loading ? 'Verifying PIN...' : 'Verify & Unlock'}
              </button>
            </div>
          </form>
        ) : authMode === 'telegram' && tgInitData ? (
          <form onSubmit={handleTelegramUnlock} className="space-y-4">
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed">
              Verifies your signed Telegram session via <span className="font-mono">TELEGRAM_BOT_TOKEN</span> &amp; <span className="font-mono">TELEGRAM_OWNER_ID</span> — no Google popup required.
            </div>

            {pinConfigured && (
              <div>
                <label htmlFor="tg-pin" className="block text-xs font-medium text-slate-700">
                  2FA Security PIN
                </label>
                <input
                  id="tg-pin"
                  type="password"
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="Enter 4–8 digit PIN"
                  className="mt-1.5 w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 text-sm font-medium bg-sky-600 text-white rounded-lg hover:bg-sky-700 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              {loading ? 'Verifying Telegram...' : 'Unlock with Telegram Account'}
            </button>
          </form>
        ) : authMode === 'pin' && pinConfigured ? (
          <form onSubmit={handleDirectPinUnlock} className="space-y-4">
            <div>
              <label htmlFor="direct-pin" className="block text-xs font-medium text-slate-700">
                Owner 2FA Security PIN
              </label>
              <input
                id="direct-pin"
                type="password"
                inputMode="numeric"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="Enter 4–8 digit PIN"
                className="mt-1.5 w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>Anti-Bot Verification: <strong className="font-mono text-slate-900">{challengeQuestion || '...'}</strong></span>
                <button
                  type="button"
                  onClick={refreshChallengeOnly}
                  className="text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  New
                </button>
              </div>
              <input
                type="number"
                value={challengeAnswer}
                onChange={(e) => setChallengeAnswer(e.target.value)}
                placeholder="Type the sum"
                className="mt-1.5 w-full px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !challengeToken}
              className="w-full py-2.5 px-4 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              <KeyRound className="w-4 h-4" />
              {loading ? 'Checking...' : 'Unlock Dashboard'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleGoogleUnlock} className="space-y-4">
            <div>
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>Human Verification: <strong className="font-mono text-slate-900">{challengeQuestion || '...'}</strong></span>
                <button
                  type="button"
                  onClick={refreshChallengeOnly}
                  className="text-slate-500 hover:text-slate-900 flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  Refresh
                </button>
              </div>
              <input
                type="number"
                value={challengeAnswer}
                onChange={(e) => setChallengeAnswer(e.target.value)}
                placeholder="Solve math check before signing in"
                className="mt-1.5 w-full px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !challengeToken}
              className="w-full py-2.5 px-4 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
            >
              <ShieldCheck className="w-4 h-4" />
              {loading ? 'Verifying Owner...' : 'Unlock with Google Account'}
            </button>
          </form>
        )}

        <div className="pt-4 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Rate-limited (5 attempts / 5m lock)</span>
          <span>HMAC Session Auth</span>
        </div>
      </div>
    </div>
  );
}
