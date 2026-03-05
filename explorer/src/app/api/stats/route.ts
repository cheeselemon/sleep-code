import { NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';

export async function GET() {
  const memory = await getMemoryService();
  const projectNames = await memory.listProjects();

  const projects = await Promise.all(
    projectNames.map(async (name) => ({
      name,
      count: await memory.countByProject(name),
    }))
  );

  // Kind distribution across all projects
  const kindDist: Record<string, number> = {};
  const speakerDist: Record<string, number> = {};
  let total = 0;

  for (const p of projectNames) {
    const memories = await memory.getByProject(p, { limit: 1000 });
    for (const m of memories) {
      kindDist[m.kind] = (kindDist[m.kind] ?? 0) + 1;
      speakerDist[m.speaker] = (speakerDist[m.speaker] ?? 0) + 1;
      total++;
    }
  }

  return NextResponse.json({
    total,
    projects,
    kindDistribution: kindDist,
    speakerDistribution: speakerDist,
  });
}
