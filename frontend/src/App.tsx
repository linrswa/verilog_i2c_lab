import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
  MarkerType,
  useReactFlow,
} from '@xyflow/react'
import type { Node, Edge, NodeTypes, NodeChange, EdgeChange, OnNodeDrag, Viewport } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { ResizeHandle } from './components/ResizeHandle'
import { ResultPanel } from './components/ResultPanel'
import { WaveformPanel } from './components/WaveformPanel'
import type { FlowViewport } from './components/WaveformPanel'
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
import { buildTimeToX, NODE_WIDTH as WAVEFORM_NODE_WIDTH, GAP as WAVEFORM_GAP, LAYOUT_Y as WAVEFORM_LAYOUT_Y, LABEL_WIDTH as WAVEFORM_LABEL_WIDTH } from './lib/waveform'
import { HighlightContext } from './lib/highlightContext'

/** Status of each step after simulation: 'ok' | 'fail', keyed by node ID. */
type NodeStatusMap = Map<string, 'ok' | 'fail'>

// ── Layout constants ──────────────────────────────────────────────────────────
// Re-export from lib/waveform so they remain the single source of truth.
const NODE_WIDTH = WAVEFORM_NODE_WIDTH
const GAP = WAVEFORM_GAP
const LAYOUT_Y = WAVEFORM_LAYOUT_Y
/** Offset applied to all node x-positions so they align with the waveform label column. */
const X_OFFSET = WAVEFORM_LABEL_WIDTH

/**
 * Apply horizontal auto-layout: all nodes share the same y-coordinate and
 * are spaced evenly along the x-axis.  Returns a new nodes array — does not
 * mutate the input.
 *
 * Also strips any post-simulation time-based layout properties (style.width,
 * nodeTooltip) so nodes revert to their default appearance.
 */
