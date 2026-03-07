import { Handle, Position, useReactFlow } from '@xyflow/react'
import type { NodeProps, Node } from '@xyflow/react'
import type { ChangeEvent } from 'react'

export interface ReadNodeData {
  address: string
  register: string
  n: string
  expect: string
  [key: string]: unknown
}

type ReadNode = Node<ReadNodeData>

function NodeField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="flex items-center gap-1 mb-1">
      <span className="text-xs text-gray-500 w-16 flex-shrink-0">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 bg-white focus:outline-none focus:border-green-400 nodrag"
      />
    </div>
  )
}

export function ReadNode({ id, data }: NodeProps<ReadNode>) {
  const { setNodes } = useReactFlow()

  function updateField(field: keyof ReadNodeData, value: string) {
    setNodes((nodes) =>
      nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, [field]: value } } : n
      )
    )
  }

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
      <div className="bg-green-500 text-white text-xs font-semibold px-3 py-1 rounded-t">
        Read
      </div>

      {/* Fields */}
      <div className="px-3 py-2">
        <NodeField
          label="Address"
          value={data.address}
          placeholder="0x50"
          onChange={(e) => updateField('address', e.target.value)}
        />
        <NodeField
          label="Register"
          value={data.register}
          placeholder="0x00"
          onChange={(e) => updateField('register', e.target.value)}
        />
        <NodeField
          label="Byte count"
          value={data.n}
          placeholder="1"
          onChange={(e) => updateField('n', e.target.value)}
        />
        <NodeField
          label="Expected"
          value={data.expect}
          placeholder="0xA5, 0xB6"
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
