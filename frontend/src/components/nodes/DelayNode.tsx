import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'

export interface DelayNodeData {
  cycles: string
  [key: string]: unknown
}

type DelayNode = Node<DelayNodeData>

export function DelayNode({ id, data }: NodeProps<DelayNode>) {
  const { setNodes } = useReactFlow()

  function handleCyclesChange(e: ChangeEvent<HTMLInputElement>) {
    setNodes((nodes) =>
      nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, cycles: e.target.value } } : n
      )
    )
  }

  return (
    <div className="rounded-md border-2 border-purple-400 bg-purple-50 shadow-sm min-w-[180px]">
      {/* Input handle — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-purple-400 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-purple-400 text-white text-xs font-semibold px-3 py-1 rounded-t">
        Delay
      </div>

      {/* Fields */}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs text-gray-500 w-16 flex-shrink-0">Cycles</span>
          <input
            type="number"
            value={data.cycles}
            placeholder="100"
            min={1}
            onChange={handleCyclesChange}
            className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 bg-white focus:outline-none focus:border-purple-400 nodrag"
          />
        </div>
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-purple-400 border-2 border-white"
      />
    </div>
  )
}
