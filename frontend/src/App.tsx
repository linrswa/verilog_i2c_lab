import React, { useState, useCallback, useEffect } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
  MarkerType,
  useReactFlow,
} from '@xyflow/react'
import type { Node, Edge, NodeTypes, NodeChange, EdgeChange } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { ResultPanel } from './components/ResultPanel'
import {
  StartNode,
  StopNode,
  RepeatedStartNode,
  SendByteNode,
  RecvByteNode,
} from './components/nodes'
import { serializeFlowWithOrder } from './lib/serialize'
import type { StepPayload } from './lib/serialize'
import { runSimulation, getTemplate } from './lib/api'
import type { SimulationResult, TemplateDetail } from './lib/api'
import {
  loadPersistedFlow,
  clearPersistedFlow,
  useFlowAutosave,
} from './lib/useFlowPersistence'
import { chainHasErrors } from './lib/validate'
import { validateProtocolFlow } from './lib/protocol-validate'

/** Status of each step after simulation: 'ok' | 'fail', keyed by node ID. */
type NodeStatusMap = Map<string, 'ok' | 'fail'>

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_WIDTH = 160
const GAP = 40
const LAYOUT_Y = 200

/**
 * Apply horizontal auto-layout: all nodes share the same y-coordinate and
 * are spaced evenly along the x-axis.  Returns a new nodes array — does not
 * mutate the input.
 */
function applyHorizontalLayout(nodes: Node[]): Node[] {
  return nodes.map((node, i) => ({
    ...node,
    position: { x: i * (NODE_WIDTH + GAP), y: LAYOUT_Y },
  }))
}

/**
 * Build auto-generated smoothstep edges between every consecutive pair of nodes.
 * Existing custom edge attributes (markers, etc.) are not preserved — this
 * produces a canonical edge list from the ordered node array.
 */
