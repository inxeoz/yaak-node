import { httpRequestsAtom } from "@yaakapp-internal/models";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { activeRequestAtom } from "../../hooks/useActiveRequest";
import { activeWorkspaceAtom } from "../../hooks/useActiveWorkspace";
import { sendAnyHttpRequest } from "../../hooks/useSendAnyHttpRequest";
import { showToast } from "../../lib/toast";
import { BranchPrompt } from "./BranchPrompt";
import { FlowNode } from "./FlowNode";
import { svgPath, topoSort } from "./graph";
import type { Node } from "./types";
import { useNodeGraph } from "./useNodeGraph";

type Menu =
  | { x: number; y: number; cx: number; cy: number; kind: "canvas" }
  | { x: number; y: number; cx: number; cy: number; kind: "node"; id: string }
  | { x: number; y: number; cx: number; cy: number; kind: "edge"; id: string }
  | null;

export function NodeSpace({ style }: { style?: React.CSSProperties; fullHeight?: boolean }) {
  const httpRequests = useAtomValue(httpRequestsAtom);
  const activeWorkspace = useAtomValue(activeWorkspaceAtom);
  const wsId = activeWorkspace?.id ?? "n/a";
  const activeRequest = useAtomValue(activeRequestAtom);
  const { nodes, setNodes, edges, setEdges, save, saveSoon, addNode } = useNodeGraph(wsId);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [pending, setPending] = useState<{
    source: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [statusById, setStatusById] = useState<Record<string, "ok" | "err" | "run">>({});
  const [branchPrompt, setBranchPrompt] = useState<{ from: string; targets: Node[] } | null>(null);
  const [flowRunning, setFlowRunning] = useState(false);
  const [branchPos, setBranchPos] = useState<{ x: number; y: number } | null>(null);
  const [branchDrag, setBranchDrag] = useState<{
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);

  useEffect(() => {
    if (branchPrompt) setBranchPos(null);
  }, [branchPrompt]);

  const [running, setRunning] = useState(false);

  useEffect(() => {
    // console.log("[NodeSpace] nodes", nodes.length);
  }, [nodes.length]);

  // close menu on click/escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeId) {
          setEdges((prev) => {
            const next = prev.filter((ee) => ee.id !== selectedEdgeId);
            setNodes((pn) => {
              saveSoon(pn, next);
              return pn;
            });
            return next;
          });
          setSelectedEdgeId(null);
          e.preventDefault();
        } else if (selectedId) {
          const id = selectedId;
          setNodes((prev) => {
            const next = prev.filter((n) => n.id !== id);
            setEdges((pe) => {
              const ne = pe.filter((ee) => ee.source !== id && ee.target !== id);
              saveSoon(next, ne);
              return ne;
            });
            return next;
          });
          setSelectedId(null);
          e.preventDefault();
        }
      }
      if (e.key === "Escape") {
        setSelectedId(null);
        setSelectedEdgeId(null);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedId, selectedEdgeId, saveSoon, setEdges, setNodes]);

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
    const winId = (window as unknown as { __yaakDragId?: string }).__yaakDragId;
    if (winId && tryAdd(winId)) {
      (window as unknown as { __yaakDragId?: string }).__yaakDragId = undefined;
      return;
    }
    if (activeRequest && (activeRequest as unknown as { model: string }).model === "http_request") {
      addNode(
        activeRequest as unknown as { id: string; name: string; method: string; url: string },
        x,
        y,
      );
    } else {
      showToast({
        message: "Drop failed: drag an API from left sidebar or use right-click → Add",
        color: "warning",
      });
    }
  };

  const run = async () => {
    if (nodes.length === 0) {
      showToast({ message: "Add nodes first", color: "notice" });
      return;
    }
    setRunning(true);
    const order = topoSort(nodes, edges);
    const results: unknown[] = [];
    for (const nid of order) {
      const node = nodes.find((n) => n.id === nid);
      if (!node) continue;
      setStatusById((m) => ({ ...m, [nid]: "run" }));
      await new Promise((r) => setTimeout(r, 0));
      try {
        const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
        const ok = !!res && res.status < 400;
        setStatusById((m) => ({ ...m, [nid]: ok ? "ok" : "err" }));
        results.push({ nodeId: nid, name: node.data.name, status: res?.status ?? "unknown", ok });
      } catch (e) {
        setStatusById((m) => ({ ...m, [nid]: "err" }));
        results.push({ nodeId: nid, name: node.data.name, error: String(e), ok: false });
      }
    }
    showToast({
      message: `Ran ${results.length} requests`,
      color: (results as { ok: boolean }[]).some((r) => !r.ok) ? "warning" : "success",
    });
    setRunning(false);
  };

  const runSingle = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setRunning(true);
    setStatusById((m) => ({ ...m, [nodeId]: "run" }));
    try {
      const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
      setStatusById((m) => ({ ...m, [nodeId]: res && res.status < 400 ? "ok" : "err" }));
      showToast({
        message: `${node.data.name}: ${res?.status ?? "sent"}`,
        color: res && res.status < 400 ? "success" : "warning",
      });
    } catch (e) {
      setStatusById((m) => ({ ...m, [nodeId]: "err" }));
      showToast({ message: `${node.data.name} failed: ${String(e)}`, color: "danger" });
    }
    setRunning(false);
  };

  const runFlow = async (startId: string) => {
    const start = nodes.find((n) => n.id === startId);
    if (!start) return;
    setFlowRunning(true);
    let cur: string | null = startId;
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) {
        showToast({ message: "Cycle detected, stopping", color: "warning" });
        break;
      }
      visited.add(cur);
      const node = nodes.find((n) => n.id === cur);
      if (!node) break;
      setSelectedId(cur);
      setStatusById((m) => ({ ...m, [cur!]: "run" }));
      await new Promise((r) => setTimeout(r, 0));
      try {
        const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
        const ok = !!res && res.status < 400;
        setStatusById((m) => ({ ...m, [cur!]: ok ? "ok" : "err" }));
        if (!ok) {
          showToast({
            message: `${node.data.name} failed (${res?.status}), stopping`,
            color: "danger",
          });
          break;
        }
      } catch (e) {
        setStatusById((m) => ({ ...m, [cur!]: "err" }));
        showToast({ message: `${node.data.name} error: ${String(e)}`, color: "danger" });
        break;
      }
      const outs = edges.filter((e) => e.source === cur).map((e) => e.target);
      if (outs.length === 0) {
        showToast({ message: "Flow complete", color: "success" });
        break;
      }
      if (outs.length === 1) {
        cur = outs[0] ?? null;
        continue;
      }
      const targets = outs.map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as Node[];
      const choice = await new Promise<string | null>((resolve) => {
        setBranchPrompt({ from: cur!, targets });
        (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve =
          resolve;
      });
      setBranchPrompt(null);
      (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve =
        undefined;
      if (!choice) {
        showToast({ message: "Flow cancelled at branch", color: "notice" });
        break;
      }
      cur = choice;
    }
    setFlowRunning(false);
  };

  const deleteNode = (id: string) => {
    setNodes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      setEdges((pe) => {
        const ne = pe.filter((e) => e.source !== id && e.target !== id);
        save(next, ne);
        return ne;
      });
      return next;
    });
    if (selectedId === id) setSelectedId(null);
  };

  const deleteEdge = (id: string) => {
    setEdges((prev) => {
      const next = prev.filter((e) => e.id !== id);
      setNodes((pn) => {
        saveSoon(pn, next);
        return pn;
      });
      return next;
    });
    if (selectedEdgeId === id) setSelectedEdgeId(null);
  };

  const clearAll = () => {
    setNodes([]);
    setEdges([]);
    save([], []);
    setSelectedId(null);
    setSelectedEdgeId(null);
  };

  const openMenu = (
    e: React.MouseEvent,
    kind: "canvas" | "node" | "edge",
    id?: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // clamp to viewport so toolbox stays visible
    const x = e.clientX;
    const y = e.clientY;
    if (kind === "node" && id) setSelectedId(id);
    if (kind === "edge" && id) setSelectedEdgeId(id);
    setMenu({ x, y, cx, cy, kind, id } as Menu);
  };


  return (
    <div style={style} className="w-full h-full flex flex-col bg-surface overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-2 px-2 border-b border-border-subtle bg-surface">
        <span className="text-sm font-semibold">Node Space</span>
        <span className="text-xs text-text-subtle">
          {nodes.length} nodes • {edges.length} edges
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-text-subtle hidden sm:inline">
          {selectedId ? `selected: ${nodes.find((n) => n.id === selectedId)?.data.name ?? selectedId}` : "no selection"}
        </span>
      </div>

      <div className="flex-1 min-h-0 relative">
        <div
          ref={canvasRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedId(null);
              setSelectedEdgeId(null);
            }
          }}
          onContextMenu={(e) => openMenu(e, "canvas")}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setIsDragOver(true);
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
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
              const x1 = s.x + 140,
                y1 = s.y + 22,
                x2 = t.x,
                y2 = t.y + 22;
              const sel = selectedEdgeId === e.id;
              return (
                <g
                  key={e.id}
                  style={{ pointerEvents: "auto", cursor: "pointer" }}
                  onClick={() => setSelectedEdgeId(e.id)}
                  onContextMenu={(ev) => openMenu(ev as unknown as React.MouseEvent, "edge", e.id)}
                >
                  <path
                    d={svgPath(x1, y1, x2, y2)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                  />
                  <path
                    d={svgPath(x1, y1, x2, y2)}
                    fill="none"
                    stroke={sel ? "var(--color-primary)" : "var(--color-text)"}
                    strokeWidth={sel ? 2.2 : 1.4}
                    opacity={sel ? 1 : 0.9}
                  />
                </g>
              );
            })}
            {pending && (
              <path
                d={svgPath(pending.x1, pending.y1, pending.x2, pending.y2)}
                fill="none"
                stroke="var(--color-text)"
                strokeWidth={1.4}
                strokeDasharray="6 4"
                opacity={0.6}
              />
            )}
          </svg>

          {nodes.map((n) => {
            const idx = branchPrompt?.targets.findIndex((t) => t.id === n.id) ?? -1;
            void statusById;
            return (
              <FlowNode
                key={n.id}
                node={n}
                selected={selectedId === n.id}
                branchIdx={idx}
                running={running || flowRunning}
                canvasRef={canvasRef}
                drag={drag}
                setDrag={setDrag}
                setNodes={setNodes}
                setEdges={setEdges}
                setSelectedId={setSelectedId}
                setPending={setPending}
                save={save}
                saveSoon={saveSoon}
                edges={edges}
                nodes={nodes}
                onContextMenu={(e) => openMenu(e, "node", n.id)}
              />
            );
          })}

          {nodes.length === 0 && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="text-sm text-text-subtle border border-dashed border-border-subtle rounded-lg px-4 py-3 bg-surface/80 text-center">
                Drop APIs here or right-click → Add API
              </div>
            </div>
          )}
        </div>

        {menu && (
          <div
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            className="fixed z-20 min-w-[220px] max-w-[320px] bg-surface border border-border-subtle rounded-lg shadow-xl py-1 text-sm overflow-hidden"
            style={{
              left: Math.min(menu.x, window.innerWidth - 240),
              top: Math.min(menu.y, window.innerHeight - 320),
            }}
          >
            {menu.kind === "node" && menu.id && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-text-subtle border-b border-border-subtle truncate">
                  {nodes.find((n) => n.id === menu.id)?.data.name || menu.id}
                </div>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                  disabled={running || flowRunning}
                  onClick={() => {
                    setMenu(null);
                    runSingle(menu.id!);
                  }}
                >
                  ▶ Run
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                  disabled={running || flowRunning}
                  onClick={() => {
                    setMenu(null);
                    runFlow(menu.id!);
                  }}
                >
                  ⤳ Run Flow from here
                </button>
                <div className="h-px bg-border-subtle my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-danger/10 text-danger"
                  onClick={() => {
                    setMenu(null);
                    deleteNode(menu.id!);
                  }}
                >
                  ✕ Delete Node
                </button>
              </>
            )}

            {menu.kind === "edge" && menu.id && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-text-subtle border-b border-border-subtle">
                  Connection
                </div>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-danger/10 text-danger"
                  onClick={() => {
                    setMenu(null);
                    deleteEdge(menu.id!);
                  }}
                >
                  ✕ Delete Connection
                </button>
              </>
            )}

            {menu.kind === "canvas" && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-text-subtle border-b border-border-subtle">
                  Toolbox
                </div>

                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={
                    !activeRequest ||
                    (activeRequest as unknown as { model: string }).model !== "http_request"
                  }
                  onClick={() => {
                    if (
                      activeRequest &&
                      (activeRequest as unknown as { model: string }).model === "http_request"
                    ) {
                      addNode(
                        activeRequest as unknown as {
                          id: string;
                          name: string;
                          method: string;
                          url: string;
                        },
                        menu.cx,
                        menu.cy,
                      );
                    }
                    setMenu(null);
                  }}
                >
                  + Add Selected here
                </button>

                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                  disabled={running || flowRunning || nodes.length === 0}
                  onClick={() => {
                    setMenu(null);
                    run();
                  }}
                >
                  ▶ Run All
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                  disabled={running || flowRunning || !selectedId}
                  onClick={() => {
                    setMenu(null);
                    if (selectedId) runSingle(selectedId);
                  }}
                >
                  ▶ Run Selected
                </button>
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                  disabled={running || flowRunning || !selectedId}
                  onClick={() => {
                    setMenu(null);
                    if (selectedId) runFlow(selectedId);
                  }}
                >
                  ⤳ Run Flow (selected)
                </button>
                <div className="h-px bg-border-subtle my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-danger/10 text-danger disabled:opacity-50"
                  disabled={nodes.length === 0 && edges.length === 0}
                  onClick={() => {
                    setMenu(null);
                    clearAll();
                  }}
                >
                  ✕ Clear Canvas
                </button>
              </>
            )}
          </div>
        )}

        <BranchPrompt
          branchPrompt={branchPrompt}
          branchPos={branchPos}
          setBranchPos={setBranchPos}
          branchDrag={branchDrag}
          setBranchDrag={setBranchDrag}
          nodes={nodes}
        />
      </div>
    </div>
  );
}
