import { NextRequest, NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const memory = await getMemoryService();
  const projects = await memory.listProjects();

  for (const project of projects) {
    const memories = await memory.getByProject(project, { limit: 1000 });
    const found = memories.find((m) => m.id === id);
    if (found) {
      return NextResponse.json(found);
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const memory = await getMemoryService();
  await memory.remove(id);
  return NextResponse.json({ success: true });
}
