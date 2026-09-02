import type { Edge, Node } from "./types";

// ponytail: O(n+m) DFS for cycle, naive topo - upgrade to Kahn with priority if needed
export function wouldCreateCycle(source: string, target: string, curEdges: Edge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of [...curEdges, { id: "tmp", source, target }]) {
    const a = adj.get(e.source) ?? [];
    a.push(e.target);
    adj.set(e.source, a);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

export function svgPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

export function topoSort(nodes: Node[], edges: Edge[]): string[] {
  const incoming = new Map<string, number>();
  nodes.forEach((n) => incoming.set(n.id, 0));
  edges.forEach((e) => incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1));
  const q = nodes.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  const visited = new Set<string>();
  const order: string[] = [];
  const adj = new Map<string, string[]>();
  edges.forEach((e) => {
    const a = adj.get(e.source) ?? [];
    a.push(e.target);
    adj.set(e.source, a);
  });
  while (q.length) {
    const id = q.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    for (const nxt of adj.get(id) ?? []) {
      incoming.set(nxt, (incoming.get(nxt) ?? 1) - 1);
      if ((incoming.get(nxt) ?? 0) === 0) q.push(nxt);
    }
  }
  nodes.forEach((n) => {
    if (!visited.has(n.id)) order.push(n.id);
  });
  return order;
}
