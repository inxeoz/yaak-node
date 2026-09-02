export type NodeData = { requestId: string; name: string; method: string; url: string };
export type Node = { id: string; x: number; y: number; data: NodeData };
export type Edge = { id: string; source: string; target: string };

export function storageKey(wsId: string) {
  return `node_graph::${wsId}`;
}
