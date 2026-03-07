import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

export type ResetNodeData = Record<string, never>

export function ResetNode(_props: NodeProps) {
  return (
    <div className="rounded-md border-2 border-slate-400 bg-slate-50 shadow-sm min-w-[140px]">
      {/* Header */}
      <div className="bg-slate-400 text-white text-xs font-semibold px-3 py-1 rounded-t">
        Reset
      </div>

      {/* Body */}
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        No parameters
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-slate-400 border-2 border-white"
      />
    </div>
  )
}
