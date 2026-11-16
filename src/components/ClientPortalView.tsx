import { useCallback, useEffect, useState } from 'react';
import { Lock, ShieldAlert, Smartphone } from 'lucide-react';
import type { ClientBotItem, ClientKnownGroup } from '../types';
import { ClientBotControlsEditor } from './ClientBotControlsEditor';

interface ClientPortalViewProps {
  botId: string;
  accessKey: string;
}

export function ClientPortalView({ botId, accessKey }: ClientPortalViewProps) {
  const [bot, setBot] = useState<ClientBotItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<{ code: string; message: string } | null>(null);

  const portalFetch = useCallback(
    async (suffix = '', init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      headers.set('x-client-access-key', accessKey);
      return fetch(`/api/client-portal/${encodeURIComponent(botId)}${suffix}`, {
        ...init,
        headers,
      });
    },
    [botId, accessKey]
  );

  const loadPortal = useCallback(async () => {
    try {
      const res = await portalFetch('');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorState({
          code: String(data.code || res.status),
          message: String(data.error || 'Access denied.'),
        });
        return;
      }
      setErrorState(null);
      setBot(data.bot as ClientBotItem);
    } catch {
      setErrorState({ code: 'NETWORK', message: 'Unable to reach bot server.' });
    } finally {
      setLoading(false);
    }
  }, [portalFetch]);

  useEffect(() => {
    void loadPortal();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadPortal();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [loadPortal]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-xs text-slate-500">Loading WhatsApp Bot Control Portal...</div>
      </div>
    );
  }

  if (errorState) {
    const isSuspended = errorState.code === 'SUSPENDED';
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center space-y-3">
          {isSuspended ? (
            <ShieldAlert className="w-8 h-8 text-red-600 mx-auto" />
          ) : (
            <Lock className="w-8 h-8 text-slate-500 mx-auto" />
          )}
          <h1 className="text-base font-bold text-slate-900">
            {isSuspended ? 'Bot Service Suspended' : 'Client Portal Unavailable'}
          </h1>
          <p className="text-xs text-slate-600 leading-relaxed">{errorState.message}</p>
        </div>
      </div>
    );
  }

  if (!bot) return null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="h-16 px-6 bg-white border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Smartphone className="w-4 h-4 text-emerald-600" />
          <span className="text-sm font-bold text-slate-900">{bot.clientName} — Bot Portal</span>
        </div>
        <div className="text-xs text-slate-500 font-mono">Zero-AI Group Moderator &amp; Auto-Reply</div>
      </header>

      <main className="max-w-4xl mx-auto p-6">
        <ClientBotControlsEditor
          bot={bot}
          mode="portal"
          onUpdate={async (patch) => {
            const res = await portalFetch('', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to save changes.');
            setBot(data.bot as ClientBotItem);
          }}
          onPair={async (phoneNumber) => {
            const res = await portalFetch('/pair', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phoneNumber }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Pairing failed.');
            setBot(data.bot as ClientBotItem);
          }}
          onDisconnect={async () => {
            const res = await portalFetch('/disconnect', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Disconnect failed.');
            setBot(data.bot as ClientBotItem);
          }}
          onResetSession={async () => {
            const res = await portalFetch('/reset-session', { method: 'POST' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Reset failed.');
            setBot(data.bot as ClientBotItem);
          }}
          onFetchGroups={async () => {
            const res = await portalFetch('/groups');
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load groups.');
            return (data.groups || []) as ClientKnownGroup[];
          }}
          onResetWarnings={async (groupJid, userKey) => {
            const res = await portalFetch(`/groups/${encodeURIComponent(groupJid)}/reset-warnings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userKey }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to reset warnings.');
            setBot(data.bot as ClientBotItem);
          }}
        />
      </main>
    </div>
  );
}
