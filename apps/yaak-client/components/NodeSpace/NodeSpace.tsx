import { httpRequestsAtom } from "@yaakapp-internal/models";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { activeRequestAtom } from "../../hooks/useActiveRequest";
import { activeWorkspaceAtom } from "../../hooks/useActiveWorkspace";
import { sendAnyHttpRequest } from "../../hooks/useSendAnyHttpRequest";
import { showToast } from "../../lib/toast";
import { Icon } from "@yaakapp-internal/ui";
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

type Settings = {
  minimap: boolean;
  canvas: {
    addSelected: boolean;
    runAll: boolean;
    runSelected: boolean;
    runFlow: boolean;
    zoom: boolean;
    resetView: boolean;
    clearCanvas: boolean;
  };
  node: { run: boolean; runFlow: boolean; del: boolean };
  edge: { del: boolean };
};

const defaultSettings: Settings = {
  minimap: true,
  canvas: { addSelected: true, runAll: true, runSelected: true, runFlow: true, zoom: true, resetView: true, clearCanvas: true },
  node: { run: true, runFlow: true, del: true },
  edge: { del: true },
};
const SETTINGS_KEY = "node_space_settings";

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
  const [zoom, setZoom] = useState(1);
  const zoomIn = () => setZoom((z) => Math.min(2.5, Math.round((z + 0.15) * 100) / 100));
  const zoomOut = () => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100));
  const zoomReset = () => setZoom(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panDrag, setPanDrag] = useState<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const viewReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Settings>;
        return {
          minimap: parsed.minimap ?? defaultSettings.minimap,
          canvas: { ...defaultSettings.canvas, ...(parsed.canvas ?? {}) },
          node: { ...defaultSettings.node, ...(parsed.node ?? {}) },
          edge: { ...defaultSettings.edge, ...(parsed.edge ?? {}) },
        };
      }
    } catch {}
    return defaultSettings;
  });
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings]);

  // minimap: compute bounds of nodes + viewport, scale to fit 160x100
  const MINI_W = 160;
  const MINI_H = 100;
  const getViewportWorld = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    return {
      left: (-pan.x) / zoom,
      top: (-pan.y) / zoom,
      right: (w - pan.x) / zoom,
      bottom: (h - pan.y) / zoom,
      w,
      h,
    };
  };
  const mini = (() => {
    const vp = getViewportWorld();
    let minX = vp.left;
    let minY = vp.top;
    let maxX = vp.right;
    let maxY = vp.bottom;
    if (nodes.length > 0) {
      const xs = nodes.map((n) => n.x);
      const ys = nodes.map((n) => n.y);
      const nMinX = Math.min(...xs);
      const nMinY = Math.min(...ys);
      const nMaxX = Math.max(...nodes.map((n) => n.x + 140));
      const nMaxY = Math.max(...nodes.map((n) => n.y + 44));
      minX = Math.min(minX, nMinX - 80);
      minY = Math.min(minY, nMinY - 80);
      maxX = Math.max(maxX, nMaxX + 80);
      maxY = Math.max(maxY, nMaxY + 80);
    } else {
      // empty: show centered area around origin
      minX -= 200;
      minY -= 200;
      maxX += 200;
      maxY += 200;
    }
    const worldW = Math.max(1, maxX - minX);
    const worldH = Math.max(1, maxY - minY);
    const scale = Math.min((MINI_W - 8) / worldW, (MINI_H - 8) / worldH);
    const offX = (MINI_W - worldW * scale) / 2;
    const offY = (MINI_H - worldH * scale) / 2;
    const toMini = (x: number, y: number) => ({ x: (x - minX) * scale + offX, y: (y - minY) * scale + offY });
    const vpMini = {
      x: (vp.left - minX) * scale + offX,
      y: (vp.top - minY) * scale + offY,
      w: (vp.right - vp.left) * scale,
      h: (vp.bottom - vp.top) * scale,
    };
    return { minX, minY, scale, offX, offY, toMini, vpMini, worldW, worldH };
  })();
  const handleMiniClick = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = mini.minX + (mx - mini.offX) / mini.scale;
    const worldY = mini.minY + (my - mini.offY) / mini.scale;
    const vp = getViewportWorld();
    setPan({ x: vp.w / 2 - worldX * zoom, y: vp.h / 2 - worldY * zoom });
  };

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

  // close settings on outside click/escape
  useEffect(() => {
    if (!showSettings) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-settings-panel]") && !target.closest("[data-settings-button]")) setShowSettings(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowSettings(false);
    };
    // delay to avoid immediate close from the button click that opened it
    const id = setTimeout(() => window.addEventListener("click", close), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [showSettings]);

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
    const x = (e.clientX - rect.left - pan.x) / zoom - 40;
    const y = (e.clientY - rect.top - pan.y) / zoom - 20;
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
    const cx = (e.clientX - rect.left - pan.x) / zoom;
    const cy = (e.clientY - rect.top - pan.y) / zoom;
    // clamp to viewport so toolbox stays visible
    const x = e.clientX;
    const y = e.clientY;
    if (kind === "node" && id) setSelectedId(id);
    if (kind === "edge" && id) setSelectedEdgeId(id);
    setMenu({ x, y, cx, cy, kind, id } as Menu);
  };


  return (
    <div style={style} className="w-full h-full flex flex-col bg-surface overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-2 px-2 border-b border-border-subtle bg-surface relative">
        <span className="text-sm font-semibold">Node Space</span>
        <span className="text-xs text-text-subtle">
          {nodes.length} nodes • {edges.length} edges
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-text-subtle hidden sm:inline">
          {selectedId ? `selected: ${nodes.find((n) => n.id === selectedId)?.data.name ?? selectedId}` : "no selection"}
        </span>
        <button
          data-settings-button
          type="button"
          onClick={() => setShowSettings((v) => !v)}
          className={`w-7 h-7 grid place-items-center rounded hover:bg-surface-highlight border ${showSettings ? "bg-surface-highlight border-border" : "border-transparent"}`}
          title="Node Space settings"
          aria-label="Node Space settings"
        >
          <Icon icon="settings" size="sm" />
        </button>
        {showSettings && (
          <div data-settings-panel className="absolute top-10 right-2 z-30 w-[300px] bg-surface border border-border-subtle rounded-lg shadow-xl p-3 text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold">Node Space Settings</span>
            <button type="button" onClick={() => setShowSettings(false)} className="w-6 h-6 grid place-items-center rounded hover:bg-surface-highlight text-text-subtle">
              ✕
            </button>
          </div>
          <label className="flex items-center gap-2 py-1 cursor-pointer">
            <input type="checkbox" checked={settings.minimap} onChange={(e) => setSettings((s) => ({ ...s, minimap: e.target.checked }))} />
            <span>Show minimap</span>
          </label>
          <div className="h-px bg-border-subtle my-2" />
          <div className="text-xs font-semibold text-text-subtle mb-1">Canvas menu</div>
          {(
            [
              ["addSelected", "Add Selected here"],
              ["runAll", "Run All"],
              ["runSelected", "Run Selected"],
              ["runFlow", "Run Flow"],
              ["zoom", "Zoom controls"],
              ["resetView", "Reset view"],
              ["clearCanvas", "Clear Canvas"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 py-0.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={(settings.canvas as Record<string, boolean>)[k]}
                onChange={(e) => setSettings((s) => ({ ...s, canvas: { ...s.canvas, [k]: e.target.checked } }))}
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="h-px bg-border-subtle my-2" />
          <div className="text-xs font-semibold text-text-subtle mb-1">Node menu</div>
          {(
            [
              ["run", "Run"],
              ["runFlow", "Run Flow from here"],
              ["del", "Delete Node"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 py-0.5 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={(settings.node as Record<string, boolean>)[k]}
                onChange={(e) => setSettings((s) => ({ ...s, node: { ...s.node, [k]: e.target.checked } }))}
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="h-px bg-border-subtle my-2" />
          <div className="text-xs font-semibold text-text-subtle mb-1">Edge menu</div>
          <label className="flex items-center gap-2 py-0.5 cursor-pointer text-xs">
            <input type="checkbox" checked={settings.edge.del} onChange={(e) => setSettings((s) => ({ ...s, edge: { ...s.edge, del: e.target.checked } }))} />
            <span>Delete Connection</span>
          </label>
        </div>
        )}
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
          className={`absolute inset-0 overflow-hidden ${isDragOver ? "bg-primary/5 ring-2 ring-primary/50" : "bg-surface"} ${panDrag ? "cursor-grabbing" : "cursor-grab"}`}
          style={{
            backgroundImage:
              "linear-gradient(color-mix(in srgb, var(--color-border-subtle) 60%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-border-subtle) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              if (e.deltaY < 0) zoomIn();
              else zoomOut();
            } else {
              // wheel/trackpad pans canvas
              if (Math.abs(e.deltaX) > 0 || Math.abs(e.deltaY) > 0) {
                e.preventDefault();
                setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
              }
            }
          }}
          onPointerDown={(e) => {
            // middle-drag pans anywhere; left-drag pans background only
            if (e.button === 1) {
              e.preventDefault();
              setPanDrag({ sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y });
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              return;
            }
            if (e.button !== 0) return;
            const target = e.target as HTMLElement;
            if (target.closest("[data-node]") || target.closest("[data-handle]") || target.closest("button")) return;
            setPanDrag({ sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y });
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!panDrag) return;
            setPan({ x: panDrag.ox + e.clientX - panDrag.sx, y: panDrag.oy + e.clientY - panDrag.sy });
          }}
          onPointerUp={(e) => {
            if (!panDrag) return;
            setPanDrag(null);
            try {
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {}
          }}
        >
          <div
            className="absolute inset-0"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0", width: "100%", height: "100%" }}
          >
          <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none", overflow: "visible" }}>
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
                zoom={zoom}
                pan={pan}
                onContextMenu={(e) => openMenu(e, "node", n.id)}
              />
            );
          })}

          </div>
          {nodes.length === 0 && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="text-sm text-text-subtle border border-dashed border-border-subtle rounded-lg px-4 py-3 bg-surface/80 text-center">
                Drop APIs here or right-click → Add API
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 bg-surface border border-border-subtle rounded-lg shadow-md p-1">
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= 0.4}
            className="w-7 h-7 grid place-items-center rounded hover:bg-surface-highlight disabled:opacity-40 text-sm"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="text-xs text-text-subtle min-w-[3ch] text-center select-none">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= 2.5}
            className="w-7 h-7 grid place-items-center rounded hover:bg-surface-highlight disabled:opacity-40 text-sm"
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
          <div className="w-px h-5 bg-border-subtle mx-1" />
          <button
            type="button"
            onClick={zoomReset}
            disabled={zoom === 1}
            className="px-2 h-7 grid place-items-center rounded hover:bg-surface-highlight disabled:opacity-40 text-xs"
            title="Reset zoom"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={viewReset}
            disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
            className="px-2 h-7 grid place-items-center rounded hover:bg-surface-highlight disabled:opacity-40 text-xs"
            title="Reset view (zoom & pan)"
          >
            ⟲
          </button>
        </div>
        {/* minimap */}
        {settings.minimap && (
          <div className="absolute bottom-3 left-3 z-10 w-[160px] h-[100px] bg-surface border border-border-subtle rounded-lg shadow-md overflow-hidden">
          <div className="absolute inset-0 cursor-pointer" onClick={handleMiniClick} title="Click to pan">
            <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
              {edges.map((e) => {
                const s = nodes.find((n) => n.id === e.source);
                const t = nodes.find((n) => n.id === e.target);
                if (!s || !t) return null;
                const a = mini.toMini(s.x + 140, s.y + 22);
                const b = mini.toMini(t.x, t.y + 22);
                const dx = Math.abs(b.x - a.x) * 0.5;
                return (
                  <path
                    key={e.id}
                    d={`M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`}
                    fill="none"
                    stroke="var(--color-text)"
                    strokeWidth={1}
                    opacity={0.6}
                  />
                );
              })}
            </svg>
            {nodes.map((n) => {
              const p = mini.toMini(n.x, n.y);
              const isSel = selectedId === n.id;
              return (
                <div
                  key={n.id}
                  className={`absolute rounded-[2px] border ${isSel ? "bg-primary/20 border-primary" : "bg-surface border-border"}`}
                  style={{ left: p.x, top: p.y, width: 140 * mini.scale, height: 28 * mini.scale }}
                />
              );
            })}
            {/* viewport rect */}
            <div
              className="absolute border border-primary bg-primary/10 rounded-[2px] pointer-events-none"
              style={{
                left: mini.vpMini.x,
                top: mini.vpMini.y,
                width: mini.vpMini.w,
                height: mini.vpMini.h,
              }}
            />
          </div>
          <div className="absolute top-1 left-1 text-[8px] font-semibold tracking-wide text-text-subtle bg-surface/80 px-1 rounded">MAP</div>
          </div>
        )}

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
                {settings.node.run && (
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
                )}
                {settings.node.runFlow && (
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
                )}
                {(settings.node.run || settings.node.runFlow) && settings.node.del && <div className="h-px bg-border-subtle my-1" />}
                {settings.node.del && (
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-danger/10 text-danger"
                    onClick={() => {
                      setMenu(null);
                      deleteNode(menu.id!);
                    }}
                  >
                    ✕ Delete Node
                  </button>
                )}
                <div className="h-px bg-border-subtle my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight text-text-subtle"
                  onClick={() => {
                    setMenu(null);
                    setShowSettings(true);
                  }}
                >
                  ⚙ Settings
                </button>
              </>
            )}

            {menu.kind === "edge" && menu.id && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-text-subtle border-b border-border-subtle">
                  Connection
                </div>
                {settings.edge.del && (
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-danger/10 text-danger"
                    onClick={() => {
                      setMenu(null);
                      deleteEdge(menu.id!);
                    }}
                  >
                    ✕ Delete Connection
                  </button>
                )}
                <div className="h-px bg-border-subtle my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight text-text-subtle"
                  onClick={() => {
                    setMenu(null);
                    setShowSettings(true);
                  }}
                >
                  ⚙ Settings
                </button>
              </>
            )}

            {menu.kind === "canvas" && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-text-subtle border-b border-border-subtle">
                  Toolbox
                </div>
                {settings.canvas.addSelected && (
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
                )}
                {settings.canvas.runAll && (
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
                )}
                {settings.canvas.runSelected && (
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
                )}
                {settings.canvas.runFlow && (
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
                )}
                {(settings.canvas.runAll || settings.canvas.runSelected || settings.canvas.runFlow) &&
                  (settings.canvas.zoom || settings.canvas.resetView) && <div className="h-px bg-border-subtle my-1" />}
                {settings.canvas.zoom && (
                  <>
                    <div className="px-3 py-1 text-[11px] font-semibold text-text-subtle">Zoom & Pan</div>
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50 flex items-center justify-between"
                      disabled={zoom >= 2.5}
                      onClick={() => {
                        zoomIn();
                        setMenu(null);
                      }}
                    >
                      <span>Zoom in +</span>
                      <span className="text-xs text-text-subtle">{Math.round(zoom * 100)}%</span>
                    </button>
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                      disabled={zoom <= 0.4}
                      onClick={() => {
                        zoomOut();
                        setMenu(null);
                      }}
                    >
                      Zoom out −
                    </button>
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                      disabled={zoom === 1}
                      onClick={() => {
                        zoomReset();
                        setMenu(null);
                      }}
                    >
                      Reset zoom
                    </button>
                  </>
                )}
                {settings.canvas.resetView && (
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight disabled:opacity-50"
                    disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                    onClick={() => {
                      viewReset();
                      setMenu(null);
                    }}
                  >
                    Reset view
                  </button>
                )}
                {(settings.canvas.zoom || settings.canvas.resetView) && settings.canvas.clearCanvas && <div className="h-px bg-border-subtle my-1" />}
                {settings.canvas.clearCanvas && (
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
                )}
                <div className="h-px bg-border-subtle my-1" />
                <button
                  className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight text-text-subtle"
                  onClick={() => {
                    setMenu(null);
                    setShowSettings(true);
                  }}
                >
                  ⚙ Settings
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
