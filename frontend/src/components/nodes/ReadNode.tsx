import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
import { validateHexAddr, validateHexReg, validateHexDataList, validatePositiveInt } from '../../lib/validate'

export interface ReadNodeData {
  address: string
  register: string
  n: string
  expect: string
  errors?: Record<string, string | undefined>
  status?: 'ok' | 'fail'
  [key: string]: unknown
}

type ReadNode = Node<ReadNodeData>

function NodeField({
  label,
  value,
  placeholder,
  error,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  error?: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  const hasError = Boolean(error)
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-500 w-16 flex-shrink-0">{label}</span>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={onChange}
          className={`flex-1 text-xs border rounded px-1 py-0.5 bg-white focus:outline-none nodrag ${
            hasError
              ? 'border-red-500 focus:border-red-500'
              : 'border-gray-300 focus:border-green-400'
          }`}
        />
      </div>
      {hasError && (
        <p className="text-xs text-red-500 ml-[68px] mt-0.5 leading-tight">{error}</p>
      )}
    </div>
  )
}

export function ReadNode({ id, data }: NodeProps<ReadNode>) {
  const { setNodes } = useReactFlow()

  function updateField(field: keyof ReadNodeData, value: string) {
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n

        const currentData = n.data as ReadNodeData
        const nextAddress = field === 'address' ? value : currentData.address
        const nextRegister = field === 'register' ? value : currentData.register
        const nextN = field === 'n' ? value : currentData.n
        const nextExpect = field === 'expect' ? value : currentData.expect

        const errors: Record<string, string | undefined> = {
          address: validateHexAddr(nextAddress).error,
          register: validateHexReg(nextRegister).error,
          n: validatePositiveInt(nextN).error,
          // expect is optional — only validate if non-empty
          expect: nextExpect.trim() !== '' ? validateHexDataList(nextExpect).error : undefined,
        }

        return { ...n, data: { ...n.data, [field]: value, errors, status: undefined } }
      })
    )
  }

  const errors = (data.errors ?? {}) as Record<string, string | undefined>
  const status = data.status

  return (
    <div className="rounded-md border-2 border-green-500 bg-green-50 shadow-sm min-w-[200px]">
      {/* Input handle — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-green-500 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-green-500 text-white text-xs font-semibold px-3 py-1 rounded-t flex items-center justify-between">
        <span>Read</span>
        {status === 'ok' && (
          <span aria-label="passed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-green-700 text-white text-[10px] leading-none font-bold">✓</span>
        )}
        {status === 'fail' && (
          <span aria-label="failed" className="ml-1 flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none font-bold">✕</span>
        )}
      </div>

      {/* Fields */}
      <div className="px-3 py-2">
        <NodeField
          label="Address"
          value={data.address}
          placeholder="0x50"
          error={errors.address}
          onChange={(e) => updateField('address', e.target.value)}
        />
        <NodeField
          label="Register"
          value={data.register}
          placeholder="0x00"
          error={errors.register}
          onChange={(e) => updateField('register', e.target.value)}
        />
        <NodeField
          label="Byte count"
          value={data.n}
          placeholder="1"
          error={errors.n}
          onChange={(e) => updateField('n', e.target.value)}
        />
        <NodeField
          label="Expected"
          value={data.expect}
          placeholder="0xA5, 0xB6"
          error={errors.expect}
          onChange={(e) => updateField('expect', e.target.value)}
        />
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-green-500 border-2 border-white"
      />
    </div>
  )
}
