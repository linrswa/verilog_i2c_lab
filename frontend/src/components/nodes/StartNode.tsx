import { Handle, Position } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'

export interface StartNodeData {
  status?: 'ok' | 'fail'
  warning?: string
  nodeTooltip?: string
  [key: string]: unknown
}

type StartNode = Node<StartNodeData>

export function StartNode({ data }: NodeProps<StartNode>) {
  const status = data.status
  const warning = data.warning as string | undefined
  const nodeTooltip = data.nodeTooltip as string | undefined
  return (
    <div
      title={nodeTooltip}
      className={`rounded-md border-2 ${warning ? 'border-yellow-400' : 'border-emerald-500'} bg-emerald-50 shadow-sm w-full overflow-hidden`}
    >
      {/* Header */}
      <div className={`${warning ? 'bg-yellow-400' : 'bg-emerald-500'} text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between`}>
        <span>START</span>
        {warning ? (
          <span
            aria-label={`warning: ${warning}`}
            title={warning}
            className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-yellow-600 text-white text-[10px] leading-none font-bold cursor-help"
          >!</span>
        ) : null}
        {!warning && status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-300 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {!warning && status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2 text-xs text-emerald-700 italic">
        I2C Start condition
      </div>
      {warning && (
        <div className="px-3 pb-2 text-xs text-yellow-700 font-medium leading-tight">{warning}</div>
      )}

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
