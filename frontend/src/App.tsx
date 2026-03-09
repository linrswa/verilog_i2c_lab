import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  MarkerType,
  useReactFlow,
} from '@xyflow/react'
import type { Node, Edge, NodeTypes, NodeChange, EdgeChange, OnNodeDrag, Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { ResizeHandle } from './components/ResizeHandle'
import { ResultPanel } from './components/ResultPanel'
import { WaveformPanel } from './components/WaveformPanel'
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
import { NODE_HEIGHT as WAVEFORM_NODE_HEIGHT, GAP as WAVEFORM_GAP, LAYOUT_X as WAVEFORM_LAYOUT_X } from './lib/waveform'

/** Status of each step after simulation: 'ok' | 'fail', keyed by node ID. */
type NodeStatusMap = Map<string, 'ok' | 'fail'>

// ── Layout constants ──────────────────────────────────────────────────────────
// Re-export from lib/waveform so they remain the single source of truth.
const NODE_HEIGHT = WAVEFORM_NODE_HEIGHT
const GAP = WAVEFORM_GAP
const LAYOUT_X = WAVEFORM_LAYOUT_X
const Y_OFFSET = 0

/**
 * Apply vertical auto-layout: all nodes share the same x-coordinate and
 * are spaced evenly along the y-axis.  Returns a new nodes array — does not
 * mutate the input.
 *
 * Also strips any post-simulation time-based layout properties (style.width,
 * nodeTooltip) so nodes revert to their default appearance.
 */
function applyVerticalLayout(nodes: Node[]): Node[] {
  return nodes.map((node, i) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { width: _removedWidth, ...styleWithoutWidth } = (node.style as Record<string, unknown> | undefined) ?? {}
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { nodeTooltip: _removedTooltip, ...dataWithoutTooltip } = node.data as Record<string, unknown>
    return {
      ...node,
      position: { x: LAYOUT_X, y: Y_OFFSET + i * (NODE_HEIGHT + GAP) },
      style: Object.keys(styleWithoutWidth).length > 0 ? styleWithoutWidth as React.CSSProperties : undefined,
      data: dataWithoutTooltip,
    }
  })
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
 * Returns null for legacy ops that have no corresponding node type.
 */
function opToNodeType(op: string): string | null {
  switch (op) {
    case 'start':           return 'i2c_start'
    case 'stop':            return 'i2c_stop'
    case 'repeated_start':  return 'repeated_start'
    case 'send_byte':       return 'send_byte'
    case 'recv_byte':       return 'recv_byte'
    default:                return null
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
  const now = Date.now()
  const rawNodes: Node[] = []
  for (let i = 0; i < template.steps.length; i++) {
    const step = template.steps[i]
    const nodeType = opToNodeType(step.op)
    if (nodeType === null) continue // skip legacy ops (reset, scan, write_bytes, etc.)
    rawNodes.push({
      id: `template-${i}-${now}`,
      type: nodeType,
      position: { x: 0, y: 0 },
      data: stepToNodeData(step as StepPayload),
    })
  }

  const nodes = applyVerticalLayout(rawNodes)
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
  onNodeDrag,
  onNodeDragStop,
  onDropNode,
  onConnect,
  initialViewportRestored,
  onViewportRestored,
}: {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onNodeDrag: OnNodeDrag
  onNodeDragStop: OnNodeDrag
  onDropNode: (nodeType: string, position: { x: number; y: number }) => void
  onConnect: (connection: Connection) => void
  initialViewportRestored: boolean
  onViewportRestored: () => void
}) {
  const { setViewport, getViewport, screenToFlowPosition } = useReactFlow()

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

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const nodeType = event.dataTransfer.getData('application/reactflow-nodetype')
      if (!nodeType) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onDropNode(nodeType, position)
    },
    [screenToFlowPosition, onDropNode],
  )

  return (
    <div className="flex-1 relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onDragOver={onDragOver}
        onDrop={onDrop}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Delete', 'Backspace']}
        nodesConnectable={true}
        nodesDraggable={true}
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
    return applyVerticalLayout(saved)
  })
  const [edges, setEdges] = useState<Edge[]>(() => {
    const saved = loadPersistedFlow()?.nodes ?? []
    const laid = applyVerticalLayout(saved)
    return buildAutoEdges(laid)
  })
  const [isRunning, setIsRunning] = useState(false)
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // Tracks whether FlowCanvas has already applied the saved viewport
  const [viewportRestored, setViewportRestored] = useState(false)
  // Ref to the canvas column container — used to measure width for time-based node layout
  const canvasColumnRef = useRef<HTMLDivElement>(null)
  // Resizable pane sizes
  const [sidebarWidth, setSidebarWidth] = useState(200)
  const sidebarWidthRef = useRef(200)
  const [waveformHeight, setWaveformHeight] = useState(220)
  const waveformHeightRef = useRef(220)

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(Math.max(120, Math.min(400, sidebarWidthRef.current + delta)))
  }, [])
  const handleSidebarResizeEnd = useCallback(() => {
    // Read latest value via functional updater to avoid stale closure
    setSidebarWidth((w) => { sidebarWidthRef.current = w; return w })
  }, [])

  const handleWaveformResize = useCallback((delta: number) => {
    // Negative delta = dragging up = making panel taller
    setWaveformHeight(Math.max(120, Math.min(600, waveformHeightRef.current - delta)))
  }, [])
  const handleWaveformResizeEnd = useCallback(() => {
    setWaveformHeight((h) => { waveformHeightRef.current = h; return h })
  }, [])

  const [resultWidth, setResultWidth] = useState(320)
  const resultWidthRef = useRef(320)
  const handleResultResize = useCallback((delta: number) => {
    // Negative delta = dragging left = making panel wider
    setResultWidth(Math.max(200, Math.min(700, resultWidthRef.current - delta)))
  }, [])
  const handleResultResizeEnd = useCallback(() => {
    setResultWidth((w) => { resultWidthRef.current = w; return w })
  }, [])

  /**
   * Clear all node status badges by removing the `status` field from node data.
   * Called whenever the flow is modified so stale badges don't persist across runs.
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
   * Position changes (dragging) are handled by onNodeDrag/onNodeDragStop —
   * we skip re-layout for those so dragging is not immediately snapped back.
   * After applying non-position changes, re-apply horizontal layout and rebuild
   * auto-edges so that deleting a node re-indexes the remaining sequence.
   */
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const hasPosition = changes.some((c) => c.type === 'position')
      const hasRemoval = changes.some((c) => c.type === 'remove')

      if (hasPosition && !hasRemoval) {
        // During drag: apply position changes as-is without snapping to layout.
        // The y-axis clamping is handled by onNodeDrag.
        setNodes((nds) => applyNodeChanges(changes, nds))
        return
      }

      clearNodeStatuses()
      setNodes((nds) => {
        const updated = applyNodeChanges(changes, nds)
        if (hasRemoval) {
          // Reconnect edges around deleted nodes (bridge the gap) without re-layout.
          const removedIds = new Set(
            changes.filter((c) => c.type === 'remove').map((c) => c.id),
          )
          setEdges((currentEdges) => {
            // Build a map: for each removed node, find its predecessor and successor
            const newEdges: Edge[] = []
            const incomingOf = new Map<string, string>() // target → source
            const outgoingOf = new Map<string, string>() // source → target
            for (const e of currentEdges) {
              incomingOf.set(e.target, e.source)
              outgoingOf.set(e.source, e.target)
            }
            // Bridge: connect predecessor → successor for each removed node
            for (const id of removedIds) {
              const pred = incomingOf.get(id)
              const succ = outgoingOf.get(id)
              if (pred && succ && !removedIds.has(pred) && !removedIds.has(succ)) {
                newEdges.push({
                  id: `e-${pred}-${succ}`,
                  source: pred,
                  target: succ,
                  type: 'smoothstep',
                  markerEnd: { type: MarkerType.ArrowClosed },
                })
              }
            }
            // Keep edges not involving removed nodes + add bridge edges
            const kept = currentEdges.filter(
              (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
            )
            return [...kept, ...newEdges]
          })
        }
        return updated
      })
    },
    [clearNodeStatuses],
  )

  // Apply edge changes (select, remove, etc.) so users can delete edges.
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  // Handle manual edge connections drawn by the user.
  const onConnect = useCallback((connection: Connection) => {
    setEdges((eds) =>
      addEdge(
        { ...connection, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
        eds,
      ),
    )
  }, [])

  /**
   * Append a new node at the end of the sequence with the correct horizontal
   * position, then rebuild edges.
   * Also clears any post-simulation time-based layout (reverts to default spacing).
   */
  const handleAppendNode = useCallback(
    (nodeType: string) => {
      clearNodeStatuses()
      setSimulationResult(null)
      setNodes((existingNodes) => {
        const newNode: Node = {
          id: `${nodeType}-${Date.now()}`,
          type: nodeType,
          position: { x: LAYOUT_X, y: 0 },
          data: buildDefaultData(nodeType),
        }
        const updated = [...existingNodes, newNode]
        const laidOut = applyVerticalLayout(updated)
        setEdges(buildAutoEdges(laidOut))
        return laidOut
      })
    },
    [clearNodeStatuses],
  )

  /**
   * During drag: allow free movement (no axis locking).
   */
  const onNodeDrag: OnNodeDrag = useCallback((_event, _draggedNode) => {
    // No position clamping — nodes can move freely.
  }, [])

  /**
   * On drag end: keep nodes at their freely-dragged positions.
   * Do not re-sort or rebuild edges — the user controls layout manually.
   */
  const onNodeDragStop: OnNodeDrag = useCallback((_event, _draggedNode) => {
    // No-op: nodes stay where they were dragged, edges remain unchanged.
  }, [])

  /**
   * Handle drop from sidebar: create a new node at the drop position.
   * No auto-layout, no auto-connect — the node is placed freely on the canvas.
   */
  const handleDropNode = useCallback(
    (nodeType: string, position: { x: number; y: number }) => {
      clearNodeStatuses()
      setSimulationResult(null)
      const newNode: Node = {
        id: `${nodeType}-${Date.now()}`,
        type: nodeType,
        position,
        data: buildDefaultData(nodeType),
      }
      setNodes((nds) => [...nds, newNode])
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

      // Build status map and time-range map.
      // All steps (including start/stop/repeated_start) now produce result
      // entries.  orderedNodeIds[i] maps 1:1 to result.steps[rIdx].
      const statusMap: NodeStatusMap = new Map()
      const nodeTimeRangeMap = new Map<string, [number, number]>()
      let rIdx = result.steps[0]?.op === 'reset' ? 1 : 0
      for (let i = 0; i < orderedNodeIds.length; i++) {
        const nodeId = orderedNodeIds[i]
        if (rIdx >= result.steps.length) break
        const resultStep = result.steps[rIdx]
        const isOk = (resultStep as Record<string, unknown>).status === 'ok' || resultStep.passed === true
        statusMap.set(nodeId, isOk ? 'ok' : 'fail')
        if (resultStep?.time_range_ps) {
          nodeTimeRangeMap.set(nodeId, resultStep.time_range_ps)
        }
        rIdx++
      }

      // Apply status badges to nodes without changing their positions or sizes
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          data: {
            ...n.data,
            status: statusMap.get(n.id),
          },
        })),
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred'
      setRunError(message)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <>
      {/* Full viewport column: toolbar / error banner / body / result panel */}
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
          <Sidebar onAddNode={handleAppendNode} width={sidebarWidth} />
          <ResizeHandle direction="horizontal" onResize={handleSidebarResize} onResizeEnd={handleSidebarResizeEnd} />

          {/* Canvas column: ReactFlow canvas on top, WaveformPanel below */}
          <div ref={canvasColumnRef} className="flex flex-col flex-1 overflow-hidden">
            {/* ReactFlowProvider enables useReactFlow() inside FlowCanvas */}
            <ReactFlowProvider>
              <FlowCanvas
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDrag={onNodeDrag}
                onNodeDragStop={onNodeDragStop}
                onDropNode={handleDropNode}
                onConnect={onConnect}
                initialViewportRestored={viewportRestored}
                onViewportRestored={() => setViewportRestored(true)}
              />
            </ReactFlowProvider>

            <ResizeHandle direction="vertical" onResize={handleWaveformResize} onResizeEnd={handleWaveformResizeEnd} />
            <WaveformPanel
              waveformId={simulationResult?.waveform_id ?? null}
              panelHeight={waveformHeight}
            />
          </div>

          <ResizeHandle direction="horizontal" onResize={handleResultResize} onResizeEnd={handleResultResizeEnd} />
          <ResultPanel result={simulationResult} width={resultWidth} />
        </div>
      </div>
    </>
  )
}
