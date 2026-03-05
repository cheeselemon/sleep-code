import { NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';

export async function GET() {
  const memory = await getMemoryService();
  const names = await memory.listProjects();

  const projects = await Promise.all(
    names.map(async (name) => ({
      name,
      count: await memory.countByProject(name),
    }))
  );

  return NextResponse.json({ projects });
}
