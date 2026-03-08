import { useState, useCallback, useEffect } from 'react'
import type { DragEvent } from 'react'
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
import type { Node, Edge, NodeTypes, NodeChange, EdgeChange, Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { ResultPanel } from './components/ResultPanel'
import {
  ResetNode,
  WriteNode,
  ReadNode,
  ScanNode,
  DelayNode,
  StartNode,
  StopNode,
  RepeatedStartNode,
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

/** Status of each step after simulation: 'ok' | 'fail', keyed by node ID. */
type NodeStatusMap = Map<string, 'ok' | 'fail'>

// Register all custom node types — passed to <ReactFlow nodeTypes={...}>
const nodeTypes: NodeTypes = {
  reset: ResetNode,
  write: WriteNode,
  read: ReadNode,
  scan: ScanNode,
  delay: DelayNode,
  i2c_start: StartNode,
  i2c_stop: StopNode,
  repeated_start: RepeatedStartNode,
}

// Default data for each node type per acceptance criteria:
// address=0x50, register=0x00, data=[], n=1, cycles=100
function buildDefaultData(type: string): Record<string, unknown> {
  switch (type) {
    case 'reset':
      return {}
    case 'write':
      return { address: '0x50', register: '0x00', data: '' }
    case 'read':
      return { address: '0x50', register: '0x00', n: '1', expect: '' }
    case 'scan':
      return { address: '0x50', expect: '' }
    case 'delay':
      return { cycles: '100' }
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
    case 'reset':           return 'reset'
    case 'write_bytes':     return 'write'
    case 'read_bytes':      return 'read'
    case 'scan':            return 'scan'
    case 'delay':           return 'delay'
    case 'start':           return 'i2c_start'
    case 'stop':            return 'i2c_stop'
    case 'repeated_start':  return 'repeated_start'
    default:                return 'reset'
  }
}

/**
 * Build node data from a backend step payload.
 * Fields are converted back to the string representation expected by the node forms.
 */
function stepToNodeData(step: StepPayload): Record<string, unknown> {
  switch (step.op) {
    case 'reset':
      return {}
    case 'write_bytes':
      return {
        address: step.addr ?? '0x50',
        register: step.reg ?? '0x00',
        data: (step.data ?? []).join(', '),
      }
    case 'read_bytes':
      return {
        address: step.addr ?? '0x50',
        register: step.reg ?? '0x00',
        n: String(step.n ?? 1),
        expect: (step.expect ?? []).join(', '),
      }
    case 'scan':
      return {
        address: step.addr ?? '0x50',
        expect: step.expect !== undefined ? String(step.expect) : '',
      }
    case 'delay':
      return {
        cycles: String(step.cycles ?? 100),
      }
    case 'start':
    case 'stop':
    case 'repeated_start':
      return {}
    // US-008: send_byte and recv_byte cases will be added here
    default:
      return {}
  }
}

/**
 * Convert a template's steps array into React Flow nodes and edges.
 * Nodes are positioned in a vertical chain, spaced 120 px apart at x=250.
 */
function templateToNodesAndEdges(template: TemplateDetail): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = template.steps.map((step, i) => ({
    id: `template-${i}-${Date.now()}`,
    type: opToNodeType(step.op),
    position: { x: 250, y: i * 120 },
    data: stepToNodeData(step),
  }))

  const edges: Edge[] = nodes.slice(0, -1).map((node, i) => ({
    id: `template-edge-${i}-${Date.now()}`,
    source: node.id,
    target: nodes[i + 1].id,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  }))

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
  onConnect,
  initialViewportRestored,
  onViewportRestored,
}: {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  initialViewportRestored: boolean
  onViewportRestored: () => void
}) {
  const { screenToFlowPosition, setNodes, setViewport, getViewport } = useReactFlow()

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

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()

      const nodeType = event.dataTransfer.getData('application/reactflow-node-type')
      if (!nodeType) return

      // Convert screen coordinates to flow canvas coordinates
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const newNode: Node = {
        id: `${nodeType}-${Date.now()}`,
        type: nodeType,
        position,
        data: buildDefaultData(nodeType),
      }

      setNodes((existingNodes) => [...existingNodes, newNode])
    },
    [screenToFlowPosition, setNodes],
  )

  return (
    <div
      className="flex-1 relative"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        defaultEdgeOptions={defaultEdgeOptions}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView={!loadPersistedFlow()}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default function App() {
  // Initialise nodes/edges from localStorage on first mount only (lazy initializer)
  const [nodes, setNodes] = useState<Node[]>(() => loadPersistedFlow()?.nodes ?? [])
  const [edges, setEdges] = useState<Edge[]>(() => loadPersistedFlow()?.edges ?? [])
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

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      clearNodeStatuses()
      setNodes((nds) => applyNodeChanges(changes, nds))
    },
    [clearNodeStatuses],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      clearNodeStatuses()
      setEdges((eds) => applyEdgeChanges(changes, eds))
    },
    [clearNodeStatuses],
  )

  // Enforce single outgoing edge per source handle and single incoming edge per target handle.
  // If a conflicting edge exists it is replaced so the canvas always stays a simple linear chain.
  const onConnect = useCallback(
    (connection: Connection) => {
      clearNodeStatuses()
      setEdges((eds) => {
        // Remove any existing edge that originates from the same source handle
        const withoutSourceEdge = eds.filter(
          (e) => !(e.source === connection.source && e.sourceHandle === connection.sourceHandle),
        )
        // Remove any existing edge that terminates at the same target handle
        const withoutConflict = withoutSourceEdge.filter(
          (e) => !(e.target === connection.target && e.targetHandle === connection.targetHandle),
        )
        return addEdge(connection, withoutConflict)
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

      // Build status map: each step result maps to the node at the same index
      const statusMap: NodeStatusMap = new Map()
      result.steps.forEach((stepResult, i) => {
        const nodeId = orderedNodeIds[i]
        if (nodeId !== undefined) {
          statusMap.set(nodeId, stepResult.passed ? 'ok' : 'fail')
        }
      })
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

      {/* Main body: sidebar + canvas */}
      <div className="flex flex-row flex-1 overflow-hidden">
        <Sidebar />

        {/* ReactFlowProvider enables useReactFlow() inside FlowCanvas */}
        <ReactFlowProvider>
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            initialViewportRestored={viewportRestored}
            onViewportRestored={() => setViewportRestored(true)}
          />
        </ReactFlowProvider>
      </div>

      <ResultPanel result={simulationResult} />
    </div>
  )
}
