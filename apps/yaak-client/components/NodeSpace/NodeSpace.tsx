import { duplicateModel, getModel, httpRequestsAtom } from "@yaakapp-internal/models";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { activeRequestAtom } from "../../hooks/useActiveRequest";
import { activeWorkspaceAtom } from "../../hooks/useActiveWorkspace";
import { sendAnyHttpRequest } from "../../hooks/useSendAnyHttpRequest";
import { showToast } from "../../lib/toast";
import { Icon } from "@yaakapp-internal/ui";
import { BranchPrompt } from "./BranchPrompt";
import { FlowNode } from "./FlowNode";
import { findFreePosition, svgPath, topoSort, wouldOverlap } from "./graph";
import type { Node } from "./types";
import { NODE_MIN_H, NODE_MIN_W } from "./types";
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
  node: { run: boolean; runFlow: boolean; del: boolean; resize: boolean; duplicate: boolean };
  edge: { del: boolean };
  layout: { noOverlap: boolean; gap: number };
};

const defaultSettings: Settings = {
  minimap: true,
  canvas: { addSelected: true, runAll: true, runSelected: true, runFlow: true, zoom: true, resetView: true, clearCanvas: true },
  node: { run: true, runFlow: true, del: true, resize: true, duplicate: true },
  edge: { del: true },
  layout: { noOverlap: true, gap: 10 },
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
  const [elapsedById, setElapsedById] = useState<Record<string, number>>({});
  const cancelRef = useRef(false);
  const clipboardRef = useRef<Node | null>(null);
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
  const fitView = () => {
    if (nodes.length === 0) {
      viewReset();
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    const pad = 80;
    const vw = rect?.width ?? 800;
    const vh = rect?.height ?? 600;
    let minX = Math.min(...nodes.map((n) => n.x));
    let minY = Math.min(...nodes.map((n) => n.y));
    let maxX = Math.max(...nodes.map((n) => n.x + (n.w ?? NODE_MIN_W)));
    let maxY = Math.max(...nodes.map((n) => n.y + (n.h ?? NODE_MIN_H)));
    const w = maxX - minX;
    const h = maxY - minY;
    const scale = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h, 1.5);
    const nz = Math.max(0.4, Math.min(2.5, Math.round(scale * 100) / 100));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setZoom(nz);
    setPan({ x: vw / 2 - cx * nz, y: vh / 2 - cy * nz });
  };
  const clearStatus = () => {
    setStatusById({});
    setElapsedById({});
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
          layout: { ...defaultSettings.layout, ...(parsed.layout ?? {}) },
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
      const nMaxX = Math.max(...nodes.map((n) => n.x + (n.w ?? NODE_MIN_W)));
      const nMaxY = Math.max(...nodes.map((n) => n.y + (n.h ?? NODE_MIN_H)));
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
      const isInput = (document.activeElement as HTMLElement | null)?.closest?.("input, textarea, [contenteditable=true]");
      const mod = e.ctrlKey || e.metaKey;
      // copy
      if (mod && e.key.toLowerCase() === "c" && selectedId && !isInput) {
        if (!settings.node.duplicate) return;
        const n = nodes.find((nn) => nn.id === selectedId);
        if (n) {
          clipboardRef.current = n;
          // also put requestId on clipboard for external paste
          try { navigator.clipboard?.writeText(n.data.requestId).catch(() => {}); } catch {}
          showToast({ message: `Copied ${n.data.name}`, color: "notice" });
          e.preventDefault();
        }
        return;
      }
      // paste - duplicate request with new name then add to canvas
      if (mod && e.key.toLowerCase() === "v" && !isInput) {
        if (!settings.node.duplicate) return;
        const src = clipboardRef.current;
        if (src) {
          void duplicateRequestAndAddNode(src.id);
          e.preventDefault();
        } else if (selectedId) {
          void duplicateRequestAndAddNode(selectedId);
          e.preventDefault();
        }
        return;
      }
      // quick duplicate via Ctrl/Cmd+D
      if (mod && e.key.toLowerCase() === "d" && selectedId && !isInput) {
        if (!settings.node.duplicate) return;
        void duplicateRequestAndAddNode(selectedId);
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (isInput) return;
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
  }, [selectedId, selectedEdgeId, saveSoon, setEdges, setNodes, nodes, httpRequests, settings.node.duplicate]);

  const onCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    let x = (e.clientX - rect.left - pan.x) / zoom - 40;
    let y = (e.clientY - rect.top - pan.y) / zoom - 20;
    x = Math.round(x / 10) * 10;
    y = Math.round(y / 10) * 10;
    const tryAdd = (id: string) => {
      const req = httpRequests.find((r) => r.id === id);
      if (req) {
        let fx = x, fy = y;
        if (settings.layout.noOverlap) {
          const free = findFreePosition(x, y, NODE_MIN_W, NODE_MIN_H, nodes, settings.layout.gap);
          fx = free.x; fy = free.y;
        }
        addNode(req, fx, fy);
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
      let fx = x, fy = y;
      if (settings.layout.noOverlap) {
        const free = findFreePosition(x, y, NODE_MIN_W, NODE_MIN_H, nodes, settings.layout.gap);
        fx = free.x; fy = free.y;
      }
      addNode(
        activeRequest as unknown as { id: string; name: string; method: string; url: string },
        fx,
        fy,
      );
    } else {
      showToast({
        message: "Drop failed: drag an API from left sidebar or use right-click → Add",
        color: "warning",
      });
    }
  };

  // ponytail: single helper for delay/retry/elapsed; per-node vars if needed later
  const execNode = async (node: Node) => {
    const delay = Math.max(0, node.data.delayMs ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (cancelRef.current) return { ok: false, cancelled: true as const };
    const retries = Math.max(0, Math.min(5, node.data.retry ?? 0));
    const t0 = Date.now();
    let lastErr: unknown = null;
    let lastRes: Awaited<ReturnType<typeof sendAnyHttpRequest.mutateAsync>> = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (cancelRef.current) return { ok: false, cancelled: true as const };
      try {
        const res = await sendAnyHttpRequest.mutateAsync(node.data.requestId);
        lastRes = res;
        const ok = !!res && res.status < 400;
        if (ok || attempt === retries) {
          const elapsed = Date.now() - t0;
          setElapsedById((m) => ({ ...m, [node.id]: elapsed }));
          setStatusById((m) => ({ ...m, [node.id]: ok ? "ok" : "err" }));
          return { ok, res, elapsed };
        }
        // retry after short backoff
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      } catch (e) {
        lastErr = e;
        if (attempt === retries) {
          const elapsed = Date.now() - t0;
          setElapsedById((m) => ({ ...m, [node.id]: elapsed }));
          setStatusById((m) => ({ ...m, [node.id]: "err" }));
          return { ok: false, error: e, elapsed };
        }
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    const elapsed = Date.now() - t0;
    setElapsedById((m) => ({ ...m, [node.id]: elapsed }));
    setStatusById((m) => ({ ...m, [node.id]: "err" }));
    return { ok: false, error: lastErr, res: lastRes, elapsed };
  };

  const duplicateRequestAndAddNode = async (nodeId: string) => {
    const src = nodes.find((n) => n.id === nodeId);
    if (!src) {
      showToast({ message: "No node selected", color: "warning" });
      return;
    }
    const origModel = getModel("http_request", src.data.requestId) as unknown as { id: string; name: string; method: string; url: string } | null;
    const fallbackReq = httpRequests.find((r) => r.id === src.data.requestId);
    const modelToDup = origModel ?? (fallbackReq as unknown as { id: string; model: string } | null);
    if (!modelToDup) {
      showToast({ message: "Original request not found", color: "danger" });
      return;
    }
    try {
      const newId = await duplicateModel(modelToDup as unknown as Parameters<typeof duplicateModel>[0]);
      // wait briefly for model store to sync (duplicateModel resolves before store event)
      let newReq: { id: string; name: string; method: string; url: string } | null = null;
      for (let i = 0; i < 20; i++) {
        const m = getModel("http_request", newId) as unknown as { id: string; name: string; method: string; url: string } | null;
        if (m) { newReq = m; break; }
        const fromList = httpRequests.find((r) => r.id === newId) as unknown as { id: string; name: string; method: string; url: string } | null;
        if (fromList) { newReq = fromList; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!newReq) {
        // fallback: use orig data with incremented name
        const orig = (origModel ?? fallbackReq) as unknown as { name: string; method: string; url: string };
        newReq = { id: newId, name: `${orig.name} Copy`, method: orig.method, url: orig.url };
      }
      // offset slightly so paste is visible; snap to grid, then find free spot if noOverlap
      let nx = Math.round((src.x + 40) / 10) * 10;
      let ny = Math.round((src.y + 40) / 10) * 10;
      if (settings.layout.noOverlap) {
        const w = src.w ?? NODE_MIN_W;
        const h = src.h ?? NODE_MIN_H;
        const free = findFreePosition(nx, ny, w, h, nodes, settings.layout.gap);
        nx = free.x; ny = free.y;
      }
      const newNodeId = addNode(newReq, nx, ny);
      setSelectedId(newNodeId);
      showToast({ message: `Duplicated ${newReq.name}`, color: "success" });
    } catch (err) {
      showToast({ message: `Duplicate failed: ${String(err)}`, color: "danger" });
    }
  };

  const cancelRun = () => {
    cancelRef.current = true;
    showToast({ message: "Cancelling…", color: "notice" });
  };

  const run = async () => {
    if (nodes.length === 0) {
      showToast({ message: "Add nodes first", color: "notice" });
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    const order = topoSort(nodes, edges);
    const results: { ok: boolean }[] = [];
    for (const nid of order) {
      if (cancelRef.current) {
        showToast({ message: "Run cancelled", color: "notice" });
        break;
      }
      const node = nodes.find((n) => n.id === nid);
      if (!node) continue;
      setStatusById((m) => ({ ...m, [nid]: "run" }));
      await new Promise((r) => setTimeout(r, 0));
      const out = await execNode(node);
      if ((out as { cancelled?: boolean }).cancelled) {
        showToast({ message: "Run cancelled", color: "notice" });
        break;
      }
      results.push({ ok: out.ok });
      if (!out.ok && !node.data.continueOnError) {
        showToast({ message: `${node.data.name} failed, stopping (toggle continueOnError to ignore)`, color: "warning" });
        break;
      }
    }
    if (!cancelRef.current) {
      showToast({
        message: `Ran ${results.length}/${order.length} requests`,
        color: results.some((r) => !r.ok) ? "warning" : "success",
      });
    }
    setRunning(false);
    cancelRef.current = false;
  };

  const runSingle = async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    cancelRef.current = false;
    setRunning(true);
    setStatusById((m) => ({ ...m, [nodeId]: "run" }));
    const out = await execNode(node);
    if ((out as { cancelled?: boolean }).cancelled) {
      showToast({ message: "Cancelled", color: "notice" });
    } else if (out.ok) {
      const res = (out as { res?: { status?: number } }).res;
      showToast({ message: `${node.data.name}: ${res?.status ?? "ok"}`, color: "success" });
    } else {
      const err = (out as { error?: unknown }).error;
      const res = (out as { res?: { status?: number } }).res;
      showToast({ message: `${node.data.name} failed${res?.status ? ` (${res.status})` : ""}${err ? `: ${String(err)}` : ""}`, color: "danger" });
    }
    setRunning(false);
    cancelRef.current = false;
  };

  const runFlow = async (startId: string) => {
    const start = nodes.find((n) => n.id === startId);
    if (!start) return;
    cancelRef.current = false;
    setFlowRunning(true);
    let cur: string | null = startId;
    const visited = new Set<string>();
    while (cur) {
      if (cancelRef.current) {
        showToast({ message: "Flow cancelled", color: "notice" });
        break;
      }
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
      const out = await execNode(node);
      if ((out as { cancelled?: boolean }).cancelled) {
        showToast({ message: "Flow cancelled", color: "notice" });
        break;
      }
      if (!out.ok && !node.data.continueOnError) {
        const res = (out as { res?: { status?: number } }).res;
        showToast({ message: `${node.data.name} failed${res?.status ? ` (${res.status})` : ""}, stopping`, color: "danger" });
        break;
      }
      const outs = edges.filter((e) => e.source === cur);
      if (outs.length === 0) {
        showToast({ message: "Flow complete", color: "success" });
        break;
      }
      if (outs.length === 1) {
        cur = outs[0]!.target ?? null;
        continue;
      }
      // try auto-resolve via edge condition based on last response status
      const lastRes = (out as { res?: { status?: number } }).res;
      const status = lastRes?.status;
      const matches = (cond?: string) => {
        if (!cond || cond === "always") return true;
        if (status == null) return false;
        if (cond === "ok") return status < 400;
        if (cond === "error") return status >= 400;
        if (cond === "2xx") return status >= 200 && status < 300;
        if (cond === "3xx") return status >= 300 && status < 400;
        if (cond === "4xx") return status >= 400 && status < 500;
        if (cond === "5xx") return status >= 500 && status < 600;
        const n = parseInt(cond, 10);
        if (!isNaN(n)) return status === n;
        return false;
      };
      const autoTargets = outs.filter((ed) => ed.condition && ed.condition !== "manual" && matches(ed.condition));
      // if exactly one edge has matching condition, auto follow it without prompt
      // if multiple match, or none match but some have conditions, fall back to prompt
      // if no conditions defined at all, prompt (legacy behavior)
      const hasAnyCondition = outs.some((ed) => ed.condition && ed.condition !== "manual" && ed.condition !== "always");
      if (autoTargets.length === 1 && hasAnyCondition) {
        cur = autoTargets[0]!.target;
        continue;
      }
      if (autoTargets.length > 1) {
        // multiple matching -> let user choose among matching only
        const targets = autoTargets.map((ed) => nodes.find((n) => n.id === ed.target)).filter(Boolean) as Node[];
        const choice = await new Promise<string | null>((resolve) => {
          setBranchPrompt({ from: cur!, targets });
          (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve = resolve;
        });
        setBranchPrompt(null);
        (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve = undefined;
        if (!choice) {
          showToast({ message: "Flow cancelled at branch", color: "notice" });
          break;
        }
        cur = choice;
        continue;
      }
      // no auto match -> prompt among all
      const targets = outs.map((ed) => nodes.find((n) => n.id === ed.target)).filter(Boolean) as Node[];
      const choice = await new Promise<string | null>((resolve) => {
        setBranchPrompt({ from: cur!, targets });
        (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve = resolve;
      });
      setBranchPrompt(null);
      (window as unknown as { __branchResolve?: (v: string | null) => void }).__branchResolve = undefined;
      if (!choice) {
        showToast({ message: "Flow cancelled at branch", color: "notice" });
        break;
      }
      cur = choice;
    }
    setFlowRunning(false);
    cancelRef.current = false;
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
        {(running || flowRunning) && (
          <button
            type="button"
            onClick={cancelRun}
            className="px-2 h-7 text-xs bg-danger text-white rounded hover:bg-danger/90"
            title="Cancel run"
          >
            ■ Cancel
          </button>
        )}
        <button type="button" onClick={fitView} className="px-2 h-7 text-xs border border-border-subtle rounded hover:bg-surface-highlight" title="Fit all nodes in view">Fit</button>
        <button type="button" onClick={clearStatus} className="px-2 h-7 text-xs border border-border-subtle rounded hover:bg-surface-highlight" title="Clear status colors">Clear</button>
        <button type="button" onClick={() => {
          const data = JSON.stringify({ nodes, edges }, null, 2);
          const blob = new Blob([data], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `node-space-${wsId}.json`; a.click();
          URL.revokeObjectURL(url);
        }} className="px-2 h-7 text-xs border border-border-subtle rounded hover:bg-surface-highlight" title="Export flow JSON">Export</button>
        <label className="px-2 h-7 text-xs border border-border-subtle rounded hover:bg-surface-highlight grid place-items-center cursor-pointer" title="Import flow JSON">
          Import
          <input type="file" accept=".json" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return;
            const r = new FileReader();
            r.onload = () => {
              try {
                const j = JSON.parse(String(r.result));
                if (Array.isArray(j.nodes) && Array.isArray(j.edges)) {
                  let inNodes: Node[] = j.nodes;
                  // enforce no-overlap on import if enabled
                  if (settings.layout.noOverlap) {
                    const gap = settings.layout.gap;
                    const fixed: Node[] = [];
                    for (const n of inNodes as Node[]) {
                      const w = (n as Node).w ?? NODE_MIN_W;
                      const h = (n as Node).h ?? NODE_MIN_H;
                      const free = findFreePosition((n as Node).x, (n as Node).y, w, h, fixed, gap);
                      fixed.push({ ...(n as Node), x: free.x, y: free.y });
                    }
                    inNodes = fixed;
                  }
                  setNodes(inNodes); setEdges(j.edges); save(inNodes, j.edges);
                  showToast({ message: `Imported ${inNodes.length} nodes`, color: "success" });
                  setTimeout(fitView, 100);
                } else showToast({ message: "Invalid flow file", color: "danger" });
              } catch { showToast({ message: "Invalid JSON", color: "danger" }); }
            };
            r.readAsText(f);
            e.target.value = "";
          }} />
        </label>
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
              ["resize", "Resize (drag edge)"],
              ["duplicate", "Duplicate (Ctrl+C/V)"],
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
          <div className="h-px bg-border-subtle my-2" />
          <div className="text-xs font-semibold text-text-subtle mb-1">Layout</div>
          <label className="flex items-center gap-2 py-0.5 cursor-pointer text-xs">
            <input type="checkbox" checked={settings.layout.noOverlap} onChange={(e) => setSettings((s) => ({ ...s, layout: { ...s.layout, noOverlap: e.target.checked } }))} />
            <span>Prevent overlap</span>
          </label>
          <label className="flex items-center gap-2 py-0.5 text-xs">
            <span>Gap</span>
            <input type="number" min={0} max={50} step={1} value={settings.layout.gap} onChange={(e) => setSettings((s) => ({ ...s, layout: { ...s.layout, gap: Math.max(0, Math.min(50, parseInt(e.target.value) || 0)) } }))} className="w-14 px-1 py-0.5 border border-border-subtle rounded bg-surface text-xs" />
            <span>px</span>
          </label>
          <button
            type="button"
            onClick={() => {
              // ponytail: naive de-overlap in order; upgrade to force layout if needed
              const gap = settings.layout.gap;
              let next = [...nodes];
              let changed = false;
              for (let i = 0; i < next.length; i++) {
                const n = next[i]!;
                const w = n.w ?? NODE_MIN_W;
                const h = n.h ?? NODE_MIN_H;
                const others = next.slice(0, i);
                if (wouldOverlap(n.id, n.x, n.y, w, h, others, gap)) {
                  const free = findFreePosition(n.x, n.y, w, h, others, gap);
                  if (free.x !== n.x || free.y !== n.y) {
                    next[i] = { ...n, x: free.x, y: free.y };
                    changed = true;
                  }
                }
              }
              if (changed) {
                setNodes(next);
                save(next, edges);
                showToast({ message: "De-overlapped nodes", color: "success" });
              } else showToast({ message: "No overlap found", color: "notice" });
            }}
            className="mt-1 w-full px-2 py-1 rounded border border-border-subtle hover:bg-surface-highlight text-xs"
          >
            De-overlap nodes
          </button>
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
              const x1 = s.x + (s.w ?? NODE_MIN_W),
                y1 = s.y + (s.h ?? NODE_MIN_H) / 2,
                x2 = t.x,
                y2 = t.y + (t.h ?? NODE_MIN_H) / 2;
              const sel = selectedEdgeId === e.id;
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;
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
                  {e.condition && e.condition !== "manual" && (
                    <g>
                      <rect x={midX - 18} y={midY - 8} width={36} height={14} rx={7} fill="var(--color-surface)" stroke={sel ? "var(--color-primary)" : "var(--color-border-subtle)"} strokeWidth={1} />
                      <text x={midX} y={midY + 3} textAnchor="middle" fontSize={8} fontWeight={600} fill="var(--color-text)">{e.condition}</text>
                    </g>
                  )}
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
            return (
              <FlowNode
                key={n.id}
                node={n}
                selected={selectedId === n.id}
                branchIdx={idx}
                status={statusById[n.id]}
                elapsedMs={elapsedById[n.id]}
                allowResize={settings.node.resize}
                noOverlap={settings.layout.noOverlap}
                gap={settings.layout.gap}
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
          <button type="button" onClick={fitView} className="px-2 h-7 grid place-items-center rounded hover:bg-surface-highlight text-xs" title="Fit all nodes">Fit</button>
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
                const a = mini.toMini(s.x + (s.w ?? NODE_MIN_W), s.y + (s.h ?? NODE_MIN_H) / 2);
                const b = mini.toMini(t.x, t.y + (t.h ?? NODE_MIN_H) / 2);
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
                  style={{ left: p.x, top: p.y, width: (n.w ?? NODE_MIN_W) * mini.scale, height: (n.h ?? NODE_MIN_H) * mini.scale }}
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
                {settings.node.duplicate && (
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-surface-highlight"
                    onClick={() => {
                      const id = menu.id!;
                      setMenu(null);
                      void duplicateRequestAndAddNode(id);
                    }}
                  >
                    ⎘ Duplicate (Ctrl+C / V)
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
                        {
                          let fx = menu.cx, fy = menu.cy;
                          if (settings.layout.noOverlap) {
                            const free = findFreePosition(fx, fy, NODE_MIN_W, NODE_MIN_H, nodes, settings.layout.gap);
                            fx = free.x; fy = free.y;
                          }
                          addNode(
                            activeRequest as unknown as {
                              id: string;
                              name: string;
                              method: string;
                              url: string;
                            },
                            fx,
                            fy,
                          );
                        }
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

        {selectedId && (() => {
          const sel = nodes.find((n) => n.id === selectedId);
          if (!sel) return null;
          const update = (patch: Partial<typeof sel.data>) => {
            setNodes((prev) => {
              const next = prev.map((p) => (p.id === selectedId ? { ...p, data: { ...p.data, ...patch } } : p));
              saveSoon(next, edges);
              return next;
            });
          };
          return (
            <div className="shrink-0 border-t border-border-subtle bg-surface px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold truncate max-w-[160px]">{sel.data.name}</span>
              <span className="text-text-subtle">{sel.data.method}</span>
              {statusById[sel.id] && <span className={`px-1.5 py-0.5 rounded text-[10px] ${statusById[sel.id] === "ok" ? "bg-success/20 text-success" : statusById[sel.id] === "err" ? "bg-danger/20 text-danger" : "bg-warning/20 text-warning"}`}>{statusById[sel.id]}{elapsedById[sel.id] ? ` ${elapsedById[sel.id]}ms` : ""}</span>}
              <div className="h-4 w-px bg-border-subtle" />
              <label className="flex items-center gap-1">
                Delay
                <input type="number" min={0} max={10000} step={100} value={sel.data.delayMs ?? 0} onChange={(e) => update({ delayMs: Math.max(0, parseInt(e.target.value) || 0) || undefined })} className="w-16 px-1 py-0.5 border border-border-subtle rounded bg-surface text-xs" />
                ms
              </label>
              <label className="flex items-center gap-1">
                Retry
                <input type="number" min={0} max={5} value={sel.data.retry ?? 0} onChange={(e) => update({ retry: Math.max(0, Math.min(5, parseInt(e.target.value) || 0)) || undefined })} className="w-12 px-1 py-0.5 border border-border-subtle rounded bg-surface text-xs" />
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={!!sel.data.continueOnError} onChange={(e) => update({ continueOnError: e.target.checked || undefined })} />
                Continue on error
              </label>
              <div className="flex-1" />
              {settings.node.duplicate && <button type="button" onClick={() => void duplicateRequestAndAddNode(sel.id)} className="px-2 py-1 rounded border border-border-subtle text-xs" title="Duplicate request + node (Ctrl+C / Ctrl+V)">⎘ Dup</button>}
              <button type="button" onClick={() => runSingle(sel.id)} disabled={running || flowRunning} className="px-2 py-1 rounded bg-primary text-white text-xs disabled:opacity-50">▶ Run</button>
              <button type="button" onClick={() => runFlow(sel.id)} disabled={running || flowRunning} className="px-2 py-1 rounded border border-border-subtle text-xs disabled:opacity-50">⤳ Flow</button>
            </div>
          );
        })()}
        {selectedEdgeId && (() => {
          const ed = edges.find((e) => e.id === selectedEdgeId);
          if (!ed) return null;
          const srcName = nodes.find((n) => n.id === ed.source)?.data.name ?? ed.source;
          const dstName = nodes.find((n) => n.id === ed.target)?.data.name ?? ed.target;
          const update = (condition?: string) => {
            setEdges((prev) => {
              const next = prev.map((p) => (p.id === selectedEdgeId ? { ...p, condition: condition || undefined } : p));
              setNodes((pn) => {
                saveSoon(pn, next);
                return pn;
              });
              return next;
            });
          };
          return (
            <div className="shrink-0 border-t border-border-subtle bg-surface px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold">{srcName} → {dstName}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${selectedEdgeId ? "bg-primary/10 text-primary" : ""}`}>connection</span>
              <div className="h-4 w-px bg-border-subtle" />
              <label className="flex items-center gap-1">
                Condition
                <select value={ed.condition ?? "manual"} onChange={(e) => update(e.target.value === "manual" ? undefined : e.target.value)} className="px-1 py-0.5 border border-border-subtle rounded bg-surface text-xs">
                  <option value="manual">Manual (prompt)</option>
                  <option value="always">Always</option>
                  <option value="ok">OK (2xx/3xx)</option>
                  <option value="error">Error (4xx/5xx)</option>
                  <option value="2xx">2xx</option>
                  <option value="3xx">3xx</option>
                  <option value="4xx">4xx</option>
                  <option value="5xx">5xx</option>
                  <option value="200">200</option>
                  <option value="201">201</option>
                  <option value="400">400</option>
                  <option value="404">404</option>
                  <option value="500">500</option>
                </select>
              </label>
              <span className="text-text-subtle">auto-picks branch when status matches</span>
              <div className="flex-1" />
              <button type="button" onClick={() => deleteEdge(ed.id)} className="px-2 py-1 rounded bg-danger text-white text-xs">✕ Delete</button>
            </div>
          );
        })()}
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
