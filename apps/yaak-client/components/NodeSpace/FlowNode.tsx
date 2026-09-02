import type { Node, Edge } from "./types";
import { wouldCreateCycle } from "./graph";

type Props = {
  node: Node;
  selected: boolean;
  branchIdx: number; // -1 if not in branch
  running: boolean;
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
  runSingle: (id: string) => void;
  edges: Edge[];
  nodes: Node[];
};

export function FlowNode({
  node: n,
  selected,
  branchIdx,
  running,
  canvasRef,
  drag,
  setDrag,
  setNodes,
  setEdges,
  setSelectedId,
  setPending,
  save,
  saveSoon,
  runSingle,
  edges,
}: Props) {
  return (
    <div
      data-node={n.id}
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest("[data-handle]") ||
          target.closest("[data-del]") ||
          target.closest("[data-run]")
        )
          return;
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
      className={`absolute min-w-[140px] px-3 py-2 rounded-lg border bg-surface shadow-sm flex flex-col cursor-move select-none node ${selected ? "border-primary ring-1 ring-primary" : "border-border"}`}
    >
      {branchIdx >= 0 && (
        <div className="absolute -top-3 -left-3 w-7 h-7 rounded-full bg-primary text-white grid place-items-center text-xs font-bold shadow border-2 border-white z-10">
          {branchIdx + 1}
        </div>
      )}
      <div className="text-xs font-semibold truncate max-w-[140px]">
        {n.data.name || n.data.url}
      </div>
      <div className="text-[10px] text-text-subtle truncate max-w-[140px]">
        {n.data.method} {n.data.url.slice(0, 28)}
      </div>
      {selected && (
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
          const x1 = n.x + 140,
            y1 = n.y + 22;
          setPending({ source: n.id, x1, y1, x2: x1, y2: y1 });
          const move = (ev: PointerEvent) => {
            const crect = canvasRef.current!.getBoundingClientRect();
            setPending((prev) =>
              prev ? { ...prev, x2: ev.clientX - crect.left, y2: ev.clientY - crect.top } : null,
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
                // toast handled by caller via window? keep simple
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
        title="Drag to connect"
      />
      <div
        data-handle="in"
        className="absolute -left-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-primary border-2 border-surface shadow"
      />
      <button
        data-del
        onClick={() => {
          // caller handles bulk delete; inline for speed
          setNodes((prevNodes) => {
            const nextNodes = prevNodes.filter((x) => x.id !== n.id);
            setEdges((prevEdges) => {
              const nextEdges = prevEdges.filter((e) => e.source !== n.id && e.target !== n.id);
              save(nextNodes, nextEdges);
              return nextEdges;
            });
            return nextNodes;
          });
        }}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface border border-border-subtle grid place-items-center text-[10px] hover:bg-danger hover:text-white"
      >
        ×
      </button>
    </div>
  );
}
