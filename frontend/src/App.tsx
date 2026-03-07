import { ReactFlow, Background, Controls } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { Toolbar } from './components/Toolbar'
import { Sidebar } from './components/Sidebar'
import { ResultPanel } from './components/ResultPanel'

// Placeholder empty canvas — nodes/edges managed in later stories
const INITIAL_NODES = [] as const
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
            nodes={INITIAL_NODES as []}
            edges={INITIAL_EDGES as []}
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
