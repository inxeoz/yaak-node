import { useCallback, useEffect, useRef, useState } from "react";
import { getKeyValue, setKeyValue } from "../../lib/keyValueStore";
import { storageKey, type Edge, type Node } from "./types";

export function useNodeGraph(wsId: string) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nextId = useRef(1);

  // load per workspace
  useEffect(() => {
    const kv = getKeyValue<{ nodes: Node[]; edges: Edge[] }>({
      key: storageKey(wsId),
      fallback: null as unknown as { nodes: Node[]; edges: Edge[] },
    });
    if (kv?.nodes) {
      setNodes(kv.nodes);
      setEdges(kv.edges ?? []);
      const max = kv.nodes.reduce(
        (m: number, n: Node) => Math.max(m, parseInt(n.id.slice(1), 10) || 0),
        0,
      );
      nextId.current = max + 1;
    } else {
      setNodes([]);
      setEdges([]);
      nextId.current = 1;
    }
  }, [wsId]);

  const save = useCallback(
    (n: Node[], e: Edge[]) => {
      setKeyValue({ key: storageKey(wsId), value: { nodes: n, edges: e } }).catch(console.error);
    },
    [wsId],
  );

  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSoon = useCallback(
    (n: Node[], e: Edge[]) => {
      if (saveRef.current) clearTimeout(saveRef.current);
      saveRef.current = setTimeout(() => save(n, e), 400);
    },
    [save],
  );

  const addNode = useCallback(
    (req: { id: string; name: string; method: string; url: string }, x = 100, y = 100) => {
      const id = `n${nextId.current++}`;
      const n: Node = {
        id,
        x,
        y,
        data: { requestId: req.id, name: req.name, method: req.method, url: req.url },
      };
      setNodes((prev) => {
        const next = [...prev, n];
        setEdges((prevEdges) => {
          saveSoon(next, prevEdges);
          return prevEdges;
        });
        return next;
      });
      return id;
    },
    [saveSoon],
  );

  return { nodes, setNodes, edges, setEdges, nextId, save, saveSoon, addNode };
}
