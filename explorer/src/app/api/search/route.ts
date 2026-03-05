import { NextRequest, NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get('q');
  const project = searchParams.get('project') ?? undefined;
  const limit = parseInt(searchParams.get('limit') ?? '20');

  if (!q) {
    return NextResponse.json({ error: 'q parameter required' }, { status: 400 });
  }

  const memory = await getMemoryService();
  const results = await memory.search(q, { project, limit });

  return NextResponse.json({ results });
}
