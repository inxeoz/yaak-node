export type NodeData = {
  requestId: string;
  name: string;
  method: string;
  url: string;
  // ponytail: naive per-node execution knobs; upgrade to global defaults if needed
  delayMs?: number;
  retry?: number;
  continueOnError?: boolean;
};
export type Node = { id: string; x: number; y: number; w?: number; h?: number; data: NodeData };
export const NODE_MIN_W = 140;
export const NODE_MIN_H = 44;
export const NODE_MAX_W = 420;
export const NODE_MAX_H = 300;
export type Edge = { id: string; source: string; target: string; label?: string; condition?: string };

export function storageKey(wsId: string) {
  return `node_graph::${wsId}`;
}
