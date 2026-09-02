import { httpRequestsAtom } from "@yaakapp-internal/models";
import { Button } from "./core/Button";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState, useCallback } from "react";
import { activeWorkspaceAtom } from "../hooks/useActiveWorkspace";
import { activeRequestAtom } from "../hooks/useActiveRequest";
import { sendAnyHttpRequest } from "../hooks/useSendAnyHttpRequest";
import { showToast } from "../lib/toast";
import { getKeyValue, setKeyValue } from "../lib/keyValueStore";

type NodeData = { requestId: string; name: string; method: string; url: string };
type Node = { id: string; x: number; y: number; data: NodeData };
type Edge = { id: string; source: string; target: string };

function storageKey(wsId: string) {
  return `node_graph::${wsId}`;
}

export function NodeSpace({ style, fullHeight }: { style?: React.CSSProperties; fullHeight?: boolean }) {
  const httpRequests = useAtomValue(httpRequestsAtom);
  const activeWorkspace = useAtomValue(activeWorkspaceAtom);
  const wsId = activeWorkspace?.id ?? "n/a";
  const activeRequest = useAtomValue(activeRequestAtom);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // filter now handled by left sidebar search
  const [_filter] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [pending, setPending] = useState<{ source: string; x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<string, "ok" | "err" | "run">>({});
  const [log, setLog] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const nextId = useRef(1);

  useEffect(() => {
    console.log("[NodeSpace] nodes", nodes.length, nodes);
  }, [nodes]);
  useEffect(() => {
    console.log("[NodeSpace] httpRequests", httpRequests.length);
  }, [httpRequests]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeId) {
          setEdges((prev) => {
            const next = prev.filter((ee) => ee.id !== selectedEdgeId);
            setNodes((pn) => { saveSoon(pn, next); return pn; });
            return next;
          });
          setSelectedEdgeId(null); e.preventDefault();
        } else if (selectedId) {
          const id = selectedId;
          setNodes((prev) => {
            const next = prev.filter((n) => n.id !== id);
            setEdges((pe) => { const ne = pe.filter((ee) => ee.source !== id && ee.target !== id); saveSoon(next, ne); return ne; });
            return next;
          });
          setSelectedId(null); e.preventDefault();
        }
      }
      if (e.key === "Escape") { setSelectedId(null); setSelectedEdgeId(null); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedId, selectedEdgeId]);

  // filtered via sidebar search

  // load graph per workspace
  useEffect(() => {
    const kv = getKeyValue<{ nodes: Node[]; edges: Edge[] }>({
      key: storageKey(wsId),
      fallback: null as any,
    });
    if (kv?.nodes) {
      setNodes(kv.nodes);
      setEdges(kv.edges ?? []);
      const max = kv.nodes.reduce((m: number, n: Node) => Math.max(m, parseInt(n.id.slice(1)) || 0), 0);
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

  // persist on change (debounced)
  const saveRef = useRef<NodeJS.Timeout | null>(null);
  const saveSoon = useCallback(
    (n: Node[], e: Edge[]) => {
      if (saveRef.current) clearTimeout(saveRef.current);
      saveRef.current = setTimeout(() => save(n, e), 400);
    },
    [save],
  );

  const addNode = (req: (typeof httpRequests)[number], x = 100, y = 100) => {
    const id = `n${nextId.current++}`;
    const n: Node = { id, x, y, data: { requestId: req.id, name: req.name, method: req.method, url: req.url } };
    console.log("[NodeSpace] addNode", req.id, req.name, x, y);
    setNodes((prev) => {
      const next = [...prev, n];
      // use current edges from closure via functional ref
      setEdges((prevEdges) => {
        saveSoon(next, prevEdges);
        return prevEdges;
      });
      return next;
    });
  };

  const onCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left - 40;
    const y = e.clientY - rect.top - 20;
    const tryAdd = (id: string) => {
      const req = httpRequests.find((r) => r.id === id);
      if (req) {
        addNode(req, x, y);
        return true;
      }
      return false;
    };
    try {
      const raw = e.dataTransfer.getData("application/json");
      if (raw) {
        const data = JSON.parse(raw);
        if (data?.id && tryAdd(data.id)) return;
      }
    } catch {}
    const xId = e.dataTransfer.getData("application/x-yaak-id");
    if (xId && tryAdd(xId)) return;
    const winId = (window as any).__yaakDragId as string | undefined;
    if (winId && tryAdd(winId)) {
      (window as any).__yaakDragId = null;
      return;
    }
    // Fallback: use currently selected request from left sidebar
    if (activeRequest && (activeRequest as any).model === "http_request") {
      addNode(activeRequest as any, x, y);
    } else {
      console.log("[NodeSpace] drop no id found", e.dataTransfer.types);
      showToast({ message: "Drop failed: drag an API from left sidebar or use + Add API", color: "warning" });
    }
  };

  const wouldCreateCycle = (source: string, target: string, curEdges: Edge[]) => {
    const adj = new Map<string, string[]>();
    for (const e of [...curEdges, { id: "tmp", source, target }]) { const a = adj.get(e.source) ?? []; a.push(e.target); adj.set(e.source, a); }
    const stack = [target]; const seen = new Set<string>();
    while (stack.length) { const cur = stack.pop()!; if (cur === source) return true; if (seen.has(cur)) continue; seen.add(cur); for (const nxt of adj.get(cur) ?? []) stack.push(nxt); }
    return false;
  };

  const svgPath = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1) * 0.5;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };

  const run = async () => {
    if (nodes.length === 0) {
      showToast({ message: "Add nodes first", color: "notice" });
      return;
    }
    setRunning(true);
    setLog("Running...");
    // topo sort
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
    nodes.forEach((n) => { if (!visited.has(n.id)) order.push(n.id); });

    const results: any[] = [];
    for (const nid of order) {
      const node = nodes.find((n) => n.id === nid);
      if (!node) continue;
      setStatusById((m) => ({ ...m, [nid]: "run" })); await new Promise((r) => setTimeout(r, 0));
      try {
        const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
        const ok = !!res && res.status < 400; setStatusById((m) => ({ ...m, [nid]: ok ? "ok" : "err" }));
        results.push({ nodeId: nid, name: node.data.name, status: res?.status ?? "unknown", ok });
      } catch (e: any) {
        setStatusById((m) => ({ ...m, [nid]: "err" }));
        results.push({ nodeId: nid, name: node.data.name, error: String(e), ok: false });
      }
    }
    setLog(JSON.stringify({ order, results }, null, 2));
    showToast({ message: `Ran ${results.length} requests`, color: results.some((r) => !r.ok) ? "warning" : "success" });
    setRunning(false);
  };

  const runSingle = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setRunning(true); setStatusById((m) => ({ ...m, [nodeId]: "run" }));
    try {
      const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
      setStatusById((m) => ({ ...m, [nodeId]: res && (res.status < 400 ? "ok" : "err") }));
      showToast({ message: `${node.data.name}: ${res?.status ?? "sent"}`, color: res && res.status < 400 ? "success" : "warning" });
    } catch (e: any) {
      setStatusById((m) => ({ ...m, [nodeId]: "err" }));
      showToast({ message: `${node.data.name} failed: ${String(e)}`, color: "danger" });
    }
    setRunning(false);
  };

  return (
    <div style={style} className="w-full h-full flex flex-col bg-surface overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-2 px-2 border-b border-border-subtle bg-surface">
        <span className="text-sm font-semibold">Node Space</span>
        <span className="text-xs text-text-subtle">{nodes.length} nodes • {edges.length} edges</span>
        <span className="hidden sm:inline text-[11px] text-text-subtle ml-2">— select API in left sidebar, then Add</span>
        <div className="flex-1" />
        <select
          id="node-add-select"
          className="text-xs border border-border-subtle rounded px-1 py-1 bg-surface max-w-[180px]"
          defaultValue=""
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            const req = httpRequests.find((r) => r.id === id);
            if (req) addNode(req, 120 + Math.random() * 280, 80 + Math.random() * 200);
            e.currentTarget.value = "";
          }}
        >
          <option value="">+ Add API…</option>
          {httpRequests.map((r) => (
            <option key={r.id} value={r.id}>
              {r.method} {r.name || r.url.slice(0, 30)}
            </option>
          ))}
        </select>
        <Button
          size="xs"
          variant="border"
          disabled={!activeRequest || (activeRequest as any).model !== "http_request"}
          onClick={() => {
            if (activeRequest && (activeRequest as any).model === "http_request") {
              addNode(activeRequest as any, 120 + Math.random() * 280, 80 + Math.random() * 200);
            } else {
              showToast({ message: `No active request (active=${(activeRequest as any)?.model ?? "none"})`, color: "warning" });
            }
          }}
          title={activeRequest ? `Add ${(activeRequest as any).name}` : "Select an API on the left then click"}
        >
          + Add Selected
        </Button>
        <Button size="xs" variant="border" onClick={() => { setNodes([]); setEdges([]); save([], []); setLog(null); }}>
          Clear
        </Button>
        <Button
          size="xs"
          variant="border"
          disabled={running || !selectedId}
          onClick={() => selectedId && runSingle(selectedId)}
          title={selectedId ? `Run ${nodes.find((n) => n.id === selectedId)?.data.name ?? ""}` : "Select a node first"}
        >
          ▶ Run Selected
        </Button>
        <Button size="xs" color="primary" disabled={running} onClick={run}>
          {running ? "Running…" : "▶ Run All"}
        </Button>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div
          ref={canvasRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) { setSelectedId(null); setSelectedEdgeId(null); }
          }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setIsDragOver(true); }}
          onDragEnter={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            console.log("[NodeSpace] drop", e.dataTransfer.types, e.dataTransfer.getData("application/json"), e.dataTransfer.getData("application/x-yaak-id"));
            setIsDragOver(false);
            onCanvasDrop(e);
          }}
          className={`absolute inset-0 overflow-hidden ${isDragOver ? "bg-primary/5 ring-2 ring-primary/50" : "bg-surface"}`}
          style={{
            backgroundImage:
              "linear-gradient(color-mix(in srgb, var(--color-border-subtle) 60%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-border-subtle) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        >
          <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
            {edges.map((e) => {
              const s = nodes.find((n) => n.id === e.source);
              const t = nodes.find((n) => n.id === e.target);
              if (!s || !t) return null;
              const x1 = s.x + 140, y1 = s.y + 22, x2 = t.x, y2 = t.y + 22;
              const sel = selectedEdgeId === e.id;
              return (
                <g key={e.id} style={{ pointerEvents: "auto", cursor: "pointer" }} onClick={() => setSelectedEdgeId(e.id)}>
                  <path d={svgPath(x1, y1, x2, y2)} fill="none" stroke="transparent" strokeWidth={12} />
                  <path d={svgPath(x1, y1, x2, y2)} fill="none" stroke={sel ? "var(--color-primary)" : "var(--color-text)"} strokeWidth={sel ? 2.2 : 1.4} opacity={sel ? 1 : 0.9} />
                </g>
              );
            })}
            {pending && <path d={svgPath(pending.x1, pending.y1, pending.x2, pending.y2)} fill="none" stroke="var(--color-text)" strokeWidth={1.4} strokeDasharray="6 4" opacity={0.6} />}
          </svg>

          {nodes.map((n) => (
            <div
              key={n.id}
              data-node={n.id}
              onPointerDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest("[data-handle]") || target.closest("[data-del]") || target.closest("[data-run]")) return;
                const crect = canvasRef.current!.getBoundingClientRect();
                const offsetX = e.clientX - crect.left - n.x;
                const offsetY = e.clientY - crect.top - n.y;
                setDrag({ id: n.id, dx: offsetX, dy: offsetY });
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onClick={() => setSelectedId(n.id)}
              onPointerMove={(e) => {
                if (drag?.id !== n.id) return;
                const crect = canvasRef.current!.getBoundingClientRect();
                const cx = e.clientX - crect.left - drag.dx;
                const cy = e.clientY - crect.top - drag.dy;
                setNodes((prev) => prev.map((p) => (p.id === n.id ? { ...p, x: cx, y: cy } : p)));
              }}
              onPointerUp={() => {
                if (drag) {
                  setDrag(null);
                  setNodes((prev) => {
                    saveSoon(prev, edges);
                    return prev;
                  });
                }
              }}
              style={{ left: n.x, top: n.y }}
              className={`absolute min-w-[140px] px-3 py-2 rounded-lg border bg-surface shadow-sm flex flex-col cursor-move select-none node ${selectedId === n.id ? "border-primary ring-1 ring-primary" : "border-border"}`}
            >
              <div className="text-xs font-semibold truncate max-w-[140px]">{n.data.name || n.data.url}</div>
              <div className="text-[10px] text-text-subtle truncate max-w-[140px]">{n.data.method} {n.data.url.slice(0, 28)}</div>
              {selectedId === n.id && (
                <button
                  data-run
                  onClick={(e) => {
                    e.stopPropagation();
                    runSingle(n.id);
                  }}
                  disabled={running}
                  className="mt-1 text-[10px] px-2 py-0.5 rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-50 self-start"
                  title="Run this node"
                >
                  ▶ Run
                </button>
              )}
              <div
                data-handle="out"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const x1 = n.x + 140, y1 = n.y + 22;
                  console.log("[NodeSpace] connect start", n.id, x1, y1);
                  setPending({ source: n.id, x1, y1, x2: x1, y2: y1 });
                  const move = (ev: PointerEvent) => {
                    const crect = canvasRef.current!.getBoundingClientRect();
                    setPending((p) => (p ? { ...p, x2: ev.clientX - crect.left, y2: ev.clientY - crect.top } : null));
                  };
                  const up = (ev: PointerEvent) => {
                    document.removeEventListener("pointermove", move);
                    document.removeEventListener("pointerup", up);
                    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
                    console.log("[NodeSpace] connect end el", el, el?.closest("[data-node]"));
                    const target = el?.closest("[data-node]") as HTMLElement | null;
                    if (target && target.dataset.node !== n.id) {
                      const tid = target.dataset.node!;
                      if (wouldCreateCycle(n.id, tid, edges)) { showToast({ message: "Cycle not allowed", color: "warning" }); setPending(null); return; }
                      console.log("[NodeSpace] connect", n.id, "->", tid);
                      setEdges((prev) => {
                        if (prev.some((ee) => ee.source === n.id && ee.target === tid)) return prev;
                        if (wouldCreateCycle(n.id, tid, prev)) { showToast({ message: "Cycle not allowed", color: "warning" }); return prev; }
                        const next = [...prev, { id: `e${Date.now()}${Math.random()}`, source: n.id, target: tid }];
                        // fix stale nodes: use functional nodes
                        setNodes((prevNodes) => {
                          saveSoon(prevNodes, next);
                          return prevNodes;
                        });
                        return next;
                      });
                    } else {
                      console.log("[NodeSpace] connect no target");
                    }
                    setPending(null);
                  };
                  document.addEventListener("pointermove", move);
                  document.addEventListener("pointerup", up);
                }}
                className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-text border-2 border-surface shadow cursor-crosshair flex items-center justify-center"
                title="Drag to connect"
                title="Drag to connect"
              />
              <div data-handle="in" className="absolute -left-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-primary border-2 border-surface shadow" />
              <button
                data-del
                onClick={() => {
                  const nextNodes = nodes.filter((x) => x.id !== n.id);
                  const nextEdges = edges.filter((e) => e.source !== n.id && e.target !== n.id);
                  setNodes(nextNodes);
                  setEdges(nextEdges);
                  save(nextNodes, nextEdges);
                }}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface border border-border-subtle grid place-items-center text-[10px] hover:bg-danger hover:text-white"
              >
                ×
              </button>
              {/* node hit area via outer data-node */}
            </div>
          ))}

          {nodes.length === 0 && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="text-sm text-text-subtle border border-dashed border-border-subtle rounded-lg px-4 py-3 bg-surface/80">
                Drop APIs here to build a flow
              </div>
            </div>
          )}

          {/* log hidden — right HttpResponsePane shows response */}
        </div>
      </div>
    </div>
  );
}
