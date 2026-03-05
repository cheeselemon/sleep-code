'use client';

import KindBadge from './KindBadge';

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

export default function MemoryDetail({
  memory,
  onClose,
  onDelete,
}: {
  memory: Memory;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <KindBadge kind={memory.kind} />
            <span className="text-sm text-zinc-400">priority: {memory.priority}</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg">✕</button>
        </div>

        <p className="text-zinc-200 text-sm leading-relaxed mb-4">{memory.text}</p>

        <div className="space-y-2 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>Project</span><span className="text-zinc-400">{memory.project}</span>
          </div>
          <div className="flex justify-between">
            <span>Speaker</span><span className="text-zinc-400">{memory.speaker}</span>
          </div>
          {memory.topicKey && (
            <div className="flex justify-between">
              <span>Topic</span><span className="text-zinc-400">#{memory.topicKey}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Status</span><span className="text-zinc-400">{memory.status}</span>
          </div>
          <div className="flex justify-between">
            <span>Created</span><span className="text-zinc-400">{memory.createdAt}</span>
          </div>
          <div className="flex justify-between">
            <span>ID</span><span className="text-zinc-400 font-mono text-[10px]">{memory.id}</span>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={() => {
              if (confirm('Delete this memory?')) onDelete(memory.id);
            }}
            className="px-4 py-2 bg-red-500/10 text-red-400 hover:bg-red-500/20 rounded-lg text-sm transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
