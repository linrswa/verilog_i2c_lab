import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
import { validatePositiveInt } from '../../lib/validate'

export interface DelayNodeData {
  cycles: string
  errors?: Record<string, string | undefined>
  [key: string]: unknown
}

type DelayNode = Node<DelayNodeData>

export function DelayNode({ id, data }: NodeProps<DelayNode>) {
  const { setNodes } = useReactFlow()

  function handleCyclesChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n

        const errors: Record<string, string | undefined> = {
          cycles: validatePositiveInt(value).error,
        }

        return { ...n, data: { ...n.data, cycles: value, errors } }
      })
    )
  }

  const errors = (data.errors ?? {}) as Record<string, string | undefined>
  const cyclesError = errors.cycles

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
        <div className="mb-1">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 w-16 flex-shrink-0">Cycles</span>
            <input
              type="text"
              value={data.cycles}
              placeholder="100"
              onChange={handleCyclesChange}
              className={`flex-1 text-xs border rounded px-1 py-0.5 bg-white focus:outline-none nodrag ${
                cyclesError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-purple-400'
              }`}
            />
          </div>
          {cyclesError && (
            <p className="text-xs text-red-500 ml-[68px] mt-0.5 leading-tight">{cyclesError}</p>
          )}
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
