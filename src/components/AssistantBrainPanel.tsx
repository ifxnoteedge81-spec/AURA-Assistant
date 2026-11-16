import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronLeft, ChevronRight, Plus, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { AssistantTone, BotConfig, DictionaryEntry } from '../types';

interface AssistantBrainPanelProps {
  config: BotConfig;
  onUpdateConfig: (patch: Partial<BotConfig>) => Promise<void>;
  onSyncDictionaryEntry?: (entry: DictionaryEntry) => Promise<void>;
  onDeleteDictionaryEntry?: (id: string) => Promise<void>;
}

const TONE_OPTIONS: { id: AssistantTone; label: string; desc: string }[] = [
  {
    id: 'witty_flirty',
    label: 'Friendly & Witty (Light Flirty)',
    desc: 'Playful banter for teasing/morning-night jokes while staying classy and reminding them Sir is away.',
  },
  {
    id: 'warm_polite',
    label: 'Warm & Polite',
    desc: 'Respectful, gentle Bengali/English hospitality for family, friends, and clients.',
  },
  {
    id: 'executive_formal',
    label: 'Executive Formal',
    desc: 'Crisp, brief business assistant tone focused on taking messages and schedules.',
  },
  {
    id: 'sharp_shut_down',
    label: 'Sharp & Firm Shut-Down',
    desc: 'Confident, direct tone to shut down annoying spam, pushy requests, or time-wasters.',
  },
];

function formatPauseLabel(ms: number): string {
  if (ms <= 0) return 'No auto-pause';
  return `${Math.round(ms / 60000)} minutes`;
}