function buildAutoEdges(nodes: Node[]): Edge[] {
  return nodes.slice(0, -1).map((node, i) => ({
    id: `e-${node.id}-${nodes[i + 1].id}`,
    source: node.id,
    target: nodes[i + 1].id,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
}
// ─────────────────────────────────────────────────────────────────────────────

// Register all custom node types — passed to <ReactFlow nodeTypes={...}>
const nodeTypes: NodeTypes = {
  i2c_start: StartNode,
  i2c_stop: StopNode,
  repeated_start: RepeatedStartNode,
  send_byte: SendByteNode,
  recv_byte: RecvByteNode,
}

// Default data for each node type
function buildDefaultData(type: string): Record<string, unknown> {
  switch (type) {
    case 'i2c_start':
    case 'i2c_stop':
    case 'repeated_start':
      return {}
    case 'send_byte':
      return { data: '0xA0' }  // default: addr 0x50 + write
    case 'recv_byte':
      return { ack: true }
    default:
      return {}
  }
}

/**
 * Map a backend op name to the React Flow node type used by the canvas.
 * Mirrors the op->type table that serialize.ts does in the forward direction.
 */
function opToNodeType(op: string): string {
  switch (op) {
    case 'start':           return 'i2c_start'
    case 'stop':            return 'i2c_stop'
    case 'repeated_start':  return 'repeated_start'
    case 'send_byte':       return 'send_byte'
    case 'recv_byte':       return 'recv_byte'
    default:                return 'i2c_start'
  }
}

/**
 * Build node data from a backend step payload.
 * Fields are converted back to the string representation expected by the node forms.
 */
function stepToNodeData(step: StepPayload): Record<string, unknown> {
  switch (step.op) {
    case 'start':
    case 'stop':
    case 'repeated_start':
      return {}
    case 'send_byte':
      return { data: step.data ?? '0xA0' }
    case 'recv_byte':
      return { ack: step.ack ?? true }
    default:
      return {}
  }
}

/**
 * Convert a template's steps array into React Flow nodes and edges.
 * Nodes are arranged using the horizontal auto-layout.
 */
function templateToNodesAndEdges(template: TemplateDetail): { nodes: Node[]; edges: Edge[] } {
  const rawNodes: Node[] = template.steps.map((step, i) => ({
    id: `template-${i}-${Date.now()}`,
    type: opToNodeType(step.op),
    position: { x: 0, y: 0 },
    data: stepToNodeData(step),
  }))

  const nodes = applyHorizontalLayout(rawNodes)
  const edges = buildAutoEdges(nodes)

  return { nodes, edges }
}

// Edges render as smoothstep curves with closed arrowhead markers
const defaultEdgeOptions = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed },
} as const

/**
 * Returns true when the canvas has at least one connected chain — meaning there
 * exists at least one edge that joins two nodes.  A lone unconnected node does
 * not qualify.
 */
function hasConnectedChain(edges: Edge[]): boolean {
  return edges.length > 0
}

/**
 * Returns true when any node in the connected chain carries validation errors.
 * We check all nodes since we cannot cheaply compute the chain here without
 * re-running the topological sort; checking all nodes is a safe superset.
 */
function nodesHaveErrors(nodes: Node[]): boolean {
  const errorMaps = nodes.map(
    (n) => ((n.data as Record<string, unknown>).errors ?? {}) as Record<string, string | undefined>,
  )
  return chainHasErrors(errorMaps)
}

// FlowCanvas is a child of ReactFlowProvider so it can safely call useReactFlow()
function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  initialViewportRestored,
  onViewportRestored,
}: {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  initialViewportRestored: boolean
  onViewportRestored: () => void
}) {
  const { setViewport, getViewport } = useReactFlow()

  // Restore saved viewport once — on first mount, after ReactFlow has initialised
  useEffect(() => {
    if (initialViewportRestored) return
    const saved = loadPersistedFlow()
    if (saved?.viewport) {
      setViewport(saved.viewport)
    }
    onViewportRestored()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-save nodes/edges/viewport to localStorage (debounced 500 ms)
  useFlowAutosave(nodes, edges, getViewport)

  return (
    <div className="flex-1 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Delete', 'Backspace']}
        nodesConnectable={false}
        nodesDraggable={false}
        fitView={!loadPersistedFlow()}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default function App() {
  // Initialise nodes/edges from localStorage on first mount only (lazy initializer).
  // Re-apply horizontal layout on load so saved positions are normalised.
  const [nodes, setNodes] = useState<Node[]>(() => {
    const saved = loadPersistedFlow()?.nodes ?? []
    return applyHorizontalLayout(saved)
  })
  const [edges, setEdges] = useState<Edge[]>(() => {
    const saved = loadPersistedFlow()?.nodes ?? []
    const laid = applyHorizontalLayout(saved)
    return buildAutoEdges(laid)
  })
  const [isRunning, setIsRunning] = useState(false)
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // Tracks whether FlowCanvas has already applied the saved viewport
  const [viewportRestored, setViewportRestored] = useState(false)
  /**
   * Clear all node status badges by removing the `status` field from node data.
   * Called whenever the flow is modified so stale badges don't persist.
   */
  const clearNodeStatuses = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const data = { ...n.data }
        delete data.status
        return { ...n, data }
      }),
    )
  }, [])

  // Run protocol-level validation whenever nodes or edges change.
  // Writes `warning` and `addrHelper` fields into node.data for affected nodes.
  // Uses a ref to track previous warning values so we only call setNodes when
  // something actually changed (prevents infinite render loops).
  const prevWarningsRef = React.useRef<string>('')
  useEffect(() => {
    const { warnings, addrHelpers } = validateProtocolFlow(nodes, edges)

    // Serialise warnings to detect if anything changed
    const serialised = JSON.stringify(
      nodes.map((n) => ({ id: n.id, w: warnings.get(n.id), a: addrHelpers.get(n.id) })),
    )
    if (serialised === prevWarningsRef.current) return
    prevWarningsRef.current = serialised

    setNodes((nds) =>
      nds.map((n) => {
        const warning = warnings.get(n.id)
        const addrHelper = addrHelpers.get(n.id)
        return { ...n, data: { ...n.data, warning, addrHelper } }
      }),
    )
  }, [nodes, edges])

  /**
   * Handle node changes (select, remove, dimension updates, etc.).
   * After applying changes, re-apply horizontal layout and rebuild auto-edges
   * so that deleting a node re-indexes the remaining sequence correctly.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      clearNodeStatuses()
      setNodes((nds) => {
        const updated = applyNodeChanges(changes, nds)
        return applyHorizontalLayout(updated)
      })
      // Rebuild edges whenever node list may have changed (e.g. deletion)
      const hasRemoval = changes.some((c) => c.type === 'remove')
      if (hasRemoval) {
        setNodes((nds) => {
          setEdges(buildAutoEdges(nds))
          return nds
        })
      }
    },
    [clearNodeStatuses],
  )

  // Edges are fully managed by auto-layout — ignore external edge change events.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onEdgesChange = useCallback((_changes: EdgeChange[]) => {
    // no-op: edges are derived from node order via buildAutoEdges
  }, [])

  /**
   * Append a new node at the end of the sequence with the correct horizontal
   * position, then rebuild edges.
   */
  const handleAppendNode = useCallback(
    (nodeType: string) => {
      clearNodeStatuses()
      setNodes((existingNodes) => {
        const newNode: Node = {
          id: `${nodeType}-${Date.now()}`,
          type: nodeType,
          position: { x: existingNodes.length * (NODE_WIDTH + GAP), y: LAYOUT_Y },
          data: buildDefaultData(nodeType),
        }
        const updated = [...existingNodes, newNode]
        setEdges(buildAutoEdges(updated))
        return updated
      })
    },
    [clearNodeStatuses],
  )

  // Clear button: reset canvas state and remove persisted flow
  const handleClear = useCallback(() => {
    setNodes([])
    setEdges([])
    clearPersistedFlow()
    setSimulationResult(null)
    setRunError(null)
  }, [])

  // Run button is enabled only when the canvas has at least one connected chain
  // and no node in the connected chain carries validation errors.
  const isRunDisabled = !hasConnectedChain(edges) || nodesHaveErrors(nodes) || isRunning

  async function handleLoadTemplate(templateId: string) {
    // Guard: ask for confirmation if there is already content on the canvas
    if ((nodes.length > 0 || edges.length > 0) && !window.confirm('Replace current flow?')) {
      return
    }

    try {
      const template = await getTemplate(templateId)
      const { nodes: newNodes, edges: newEdges } = templateToNodesAndEdges(template)
      setNodes(newNodes)
      setEdges(newEdges)
      // Clear any stale results from a previous run
      setSimulationResult(null)
      setRunError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load template'
      setRunError(message)
    }
  }

  async function handleRun() {
    if (isRunDisabled) return

    setIsRunning(true)
    setRunError(null)
    // Clear stale status badges from a previous run before starting
    clearNodeStatuses()

    try {
      const { orderedNodeIds, steps } = serializeFlowWithOrder(nodes, edges)
      const result = await runSimulation(steps)
      setSimulationResult(result)

      // Build status map: result.steps only contains data-producing ops
      // (send_byte, recv_byte, reset, write_bytes, etc.) — protocol framing
      // ops (start, stop, repeated_start) produce no result entries.
      // orderedNodeIds and steps are parallel arrays, so steps[i].op tells
      // us whether orderedNodeIds[i] has a corresponding result entry.
      const statusMap: NodeStatusMap = new Map()
      const noResultOps = new Set(['start', 'stop', 'repeated_start'])
      let resultIdx = 0
      for (let i = 0; i < orderedNodeIds.length; i++) {
        const nodeId = orderedNodeIds[i]
        const sentOp = steps[i]?.op
        if (sentOp && noResultOps.has(sentOp)) {
          // Framing ops don't produce result entries — mark as ok
          statusMap.set(nodeId, 'ok')
          continue
        }
        const stepResult = result.steps[resultIdx]
        if (stepResult !== undefined) {
          const isOk = (stepResult as Record<string, unknown>).status === 'ok' || stepResult.passed === true
          statusMap.set(nodeId, isOk ? 'ok' : 'fail')
          resultIdx++
        }
      }
      // Write status into each node's data so custom node components can render badges
      setNodes((nds) =>
        nds.map((n) => ({ ...n, data: { ...n.data, status: statusMap.get(n.id) } })),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred'
      setRunError(message)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    // Full viewport column: toolbar / error banner / body / result panel
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-gray-100">
      <Toolbar onRun={handleRun} isRunDisabled={isRunDisabled} isRunning={isRunning} onLoadTemplate={handleLoadTemplate} onClear={handleClear} />

      {/* Inline error banner — shown below toolbar when a run fails */}
      {runError !== null && (
        <div
          role="alert"
          className="flex items-center gap-3 px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700"
        >
          <span className="flex-1">{runError}</span>
          <button
            onClick={() => setRunError(null)}
            aria-label="Dismiss error"
            className="text-red-400 hover:text-red-600 font-bold leading-none"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main body: sidebar + canvas + result panel */}
      <div className="flex flex-row flex-1 overflow-hidden">
        <Sidebar onAddNode={handleAppendNode} />

        {/* ReactFlowProvider enables useReactFlow() inside FlowCanvas */}
        <ReactFlowProvider>
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            initialViewportRestored={viewportRestored}
            onViewportRestored={() => setViewportRestored(true)}
          />
        </ReactFlowProvider>

        <ResultPanel result={simulationResult} />
      </div>
    </div>
  )
}
