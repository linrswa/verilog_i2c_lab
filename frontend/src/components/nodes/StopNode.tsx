import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'

export interface StopNodeData {
  status?: 'ok' | 'fail'
  [key: string]: unknown
}

type StopNode = Node<StopNodeData>

export function StopNode({ data }: NodeProps<StopNode>) {
  const status = data.status
  return (
    <div className="rounded-md border-2 border-rose-500 bg-rose-50 shadow-sm min-w-[140px]">
      {/* Input handle — top only (no output handle) */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-rose-500 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-rose-500 text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between">
        <span>STOP</span>
        {status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2 text-xs text-rose-700 italic">
        I2C Stop condition
      </div>
    </div>
  )
}
