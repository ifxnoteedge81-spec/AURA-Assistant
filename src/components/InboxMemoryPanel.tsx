import { useEffect, useState } from 'react';
import { CheckCircle2, History, MessageSquareText, RefreshCw, Trash2 } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { ChatMemoryRecord, ChatTurn, InboxNoteRecord } from '../types';

export function InboxMemoryPanel() {
  const [memories, setMemories] = useState<ChatMemoryRecord[]>([]);
  const [notes, setNotes] = useState<InboxNoteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [expandedArchives, setExpandedArchives] = useState<Record<string, ChatTurn[]>>({});
  const [loadingArchiveId, setLoadingArchiveId] = useState<string | null>(null);

  async function fetchInboxData() {
    setLoading(true);
    setInboxError(null);
    try {
      const res = await authFetch('/api/assistant/inbox');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInboxError(data.error || 'Could not load inbox notes & memories.');
        return;
      }
      setMemories(data.memories || []);
      setNotes(data.notes || []);
    } catch (err) {
      setInboxError((err as Error).message || 'Could not load inbox notes & memories.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchInboxData();
  }, []);

  async function handleToggleNote(id: string) {
    setInboxError(null);
    try {
      const res = await authFetch(`/api/notes/${id}/toggle`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInboxError(data.error || 'Could not update note status.');
        return;
      }
      setNotes(data.notes || []);
    } catch (err) {
      setInboxError((err as Error).message || 'Could not update note status.');
    }
  }

  async function handleDeleteNote(id: string) {
    setInboxError(null);
    try {
      const res = await authFetch(`/api/notes/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInboxError(data.error || 'Could not delete note.');
        return;
      }
      setNotes(data.notes || []);
    } catch (err) {
      setInboxError((err as Error).message || 'Could not delete note.');
    }
  }

  async function handleClearMemory(chatId: string) {
    setInboxError(null);
    try {
      const res = await authFetch(`/api/memories/${chatId}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInboxError(data.error || 'Could not clear chat memory.');
        return;
      }
      setMemories((prev) => prev.filter((m) => m.chatId !== chatId));
      setExpandedArchives((prev) => {
        const copy = { ...prev };
        delete copy[chatId];
        return copy;
      });
    } catch (err) {
      setInboxError((err as Error).message || 'Could not clear chat memory.');
    }
  }

  async function handleToggleFullArchive(chatId: string) {
    if (expandedArchives[chatId]) {
      setExpandedArchives((prev) => {
        const copy = { ...prev };
        delete copy[chatId];
        return copy;
      });
      return;
    }
    setLoadingArchiveId(chatId);
    setInboxError(null);
    try {
      const res = await authFetch(`/api/memories/${chatId}/archive`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInboxError(data.error || 'Could not load archived chat history.');
        return;
      }
      setExpandedArchives((prev) => ({
        ...prev,
        [chatId]: Array.isArray(data.turns) ? data.turns : [],
      }));
    } catch (err) {
      setInboxError((err as Error).message || 'Could not load archived chat history.');
    } finally {
      setLoadingArchiveId(null);
    }
  }

  return (
    <div className="space-y-8">
      {inboxError && (
        <div className="p-3.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
          {inboxError}
        </div>
      )}
      {/* Notes for Sir */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Messages &amp; Notes Left for Sir</h2>
            <p className="text-xs text-slate-600">
              When contacts leave important requests or callback messages while you are offline, the AI logs them here.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchInboxData}
            className="p-2 text-slate-500 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading inbox notes...</div>
        ) : notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No pending notes left for Sir yet. Test leaving a message in the Command Simulator with Auto-Reply enabled.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {notes.map((note) => (
              <div key={note.id} className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-semibold text-slate-900">{note.contactName || note.contactJid}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span className={note.urgency === 'important' ? 'text-red-700 font-medium' : 'text-slate-600'}>
                      {note.urgency === 'important' ? 'Important' : 'Normal'}
                    </span>
                    <span aria-hidden="true">&middot;</span>
                    <span className="font-mono tabular-nums">{new Date(note.createdAt).toLocaleString()}</span>
                  </div>
                  <div className={`text-sm ${note.resolved ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                    {note.summary}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleNote(note.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                      note.resolved
                        ? 'bg-slate-50 text-slate-600 border-slate-200'
                        : 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {note.resolved ? 'Reopen' : 'Mark Done'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteNote(note.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 border border-slate-200 rounded-lg cursor-pointer"
                    title="Delete note"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-Contact Conversation Memory */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <MessageSquareText className="w-4 h-4 text-emerald-600" />
            Private Contact Chat Memories
          </h2>
          <p className="text-xs text-slate-600">
            Recent conversation context remembered by the AI assistant so it never repeats robotic intros.
          </p>
        </div>

        {memories.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No saved conversation memories yet.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {memories.map((mem) => (
              <div key={mem.chatId} className="p-6 space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{mem.contactName || mem.contactJid}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span className="font-mono">{mem.contactJid}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>Dialect: {mem.detectedDistrict || 'Standard'}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span className="font-mono text-emerald-700">
                      {mem.archiveCount || mem.turns.length} msgs archived
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleFullArchive(mem.chatId)}
                      disabled={loadingArchiveId === mem.chatId}
                      className="px-3 py-1 text-xs font-medium text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <History className="w-3.5 h-3.5" />
                      {loadingArchiveId === mem.chatId
                        ? 'Loading...'
                        : expandedArchives[mem.chatId]
                          ? 'Show Recent (20)'
                          : 'View Full Archive'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleClearMemory(mem.chatId)}
                      className="px-3 py-1 text-xs font-medium text-red-700 border border-slate-200 rounded-lg hover:bg-red-50 cursor-pointer whitespace-nowrap"
                    >
                      Clear Memory
                    </button>
                  </div>
                </div>

                {mem.lastSummary && (
                  <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-lg px-3.5 py-2.5 text-xs text-slate-700 leading-relaxed">
                    <span className="font-semibold text-emerald-800 mr-1.5">Deep Inbox &amp; Mood Summary:</span>
                    <span>{mem.lastSummary}</span>
                  </div>
                )}

                <div className="space-y-2 bg-slate-50 border border-slate-200 rounded-lg p-3.5 max-h-60 overflow-y-auto">
                  {(expandedArchives[mem.chatId] || mem.turns).map((turn, idx) => (
                    <div key={idx} className="text-xs leading-relaxed">
                      <span className={`font-semibold ${turn.role === 'assistant' ? 'text-emerald-700' : 'text-slate-900'}`}>
                        {turn.role === 'assistant' ? 'Assistant: ' : 'Contact: '}
                      </span>
                      <span className="text-slate-700">{turn.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
