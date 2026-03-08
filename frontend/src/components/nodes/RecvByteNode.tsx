import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
export interface RecvByteNodeData {
  ack: boolean
  receivedData?: string
  status?: 'ok' | 'fail'
  warning?: string
  nodeTooltip?: string
  [key: string]: unknown
}

type RecvByteNode = Node<RecvByteNodeData>

export function RecvByteNode({ id, data }: NodeProps<RecvByteNode>) {
  const { setNodes } = useReactFlow()

  function handleAckChange(e: ChangeEvent<HTMLSelectElement>) {
    const ack = e.target.value === 'ack'
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n
        return { ...n, data: { ...n.data, ack, status: undefined } }
      }),
    )
  }

  const status = data.status
  const warning = data.warning as string | undefined
  const nodeTooltip = data.nodeTooltip as string | undefined

  return (
    <div
      title={nodeTooltip}
      className={`rounded-md border-2 ${warning ? 'border-yellow-400' : 'border-teal-500'} bg-teal-50 shadow-sm w-full overflow-hidden`}
    >
      {/* Input handle — top (vertical layout) */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-teal-500 border-2 border-white"
      />

      {/* Header */}
      <div className={`${warning ? 'bg-yellow-400' : 'bg-teal-500'} text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between`}>
        <span>Recv Byte</span>
        {warning ? (
          <span
            aria-label={`warning: ${warning}`}
            title={warning}
            className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-yellow-600 text-white text-[10px] leading-none font-bold cursor-help"
          >!</span>
        ) : null}
        {!warning && status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {!warning && status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        {/* ACK/NACK toggle */}
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs text-gray-500 w-12 flex-shrink-0">ACK</span>
          <select
            value={data.ack ? 'ack' : 'nack'}
            onChange={handleAckChange}
            className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 bg-white focus:outline-none focus:border-teal-400 nodrag"
          >
            <option value="ack">ACK</option>
            <option value="nack">NACK</option>
          </select>
        </div>

        {/* Read-only data field — populated after simulation */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500 w-12 flex-shrink-0">Data</span>
          <input
            type="text"
            readOnly
            value={data.receivedData ?? ''}
            placeholder="After sim"
            className="flex-1 text-xs border border-gray-200 rounded px-1 py-0.5 bg-gray-100 text-gray-400 cursor-default nodrag"
          />
        </div>

        {/* Protocol warning text */}
        {warning && (
          <p className="text-xs text-yellow-700 font-medium leading-tight mt-1">{warning}</p>
        )}
      </div>

      {/* Output handle — bottom (vertical layout) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-teal-500 border-2 border-white"
      />
    </div>
  )
}
