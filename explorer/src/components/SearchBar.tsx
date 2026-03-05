'use client';

import { useState } from 'react';
import KindBadge from './KindBadge';

interface SearchResult {
  id: string;
  text: string;
  kind: string;
  speaker: string;
  project: string;
  priority: number;
  topicKey: string;
  createdAt: string;
  score: number;
}

export default function SearchBar({ project }: { project?: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    const params = new URLSearchParams({ q: query, limit: '20' });
    if (project) params.set('project', project);
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();
    setResults(data.results ?? []);
    setLoading(false);
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Semantic search..."
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={search}
          disabled={loading}
          className="px-5 py-2.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {loading ? '...' : 'Search'}
        </button>
      </div>
      {results.length > 0 && (
        <div className="mt-4 space-y-2">
          {results.map((r) => (
            <div key={r.id} className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <KindBadge kind={r.kind} />
                <span className="text-xs text-zinc-500">{r.speaker}</span>
                <span className="text-xs text-zinc-600 ml-auto">
                  score: {r.score.toFixed(3)}
                </span>
              </div>
              <p className="text-sm text-zinc-300">{r.text}</p>
              <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                <span>{r.project}</span>
                {r.topicKey && <span>#{r.topicKey}</span>}
                <span className="ml-auto">{r.createdAt.slice(0, 10)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
