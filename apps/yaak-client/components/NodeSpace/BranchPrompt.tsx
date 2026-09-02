import { Button } from "../core/Button";
import type { Node } from "./types";

type Props = {
  branchPrompt: { from: string; targets: Node[] } | null;
  branchPos: { x: number; y: number } | null;
  setBranchPos: (p: { x: number; y: number } | null) => void;
  branchDrag: { sx: number; sy: number; ox: number; oy: number } | null;
  setBranchDrag: (d: { sx: number; sy: number; ox: number; oy: number } | null) => void;
  nodes: Node[];
};

export function BranchPrompt({
  branchPrompt,
  branchPos,
  setBranchPos,
  branchDrag,
  setBranchDrag,
  nodes,
}: Props) {
  if (!branchPrompt) return null;
  return (
    <div className="absolute inset-0 bg-backdrop/40 z-10" onClick={() => setBranchPos(null)}>
      <div
        className="bg-surface border border-border-subtle rounded-lg shadow-lg p-4 min-w-[320px] max-w-[90%] absolute"
        style={
          branchPos
            ? { left: branchPos.x, top: branchPos.y, transform: "none" }
            : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="text-sm font-semibold mb-1 cursor-move select-none flex items-center gap-2"
          onPointerDown={(e) => {
            const cur = branchPos ?? {
              x: window.innerWidth / 2 - 160,
              y: window.innerHeight / 2 - 100,
            };
            setBranchDrag({ sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y });
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!branchDrag) return;
            setBranchPos({
              x: branchDrag.ox + (e.clientX - branchDrag.sx),
              y: branchDrag.oy + (e.clientY - branchDrag.sy),
            });
          }}
          onPointerUp={(e) => {
            if (branchDrag) {
              setBranchDrag(null);
              try {
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
              } catch {}
            }
          }}
          title="Drag to move"
        >
          <span className="cursor-move opacity-60">⋮⋮</span> Branch:{" "}
          {nodes.find((n) => n.id === branchPrompt.from)?.data.name ?? branchPrompt.from} → ?
        </div>
        <div className="text-xs text-text-subtle mb-3">Select which way to continue flow</div>
        <div className="flex flex-col gap-2">
          {branchPrompt.targets.map((t, i) => (
            <Button
              key={t.id}
              size="sm"
              variant="border"
              className="justify-start"
              onClick={() =>
                (
                  window as unknown as { __branchResolve?: (v: string | null) => void }
                ).__branchResolve?.(t.id)
              }
            >
              <span className="w-6 h-6 rounded-full bg-primary text-white grid place-items-center text-xs font-bold mr-2 shrink-0">
                {i + 1}
              </span>
              <span className="text-xs font-mono bg-surface-highlight px-1 rounded mr-2">
                {t.data.method}
              </span>{" "}
              {t.data.name || t.data.url}
              <span className="ml-auto text-xs text-text-subtle">#{i + 1}</span>
            </Button>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            size="xs"
            variant="border"
            onClick={() =>
              (
                window as unknown as { __branchResolve?: (v: string | null) => void }
              ).__branchResolve?.(null)
            }
          >
            Cancel Flow
          </Button>
        </div>
      </div>
    </div>
  );
}
