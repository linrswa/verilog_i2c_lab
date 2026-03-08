import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'

export interface StartNodeData {
  status?: 'ok' | 'fail'
  [key: string]: unknown
}

type StartNode = Node<StartNodeData>

export function StartNode({ data }: NodeProps<StartNode>) {
  const status = data.status
  return (
    <div className="rounded-md border-2 border-emerald-500 bg-emerald-50 shadow-sm min-w-[140px]">
      {/* Header */}
      <div className="bg-emerald-500 text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between">
        <span>START</span>
        {status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-300 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2 text-xs text-emerald-700 italic">
        I2C Start condition
      </div>

      {/* Output handle — bottom only (no input handle) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-emerald-500 border-2 border-white"
      />
    </div>
  )
}