function applyHorizontalLayout(nodes: Node[]): Node[] {
  return nodes.map((node, i) => {
    // Strip time-based width override and tooltip from post-simulation layout,
    // and step index (which is only valid for the most recent simulation run).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { width: _removedWidth, ...styleWithoutWidth } = (node.style as Record<string, unknown> | undefined) ?? {}
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { nodeTooltip: _removedTooltip, stepIndex: _removedStepIndex, ...dataWithoutTooltip } = node.data as Record<string, unknown>
    return {
      ...node,
      position: { x: X_OFFSET + i * (NODE_WIDTH + GAP), y: LAYOUT_Y },
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
      data: stepToNodeData(step),
    })
  }

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
  onNodeDrag,
  onNodeDragStop,
  initialViewportRestored,
  onViewportRestored,
  onViewportChange,
}: {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onNodeDrag: OnNodeDrag
  onNodeDragStop: OnNodeDrag
  initialViewportRestored: boolean
  onViewportRestored: () => void
  onViewportChange: (vp: FlowViewport) => void
}) {
  const { setViewport, getViewport } = useReactFlow()

  // Restore saved viewport once — on first mount, after ReactFlow has initialised
  useEffect(() => {
    if (initialViewportRestored) return
    const saved = loadPersistedFlow()
    if (saved?.viewport) {
      setViewport(saved.viewport)
      // Report restored viewport immediately so WaveformPanel starts in sync
      onViewportChange(saved.viewport)
    }
    onViewportRestored()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-save nodes/edges/viewport to localStorage (debounced 500 ms)
  useFlowAutosave(nodes, edges, getViewport)

  /** Forward React Flow viewport changes to the parent (for WaveformPanel sync). */
  const handleMove = useCallback(
    (_: unknown, vp: Viewport) => {
      onViewportChange({ x: vp.x, y: vp.y, zoom: vp.zoom })
    },
    [onViewportChange],
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
        onMove={handleMove}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Delete', 'Backspace']}
        nodesConnectable={false}
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
  // Tracks the current React Flow viewport for WaveformPanel synchronisation
  const [flowViewport, setFlowViewport] = useState<FlowViewport>({ x: 0, y: 0, zoom: 1 })
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

  // Cross-highlighting state: which waveform step is hovered/selected
  const [hoveredStepIndex, setHoveredStepIndex] = useState<number | null>(null)
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null)
  /**
   * Clear all node status badges and step indices by removing the `status` and
   * `stepIndex` fields from node data.
   * Called whenever the flow is modified so stale badges and highlight indices
   * don't persist across runs.
   */
  const clearNodeStatuses = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const data = { ...n.data }
        delete data.status
        delete data.stepIndex
        return { ...n, data }
      }),
    )
    setHoveredStepIndex(null)
    setSelectedStepIndex(null)
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
        return applyHorizontalLayout(updated)
      })
      // Rebuild edges whenever node list may have changed (e.g. deletion)
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
          position: { x: 0, y: LAYOUT_Y },
          data: buildDefaultData(nodeType),
        }
        const updated = [...existingNodes, newNode]
        const laidOut = applyHorizontalLayout(updated)
        setEdges(buildAutoEdges(laidOut))
        return laidOut
      })
    },
    [clearNodeStatuses],
  )

  /**
   * During drag: lock the dragged node's y-position to LAYOUT_Y so nodes
   * can only move horizontally. This mutates the nodes state in-place via
   * setNodes so React Flow re-renders at the clamped position.
   */
  const onNodeDrag: OnNodeDrag = useCallback((_event, draggedNode) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.id === draggedNode.id
          ? { ...n, position: { x: draggedNode.position.x, y: LAYOUT_Y } }
          : n,
      ),
    )
  }, [])

  /**
   * On drag end: compute the insertion index from the dragged node's x-position,
   * enforce START-first / STOP-last constraints, reorder the nodes array, then
   * re-apply horizontal layout and rebuild edges.
   */
  const onNodeDragStop: OnNodeDrag = useCallback((_event, draggedNode) => {
    setNodes((nds) => {
      // Find the dragged node's current index and its node type
      const draggedIdx = nds.findIndex((n) => n.id === draggedNode.id)
      if (draggedIdx === -1) return nds

      const draggedType = nds[draggedIdx].type

      // START (i2c_start) and STOP (i2c_stop) cannot be reordered
      if (draggedType === 'i2c_start' || draggedType === 'i2c_stop') {
        // Snap back to canonical positions
        const reLayout = applyHorizontalLayout(nds)
        setEdges(buildAutoEdges(reLayout))
        return reLayout
      }

      // Determine insertion index from x-position of dragged node.
      // Use node center (x + NODE_WIDTH/2) as the reference point.
      const draggedCenterX = draggedNode.position.x + NODE_WIDTH / 2

      // Build a list of the other nodes with their canonical (layout) positions.
      // We compare against the current node positions (before full re-layout)
      // so we get a stable reference.
      const others = nds.filter((n) => n.id !== draggedNode.id)

      // Count how many other nodes' centers are to the left of the drag center
      let insertAt = 0
      for (const other of others) {
        const otherCenterX = other.position.x + NODE_WIDTH / 2
        if (otherCenterX < draggedCenterX) insertAt++
      }

      // Enforce boundaries: START must be index 0, STOP must be last
      const startIdx = others.findIndex((n) => n.type === 'i2c_start')
      const stopIdx = others.findIndex((n) => n.type === 'i2c_stop')

      // insertAt is the position in `others` before which we insert the dragged node
      // (i.e. final index in the new array)
      // After inserting, index 0 should be START and last should be STOP.
      // START is always at others[startIdx] which, in the new array with dragged inserted:
      //   if insertAt <= startIdx, START shifts to startIdx+1
      //   else stays at startIdx
      // We clamp insertAt so the dragged node cannot land before START or after STOP.

      // Minimum allowed insertAt: after the start node
      let minInsert = 0
      if (startIdx !== -1) {
        // START is at others[startIdx]; after insertion dragged goes to insertAt.
        // We need insertAt > (position of START in the new array).
        // START's new position = startIdx + (insertAt <= startIdx ? 1 : 0)
        // So if insertAt <= startIdx, START is at startIdx+1 — dragged is before START -> not allowed
        // Minimum: insertAt = startIdx + 1
        minInsert = startIdx + 1
      }

      // Maximum allowed insertAt: before the stop node
      let maxInsert = others.length
      if (stopIdx !== -1) {
        // STOP is at others[stopIdx]; after insertion dragged goes to insertAt.
        // STOP's new position = stopIdx + (insertAt <= stopIdx ? 1 : 0)
        // If insertAt > stopIdx, STOP is at stopIdx — dragged is after STOP -> not allowed
        // Maximum: insertAt = stopIdx
        maxInsert = stopIdx
      }

      const clampedInsert = Math.max(minInsert, Math.min(maxInsert, insertAt))

      // Build new ordered array: insert draggedNode at clampedInsert in others
      const reordered = [
        ...others.slice(0, clampedInsert),
        nds[draggedIdx],
        ...others.slice(clampedInsert),
      ]

      const reLayout = applyHorizontalLayout(reordered)
      setEdges(buildAutoEdges(reLayout))
      return reLayout
    })
  }, [])

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

      // Build node time-range map and node-to-step-index map by aligning
      // result.steps with orderedNodeIds.
      // The backend auto-prepends a `reset` step then strips it from results.
      // result.steps only contains entries for data ops (send_byte, recv_byte)
      // and legacy ops — NOT for framing ops (start, stop, repeated_start).
      // We must skip framing ops when iterating orderedNodeIds.
      const nodeTimeRangeMap = new Map<string, [number, number]>()
      // Maps node ID -> index in result.steps (for cross-highlighting)
      const nodeStepIndexMap = new Map<string, number>()
      let rIdx = result.steps[0]?.op === 'reset' ? 1 : 0
      for (let i = 0; i < orderedNodeIds.length; i++) {
        const nodeId = orderedNodeIds[i]
        const sentOp = steps[i]?.op
        if (sentOp && noResultOps.has(sentOp)) {
          // Framing ops produce no result entry — skip
          continue
        }
        if (rIdx >= result.steps.length) break
        const resultStep = result.steps[rIdx]
        nodeStepIndexMap.set(nodeId, rIdx)
        if (resultStep?.time_range_ps) {
          nodeTimeRangeMap.set(nodeId, resultStep.time_range_ps)
        }
        rIdx++
      }

      // Reset cross-highlighting when a new simulation completes
      setHoveredStepIndex(null)
      setSelectedStepIndex(null)

      // Apply time-based layout if we have timing data and a total sim time.
      // Canvas width is measured from the canvas column container; fall back to 1200px.
      const totalDurationPs = result.sim_time_total_ps ?? 0
      const canvasWidthPx = canvasColumnRef.current?.clientWidth ?? 1200

      if (totalDurationPs > 0 && nodeTimeRangeMap.size > 0) {
        // Offset by LABEL_WIDTH so nodes align with the waveform content area
        const timeToX = buildTimeToX({ totalDurationPs, canvasWidthPx: canvasWidthPx - X_OFFSET, originOffsetPx: X_OFFSET })

        setNodes((nds) =>
          nds.map((n) => {
            const timeRange = nodeTimeRangeMap.get(n.id)
            const stepIndex = nodeStepIndexMap.get(n.id) ?? null
            const statusUpdate = { status: statusMap.get(n.id) }
            if (!timeRange) {
              return { ...n, data: { ...n.data, ...statusUpdate, stepIndex } }
            }
            const [startPs, endPs] = timeRange
            const x = timeToX(startPs)
            const width = Math.max(timeToX(endPs) - x, 1)

            // Build a tooltip title so narrow nodes still surface their details
            const tipLines: string[] = [`Start: ${startPs.toLocaleString()} ps`, `End: ${endPs.toLocaleString()} ps`, `Duration: ${(endPs - startPs).toLocaleString()} ps`]
            const nodeTooltip = tipLines.join('\n')

            return {
              ...n,
              position: { x, y: LAYOUT_Y },
              style: { ...n.style, width },
              data: { ...n.data, ...statusUpdate, nodeTooltip, stepIndex },
            }
          }),
        )
      } else {
        // No timing data — just write status badges and step indices
        setNodes((nds) =>
          nds.map((n) => ({
            ...n,
            data: {
              ...n.data,
              status: statusMap.get(n.id),
              stepIndex: nodeStepIndexMap.get(n.id) ?? null,
            },
          })),
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unknown error occurred'
      setRunError(message)
    } finally {
      setIsRunning(false)
    }
  }

  const highlightContextValue = React.useMemo(
    () => ({
      hoveredStepIndex,
      selectedStepIndex,
      setHoveredStepIndex,
      setSelectedStepIndex,
    }),
    [hoveredStepIndex, selectedStepIndex],
  )

  return (
    <HighlightContext.Provider value={highlightContextValue}>
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
                initialViewportRestored={viewportRestored}
                onViewportRestored={() => setViewportRestored(true)}
                onViewportChange={setFlowViewport}
              />
            </ReactFlowProvider>

            <ResizeHandle direction="vertical" onResize={handleWaveformResize} onResizeEnd={handleWaveformResizeEnd} />
            <WaveformPanel
              waveformId={simulationResult?.waveform_id ?? null}
              steps={simulationResult?.steps ?? []}
              viewport={flowViewport}
              panelHeight={waveformHeight}
            />
          </div>

          <ResultPanel result={simulationResult} />
        </div>
      </div>
    </HighlightContext.Provider>
  )
}
