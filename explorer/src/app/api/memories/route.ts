import { NextRequest, NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const project = searchParams.get('project');
  const kind = searchParams.get('kind');
  const speaker = searchParams.get('speaker');
  const limit = parseInt(searchParams.get('limit') ?? '200');

  if (!project) {
    return NextResponse.json({ error: 'project parameter required' }, { status: 400 });
  }

  const memory = await getMemoryService();
  const all = await memory.getByProject(project, { limit: 1000 });

  // Dedup by id (LanceDB can return duplicates)
  const seen = new Set<string>();
  let filtered = all.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if (kind) filtered = filtered.filter((m) => m.kind === kind);
  if (speaker) filtered = filtered.filter((m) => m.speaker === speaker);

  // Sort by createdAt descending
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({
    memories: filtered.slice(0, limit),
    total: filtered.length,
  });
}
