import type { Node, Edge } from "./types";
import { NODE_MAX_H, NODE_MAX_W, NODE_MIN_H, NODE_MIN_W } from "./types";
import { findFreePosition, wouldCreateCycle, wouldOverlap } from "./graph";

type Props = {
  node: Node;
  selected: boolean;
  branchIdx: number;
  running: boolean;
  status?: "ok" | "err" | "run";
  elapsedMs?: number;
  allowResize?: boolean;
  noOverlap?: boolean;
  gap?: number;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  drag: { id: string; dx: number; dy: number } | null;
  setDrag: (d: { id: string; dx: number; dy: number } | null) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setSelectedId: (id: string | null) => void;
  setPending: React.Dispatch<
    React.SetStateAction<{ source: string; x1: number; y1: number; x2: number; y2: number } | null>
  >;
  save: (n: Node[], e: Edge[]) => void;
  saveSoon: (n: Node[], e: Edge[]) => void;
  edges: Edge[];
  nodes: Node[];
  zoom: number;
  pan: { x: number; y: number };
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function FlowNode({
  node: n,
  selected,
  branchIdx,
  status,
  elapsedMs,
  allowResize = true,
  noOverlap = true,
  gap = 10,
  canvasRef,
  drag,
  setDrag,
  setNodes,
  setEdges,
  setSelectedId,
  setPending,
  saveSoon,
  nodes,
  edges,
  zoom,
  pan,
  onContextMenu,
}: Props) {
  return (
    <div
      data-node={n.id}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest("[data-handle]") || target.closest("[data-resize]")) return;
        const crect = canvasRef.current!.getBoundingClientRect();
        const offsetX = (e.clientX - crect.left - pan.x) / zoom - n.x;
        const offsetY = (e.clientY - crect.top - pan.y) / zoom - n.y;
        setDrag({ id: n.id, dx: offsetX, dy: offsetY });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onClick={() => setSelectedId(n.id)}
      onContextMenu={onContextMenu}
      onPointerMove={(e) => {
        if (drag?.id !== n.id) return;
        const crect = canvasRef.current!.getBoundingClientRect();
        let cx = (e.clientX - crect.left - pan.x) / zoom - drag.dx;
        let cy = (e.clientY - crect.top - pan.y) / zoom - drag.dy;
        // ponytail: 10px grid snap, hold Shift to disable; no overlap check here for smoothness - snap on drop
        if (!e.shiftKey) {
          cx = Math.round(cx / 10) * 10;
          cy = Math.round(cy / 10) * 10;
        }
        setNodes((prev) => prev.map((p) => (p.id === n.id ? { ...p, x: cx, y: cy } : p)));
      }}
      onPointerUp={() => {
        if (drag) {
          setDrag(null);
          setNodes((prev) => {
            // smooth snap: if dropped overlapping, nudge to nearest free spot
            if (noOverlap) {
              const cur = prev.find((p) => p.id === n.id);
              if (cur) {
                const w = cur.w ?? NODE_MIN_W;
                const h = cur.h ?? NODE_MIN_H;
                if (wouldOverlap(cur.id, cur.x, cur.y, w, h, prev, gap)) {
                  const free = findFreePosition(cur.x, cur.y, w, h, prev, gap);
                  const fixed = prev.map((p) => (p.id === cur.id ? { ...p, x: free.x, y: free.y } : p));
                  saveSoon(fixed, edges);
                  return fixed;
                }
              }
            }
            saveSoon(prev, edges);
            return prev;
          });
        }
      }}
      style={{ left: n.x, top: n.y, width: n.w ?? NODE_MIN_W, minHeight: n.h ?? NODE_MIN_H, transform: "translateZ(0)", willChange: drag?.id === n.id ? "left, top" : undefined } as React.CSSProperties}
      className={`absolute px-3 py-2 rounded-lg border bg-surface shadow-sm flex flex-col cursor-move select-none touch-none node ${
        status === "run"
          ? "border-warning ring-1 ring-warning"
          : status === "ok"
            ? "border-success ring-1 ring-success"
            : status === "err"
              ? "border-danger ring-1 ring-danger"
              : selected
                ? "border-primary ring-1 ring-primary"
                : "border-border"
      }`}
    >
      {branchIdx >= 0 && (
        <div className="absolute -top-3 -left-3 w-7 h-7 rounded-full bg-primary text-white grid place-items-center text-xs font-bold shadow border-2 border-white z-10">
          {branchIdx + 1}
        </div>
      )}
      <div className="text-xs font-semibold truncate max-w-[140px] flex items-center gap-1">
        <span className="truncate flex-1">{n.data.name || n.data.url}</span>
        {status === "run" && <span className="w-2 h-2 rounded-full bg-warning animate-pulse shrink-0" />}
        {status === "ok" && <span className="w-2 h-2 rounded-full bg-success shrink-0" />}
        {status === "err" && <span className="w-2 h-2 rounded-full bg-danger shrink-0" />}
      </div>
      <div className="text-[10px] text-text-subtle truncate max-w-[140px] flex items-center gap-1">
        <span>{n.data.method}</span>
        <span className="truncate">{n.data.url.slice(0, 28)}</span>
        {elapsedMs != null && <span className="ml-auto text-[9px] bg-surface-highlight px-1 rounded">{elapsedMs}ms</span>}
      </div>
      {(n.data.delayMs || n.data.retry || n.data.continueOnError) && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {n.data.delayMs ? <span className="text-[9px] px-1 py-0 rounded bg-surface-highlight border border-border-subtle">⏱{n.data.delayMs}ms</span> : null}
          {n.data.retry ? <span className="text-[9px] px-1 py-0 rounded bg-surface-highlight border border-border-subtle">↻{n.data.retry}</span> : null}
          {n.data.continueOnError ? <span className="text-[9px] px-1 py-0 rounded bg-warning/20 border border-warning/30">cont</span> : null}
        </div>
      )}
      <div
        data-handle="out"
        onPointerDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          const w = n.w ?? NODE_MIN_W;
          const h = n.h ?? NODE_MIN_H;
          const x1 = n.x + w,
            y1 = n.y + h / 2;
          setPending({ source: n.id, x1, y1, x2: x1, y2: y1 });
          const move = (ev: PointerEvent) => {
            const crect = canvasRef.current!.getBoundingClientRect();
            setPending((prev) =>
              prev ? { ...prev, x2: (ev.clientX - crect.left - pan.x) / zoom, y2: (ev.clientY - crect.top - pan.y) / zoom } : null,
            );
          };
          const up = (ev: PointerEvent) => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
            const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
            const target = el?.closest("[data-node]") as HTMLElement | null;
            if (target && target.dataset.node !== n.id) {
              const tid = target.dataset.node!;
              if (wouldCreateCycle(n.id, tid, edges)) {
                setPending(null);
                return;
              }
              setEdges((prev) => {
                if (prev.some((ee) => ee.source === n.id && ee.target === tid)) return prev;
                if (wouldCreateCycle(n.id, tid, prev)) return prev;
                const next = [
                  ...prev,
                  { id: `e${Date.now()}${Math.random()}`, source: n.id, target: tid },
                ];
                setNodes((prevNodes) => {
                  saveSoon(prevNodes, next);
                  return prevNodes;
                });
                return next;
              });
            }
            setPending(null);
          };
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        }}
        className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-text border-2 border-surface shadow cursor-crosshair flex items-center justify-center"
        title="Drag to connect — right-click for tools"
      />
      <div
        data-handle="in"
        className="absolute -left-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-primary border-2 border-surface shadow"
      />
      {/* ponytail: minimal resize handles - east, south, southeast; capped to min/max, toggleable */}
      {selected && allowResize && (
        <>
          <div
            data-resize="e"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const startX = e.clientX;
              const startW = n.w ?? NODE_MIN_W;
              const onMove = (ev: PointerEvent) => {
                const dx = (ev.clientX - startX) / zoom;
                let nw = Math.round((startW + dx) / 10) * 10;
                nw = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, nw));
                setNodes((prev) => prev.map((p) => (p.id === n.id ? { ...p, w: nw } : p)));
              };
              const onUp = () => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                setNodes((prev) => {
                  if (noOverlap) {
                    const cur = prev.find((p) => p.id === n.id);
                    if (cur && wouldOverlap(cur.id, cur.x, cur.y, cur.w ?? NODE_MIN_W, cur.h ?? NODE_MIN_H, prev, gap)) {
                      const fixed = prev.map((p) => (p.id === n.id ? { ...p, w: startW } : p));
                      saveSoon(fixed, edges);
                      return fixed;
                    }
                  }
                  saveSoon(prev, edges);
                  return prev;
                });
              };
              document.addEventListener("pointermove", onMove);
              document.addEventListener("pointerup", onUp);
            }}
            className="absolute -right-1 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-primary/20"
            title="Drag to resize width"
          />
          <div
            data-resize="se"
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              const startX = e.clientX;
              const startY = e.clientY;
              const startW = n.w ?? NODE_MIN_W;
              const startH = n.h ?? NODE_MIN_H;
              const onMove = (ev: PointerEvent) => {
                const dx = (ev.clientX - startX) / zoom;
                const dy = (ev.clientY - startY) / zoom;
                let nw = Math.round((startW + dx) / 10) * 10;
                let nh = Math.round((startH + dy) / 10) * 10;
                nw = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, nw));
                nh = Math.max(NODE_MIN_H, Math.min(NODE_MAX_H, nh));
                setNodes((prev) => prev.map((p) => (p.id === n.id ? { ...p, w: nw, h: nh } : p)));
              };
              const onUp = () => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
                setNodes((prev) => {
                  if (noOverlap) {
                    const cur = prev.find((p) => p.id === n.id);
                    if (cur && wouldOverlap(cur.id, cur.x, cur.y, cur.w ?? NODE_MIN_W, cur.h ?? NODE_MIN_H, prev, gap)) {
                      const fixed = prev.map((p) => (p.id === n.id ? { ...p, w: startW, h: startH } : p));
                      saveSoon(fixed, edges);
                      return fixed;
                    }
                  }
                  saveSoon(prev, edges);
                  return prev;
                });
              };
              document.addEventListener("pointermove", onMove);
              document.addEventListener("pointerup", onUp);
            }}
            className="absolute -right-1 -bottom-1 w-3 h-3 cursor-nwse-resize bg-surface border border-primary rounded-sm hover:bg-primary/20"
            title="Drag to resize"
          />
        </>
      )}
    </div>
  );
}
