import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Plus, Search, Sparkles, Trash2, Upload } from 'lucide-react';
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
  const [firstGreeting, setFirstGreeting] = useState(config.firstGreetingTemplate);
  const [assistantTone, setAssistantTone] = useState<AssistantTone>(config.assistantTone);
  const [takeoverPauseMs, setTakeoverPauseMs] = useState(config.takeoverPauseMs);
  const [aiEnabled, setAiEnabled] = useState(config.aiAssistantEnabled);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSavedToast, setProfileSavedToast] = useState(false);

  // Dictionary State
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [districtFilter, setDistrictFilter] = useState('ALL');
  const [term, setTerm] = useState('');
  const [meaning, setMeaning] = useState('');
  const [district, setDistrict] = useState('Dhaka');
  const [language, setLanguage] = useState<DictionaryEntry['language']>('bn_dialect');
  const [replyStyleHint, setReplyStyleHint] = useState('');
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOwnerName(config.ownerName);
    setOwnerProfession(config.ownerProfession);
    setOwnerLocation(config.ownerLocation);
    setOwnerBio(config.ownerBio);
    setOwnerBoundaries(config.ownerBoundaries);
    setFirstGreeting(config.firstGreetingTemplate);
    setAssistantTone(config.assistantTone);
    setTakeoverPauseMs(config.takeoverPauseMs);
    setAiEnabled(config.aiAssistantEnabled);
  }, [config]);

  async function loadDictionary() {
    const res = await authFetch('/api/dictionary');
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries || []);
    }
  }

  useEffect(() => {
    void loadDictionary();
  }, []);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setIsSavingProfile(true);
    try {
      await onUpdateConfig({
        aiAssistantEnabled: aiEnabled,
        ownerName,
        ownerProfession,
        ownerLocation,
        ownerBio,
        ownerBoundaries,
        firstGreetingTemplate: firstGreeting,
        assistantTone,
        takeoverPauseMs,
      });
      setProfileSavedToast(true);
      setTimeout(() => setProfileSavedToast(false), 2000);
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function handleAddWord(e: React.FormEvent) {
    e.preventDefault();
    if (!term.trim() || !meaning.trim()) return;
    const res = await authFetch('/api/dictionary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, meaning, district, language, replyStyleHint }),
    });
    const data = await res.json();
    if (res.ok) {
      setEntries(data.entries || []);
      if (data.entry && onSyncDictionaryEntry) {
        await onSyncDictionaryEntry(data.entry);
      }
      setTerm('');
      setMeaning('');
      setReplyStyleHint('');
    }
  }

  async function handleLoadStarter() {
    setUploadError(null);
    const res = await authFetch('/api/dictionary/starter', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      setEntries(data.entries || []);
      setUploadStatus(`Loaded ${data.importedCount} regional dialect & Bangla-English starter phrases.`);
      setTimeout(() => setUploadStatus(null), 4000);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploadStatus(null);

    try {
      const content = await file.text();
      const res = await authFetch('/api/dictionary/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, fileName: file.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error || 'Import failed.');
        return;
      }
      setEntries(data.entries || []);
      if (Array.isArray(data.added) && onSyncDictionaryEntry) {
        for (const item of data.added.slice(0, 30)) {
          await onSyncDictionaryEntry(item);
        }
      }
      setUploadStatus(`Imported ${data.importedCount} dictionary entries from ${file.name}.`);
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDeleteEntry(id: string) {
    const res = await authFetch(`/api/dictionary/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      setEntries(data.entries || []);
      if (onDeleteDictionaryEntry) {
        await onDeleteDictionaryEntry(id);
      }
    }
  }

  const uniqueDistricts = Array.from(new Set(entries.map((e) => e.district))).sort();
  const filteredEntries = entries.filter((entry) => {
    const matchesDistrict = districtFilter === 'ALL' || entry.district === districtFilter;
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      !q ||
      entry.term.toLowerCase().includes(q) ||
      entry.meaning.toLowerCase().includes(q) ||
      entry.district.toLowerCase().includes(q);
    return matchesDistrict && matchesSearch;
  });

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
              onClick={() => setAiEnabled(!aiEnabled)}
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
              {isSavingProfile ? 'Saving...' : profileSavedToast ? 'Saved to Cloud' : 'Save Persona'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600">Owner Name</label>
            <input
              type="text"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="e.g. Sir / Afnan"
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Profession / Role</label>
            <input
              type="text"
              value={ownerProfession}
              onChange={(e) => setOwnerProfession(e.target.value)}
              placeholder="e.g. Software Engineer & Entrepreneur"
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Location</label>
            <input
              type="text"
              value={ownerLocation}
              onChange={(e) => setOwnerLocation(e.target.value)}
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
              onChange={(e) => setOwnerBio(e.target.value)}
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
              onChange={(e) => setOwnerBoundaries(e.target.value)}
              className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
              placeholder="e.g. Sir does not arrange flat/room rentals or lend money..."
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7">
            <label className="block text-xs font-medium text-slate-600">
              First Greeting Style (Sent on new conversations only)
            </label>
            <textarea
              rows={2}
              value={firstGreeting}
              onChange={(e) => setFirstGreeting(e.target.value)}
              className="mt-1.5 w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>

          <div className="lg:col-span-5">
            <label className="block text-xs font-medium text-slate-600">
              Smart Human Takeover Pause (When you reply manually from phone)
            </label>
            <select
              value={takeoverPauseMs}
              onChange={(e) => setTakeoverPauseMs(Number(e.target.value))}
              className="mt-1.5 w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600/20"
            >
              <option value={900000}>Pause AI for 15 minutes</option>
              <option value={1200000}>Pause AI for 20 minutes</option>
              <option value={1800000}>Pause AI for 30 minutes</option>
              <option value={3600000}>Pause AI for 60 minutes</option>
              <option value={0}>No auto-pause</option>
            </select>
          </div>
        </div>

        <div>
          <div className="text-xs font-medium text-slate-600 mb-2">Assistant Personality &amp; Banter Tone</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {TONE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAssistantTone(opt.id)}
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
      </form>

      {/* 64-District Bangla & English Dictionary Uploader */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-emerald-600" />
              64-District Bangla &amp; English Dialect Dictionary
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Upload a <span className="font-mono text-xs text-slate-800">.json</span>, <span className="font-mono text-xs text-slate-800">.csv</span>, or <span className="font-mono text-xs text-slate-800">.txt</span> dictionary (<span className="font-mono text-xs">term | meaning | district | reply hint</span>) so the AI understands and banters in all 64 district dialects.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleLoadStarter}
              className="px-3.5 py-2 text-xs font-medium bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 whitespace-nowrap cursor-pointer"
            >
              Load Starter Dialect Pack
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.csv,.txt"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Dictionary File
            </button>
          </div>
        </div>

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
          <input
            type="text"
            value={replyStyleHint}
            onChange={(e) => setReplyStyleHint(e.target.value)}
            placeholder="Optional reply hint / banter style"
            className="md:col-span-2 px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
          />
          <button
            type="submit"
            className="md:col-span-2 px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Entry
          </button>
        </form>

        {/* Search & Filter */}
        <div className="px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search words, meanings, or districts..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
            />
          </div>

          <div className="flex items-center gap-3">
            <select
              value={districtFilter}
              onChange={(e) => setDistrictFilter(e.target.value)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="ALL">All Districts ({entries.length})</option>
              {uniqueDistricts.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as DictionaryEntry['language'])}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
              aria-label="Default language tag for new entries"
            >
              <option value="bn_dialect">Tag: Regional Dialect</option>
              <option value="bn_en">Tag: Bangla-English</option>
              <option value="en_slang">Tag: English / Slang</option>
            </select>
          </div>
        </div>

        {filteredEntries.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No dictionary entries loaded yet. Click <strong>Load Starter Dialect Pack</strong> or upload your own 64-district dictionary file above.
          </div>
        ) : (
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
                {filteredEntries.map((entry) => (
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
        )}
      </section>
    </div>
  );
}
