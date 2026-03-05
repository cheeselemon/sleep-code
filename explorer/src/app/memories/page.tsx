'use client';

import { useEffect, useState } from 'react';
import KindBadge from '@/components/KindBadge';
import MemoryDetail from '@/components/MemoryDetail';

interface Memory {
  id: string;
  text: string;
  kind: string;
  speaker: string;
  project: string;
  priority: number;
  topicKey: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface Project {
  name: string;
  count: number;
}

const KINDS = ['decision', 'fact', 'task', 'proposal', 'feedback', 'observation', 'dialog_summary'];
const SPEAKERS = ['user', 'claude', 'codex', 'system'];

export default function MemoriesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [selectedKind, setSelectedKind] = useState<string>('');
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [sortField, setSortField] = useState<'createdAt' | 'priority'>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    fetch('/api/projects').then((r) => r.json()).then((d) => {
      setProjects(d.projects);
      if (d.projects.length > 0 && !selectedProject) {
        setSelectedProject(d.projects[0].name);
      }
    });
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    setLoading(true);
    const params = new URLSearchParams({ project: selectedProject, limit: '500' });
    if (selectedKind) params.set('kind', selectedKind);
    if (selectedSpeaker) params.set('speaker', selectedSpeaker);
    fetch(`/api/memories?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setMemories(d.memories);
        setTotal(d.total);
        setLoading(false);
      });
  }, [selectedProject, selectedKind, selectedSpeaker]);

  const sorted = [...memories].sort((a, b) => {
    if (sortField === 'priority') {
      return sortDir === 'desc' ? b.priority - a.priority : a.priority - b.priority;
    }
    return sortDir === 'desc'
      ? b.createdAt.localeCompare(a.createdAt)
      : a.createdAt.localeCompare(b.createdAt);
  });

  const handleDelete = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: 'DELETE' });
    setMemories((prev) => prev.filter((m) => m.id !== id));
    setTotal((prev) => prev - 1);
    setSelected(null);
  };

  const toggleSort = (field: 'createdAt' | 'priority') => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  return (
    <div className="max-w-6xl">
      <h2 className="text-2xl font-bold mb-4">Memories</h2>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
        >
          {projects.map((p) => (
            <option key={p.name} value={p.name}>{p.name} ({p.count})</option>
          ))}
        </select>
        <select
          value={selectedKind}
          onChange={(e) => setSelectedKind(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
        >
          <option value="">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select
          value={selectedSpeaker}
          onChange={(e) => setSelectedSpeaker(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
        >
          <option value="">All speakers</option>
          {SPEAKERS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-sm text-zinc-500 self-center ml-2">
          {loading ? 'Loading...' : `${total} results`}
        </span>
      </div>

      {/* Table */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-900 text-zinc-400 text-left">
              <th className="px-4 py-3 font-medium">Text</th>
              <th className="px-4 py-3 font-medium w-24">Kind</th>
              <th className="px-4 py-3 font-medium w-20">Speaker</th>
              <th
                className="px-4 py-3 font-medium w-20 cursor-pointer hover:text-zinc-200"
                onClick={() => toggleSort('priority')}
              >
                Priority {sortField === 'priority' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
              <th className="px-4 py-3 font-medium w-24">Topic</th>
              <th
                className="px-4 py-3 font-medium w-28 cursor-pointer hover:text-zinc-200"
                onClick={() => toggleSort('createdAt')}
              >
                Date {sortField === 'createdAt' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr
                key={m.id}
                onClick={() => setSelected(m)}
                className="border-t border-zinc-800/50 hover:bg-zinc-800/30 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3 text-zinc-300 max-w-md truncate">{m.text}</td>
                <td className="px-4 py-3"><KindBadge kind={m.kind} /></td>
                <td className="px-4 py-3 text-zinc-400">{m.speaker}</td>
                <td className="px-4 py-3 text-zinc-400">{m.priority}</td>
                <td className="px-4 py-3 text-zinc-500 text-xs">{m.topicKey}</td>
                <td className="px-4 py-3 text-zinc-500 text-xs">{m.createdAt.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <MemoryDetail memory={selected} onClose={() => setSelected(null)} onDelete={handleDelete} />
      )}
    </div>
  );
}
