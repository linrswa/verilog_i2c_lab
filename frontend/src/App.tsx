import { ReactFlow, Background, Controls } from '@xyflow/react'
import type { NodeTypes } from '@xyflow/react'
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

// Sample nodes for visual verification — replaced by dynamic state in US-004
const INITIAL_NODES = [
  {
    id: 'reset-1',
    type: 'reset',
    position: { x: 80, y: 40 },
    data: {},
  },
  {
    id: 'write-1',
    type: 'write',
    position: { x: 320, y: 40 },
    data: { address: '0x50', register: '0x00', data: '0xA5' },
  },
  {
    id: 'read-1',
    type: 'read',
    position: { x: 560, y: 40 },
    data: { address: '0x50', register: '0x00', n: '1', expect: '' },
  },
  {
    id: 'scan-1',
    type: 'scan',
    position: { x: 80, y: 220 },
    data: { address: '0x50', expect: 'true' },
  },
  {
    id: 'delay-1',
    type: 'delay',
    position: { x: 320, y: 220 },
    data: { cycles: '100' },
  },
]

const INITIAL_EDGES = [] as const

export default function App() {
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

        {/* React Flow canvas fills remaining space */}
        <div className="flex-1 relative">
          <ReactFlow
            nodes={INITIAL_NODES}
            edges={INITIAL_EDGES as []}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      <ResultPanel />
    </div>
  )
}
