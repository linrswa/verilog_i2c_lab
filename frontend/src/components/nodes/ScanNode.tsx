import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
import { validateHexAddr } from '../../lib/validate'

export interface ScanNodeData {
  address: string
  expect: string
  errors?: Record<string, string | undefined>
  status?: 'ok' | 'fail'
  [key: string]: unknown
}

type ScanNode = Node<ScanNodeData>

export function ScanNode({ id, data }: NodeProps<ScanNode>) {
  const { setNodes } = useReactFlow()

  function updateField(field: keyof ScanNodeData, value: string) {
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n

        const currentData = n.data as ScanNodeData
        const nextAddress = field === 'address' ? value : currentData.address

        const errors: Record<string, string | undefined> = {
          address: validateHexAddr(nextAddress).error,
        }

        return { ...n, data: { ...n.data, [field]: value, errors, status: undefined } }
      })
    )
  }

  function handleAddressChange(e: ChangeEvent<HTMLInputElement>) {
    updateField('address', e.target.value)
  }

  function handleExpectChange(e: ChangeEvent<HTMLSelectElement>) {
    updateField('expect', e.target.value)
  }

  const errors = (data.errors ?? {}) as Record<string, string | undefined>
  const addressError = errors.address
  const status = data.status

  return (
    <div className="rounded-md border-2 border-amber-400 bg-amber-50 shadow-sm min-w-[200px]">
      {/* Input handle — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-amber-400 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-amber-400 text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between">
        <span>Scan</span>
        {status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Fields */}
      <div className="px-3 py-2">
        {/* Address field */}
        <div className="mb-1">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 w-16 flex-shrink-0">Address</span>
            <input
              type="text"
              value={data.address}
              placeholder="0x50"
              onChange={handleAddressChange}
              className={`flex-1 text-xs border rounded px-1 py-0.5 bg-white focus:outline-none nodrag ${
                addressError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-amber-400'
              }`}
            />
          </div>
          {addressError && (
            <p className="text-xs text-red-500 ml-[68px] mt-0.5 leading-tight">{addressError}</p>
          )}
        </div>

        {/* Expected result select */}
        <div className="flex items-center gap-1 mb-1">
          <span className="text-xs text-gray-500 w-16 flex-shrink-0">Expected</span>
          <select
            value={data.expect}
            onChange={handleExpectChange}
            className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 bg-white focus:outline-none focus:border-amber-400 nodrag"
          >
            <option value="">— any —</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-amber-400 border-2 border-white"
      />
    </div>
  )
}
