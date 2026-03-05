'use client';

import { useEffect, useState } from 'react';
import KindBadge from '@/components/KindBadge';
import SearchBar from '@/components/SearchBar';

interface Stats {
  total: number;
  projects: { name: string; count: number }[];
  kindDistribution: Record<string, number>;
  speakerDistribution: Record<string, number>;
}

const PROJECT_COLORS: Record<string, string> = {
  'sleep-code': 'border-blue-500/50 bg-blue-500/5',
  'cpik-inc': 'border-emerald-500/50 bg-emerald-500/5',
  'tpt-strategy': 'border-amber-500/50 bg-amber-500/5',
  'personal-memory': 'border-purple-500/50 bg-purple-500/5',
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/api/stats').then((r) => r.json()).then(setStats);
  }, []);

  if (!stats) {
    return <div className="text-zinc-500 animate-pulse">Loading...</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-1">Dashboard</h2>
        <p className="text-sm text-zinc-500">{stats.total} memories across {stats.projects.length} projects</p>
      </div>

      {/* Search */}
      <SearchBar />

      {/* Project Cards */}
      <div className="grid grid-cols-2 gap-4">
        {stats.projects.map((p) => (
          <div
            key={p.name}
            className={`border rounded-xl p-5 ${PROJECT_COLORS[p.name] ?? 'border-zinc-700 bg-zinc-800/30'}`}
          >
            <div className="text-sm font-medium text-zinc-300">{p.name}</div>
            <div className="text-3xl font-bold mt-1 text-zinc-100">{p.count}</div>
            <div className="text-xs text-zinc-500 mt-1">memories</div>
          </div>
        ))}
      </div>

      {/* Kind Distribution */}
      <div>
        <h3 className="text-sm font-medium text-zinc-400 mb-3">Kind Distribution</h3>
        <div className="flex flex-wrap gap-3">
          {Object.entries(stats.kindDistribution)
            .sort(([, a], [, b]) => b - a)
            .map(([kind, count]) => (
              <div key={kind} className="flex items-center gap-2">
                <KindBadge kind={kind} />
                <span className="text-sm text-zinc-400">{count}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Speaker Distribution */}
      <div>
        <h3 className="text-sm font-medium text-zinc-400 mb-3">Speaker Distribution</h3>
        <div className="flex flex-wrap gap-4">
          {Object.entries(stats.speakerDistribution)
            .sort(([, a], [, b]) => b - a)
            .map(([speaker, count]) => (
              <div key={speaker} className="text-sm">
                <span className="text-zinc-300 font-medium">{speaker}</span>
                <span className="text-zinc-500 ml-2">{count}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
