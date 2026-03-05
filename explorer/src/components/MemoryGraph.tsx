'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import KindBadge from './KindBadge';

interface Node {
  id: string;
  text: string;
  project: string;
  kind: string;
  speaker: string;
  priority: number;
  topicKey: string;
  createdAt: string;
  // d3 adds these
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface Edge {
  source: string | Node;
  target: string | Node;
  similarity: number;
}

const PROJECT_COLORS: Record<string, string> = {
  'sleep-code': '#4A90D9',
  'cpik-inc': '#50C878',
  'tpt-strategy': '#F5A623',
  'personal-memory': '#9B59B6',
};

const DEFAULT_COLOR = '#666';

export default function MemoryGraph({
  projects,
  threshold,
  kindFilter,
}: {
  projects: string[];
  threshold: number;
  kindFilter: string[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Node | null>(null);
  const simRef = useRef<d3.Simulation<Node, Edge> | null>(null);

  // Fetch graph data
  useEffect(() => {
    if (projects.length === 0) return;
    setLoading(true);
    const params = new URLSearchParams({
      projects: projects.join(','),
      threshold: threshold.toString(),
    });
    fetch(`/api/graph?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setNodes(data.nodes);
        setEdges(data.edges);
        setLoading(false);
      });
  }, [projects, threshold]);

  // Render D3
  const renderGraph = useCallback(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    // Filter by kind
    const filteredNodes = kindFilter.length > 0
      ? nodes.filter((n) => kindFilter.includes(n.kind))
      : nodes;
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = edges.filter(
      (e) => nodeIds.has(typeof e.source === 'string' ? e.source : e.source.id)
        && nodeIds.has(typeof e.target === 'string' ? e.target : e.target.id)
    );

    // Deep copy for d3 mutation
    const nodesCopy = filteredNodes.map((n) => ({ ...n }));
    const edgesCopy = filteredEdges.map((e) => ({ ...e }));

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const g = svg.append('g');

    // Zoom
    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.1, 8])
        .on('zoom', (e) => g.attr('transform', e.transform))
    );

    // Simulation
    const nodeRadius = (d: Node) => 3 + d.priority * 0.8;

    const sim = d3.forceSimulation<Node>(nodesCopy)
      .force('link', d3.forceLink<Node, Edge>(edgesCopy)
        .id((d) => d.id)
        .distance(150)
        .strength((d) => (typeof d.similarity === 'number' ? d.similarity : 0.7) * 0.2)
      )
      .force('charge', d3.forceManyBody().strength(-200).distanceMax(500))
      .force('x', d3.forceX(width / 2).strength(0.03))
      .force('y', d3.forceY(height / 2).strength(0.03))
      .force('collision', d3.forceCollide<Node>().radius((d) => nodeRadius(d) + 8))
      .alphaDecay(0.03);

    simRef.current = sim;

    // Edges
    const link = g.append('g')
      .selectAll('line')
      .data(edgesCopy)
      .join('line')
      .attr('stroke', '#334')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', (d) => 0.5 + ((typeof d.similarity === 'number' ? d.similarity : 0.7) - 0.5) * 4);

    // Nodes
    const node = g.append('g')
      .selectAll('circle')
      .data(nodesCopy)
      .join('circle')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => PROJECT_COLORS[d.project] ?? DEFAULT_COLOR)
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.8)
      .attr('cursor', 'pointer')
      .attr('opacity', 0.85)
      .on('click', (_e, d) => setSelected(d))
      .call(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        d3.drag<any, Node>()
          .on('start', (e, d) => {
            if (!e.active) sim.alphaTarget(0.1).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (e, d) => {
            d.fx = e.x;
            d.fy = e.y;
          })
          .on('end', (e, d) => {
            if (!e.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    // Labels
    const label = g.append('g')
      .selectAll('text')
      .data(nodesCopy)
      .join('text')
      .text((d) => d.topicKey || d.text.slice(0, 18))
      .attr('font-size', 11)
      .attr('fill', '#999')
      .attr('dx', 14)
      .attr('dy', 4)
      .style('pointer-events', 'none');

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as Node).x!)
        .attr('y1', (d) => (d.source as Node).y!)
        .attr('x2', (d) => (d.target as Node).x!)
        .attr('y2', (d) => (d.target as Node).y!);
      node.attr('cx', (d) => d.x!).attr('cy', (d) => d.y!);
      label.attr('x', (d) => d.x!).attr('y', (d) => d.y!);
    });

    return () => {
      sim.stop();
    };
  }, [nodes, edges, kindFilter]);

  useEffect(() => {
    const cleanup = renderGraph();
    return cleanup;
  }, [renderGraph]);

  return (
    <div className="relative w-full h-full">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 z-10">
          <span className="text-zinc-400 animate-pulse">Loading graph...</span>
        </div>
      )}
      <svg ref={svgRef} className="w-full h-full" />

      {/* Stats overlay */}
      <div className="absolute bottom-4 left-4 text-xs text-zinc-600">
        {nodes.length} nodes, {edges.length} edges
      </div>

      {/* Selected node detail */}
      {selected && (
        <div className="absolute top-4 right-4 w-80 bg-zinc-900 border border-zinc-700 rounded-xl p-4 shadow-xl z-20">
          <div className="flex items-center justify-between mb-2">
            <KindBadge kind={selected.kind} />
            <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-300">✕</button>
          </div>
          <p className="text-sm text-zinc-300 mb-3">{selected.text}</p>
          <div className="space-y-1 text-xs text-zinc-500">
            <div className="flex justify-between">
              <span>Project</span><span className="text-zinc-400">{selected.project}</span>
            </div>
            <div className="flex justify-between">
              <span>Speaker</span><span className="text-zinc-400">{selected.speaker}</span>
            </div>
            <div className="flex justify-between">
              <span>Priority</span><span className="text-zinc-400">{selected.priority}</span>
            </div>
            {selected.topicKey && (
              <div className="flex justify-between">
                <span>Topic</span><span className="text-zinc-400">#{selected.topicKey}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Date</span><span className="text-zinc-400">{selected.createdAt.slice(0, 10)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
