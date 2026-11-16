import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Link2,
  MessageSquareText,
  Phone,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Shield,
  Terminal,
  Trash2,
  Unplug,
} from 'lucide-react';
import type {
  ClientBotItem,
  ClientGroupRule,
  ClientKeywordReply,
  ClientKnownGroup,
} from '../types';

interface ClientBotControlsEditorProps {
  bot: ClientBotItem;
  mode: 'owner' | 'portal';
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
  onPair: (phoneNumber: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onResetSession: () => Promise<void>;
  onFetchGroups: () => Promise<ClientKnownGroup[]>;
  onResetWarnings: (groupJid: string, userKey?: string) => Promise<void>;
  onRotateKey?: () => Promise<void>;
  onDeleteBot?: () => Promise<void>;
}

function createEmptyGroupRule(
  groupJid: string,
  groupName: string,
  defaults: ClientBotItem['defaultModeration']
): ClientGroupRule {
  return {
    groupJid,
    groupName,
    enabled: defaults.enabled,
    deleteLinks: defaults.deleteLinks,
    deleteStickers: defaults.deleteStickers,
    deleteMedia: defaults.deleteMedia,
    warnEnabled: defaults.warnEnabled,
    maxWarnings: defaults.maxWarnings,
    kickOnLimit: defaults.kickOnLimit,
    warningTemplate: defaults.warningTemplate,
    kickTemplate: defaults.kickTemplate,
    userWarnings: {},
  };
}

export function ClientBotControlsEditor({
  bot,
  mode,
  onUpdate,
  onPair,
  onDisconnect,
  onResetSession,
  onFetchGroups,
  onResetWarnings,
  onRotateKey,
  onDeleteBot,
}: ClientBotControlsEditorProps) {
  const [phoneInput, setPhoneInput] = useState(bot.phoneNumber || '');
  const [clientNameInput, setClientNameInput] = useState(bot.clientName);
  const [moderateAllGroups, setModerateAllGroups] = useState(bot.moderateAllGroups);
  const [defaultMod, setDefaultMod] = useState(bot.defaultModeration);

  const [savedReplyEnabled, setSavedReplyEnabled] = useState(bot.savedReplyEnabled);
  const [savedReplyMessage, setSavedReplyMessage] = useState(bot.savedReplyMessage);
  const [savedReplyCooldownSec, setSavedReplyCooldownSec] = useState(
    Math.round((bot.savedReplyCooldownMs || 0) / 1000)
  );
  const [keywordReplies, setKeywordReplies] = useState<ClientKeywordReply[]>(bot.keywordReplies || []);
  const [newKeyword, setNewKeyword] = useState('');
  const [newKeywordReply, setNewKeywordReply] = useState('');

  const [liveGroups, setLiveGroups] = useState<ClientKnownGroup[]>(bot.knownGroups || []);
  const [manualGroupJid, setManualGroupJid] = useState('');
  const [manualGroupName, setManualGroupName] = useState('');
  const [selectedGroupJid, setSelectedGroupJid] = useState<string>(() => {
    const keys = Object.keys(bot.groupRules || {});
    return keys[0] || '';
  });
  const [editingRule, setEditingRule] = useState<ClientGroupRule | null>(null);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const isDefaultsDirtyRef = useRef(false);
  const isRuleDirtyRef = useRef(false);
  const isSmsDirtyRef = useRef(false);
  const prevGroupSelectionRef = useRef<string>(`${bot.botId}::${selectedGroupJid}`);

  // Reset all dirty flags & hydrate cleanly when switching to a different client bot slot
  useEffect(() => {
    isDefaultsDirtyRef.current = false;
    isRuleDirtyRef.current = false;
    isSmsDirtyRef.current = false;
    setPhoneInput(bot.phoneNumber || '');
    setClientNameInput(bot.clientName);
    setModerateAllGroups(bot.moderateAllGroups);
    setDefaultMod(bot.defaultModeration);
    setSavedReplyEnabled(bot.savedReplyEnabled);
    setSavedReplyMessage(bot.savedReplyMessage);
    setSavedReplyCooldownSec(Math.round((bot.savedReplyCooldownMs || 0) / 1000));
    setKeywordReplies(bot.keywordReplies || []);
    setLiveGroups(bot.knownGroups || []);
    const keys = Object.keys(bot.groupRules || {});
    if (!keys.includes(selectedGroupJid)) {
      setSelectedGroupJid(keys[0] || '');
    }
  }, [bot.botId]);

  // Sync clean fields when server updates (e.g. after save or WhatsApp .mod/.savedreply command) without wiping unsaved edits
  useEffect(() => {
    if ((bot.knownGroups || []).length > 0) {
      setLiveGroups(bot.knownGroups || []);
    }
    if (!isDefaultsDirtyRef.current) {
      setClientNameInput(bot.clientName);
      setModerateAllGroups(bot.moderateAllGroups);
      setDefaultMod(bot.defaultModeration);
    }
    if (!isSmsDirtyRef.current) {
      setSavedReplyEnabled(bot.savedReplyEnabled);
      setSavedReplyMessage(bot.savedReplyMessage);
      setSavedReplyCooldownSec(Math.round((bot.savedReplyCooldownMs || 0) / 1000));
      setKeywordReplies(bot.keywordReplies || []);
    }
  }, [
    bot.updatedAt,
    bot.clientName,
    bot.moderateAllGroups,
    bot.defaultModeration,
    bot.savedReplyEnabled,
    bot.savedReplyMessage,
    bot.savedReplyCooldownMs,
    bot.keywordReplies,
    bot.knownGroups,
  ]);

  // Keep selected group editor synced ONLY when group selection changes OR editor is clean (never clobber active edits on 5s poll)
  useEffect(() => {
    const selectionKey = `${bot.botId}::${selectedGroupJid}`;
    const selectionChanged = prevGroupSelectionRef.current !== selectionKey;
    prevGroupSelectionRef.current = selectionKey;

    if (selectionChanged) {
      isRuleDirtyRef.current = false;
    }

    if (!selectedGroupJid) {
      setEditingRule(null);
      return;
    }

    if (!selectionChanged && isRuleDirtyRef.current) {
      return;
    }

    const existing = bot.groupRules?.[selectedGroupJid];
    if (existing) {
      setEditingRule(existing);
    } else {
      const known = liveGroups.find((g) => g.jid === selectedGroupJid);
      setEditingRule(
        createEmptyGroupRule(selectedGroupJid, known?.name || selectedGroupJid, bot.defaultModeration)
      );
    }
  }, [bot.botId, selectedGroupJid, bot.groupRules, bot.defaultModeration, liveGroups]);

  const portalUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/?portal=${encodeURIComponent(bot.botId)}&access=${encodeURIComponent(bot.clientAccessKey)}`
      : '';

  async function runAction(label: string, fn: () => Promise<void>, successMessage?: string) {
    setBusyAction(label);
    setFeedback(null);
    try {
      await fn();
      if (successMessage) {
        setFeedback({ type: 'ok', text: successMessage });
      }
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopyPortalUrl() {
    if (!portalUrl) return;
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      setFeedback({ type: 'err', text: 'Clipboard copy failed.' });
    }
  }

  async function handleFetchLiveGroups() {
    await runAction('groups', async () => {
      const list = await onFetchGroups();
      setLiveGroups(list);
      if (!selectedGroupJid && list.length > 0) {
        setSelectedGroupJid(list[0].jid);
      }
    }, 'Loaded participating WhatsApp groups.');
  }

  function handleAddManualGroup() {
    const trimmed = manualGroupJid.trim();
    if (!trimmed) return;
    const jid = trimmed.includes('@') ? trimmed : `${trimmed}@g.us`;
    const name = manualGroupName.trim() || jid;
    isRuleDirtyRef.current = true;
    setSelectedGroupJid(jid);
    setEditingRule(createEmptyGroupRule(jid, name, defaultMod));
    setManualGroupJid('');
    setManualGroupName('');
  }

  function handleAddKeywordRule() {
    const kw = newKeyword.trim();
    const reply = newKeywordReply.trim();
    if (!kw || !reply) return;
    isSmsDirtyRef.current = true;
    setKeywordReplies((prev) => [
      ...prev,
      { id: `kw_${Date.now()}`, keyword: kw, reply, enabled: true },
    ]);
    setNewKeyword('');
    setNewKeywordReply('');
  }

  const configuredGroupList = Object.values(bot.groupRules || {});
  const mergedGroupChoices = new Map<string, { jid: string; name: string; isCustom: boolean; botIsAdmin?: boolean }>();
  for (const g of liveGroups) {
    mergedGroupChoices.set(g.jid, {
      jid: g.jid,
      name: g.name,
      isCustom: Boolean(bot.groupRules?.[g.jid]),
      botIsAdmin: g.botIsAdmin,
    });
  }
  for (const rule of configuredGroupList) {
    const existing = mergedGroupChoices.get(rule.groupJid);
    mergedGroupChoices.set(rule.groupJid, {
      jid: rule.groupJid,
      name: rule.groupName || existing?.name || rule.groupJid,
      isCustom: true,
      botIsAdmin: existing?.botIsAdmin,
    });
  }
  const groupChoices = Array.from(mergedGroupChoices.values());

  const statusText =
    bot.status === 'connected'
      ? 'Connected'
      : bot.status === 'awaiting_pairing'
      ? 'Awaiting Pairing Code'
      : bot.status === 'connecting'
      ? 'Connecting...'
      : bot.status === 'suspended'
      ? 'Suspended (Paused by Owner)'
      : 'Disconnected';

  const statusColorClass =
    bot.status === 'connected'
      ? 'text-emerald-700'
      : bot.status === 'suspended'
      ? 'text-red-700'
      : bot.status === 'awaiting_pairing' || bot.status === 'connecting'
      ? 'text-amber-700'
      : 'text-slate-600';

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`px-4 py-3 rounded-xl border text-xs font-medium ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Header & Owner Kill-Switch / Portal Access Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-base font-semibold text-slate-900 truncate">{bot.clientName}</h3>
              <span className={`text-xs font-semibold tabular-nums ${statusColorClass}`}>
                • {statusText}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
              ID: {bot.botId} · Zero-AI Mode (0 API Tokens) · {bot.connectedUser || 'Not linked'}
            </p>
          </div>

          {mode === 'owner' && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() =>
                  runAction(
                    'toggleActive',
                    () => onUpdate({ active: !bot.active }),
                    bot.active ? 'Client bot suspended.' : 'Client bot activated.'
                  )
                }
                className={`px-3.5 py-2 text-xs font-medium rounded-lg border flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                  bot.active
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100'
                    : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                }`}
              >
                <Power className="w-3.5 h-3.5" />
                {bot.active ? 'Active (Click to Suspend)' : 'Suspended (Click to Activate)'}
              </button>

              {onDeleteBot && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => runAction('delete', onDeleteBot)}
                  className="px-3 py-2 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                  title="Delete Client Bot Slot"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {/* Shareable Client Portal Link (Owner Only) */}
        {mode === 'owner' && (
          <div className="pt-3 border-t border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-1">
                Scoped Client Self-Service Portal Link (Single Bot Only — No AI Access)
              </div>
              <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700 truncate">
                {portalUrl}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopyPortalUrl}
                className="px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedKey ? 'Copied Link' : 'Copy Portal Link'}
              </button>
              {onRotateKey && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => runAction('rotateKey', onRotateKey, 'Access key rotated; old portal link revoked.')}
                  className="px-3 py-2 text-xs font-medium bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  Rotate Key
                </button>
              )}
            </div>
          </div>
        )}

        {/* Counters Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-slate-100 text-xs">
          <div>
            <div className="text-slate-500">Deleted Violations</div>
            <div className="text-base font-semibold text-slate-900 tabular-nums mt-0.5">
              {bot.stats.deletedCount}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Warnings Sent</div>
            <div className="text-base font-semibold text-slate-900 tabular-nums mt-0.5">
              {bot.stats.warnedCount}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Auto-Kicks</div>
            <div className="text-base font-semibold text-slate-900 tabular-nums mt-0.5">
              {bot.stats.kickedCount}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Saved SMS Sent</div>
            <div className="text-base font-semibold text-slate-900 tabular-nums mt-0.5">
              {bot.stats.savedRepliesSent}
            </div>
          </div>
        </div>
      </div>

      {/* Section 1: WhatsApp Number Pairing */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-emerald-600" />
            <h4 className="text-sm font-semibold text-slate-900">WhatsApp Pairing (8-Digit Code)</h4>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busyAction !== null || bot.status === 'disconnected'}
              onClick={() => runAction('disconnect', onDisconnect, 'Disconnected client socket.')}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Unplug className="w-3.5 h-3.5" />
              Disconnect
            </button>
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => runAction('reset', onResetSession, 'Cleared WhatsApp session credentials.')}
              className="px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Session
            </button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="8801712345678 (Country code + number)"
            className="flex-1 px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg font-mono focus:outline-none focus:border-emerald-600"
          />
          <button
            type="button"
            disabled={busyAction !== null || !bot.active}
            onClick={() =>
              runAction('pair', () => onPair(phoneInput), 'Generated WhatsApp pairing code.')
            }
            className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {busyAction === 'pair' ? 'Requesting Code...' : 'Generate Pairing Code'}
          </button>
        </div>

        {bot.pairingCode && (
          <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="text-xs text-emerald-900">
              WhatsApp Linked Devices → Link with phone number → Enter code:
            </div>
            <div className="text-xl font-bold font-mono tracking-[0.2em] text-emerald-800 tabular-nums">
              {bot.pairingCode}
            </div>
          </div>
        )}

        {bot.lastError && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {bot.lastError}
          </div>
        )}
      </div>

      {/* Section 2: Default Group Moderation Settings */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-600" />
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Default Group Moderation Rules (All Groups Fallback)
              </h4>
              <p className="text-xs text-slate-500">
                Each group can override these rules individually below or via WhatsApp <code className="font-mono">.mod</code> commands.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              runAction(
                'saveDefaults',
                async () => {
                  await onUpdate({
                    ...(mode === 'owner' ? { clientName: clientNameInput } : {}),
                    moderateAllGroups,
                    defaultModeration: defaultMod,
                  });
                  isDefaultsDirtyRef.current = false;
                },
                'Saved default moderation policy.'
              )
            }
            className="px-3.5 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Save Defaults
          </button>
        </div>

        {mode === 'owner' && (
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Client Slot Label</label>
            <input
              type="text"
              value={clientNameInput}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setClientNameInput(e.target.value);
              }}
              className="w-full sm:max-w-sm px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Auto-moderate All Groups</span>
            <input
              type="checkbox"
              checked={moderateAllGroups}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setModerateAllGroups(e.target.checked);
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Delete Links</span>
            <input
              type="checkbox"
              checked={defaultMod.deleteLinks}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, deleteLinks: e.target.checked }));
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Delete Stickers</span>
            <input
              type="checkbox"
              checked={defaultMod.deleteStickers}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, deleteStickers: e.target.checked }));
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Delete Photos / Videos / Media</span>
            <input
              type="checkbox"
              checked={defaultMod.deleteMedia}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, deleteMedia: e.target.checked }));
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Send Warning Message</span>
            <input
              type="checkbox"
              checked={defaultMod.warnEnabled}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, warnEnabled: e.target.checked }));
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Auto-Kick on Warning Limit</span>
            <input
              type="checkbox"
              checked={defaultMod.kickOnLimit}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, kickOnLimit: e.target.checked }));
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Default Max Warnings (1–20)
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={defaultMod.maxWarnings}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({
                  ...d,
                  maxWarnings: Math.max(1, Math.min(20, Number(e.target.value) || 3)),
                }));
              }}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Warning Message Template (<code className="font-mono">{'{user} {reason} {count} {max}'}</code>)
            </label>
            <input
              type="text"
              value={defaultMod.warningTemplate}
              onChange={(e) => {
                isDefaultsDirtyRef.current = true;
                setDefaultMod((d) => ({ ...d, warningTemplate: e.target.value }));
              }}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
            />
          </div>
        </div>
      </div>

      {/* Section 3: Per-Group Custom Rules (Group Admin Choice) */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-emerald-600" />
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Per-Group Custom Moderation (Every Group Customizable)
              </h4>
              <p className="text-xs text-slate-500">
                Choose exact rules per group: Links, Stickers, Media, Max Warnings, Kick, and Warning text.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busyAction !== null || bot.status !== 'connected'}
            onClick={handleFetchLiveGroups}
            className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'groups' ? 'animate-spin' : ''}`} />
            Load Live WhatsApp Groups
          </button>
        </div>

        {/* Manual Group Add */}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={manualGroupJid}
            onChange={(e) => setManualGroupJid(e.target.value)}
            placeholder="Group JID (e.g. 120363041928374655@g.us)"
            className="flex-1 px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
          />
          <input
            type="text"
            value={manualGroupName}
            onChange={(e) => setManualGroupName(e.target.value)}
            placeholder="Group Name (optional)"
            className="sm:w-48 px-3 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
          />
          <button
            type="button"
            onClick={handleAddManualGroup}
            className="px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Select / Add Group
          </button>
        </div>

        {groupChoices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {groupChoices.map((g) => (
              <button
                key={g.jid}
                type="button"
                onClick={() => setSelectedGroupJid(g.jid)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                  selectedGroupJid === g.jid
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {g.name}
                {g.isCustom ? ' *' : ''}
              </button>
            ))}
          </div>
        )}

        {editingRule ? (
          <div className="pt-4 border-t border-slate-200 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">{editingRule.groupName}</div>
                <div className="text-xs font-mono text-slate-500">{editingRule.groupJid}</div>
              </div>
              <div className="flex items-center gap-2">
                {bot.groupRules?.[editingRule.groupJid] && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      runAction(
                        'removeGroup',
                        () => onUpdate({ removeGroupJid: editingRule.groupJid }),
                        'Removed custom group override (falls back to default).'
                      )
                    }
                    className="px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 whitespace-nowrap cursor-pointer"
                  >
                    Remove Override
                  </button>
                )}
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() =>
                    runAction(
                      'saveGroupRule',
                      async () => {
                        await onUpdate({ upsertGroupRule: editingRule });
                        isRuleDirtyRef.current = false;
                      },
                      `Saved custom rules for ${editingRule.groupName}.`
                    )
                  }
                  className="px-3.5 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save This Group Rule
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Moderation Enabled</span>
                <input
                  type="checkbox"
                  checked={editingRule.enabled}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, enabled: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Delete Links</span>
                <input
                  type="checkbox"
                  checked={editingRule.deleteLinks}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, deleteLinks: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Delete Stickers</span>
                <input
                  type="checkbox"
                  checked={editingRule.deleteStickers}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, deleteStickers: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Delete Media</span>
                <input
                  type="checkbox"
                  checked={editingRule.deleteMedia}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, deleteMedia: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Send Warnings</span>
                <input
                  type="checkbox"
                  checked={editingRule.warnEnabled}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, warnEnabled: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 border border-slate-200 rounded-lg cursor-pointer">
                <span>Auto-Kick on Limit</span>
                <input
                  type="checkbox"
                  checked={editingRule.kickOnLimit}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, kickOnLimit: e.target.checked } : r));
                  }}
                  className="accent-emerald-600 w-4 h-4"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Max Warnings</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={editingRule.maxWarnings}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) =>
                      r ? { ...r, maxWarnings: Math.max(1, Math.min(20, Number(e.target.value) || 3)) } : r
                    );
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Group Warning Text</label>
                <input
                  type="text"
                  value={editingRule.warningTemplate}
                  onChange={(e) => {
                    isRuleDirtyRef.current = true;
                    setEditingRule((r) => (r ? { ...r, warningTemplate: e.target.value } : r));
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            {Object.keys(editingRule.userWarnings || {}).length > 0 && (
              <div className="pt-3 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-slate-700">Active User Warning Counts</span>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() =>
                      runAction(
                        'resetWarn',
                        () => onResetWarnings(editingRule.groupJid),
                        'Cleared all warnings in this group.'
                      )
                    }
                    className="text-xs font-medium text-red-600 hover:underline cursor-pointer"
                  >
                    Reset All Warnings
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs font-mono">
                  {Object.entries(editingRule.userWarnings).map(([userKey, count]) => (
                    <div
                      key={userKey}
                      className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg flex items-center gap-2 tabular-nums"
                    >
                      <span>+{userKey}: {count}/{editingRule.maxWarnings}</span>
                      <button
                        type="button"
                        onClick={() =>
                          runAction('resetOneWarn', () => onResetWarnings(editingRule.groupJid, userKey))
                        }
                        className="text-red-600 hover:text-red-800 cursor-pointer"
                        title="Reset user warning"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-slate-500 py-3">
            Connect WhatsApp and click &ldquo;Load Live WhatsApp Groups&rdquo; or enter a Group JID above to customize per-group rules.
          </div>
        )}
      </div>

      {/* Section 4: Saved Auto-Reply SMS & Keyword Rules */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="w-4 h-4 text-emerald-600" />
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Saved Auto-Reply SMS (Zero-AI Private Inbox)
              </h4>
              <p className="text-xs text-slate-500">
                Instant saved text replies &amp; keyword rules for incoming private DMs (uses 0 AI tokens).
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() =>
              runAction(
                'saveSms',
                async () => {
                  await onUpdate({
                    savedReplyEnabled,
                    savedReplyMessage,
                    savedReplyCooldownMs: Math.max(0, savedReplyCooldownSec) * 1000,
                    keywordReplies,
                  });
                  isSmsDirtyRef.current = false;
                },
                'Saved auto-reply SMS & keyword rules.'
              )
            }
            className="px-3.5 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            Save SMS Settings
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label className="flex items-center justify-between p-3 border border-slate-200 rounded-lg cursor-pointer">
            <span className="font-medium text-slate-800">Enable Saved DM Auto-Reply</span>
            <input
              type="checkbox"
              checked={savedReplyEnabled}
              onChange={(e) => {
                isSmsDirtyRef.current = true;
                setSavedReplyEnabled(e.target.checked);
              }}
              className="accent-emerald-600 w-4 h-4"
            />
          </label>
          <div className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-lg">
            <span className="font-medium text-slate-800">Reply Cooldown (Seconds)</span>
            <input
              type="number"
              min={0}
              max={86400}
              value={savedReplyCooldownSec}
              onChange={(e) => {
                isSmsDirtyRef.current = true;
                setSavedReplyCooldownSec(Math.max(0, Number(e.target.value) || 0));
              }}
              className="w-24 px-2.5 py-1 text-right border border-slate-200 rounded-md tabular-nums"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Default Saved SMS</label>
          <textarea
            rows={3}
            value={savedReplyMessage}
            onChange={(e) => {
              isSmsDirtyRef.current = true;
              setSavedReplyMessage(e.target.value);
            }}
            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-600"
          />
        </div>

        <div className="pt-3 border-t border-slate-100 space-y-3">
          <div className="text-xs font-medium text-slate-700">Keyword Auto-Replies (Exact / Contains Match)</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder="Keyword (e.g. price)"
              className="sm:w-44 px-3 py-2 text-xs border border-slate-200 rounded-lg"
            />
            <input
              type="text"
              value={newKeywordReply}
              onChange={(e) => setNewKeywordReply(e.target.value)}
              placeholder="Saved reply SMS when keyword is matched"
              className="flex-1 px-3 py-2 text-xs border border-slate-200 rounded-lg"
            />
            <button
              type="button"
              onClick={handleAddKeywordRule}
              className="px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Rule
            </button>
          </div>

          {keywordReplies.length > 0 && (
            <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs">
              {keywordReplies.map((item) => (
                <div key={item.id} className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-mono font-semibold text-slate-900">{item.keyword}</span>
                    <span className="mx-2 text-slate-300">→</span>
                    <span className="text-slate-600 break-words">{item.reply}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      isSmsDirtyRef.current = true;
                      setKeywordReplies((prev) => prev.filter((k) => k.id !== item.id));
                    }}
                    className="text-red-600 hover:text-red-800 shrink-0 cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Section 5: WhatsApp Admin Commands Reference */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-slate-700" />
          <h4 className="text-sm font-semibold text-slate-900">
            WhatsApp Group Admin Commands (Type Directly Inside Connected WhatsApp)
          </h4>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono text-slate-700">
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod status</span> — View group moderation rules
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod on / .mod off</span> — Enable or pause group bot
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod link on / off</span> — Toggle link deletion
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod sticker on / off</span> — Toggle sticker deletion
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod media on / off</span> — Toggle photo/video deletion
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod warn 5 / .mod warn off</span> — Set max warnings
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.mod kick on / off</span> — Auto-kick on limit
          </div>
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
            <span className="font-semibold text-slate-900">.savedreply set &lt;text&gt;</span> — Update DM SMS from phone
          </div>
        </div>
      </div>

      {/* Section 6: Recent Client Bot Activity Logs */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-slate-900">Recent Client Bot Events</h4>
          <span className="text-xs text-slate-500 tabular-nums">{bot.logs.length} events</span>
        </div>
        {bot.logs.length === 0 ? (
          <div className="px-5 py-6 text-xs text-slate-500 text-center">
            No events recorded for this client slot yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto text-xs">
            {bot.logs.map((entry) => (
              <div key={entry.id} className="px-5 py-2.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="font-medium text-slate-900 mr-2">[{entry.category}]</span>
                  <span className="text-slate-700">{entry.summary}</span>
                </div>
                <span className="text-slate-400 font-mono tabular-nums shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
