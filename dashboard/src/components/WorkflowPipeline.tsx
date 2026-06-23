import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Position,
  Handle,
  type NodeProps,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import type { WorkflowRun, RunPhase } from "../api";

type PhaseStatus = "active" | "paused" | "done" | "failed";

interface PhaseNodeData extends Record<string, unknown> {
  label: string;
  status: PhaseStatus;
  timestamp?: string;
  duration?: number;
  messageCount: number;
  toolCount: number;
  selected?: boolean;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s}s`;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PhaseFlowNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  const dotClass = clsx("w-2.5 h-2.5 rounded-full shrink-0", {
    "bg-success": data.status === "done",
    "bg-error": data.status === "failed",
    "bg-info animate-pulse": data.status === "active",
    "bg-warning": data.status === "paused",
  });

  const containerClass = clsx(
    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg border shadow-md min-w-[90px] text-center cursor-pointer transition-shadow",
    {
      "border-success/60 bg-success/15": data.status === "done",
      "border-error/60 bg-error/15": data.status === "failed",
      "border-info/60 bg-info/15": data.status === "active",
      "border-warning/60 bg-warning/15": data.status === "paused",
      "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected,
    },
  );

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Left} className="!bg-base-300/60 !border-none !w-1 !h-1" />
      <div className="flex items-center gap-1.5">
        <span className={dotClass} />
        <span className="text-xs font-medium text-base-content/80 font-mono">{data.label}</span>
      </div>
      {data.timestamp && (
        <span className="text-2xs text-base-content/40 font-mono">{formatTime(data.timestamp)}</span>
      )}
      {data.duration !== undefined && (
        <span className="text-2xs text-base-content/40 font-mono">{formatDuration(data.duration)}</span>
      )}
      <span className="text-2xs text-base-content/40 font-mono">
        {data.messageCount} msg · {data.toolCount} tool
      </span>
      <Handle type="source" position={Position.Right} className="!bg-base-300/60 !border-none !w-1 !h-1" />
    </div>
  );
}

const nodeTypes = { phase: PhaseFlowNode };

const NODE_WIDTH = 120;
const NODE_GAP = 40;

interface Props {
  run: WorkflowRun;
  /**
   * Phases derived from the run's event stream (one operation per agent phase).
   * The pipeline is fully history-driven — Flue workflows carry no declarative
   * phase definitions, so each node maps to a real executed operation.
   */
  phases: RunPhase[];
  /** Pixel height of the pipeline canvas. Defaults to 180. */
  height?: number | string;
  /** Currently-selected phase operationId (for the visual indicator). */
  selectedPhase?: string | null;
  /** Invoked with the operationId when the user clicks a phase node. */
  onPhaseClick?: (operationId: string) => void;
}

/**
 * Pipeline visualisation for a workflow run, reconstructed from the run's
 * durable event stream (see `derivePhases` server-side). Each node is one
 * operation — an agent-running phase — labeled by its harness session name.
 * Loop iterations (each cycle opens a fresh named session) appear as their own
 * nodes naturally. A single-agent workflow renders as one `default` node.
 */
export function WorkflowPipeline({
  run,
  phases,
  height = 180,
  selectedPhase,
  onPhaseClick,
}: Props) {
  const { nodes, edges } = useMemo(() => {
    const isRunActive = run.status === "running" || run.status === "paused";
    const lastIdx = phases.length - 1;

    const reactFlowNodes: Node<PhaseNodeData>[] = phases.map((p, idx) => {
      let status: PhaseStatus;
      if (p.isError) status = "failed";
      else if (isRunActive && idx === lastIdx) status = run.status === "paused" ? "paused" : "active";
      else status = "done";

      const duration =
        p.startedAt && p.endedAt
          ? (new Date(p.endedAt).getTime() - new Date(p.startedAt).getTime()) / 1000
          : undefined;

      return {
        id: p.operationId,
        type: "phase",
        position: { x: idx * (NODE_WIDTH + NODE_GAP), y: 0 },
        data: {
          label: p.name,
          status,
          timestamp: p.startedAt,
          duration: duration !== undefined && duration >= 0 ? duration : undefined,
          messageCount: p.messageCount,
          toolCount: p.toolCount,
          selected: selectedPhase === p.operationId,
        },
        style: { width: NODE_WIDTH },
      };
    });

    const reactFlowEdges: Edge[] = [];
    for (let i = 0; i < phases.length - 1; i++) {
      const a = phases[i]!.operationId;
      const b = phases[i + 1]!.operationId;
      reactFlowEdges.push({
        id: `${a}->${b}`,
        source: a,
        target: b,
        style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
        animated: false,
      });
    }

    return { nodes: reactFlowNodes, edges: reactFlowEdges };
  }, [phases, run, selectedPhase]);

  // Re-center on resize. The `mounted` guard + try/catch prevent xyflow's async
  // tick from accessing a torn-down store when the run is swapped mid-fit.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<PhaseNodeData>, Edge> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const el = wrapperRef.current;
    if (!el) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        const flow = flowRef.current;
        if (!flow) return;
        try {
          if (flow.getNodes().length === 0) return;
          flow.fitView({ padding: 0.2, minZoom: 0.4, maxZoom: 1 });
        } catch {
          /* fitView raced against unmount / node-list update — safe to ignore */
        }
      });
    });
    ro.observe(el);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      flowRef.current = null;
    };
  }, []);

  if (phases.length === 0) {
    return (
      <div className="p-4 text-sm text-base-content/40">
        No phases recorded for this run yet.
      </div>
    );
  }

  const numericHeight = typeof height === "number" ? height : 180;

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: numericHeight }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.4, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_, node) => onPhaseClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
      </ReactFlow>
    </div>
  );
}
