import { useState, useCallback } from 'react'
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
} from './components/nodes'
import { serializeFlow } from './lib/serialize'
import { runSimulation } from './lib/api'
import type { SimulationResult } from './lib/api'

// Register all custom node types — passed to <ReactFlow nodeTypes={...}>
const nodeTypes: NodeTypes = {
  reset: ResetNode,
  write: WriteNode,
  read: ReadNode,
  scan: ScanNode,
  delay: DelayNode,
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
    default:
      return {}
  }
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

// FlowCanvas is a child of ReactFlowProvider so it can safely call useReactFlow()
function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
}: {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
}) {
  const { screenToFlowPosition, setNodes } = useReactFlow()

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
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

export default function App() {
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  )

  // Enforce single outgoing edge per source handle and single incoming edge per target handle.
  // If a conflicting edge exists it is replaced so the canvas always stays a simple linear chain.
  const onConnect = useCallback(
    (connection: Connection) => {
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
    [],
  )

  // Run button is enabled only when the canvas has at least one connected chain
  const isRunDisabled = !hasConnectedChain(edges) || isRunning

  async function handleRun() {
    if (isRunDisabled) return

    setIsRunning(true)
    setRunError(null)

    try {
      const steps = serializeFlow(nodes, edges)
      const result = await runSimulation(steps)
      setSimulationResult(result)
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
      <Toolbar onRun={handleRun} isRunDisabled={isRunDisabled} isRunning={isRunning} />

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
          />
        </ReactFlowProvider>
      </div>

      <ResultPanel result={simulationResult} />
    </div>
  )
}
