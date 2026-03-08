import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
import { validateHexByte } from '../../lib/validate'

export interface SendByteNodeData {
  data: string
  errors?: Record<string, string | undefined>
  status?: 'ok' | 'fail'
  [key: string]: unknown
}

type SendByteNode = Node<SendByteNodeData>

/**
 * Decode an 8-bit byte as an I2C address byte: upper 7 bits = address, LSB = R/W.
 * Returns a string like 'Addr: 0x50 W' or 'Addr: 0x50 R'.
 */
function decodeAddressByte(hexStr: string): string | null {
  const trimmed = hexStr.trim()
  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed) || parsed < 0x00 || parsed > 0xff) return null

  const addr = parsed >> 1
  const rw = (parsed & 0x01) === 0 ? 'W' : 'R'
  const addrHex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`
  return `Addr: ${addrHex} ${rw}`
}

export function SendByteNode({ id, data }: NodeProps<SendByteNode>) {
  const { setNodes } = useReactFlow()

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n
        const errors: Record<string, string | undefined> = {
          data: validateHexByte(value).error,
        }
        return { ...n, data: { ...n.data, data: value, errors, status: undefined } }
      }),
    )
  }

  const errors = (data.errors ?? {}) as Record<string, string | undefined>
  const dataError = errors.data
  const hasError = Boolean(dataError)
  const helperText = decodeAddressByte(data.data)
  const status = data.status

  return (
    <div className="rounded-md border-2 border-purple-500 bg-purple-50 shadow-sm min-w-[180px]">
      {/* Input handle — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-purple-500 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-purple-500 text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between">
        <span>Send Byte</span>
        {status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <div className="mb-1">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500 w-12 flex-shrink-0">Byte</span>
            <input
              type="text"
              value={data.data}
              placeholder="0xA0"
              onChange={handleChange}
              className={`flex-1 text-xs border rounded px-1 py-0.5 bg-white focus:outline-none nodrag ${
                hasError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-gray-300 focus:border-purple-400'
              }`}
            />
          </div>
          {hasError && (
            <p className="text-xs text-red-500 ml-[52px] mt-0.5 leading-tight">{dataError}</p>
          )}
        </div>

        {/* Helper text: always shown when value is a valid hex byte */}
        {helperText !== null && !hasError && (
          <p className="text-xs text-purple-600 italic ml-[52px] leading-tight">{helperText}</p>
        )}
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-purple-500 border-2 border-white"
      />
    </div>
  )
}
