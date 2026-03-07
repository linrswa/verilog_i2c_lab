import { useState, useCallback } from 'react'
import type { DragEvent } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react'
import type { Node, NodeTypes, NodeChange } from '@xyflow/react'
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

// FlowCanvas is a child of ReactFlowProvider so it can safely call useReactFlow()
function FlowCanvas({
  nodes,
  onNodesChange,
}: {
  nodes: Node[]
  onNodesChange: (changes: NodeChange[]) => void
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
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
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

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )

  // Run is always disabled in this story; wired up in US-007
  const isRunDisabled = true
  const isRunning = false

  function handleRun() {
    // Placeholder — implemented in US-007
  }

  return (
    // Full viewport column: toolbar / body / result panel
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-gray-100">
      <Toolbar onRun={handleRun} isRunDisabled={isRunDisabled} isRunning={isRunning} />

      {/* Main body: sidebar + canvas */}
      <div className="flex flex-row flex-1 overflow-hidden">
        <Sidebar />

        {/* ReactFlowProvider enables useReactFlow() inside FlowCanvas */}
        <ReactFlowProvider>
          <FlowCanvas nodes={nodes} onNodesChange={onNodesChange} />
        </ReactFlowProvider>
      </div>

      <ResultPanel />
    </div>
  )
}
