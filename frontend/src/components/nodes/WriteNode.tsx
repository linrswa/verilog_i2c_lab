import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'
import { validateHexAddr, validateHexReg, validateHexDataList } from '../../lib/validate'

export interface WriteNodeData {
  address: string
  register: string
  data: string
  errors?: Record<string, string | undefined>
  [key: string]: unknown
}

type WriteNode = Node<WriteNodeData>

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
              : 'border-gray-300 focus:border-blue-400'
          }`}
        />
      </div>
      {hasError && (
        <p className="text-xs text-red-500 ml-[68px] mt-0.5 leading-tight">{error}</p>
      )}
    </div>
  )
}

export function WriteNode({ id, data }: NodeProps<WriteNode>) {
  const { setNodes } = useReactFlow()

  function updateField(field: keyof WriteNodeData, value: string) {
    setNodes((nodes) =>
      nodes.map((n) => {
        if (n.id !== id) return n

        // Recompute validation errors for the updated field
        const currentData = n.data as WriteNodeData
        const nextAddress = field === 'address' ? value : currentData.address
        const nextRegister = field === 'register' ? value : currentData.register
        const nextData = field === 'data' ? value : currentData.data

        const errors: Record<string, string | undefined> = {
          address: validateHexAddr(nextAddress).error,
          register: validateHexReg(nextRegister).error,
          data: validateHexDataList(nextData).error,
        }

        return { ...n, data: { ...n.data, [field]: value, errors } }
      })
    )
  }

  const errors = (data.errors ?? {}) as Record<string, string | undefined>

  return (
    <div className="rounded-md border-2 border-blue-400 bg-blue-50 shadow-sm min-w-[200px]">
      {/* Input handle — top */}
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        className="w-3 h-3 bg-blue-400 border-2 border-white"
      />

      {/* Header */}
      <div className="bg-blue-400 text-white text-xs font-semibold px-3 py-1 rounded-t">
        Write
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
          label="Data"
          value={data.data}
          placeholder="0xA5, 0xB6"
          error={errors.data}
          onChange={(e) => updateField('data', e.target.value)}
        />
      </div>

      {/* Output handle — bottom */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="out"
        className="w-3 h-3 bg-blue-400 border-2 border-white"
      />
    </div>
  )
}
