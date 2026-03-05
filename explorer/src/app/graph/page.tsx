'use client';

import { useEffect, useState } from 'react';
import MemoryGraph from '@/components/MemoryGraph';

const KINDS = ['decision', 'fact', 'task', 'proposal', 'feedback', 'observation', 'dialog_summary'];

const PROJECT_DOT_COLORS: Record<string, string> = {
  'sleep-code': 'bg-blue-500',
  'cpik-inc': 'bg-emerald-500',
  'tpt-strategy': 'bg-amber-500',
  'personal-memory': 'bg-purple-500',
};

export default function GraphPage() {
  const [allProjects, setAllProjects] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.7);
  const [kindFilter, setKindFilter] = useState<string[]>([]);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        const names = d.projects.map((p: { name: string }) => p.name);
        setAllProjects(names);
        setSelectedProjects(names);
      });
  }, []);

  const toggleProject = (name: string) => {
    setSelectedProjects((prev) =>
      prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name]
    );
  };

  const toggleKind = (kind: string) => {
    setKindFilter((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    );
  };

  return (
    <div className="flex flex-col h-full -m-6">
      {/* Control bar */}
      <div className="flex items-center gap-6 px-6 py-3 bg-zinc-900 border-b border-zinc-800 shrink-0">
        {/* Projects */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 mr-1">Projects:</span>
          {allProjects.map((p) => (
            <button
              key={p}
              onClick={() => toggleProject(p)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                selectedProjects.includes(p)
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'bg-zinc-800/50 text-zinc-500'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${PROJECT_DOT_COLORS[p] ?? 'bg-zinc-500'}`} />
              {p}
            </button>
          ))}
        </div>

        {/* Threshold slider */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Threshold:</span>
          <input
            type="range"
            min="0.3"
            max="0.95"
            step="0.05"
            value={threshold}
            onChange={(e) => setThreshold(parseFloat(e.target.value))}
            className="w-28 accent-zinc-400"
          />
          <span className="text-xs text-zinc-400 w-8">{threshold.toFixed(2)}</span>
        </div>

        {/* Kind filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 mr-1">Kind:</span>
          {KINDS.map((k) => (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                kindFilter.length === 0 || kindFilter.includes(k)
                  ? 'bg-zinc-700 text-zinc-300'
                  : 'bg-zinc-800/50 text-zinc-600'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {/* Graph */}
      <div className="flex-1 min-h-0">
        <MemoryGraph
          projects={selectedProjects}
          threshold={threshold}
          kindFilter={kindFilter}
        />
      </div>
    </div>
  );
}
