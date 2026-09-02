import type { Edge, Node } from "./types";
import { NODE_MIN_H, NODE_MIN_W } from "./types";

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

// ponytail: naive AABB gap check; upgrade to spatial index if many nodes
export const LAYOUT_GAP_DEFAULT = 10;
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number): boolean {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}
export function wouldOverlap(nodeId: string, nx: number, ny: number, nw: number, nh: number, nodes: Node[], gap: number): boolean {
  const a = { x: nx, y: ny, w: nw, h: nh };
  for (const n of nodes) {
    if (n.id === nodeId) continue;
    const b = { x: n.x, y: n.y, w: n.w ?? NODE_MIN_W, h: n.h ?? NODE_MIN_H };
    if (rectsOverlap(a, b, gap)) return true;
  }
  return false;
}
export function findFreePosition(x: number, y: number, w: number, h: number, nodes: Node[], gap: number): { x: number; y: number } {
  if (!wouldOverlap("__new__", x, y, w, h, nodes, gap)) return { x, y };
  // spiral search outward in 20px steps, up to 25 tries
  const steps = [20, 40, 60, 80, 100, 140, 180, 240];
  for (const d of steps) {
    const candidates: { x: number; y: number }[] = [
      { x: x + d, y },
      { x: x - d, y },
      { x, y: y + d },
      { x, y: y - d },
      { x: x + d, y: y + d },
      { x: x - d, y: y + d },
      { x: x + d, y: y - d },
      { x: x - d, y: y - d },
    ];
    for (const c of candidates) {
      const cx = Math.round(c.x / 10) * 10;
      const cy = Math.round(c.y / 10) * 10;
      if (!wouldOverlap("__new__", cx, cy, w, h, nodes, gap)) return { x: cx, y: cy };
    }
  }
  // fallback: stack downwards
  let ny = y;
  for (let i = 0; i < 30; i++) {
    ny += h + gap;
    if (!wouldOverlap("__new__", x, ny, w, h, nodes, gap)) return { x, y: ny };
  }
  return { x, y };
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
