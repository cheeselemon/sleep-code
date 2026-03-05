import { NextRequest, NextResponse } from 'next/server';
import { getMemoryService } from '@/lib/memory';
import { cosine } from '@/lib/cosine';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const projectsParam = searchParams.get('projects');
  const threshold = parseFloat(searchParams.get('threshold') ?? '0.7');

  const memory = await getMemoryService();
  const allProjects = projectsParam
    ? projectsParam.split(',')
    : await memory.listProjects();

  // Load all memories with vectors
  const allNodes: {
    id: string; text: string; project: string; kind: string;
    speaker: string; priority: number; topicKey: string; createdAt: string;
    vector: number[];
  }[] = [];

  for (const p of allProjects) {
    const records = await memory.getAllWithVectors(p);
    for (const r of records) {
      allNodes.push({
        id: r.id, text: r.text, project: r.project, kind: r.kind,
        speaker: r.speaker, priority: r.priority,
        topicKey: r.topicKey ?? '', createdAt: r.createdAt, vector: r.vector,
      });
    }
  }

  // Compute edges (pairwise cosine similarity)
  const edges: { source: string; target: string; similarity: number }[] = [];
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const sim = cosine(allNodes[i].vector, allNodes[j].vector);
      if (sim >= threshold) {
        edges.push({ source: allNodes[i].id, target: allNodes[j].id, similarity: sim });
      }
    }
  }

  // Strip vectors from response
  const nodes = allNodes.map(({ vector: _, ...rest }) => rest);

  return NextResponse.json({ nodes, edges });
}