export function AssistantBrainPanel({
  config,
  onUpdateConfig,
  onSyncDictionaryEntry,
  onDeleteDictionaryEntry,
}: AssistantBrainPanelProps) {
  const [ownerName, setOwnerName] = useState(config.ownerName);
  const [ownerProfession, setOwnerProfession] = useState(config.ownerProfession);
  const [ownerLocation, setOwnerLocation] = useState(config.ownerLocation);
  const [ownerBio, setOwnerBio] = useState(config.ownerBio);
  const [ownerBoundaries, setOwnerBoundaries] = useState(config.ownerBoundaries);
  const [strictLogicRules, setStrictLogicRules] = useState(config.strictLogicRules || '');
  const [firstGreeting, setFirstGreeting] = useState(config.firstGreetingTemplate);
  const [assistantTone, setAssistantTone] = useState<AssistantTone>(config.assistantTone);
  const [takeoverPauseMs, setTakeoverPauseMs] = useState(config.takeoverPauseMs);
  const [aiEnabled, setAiEnabled] = useState(config.aiAssistantEnabled);

  const isDirtyRef = useRef(false);
  const [hasUnsavedText, setHasUnsavedText] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSavedToast, setProfileSavedToast] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [quickSaveNote, setQuickSaveNote] = useState<string | null>(null);

  // Dictionary State (Server-side paginated — never loads massive dictionaries into browser RAM)
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [districts, setDistricts] = useState<string[]>([]);
  const [storageMode, setStorageMode] = useState<'postgres' | 'local'>('local');
  const [isLoadingPage, setIsLoadingPage] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [districtFilter, setDistrictFilter] = useState('ALL');
  const [term, setTerm] = useState('');
  const [meaning, setMeaning] = useState('');
  const [district, setDistrict] = useState('Dhaka');
  const [language, setLanguage] = useState<DictionaryEntry['language']>('bn_dialect');
  const [replyStyleHint, setReplyStyleHint] = useState('');
  const [isAddingWord, setIsAddingWord] = useState(false);
  const [isLoadingStarter, setIsLoadingStarter] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    active: boolean;
    fileName: string;
    bytesSent: number;
    totalBytes: number;
    importedSoFar: number;
    chunksSent: number;
    totalChunks: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelUploadRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Only sync text fields from server polls when user has NOT made unsaved edits
  useEffect(() => {
    setAssistantTone(config.assistantTone);
    setTakeoverPauseMs(config.takeoverPauseMs);
    setAiEnabled(config.aiAssistantEnabled);
    if (!isDirtyRef.current) {
      setOwnerName(config.ownerName);
      setOwnerProfession(config.ownerProfession);
      setOwnerLocation(config.ownerLocation);
      setOwnerBio(config.ownerBio);
      setOwnerBoundaries(config.ownerBoundaries);
      setStrictLogicRules(config.strictLogicRules || '');
      setFirstGreeting(config.firstGreetingTemplate);
    }
  }, [config]);

  function markTextDirty() {
    isDirtyRef.current = true;
    setHasUnsavedText(true);
    setProfileError(null);
  }

  function showQuickNote(msg: string) {
    setQuickSaveNote(msg);
    setTimeout(() => {
      setQuickSaveNote((curr) => (curr === msg ? null : curr));
    }, 2800);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadDictionary = useCallback(
    async (targetPage = page, targetSearch = debouncedSearch, targetDistrict = districtFilter) => {
      setIsLoadingPage(true);
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          limit: '50',
          search: targetSearch,
          district: targetDistrict,
        });
        const res = await authFetch(`/api/dictionary?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setEntries(Array.isArray(data.entries) ? data.entries : []);
          setTotalCount(Number(data.totalCount || 0));
          setTotalPages(Math.max(1, Number(data.totalPages || 1)));
          setPage(Math.max(1, Number(data.page || targetPage)));
          setDistricts(Array.isArray(data.districts) ? data.districts : []);
          setStorageMode(data.storageMode === 'postgres' ? 'postgres' : 'local');
        } else {
          const errData = await res.json().catch(() => ({}));
          setUploadError(errData.error || 'Could not load dictionary entries.');
        }
      } catch (err) {
        setUploadError((err as Error).message);
      } finally {
        setIsLoadingPage(false);
      }
    },
    [page, debouncedSearch, districtFilter]
  );

  useEffect(() => {
    void loadDictionary(page, debouncedSearch, districtFilter);
  }, [page, debouncedSearch, districtFilter, loadDictionary]);

  async function handleToggleAiBrain() {
    const nextVal = !aiEnabled;
    const prevVal = aiEnabled;
    setAiEnabled(nextVal);
    setProfileError(null);
    try {
      await onUpdateConfig({ aiAssistantEnabled: nextVal });
      showQuickNote(nextVal ? 'AI Brain turned ON and saved.' : 'Switched to Static Fallback and saved.');
    } catch (err) {
      setAiEnabled(prevVal);
      setProfileError((err as Error).message || 'Failed to toggle AI Brain.');
    }
  }

  async function handleChangeTakeoverPause(nextMs: number) {
    const prevMs = takeoverPauseMs;
    setTakeoverPauseMs(nextMs);
    setProfileError(null);
    try {
      await onUpdateConfig({ takeoverPauseMs: nextMs });
      showQuickNote(`Takeover pause saved: ${formatPauseLabel(nextMs)}`);
    } catch (err) {
      setTakeoverPauseMs(prevMs);
      setProfileError((err as Error).message || 'Failed to save Human Takeover pause duration.');
    }
  }

  async function handleSelectTone(tone: AssistantTone) {
    const prevTone = assistantTone;
    setAssistantTone(tone);
    setProfileError(null);
    try {
      await onUpdateConfig({ assistantTone: tone });
      showQuickNote('Assistant tone saved.');
    } catch (err) {
      setAssistantTone(prevTone);
      setProfileError((err as Error).message || 'Failed to save tone.');
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setIsSavingProfile(true);
    setProfileError(null);
    try {
      await onUpdateConfig({
        aiAssistantEnabled: aiEnabled,
        ownerName,
        ownerProfession,
        ownerLocation,
        ownerBio,
        ownerBoundaries,
        strictLogicRules,
        firstGreetingTemplate: firstGreeting,
        assistantTone,
        takeoverPauseMs,
      });
      isDirtyRef.current = false;
      setHasUnsavedText(false);
      setProfileSavedToast(true);
      setTimeout(() => setProfileSavedToast(false), 2500);
    } catch (err) {
      setProfileError((err as Error).message || 'Failed to save persona configuration.');
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function handleAddWord(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    setUploadStatus(null);
    if (!term.trim() || !meaning.trim()) {
      setUploadError('Please enter both Word / Dialect phrase and Meaning before clicking Add Entry.');
      return;
    }

    setIsAddingWord(true);
    try {
      const res = await authFetch('/api/dictionary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, meaning, district, language, replyStyleHint }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(data.error || 'Failed to add dictionary entry.');
        return;
      }
      if (data.entry && onSyncDictionaryEntry) {
        await onSyncDictionaryEntry(data.entry).catch(() => {});
      }
      setTerm('');
      setMeaning('');
      setReplyStyleHint('');
      setUploadStatus(`Added "${data.entry?.term || term}" to ${district} dictionary.`);
      setPage(1);
      await loadDictionary(1, debouncedSearch, districtFilter);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setIsAddingWord(false);
    }
  }

  async function handleLoadStarter() {
    setUploadError(null);
    setUploadStatus(null);
    setIsLoadingStarter(true);
    try {
      const res = await authFetch('/api/dictionary/starter', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(data.error || 'Failed to load starter dialect pack.');
        return;
      }
      if (Array.isArray(data.added) && onSyncDictionaryEntry) {
        for (const item of data.added) {
          await onSyncDictionaryEntry(item).catch(() => {});
        }
      }
      setUploadStatus(
        data.importedCount > 0
          ? `Loaded ${data.importedCount} regional dialect & Bangla-English starter phrases.`
          : 'All starter dialect phrases are already in your dictionary.'
      );
      setPage(1);
      await loadDictionary(1, debouncedSearch, districtFilter);
      setTimeout(() => setUploadStatus(null), 4000);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setIsLoadingStarter(false);
    }
  }

  function extractSafeChunkForStreaming(
    buffer: string,
    isFinal: boolean,
    jsonStyle: 'none' | 'array' | 'kv' | 'jsonl'
  ): { chunkToSend: string; remainder: string } {
    if (jsonStyle === 'none' || jsonStyle === 'jsonl') {
      if (isFinal) return { chunkToSend: buffer, remainder: '' };
      const lastNewline = buffer.lastIndexOf('\n');
      if (lastNewline !== -1) {
        return {
          chunkToSend: buffer.slice(0, lastNewline),
          remainder: buffer.slice(lastNewline + 1),
        };
      }
      return { chunkToSend: '', remainder: buffer };
    }

    if (isFinal) {
      if (jsonStyle === 'array') {
        const rawTrim = buffer.trim().replace(/^,+/, '');
        const lastBrace = rawTrim.lastIndexOf('}');
        const firstBrace = rawTrim.indexOf('{');
        if (firstBrace !== -1 && lastBrace >= firstBrace) {
          return { chunkToSend: `[${rawTrim.slice(firstBrace, lastBrace + 1)}]`, remainder: '' };
        }
        return { chunkToSend: '', remainder: '' };
      }
      const piece = buffer
        .trim()
        .replace(/^,+/, '')
        .replace(/,+\s*$/, '')
        .replace(/\}\s*$/, '')
        .replace(/,\s*$/, '');
      return { chunkToSend: piece ? `{${piece}}` : '', remainder: '' };
    }

    let inString = false;
    let escaped = false;
    let depth = 0;
    let lastSafeCut = -1;

    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{' || ch === '[') {
        depth += 1;
      } else if (ch === '}' || ch === ']') {
        depth = Math.max(0, depth - 1);
        if (jsonStyle === 'array' && ch === '}' && depth === 0) {
          lastSafeCut = i + 1;
        }
      } else if (jsonStyle === 'kv' && ch === ',' && depth === 0) {
        lastSafeCut = i + 1;
      }
    }

    if (lastSafeCut > 0) {
      let piece = buffer.slice(0, lastSafeCut).trim();
      const rem = buffer.slice(lastSafeCut);
      if (jsonStyle === 'array') {
        const firstBrace = piece.indexOf('{');
        const lastBrace = piece.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace >= firstBrace) {
          piece = `[${piece.slice(firstBrace, lastBrace + 1)}]`;
        } else {
          piece = '';
        }
      } else {
        piece = piece.replace(/^,+/, '').replace(/,\s*$/, '');
        piece = piece ? `{${piece}}` : '';
      }
      return { chunkToSend: piece, remainder: rem };
    }

    return { chunkToSend: '', remainder: buffer };
  }

  function handleCancelUpload() {
    cancelUploadRef.current = true;
    uploadAbortRef.current?.abort();
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadStatus(null);
    cancelUploadRef.current = false;

    const CHUNK_BYTES = 256 * 1024; // 256 KB per binary slice -> Zero RAM spike even for 100 MB+ files
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
    const isJsonExt = file.name.toLowerCase().endsWith('.json');
    const decoder = new TextDecoder('utf-8');

    setUploadProgress({
      active: true,
      fileName: file.name,
      bytesSent: 0,
      totalBytes: file.size,
      importedSoFar: 0,
      chunksSent: 0,
      totalChunks,
    });

    let offset = 0;
    let chunkIndex = 0;
    let remainder = '';
    let importedSoFar = 0;
    let finalTotalCount = totalCount;
    let lastStorageMode: 'postgres' | 'local' = storageMode;
    let jsonStyle: 'none' | 'array' | 'kv' | 'jsonl' = isJsonExt ? 'jsonl' : 'none';
    let detectedJsonHeader = false;

    try {
      while (offset < file.size || remainder.trim().length > 0) {
        if (cancelUploadRef.current) {
          setUploadStatus(`Upload cancelled after importing ${importedSoFar.toLocaleString()} entries.`);
          break;
        }

        const isLastSlice = offset + CHUNK_BYTES >= file.size;
        let decoded = '';
        if (offset < file.size) {
          const slice = file.slice(offset, offset + CHUNK_BYTES);
          const buffer = await slice.arrayBuffer();

          // Guard against accidental binary file uploads (ZIP, PDF, images, etc.)
          if (offset === 0) {
            const bytes = new Uint8Array(buffer.slice(0, 1024));
            let nullBytes = 0;
            for (let b = 0; b < bytes.length; b += 1) {
              if (bytes[b] === 0) nullBytes += 1;
            }
            if (nullBytes > 2) {
              throw new Error(
                'Binary file detected. Please upload a UTF-8 text dictionary (.txt, .csv, .tsv, .json, .jsonl, .md).'
              );
            }
          }

          decoded = decoder.decode(buffer, { stream: !isLastSlice });
          offset += CHUNK_BYTES;
        } else {
          decoded = decoder.decode();
        }

        let combined = (remainder + decoded).replace(/^\uFEFF/, '');

        // Detect JSON container layout once at stream start and strip outer wrapper so every chunk splits at depth 0
        if (isJsonExt && !detectedJsonHeader) {
          detectedJsonHeader = true;
          const trimmedStart = combined.trimStart();
          const wrappedArrayMatch = trimmedStart.match(
            /^\{\s*"(?:entries|words|data|dictionary)"\s*:\s*\[/i
          );
          if (wrappedArrayMatch) {
            jsonStyle = 'array';
            combined = trimmedStart.slice(wrappedArrayMatch[0].length);
          } else if (trimmedStart.startsWith('[')) {
            jsonStyle = 'array';
            combined = trimmedStart.slice(1);
          } else if (trimmedStart.startsWith('{')) {
            // Distinguish JSONL ({...}\n{...}) vs KV map ({"word":"meaning",...})
            const firstLine = trimmedStart.split(/\r?\n/, 1)[0].trim();
            if (firstLine.startsWith('{') && firstLine.endsWith('}') && trimmedStart.includes('\n{')) {
              jsonStyle = 'jsonl';
            } else {
              jsonStyle = 'kv';
              combined = trimmedStart.slice(1);
            }
          }
        }

        const { chunkToSend, remainder: nextRem } = extractSafeChunkForStreaming(
          combined,
          isLastSlice && offset >= file.size,
          jsonStyle
        );
        remainder = nextRem;

        if (chunkToSend.trim().length > 0) {
          const controller = new AbortController();
          uploadAbortRef.current = controller;
          const res = await authFetch('/api/dictionary/import-chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: chunkToSend,
              fileName: file.name,
              chunkIndex,
              totalChunks,
            }),
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || `Chunk #${chunkIndex + 1} import failed.`);
          }
          importedSoFar += Number(data.insertedCount ?? data.parsedCount ?? 0);
          finalTotalCount = Number(data.totalCount ?? finalTotalCount);
          if (data.storageMode === 'postgres' || data.storageMode === 'local') {
            lastStorageMode = data.storageMode;
          }
        }

        chunkIndex += 1;
        setUploadProgress({
          active: true,
          fileName: file.name,
          bytesSent: Math.min(offset, file.size),
          totalBytes: file.size,
          importedSoFar,
          chunksSent: Math.min(chunkIndex, totalChunks),
          totalChunks,
        });

        // If remainder grew dangerously large (e.g. single unbroken >2MB line), flush safely
        if (remainder.length > 2 * 1024 * 1024) {
          remainder = '';
        }

        if (isLastSlice && offset >= file.size && !remainder.trim()) {
          break;
        }
      }

      if (!cancelUploadRef.current) {
        setUploadStatus(
          `Streamed ${importedSoFar.toLocaleString()} entries from ${file.name} into ${
            lastStorageMode === 'postgres' ? 'PostgreSQL' : 'local dictionary'
          } (Total: ${finalTotalCount.toLocaleString()}).`
        );
      }
      setPage(1);
      await loadDictionary(1, debouncedSearch, districtFilter);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || cancelUploadRef.current) {
        setUploadStatus(`Upload cancelled (${importedSoFar.toLocaleString()} entries saved).`);
      } else {
        setUploadError((err as Error).message);
      }
    } finally {
      uploadAbortRef.current = null;
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteEntry(id: string) {
    setUploadError(null);
    try {
      const res = await authFetch(`/api/dictionary/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(data.error || 'Failed to delete dictionary entry.');
        return;
      }
      if (onDeleteDictionaryEntry) {
        await onDeleteDictionaryEntry(id).catch(() => {});
      }
      await loadDictionary(page, debouncedSearch, districtFilter);
    } catch (err) {
      setUploadError((err as Error).message);
    }
  }

  async function handleClearAllDictionary() {
    setUploadError(null);
    setUploadStatus(null);
    setIsClearingAll(true);
    try {
      const res = await authFetch('/api/dictionary', { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadError(data.error || 'Failed to clear dictionary.');
        return;
      }
      setConfirmClearAll(false);
      setUploadStatus('Cleared all dictionary entries.');
      setPage(1);
      await loadDictionary(1, '', 'ALL');
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setIsClearingAll(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Owner Persona, Tone & Boundaries */}
      <form onSubmit={handleSaveProfile} className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-600" />
              AI Personal Executive Assistant
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Configure how your 24/7 AI assistant introduces itself, praises Sir positively, handles playful banter, and declines out-of-scope requests.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleToggleAiBrain}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                aiEnabled
                  ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {aiEnabled ? 'AI Brain: ON' : 'AI Brain: Static Fallback'}
            </button>

            <button
              type="submit"
              disabled={isSavingProfile}
              className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {profileSavedToast ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : null}
              {isSavingProfile ? 'Saving...' : profileSavedToast ? 'Saved!' : 'Save Persona'}
            </button>
          </div>
        </div>

        {profileError && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
            {profileError}
          </div>
        )}

        {quickSaveNote && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 shrink-0" />
            <span>{quickSaveNote}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600">Owner Name</label>
            <input
              type="text"
              value={ownerName}
              onChange={(e) => {
                setOwnerName(e.target.value);
                markTextDirty();
              }}
              placeholder="e.g. Sir / Afnan"
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Profession / Role</label>
            <input
              type="text"
              value={ownerProfession}
              onChange={(e) => {
                setOwnerProfession(e.target.value);
                markTextDirty();
              }}
              placeholder="e.g. Software Engineer & Entrepreneur"
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Location</label>
            <input
              type="text"
              value={ownerLocation}
              onChange={(e) => {
                setOwnerLocation(e.target.value);
                markTextDirty();
              }}
              placeholder="e.g. Dhaka, Bangladesh"
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-medium text-slate-600">
              Positive Bio (What AI shares when someone asks about Sir)
            </label>
            <textarea
              rows={4}
              value={ownerBio}
              onChange={(e) => {
                setOwnerBio(e.target.value);
                markTextDirty();
              }}
              className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              placeholder="Write what you do, your strengths, and how people can reach you..."
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">
              Boundaries / What Sir Does NOT Do (Out-of-scope rejection rules)
            </label>
            <textarea
              rows={4}
              value={ownerBoundaries}
              onChange={(e) => {
                setOwnerBoundaries(e.target.value);
                markTextDirty();
              }}
              className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              placeholder="e.g. Sir does not arrange flat/room rentals or lend money..."
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600">
            Strict Logic, Debate, Emotion &amp; Time-Lapse Rules (যুক্তি-তর্ক, আবেগ ও সময়-সচেতনতা নিয়ম)
          </label>
          <textarea
            rows={4}
            value={strictLogicRules}
            onChange={(e) => {
              setStrictLogicRules(e.target.value);
              markTextDirty();
            }}
            className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            placeholder="Rules governing how the AI debates logically, matches human emotion, reads full inbox continuity, and tracks BD time gaps..."
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <label className="block text-xs font-medium text-slate-600">
              First Greeting Style (Sent on new conversations only)
            </label>
            <textarea
              rows={2}
              value={firstGreeting}
              onChange={(e) => {
                setFirstGreeting(e.target.value);
                markTextDirty();
              }}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>

          <div className="lg:col-span-5">
            <label className="block text-xs font-medium text-slate-600">
              Smart Human Takeover Pause (Auto-saves when changed)
            </label>
            <select
              value={takeoverPauseMs}
              onChange={(e) => void handleChangeTakeoverPause(Number(e.target.value))}
              className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value={900000}>Pause AI for 15 minutes</option>
              <option value={1200000}>Pause AI for 20 minutes</option>
              <option value={1800000}>Pause AI for 30 minutes</option>
              <option value={3600000}>Pause AI for 60 minutes</option>
              <option value={0}>No auto-pause</option>
            </select>
            <div className="mt-1 text-[11px] text-slate-500">
              Active setting: <span className="font-medium text-slate-800">{formatPauseLabel(config.takeoverPauseMs)}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-slate-600 mb-2">Assistant Personality &amp; Banter Tone (Auto-saves when clicked)</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {TONE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => void handleSelectTone(opt.id)}
                className={`p-3.5 text-left rounded-lg border transition-colors cursor-pointer ${
                  assistantTone === opt.id
                    ? 'border-emerald-600 bg-emerald-50/70'
                    : 'border-slate-200 bg-white hover:bg-slate-50'
                }`}
              >
                <div className="text-xs font-semibold text-slate-900">{opt.label}</div>
                <div className="mt-1 text-[11px] text-slate-600 leading-relaxed">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Bottom Save Bar (convenient on mobile) */}
        <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            {hasUnsavedText
              ? 'You have unsaved text edits in Bio, Name, Boundaries, Logic Rules, or Greeting.'
              : 'All persona & bio changes are up to date.'}
          </div>
          <button
            type="submit"
            disabled={isSavingProfile}
            className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          >
            {profileSavedToast ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : null}
            {isSavingProfile ? 'Saving...' : profileSavedToast ? 'Saved!' : 'Save Persona'}
          </button>
        </div>
      </form>

      {/* 64-District Bangla & English Dictionary Uploader (Zero-RAM Streaming + Postgres Paginated) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-emerald-600" />
              64-District Bangla &amp; English Dictionary
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Upload any <span className="font-mono text-xs text-slate-800">.txt</span>,{' '}
              <span className="font-mono text-xs text-slate-800">.csv</span>,{' '}
              <span className="font-mono text-xs text-slate-800">.tsv</span>,{' '}
              <span className="font-mono text-xs text-slate-800">.json</span>,{' '}
              <span className="font-mono text-xs text-slate-800">.jsonl</span>, or{' '}
              <span className="font-mono text-xs text-slate-800">.md</span> file (6MB–100MB+). Auto-detects{' '}
              <span className="font-mono text-xs">| - : = =&gt; , ।</span> formats and streams in 256KB chunks straight to{' '}
              {storageMode === 'postgres' ? 'PostgreSQL' : 'storage'} with zero RAM lag.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleLoadStarter}
              disabled={isLoadingStarter || Boolean(uploadProgress?.active)}
              className="px-3.5 py-2 text-xs font-medium bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              {isLoadingStarter ? 'Loading...' : 'Load Starter Pack'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv,.tsv,.json,.jsonl,.md,.dic,.lst,text/plain,text/csv,application/json"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              disabled={Boolean(uploadProgress?.active)}
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {uploadProgress?.active ? 'Streaming...' : 'Upload Dictionary File'}
            </button>
            {totalCount > 0 && !uploadProgress?.active && (
              confirmClearAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={isClearingAll}
                    onClick={() => void handleClearAllDictionary()}
                    className="px-3 py-2 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 whitespace-nowrap cursor-pointer"
                  >
                    {isClearingAll ? 'Clearing...' : 'Confirm Clear All'}
                  </button>
                  <button
                    type="button"
                    disabled={isClearingAll}
                    onClick={() => setConfirmClearAll(false)}
                    className="px-2.5 py-2 text-xs font-medium bg-white text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(true)}
                  className="px-3 py-2 text-xs font-medium bg-white text-red-600 border border-slate-200 rounded-lg hover:bg-red-50 whitespace-nowrap cursor-pointer"
                >
                  Clear All
                </button>
              )
            )}
          </div>
        </div>

        {uploadProgress?.active && (
          <div className="px-6 py-3.5 bg-slate-50 border-b border-slate-200 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="font-medium text-slate-800 truncate max-w-md">
                Streaming <span className="font-mono">{uploadProgress.fileName}</span>
              </div>
              <div className="flex items-center gap-3 tabular-nums text-slate-600">
                <span>
                  {(uploadProgress.bytesSent / (1024 * 1024)).toFixed(2)} /{' '}
                  {(uploadProgress.totalBytes / (1024 * 1024)).toFixed(2)} MB
                </span>
                <span className="font-semibold text-emerald-700">
                  {uploadProgress.importedSoFar.toLocaleString()} entries saved
                </span>
                <span>
                  {uploadProgress.totalBytes > 0
                    ? Math.min(100, Math.round((uploadProgress.bytesSent / uploadProgress.totalBytes) * 100))
                    : 0}
                  %
                </span>
                <button
                  type="button"
                  onClick={handleCancelUpload}
                  className="px-2 py-1 text-[11px] font-medium text-red-600 bg-white border border-slate-200 rounded hover:bg-red-50 flex items-center gap-1 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-600 transition-all duration-150"
                style={{
                  width: `${
                    uploadProgress.totalBytes > 0
                      ? Math.min(100, Math.round((uploadProgress.bytesSent / uploadProgress.totalBytes) * 100))
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {(uploadStatus || uploadError) && (
          <div
            className={`px-6 py-3 text-xs border-b border-slate-200 ${
              uploadError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
            }`}
          >
            {uploadError || uploadStatus}
          </div>
        )}

        {/* Quick Add Single Phrase */}
        <form onSubmit={handleAddWord} className="p-6 border-b border-slate-200 bg-slate-50/70 grid grid-cols-1 md:grid-cols-12 gap-3">
          <input
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Word / Dialect phrase (e.g. কেনে আছো)"
            className="md:col-span-3 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
          />
          <input
            type="text"
            value={meaning}
            onChange={(e) => setMeaning(e.target.value)}
            placeholder="Meaning in Bangla/English"
            className="md:col-span-3 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
          />
          <input
            type="text"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
            placeholder="District (e.g. Chattogram)"
            className="md:col-span-2 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
          />
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as DictionaryEntry['language'])}
            className="md:col-span-2 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            aria-label="Language tag for new entry"
          >
            <option value="bn_dialect">Regional Dialect</option>
            <option value="bn_en">Bangla-English</option>
            <option value="en_slang">English / Slang</option>
          </select>
          <input
            type="text"
            value={replyStyleHint}
            onChange={(e) => setReplyStyleHint(e.target.value)}
            placeholder="Optional reply hint / banter style"
            className="md:col-span-10 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
          />
          <button
            type="submit"
            disabled={isAddingWord}
            className="md:col-span-2 px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            {isAddingWord ? 'Adding...' : 'Add Entry'}
          </button>
        </form>

        {/* Search & Filter */}
        <div className="px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search words, meanings, or districts..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-500 tabular-nums">
              {storageMode === 'postgres' ? 'PostgreSQL Unlimited' : 'Local Cache'} ·{' '}
              {totalCount.toLocaleString()} total
            </span>
            <select
              value={districtFilter}
              onChange={(e) => {
                setDistrictFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="ALL">All Districts ({totalCount.toLocaleString()})</option>
              {districts.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {isLoadingPage
              ? 'Loading dictionary entries...'
              : 'No matching dictionary entries found. Click Load Starter Pack or upload your own dictionary file above.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="py-2.5 px-6">District</th>
                    <th className="py-2.5 px-4">Term / Phrase</th>
                    <th className="py-2.5 px-4">Meaning</th>
                    <th className="py-2.5 px-4">Reply Style Hint</th>
                    <th className="py-2.5 px-6 text-right">Remove</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-6 font-medium text-slate-900 whitespace-nowrap">
                        {entry.district}
                      </td>
                      <td className="py-2.5 px-4 text-slate-800 font-medium">{entry.term}</td>
                      <td className="py-2.5 px-4 text-slate-600">{entry.meaning}</td>
                      <td className="py-2.5 px-4 text-slate-500 max-w-xs truncate">
                        {entry.replyStyleHint || '—'}
                      </td>
                      <td className="py-2.5 px-6 text-right">
                        <button
                          type="button"
                          onClick={() => handleDeleteEntry(entry.id)}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                          title="Delete entry"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
              <div className="tabular-nums">
                Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, totalCount)} of{' '}
                {totalCount.toLocaleString()} entries
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1 || isLoadingPage}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Prev
                </button>
                <span className="px-2 font-medium text-slate-800 tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages || isLoadingPage}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
