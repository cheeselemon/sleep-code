const KIND_COLORS: Record<string, string> = {
  decision: 'bg-emerald-500/20 text-emerald-400',
  fact: 'bg-blue-500/20 text-blue-400',
  task: 'bg-amber-500/20 text-amber-400',
  proposal: 'bg-purple-500/20 text-purple-400',
  feedback: 'bg-rose-500/20 text-rose-400',
  observation: 'bg-zinc-500/20 text-zinc-400',
  dialog_summary: 'bg-cyan-500/20 text-cyan-400',
};

export default function KindBadge({ kind }: { kind: string }) {
  const color = KIND_COLORS[kind] ?? 'bg-zinc-500/20 text-zinc-400';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {kind}
    </span>
  );
}
