import { useEffect, useState } from 'react';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';
import { authFetch } from '../lib/api';
import type { SourceFileItem } from '../types';

export function SourceExplorer() {
  const [files, setFiles] = useState<SourceFileItem[]>([]);
  const [selectedName, setSelectedName] = useState<string>('index.js');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    authFetch('/api/source-files')
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((data) => {
        if (!active) return;
        const list: SourceFileItem[] = data.files || [];
        setFiles(list);
        if (list.length > 0 && !list.some((f) => f.name === selectedName)) {
          setSelectedName(list[0].name);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentFile = files.find((f) => f.name === selectedName) || files[0];

  async function handleCopy() {
    if (!currentFile) return;
    await navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  function handleDownload(file: SourceFileItem) {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Render Deployment Steps */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-slate-900">
          Render Production Deployment Package
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Complete standalone Node.js source files located in <span className="font-mono text-slate-800">/bot/</span>. Copy or download them directly to deploy as a Render Web Service.
        </p>

        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-200 pt-5 text-xs text-slate-700">
          <div>
            <div className="font-semibold text-slate-900">01. Environment Variables</div>
            <p className="mt-1 text-slate-600">
              Set <span className="font-mono text-slate-800">GEMINI_API_KEY</span> and <span className="font-mono text-slate-800">PAIRING_PHONE_NUMBER</span> (digits with country code) in Render Dashboard.
            </p>
          </div>
          <div>
            <div className="font-semibold text-slate-900">02. Build &amp; Start Commands</div>
            <p className="mt-1 text-slate-600">
              Build: <span className="font-mono text-slate-800">npm install</span> &middot; Start: <span className="font-mono text-slate-800">npm start</span>. Built-in HTTP <span className="font-mono text-slate-800">/health</span> keeps Render alive.
            </p>
          </div>
          <div>
            <div className="font-semibold text-slate-900">03. Pairing in Render Logs</div>
            <p className="mt-1 text-slate-600">
              On first boot, copy the 8-digit pairing code printed in Render Logs and enter it in WhatsApp Linked Devices.
            </p>
          </div>
        </div>
      </section>

      {/* Code Explorer */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-slate-50">
          <div className="flex flex-wrap items-center gap-1.5">
            {files.map((file) => (
              <button
                key={file.name}
                type="button"
                onClick={() => setSelectedName(file.name)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                  file.name === currentFile?.name
                    ? 'bg-white text-slate-900 border border-slate-200 shadow-xs font-medium'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5" />
                {file.name}
              </button>
            ))}
          </div>

          {currentFile && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 text-xs font-medium bg-white text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy Code'}
              </button>
              <button
                type="button"
                onClick={() => handleDownload(currentFile)}
                className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download {currentFile.name}
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-500">Loading bot source files...</div>
        ) : currentFile ? (
          <pre className="p-5 text-xs font-mono leading-relaxed text-slate-800 bg-white overflow-x-auto max-h-[620px]">
            <code>{currentFile.content}</code>
          </pre>
        ) : (
          <div className="p-8 text-sm text-slate-500">No source files found.</div>
        )}
      </section>
    </div>
  );
}
