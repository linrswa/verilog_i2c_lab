import type { DragEvent } from 'react'

interface NodeType {
  type: string
  label: string
  color: string
  description: string
}

const BASIC_NODE_TYPES: NodeType[] = [
  { type: 'reset', label: 'Reset', color: '#ef4444', description: 'Reset the I2C bus' },
  { type: 'write', label: 'Write', color: '#3b82f6', description: 'Write bytes to a register' },
  { type: 'read', label: 'Read', color: '#22c55e', description: 'Read bytes from a register' },
  { type: 'scan', label: 'Scan', color: '#a855f7', description: 'Scan for a device address' },
  { type: 'delay', label: 'Delay', color: '#f59e0b', description: 'Wait for N clock cycles' },
]

const PROTOCOL_NODE_TYPES: NodeType[] = [
  { type: 'i2c_start', label: 'START', color: '#10b981', description: 'I2C Start condition' },
  { type: 'i2c_stop', label: 'STOP', color: '#f43f5e', description: 'I2C Stop condition' },
  { type: 'repeated_start', label: 'Sr (Repeated Start)', color: '#f97316', description: 'I2C Repeated Start condition' },
]

function handleDragStart(event: DragEvent<HTMLDivElement>, nodeType: string) {
  event.dataTransfer.setData('application/reactflow-node-type', nodeType)
  event.dataTransfer.effectAllowed = 'move'
}

function NodePaletteItem({ type, label, color, description }: NodeType) {
  return (
    <div
      key={type}
      draggable
      onDragStart={(e) => handleDragStart(e, type)}
      className="flex items-center gap-2 px-3 py-2 rounded-md bg-white border border-gray-200 cursor-grab shadow-sm hover:shadow-md hover:border-gray-300 transition-all select-none active:cursor-grabbing"
      title={description}
    >
      <span
        className="w-3 h-3 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-sm font-medium text-gray-700">{label}</span>
    </div>
  )
}

export function Sidebar() {
  return (
    <aside
      style={{ width: '200px', minWidth: '200px' }}
      className="flex flex-col border-r border-gray-200 bg-gray-50 p-3 gap-2 overflow-y-auto"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
        Node Palette
      </h2>
      {BASIC_NODE_TYPES.map((nodeType) => (
        <NodePaletteItem key={nodeType.type} {...nodeType} />
      ))}

      {/* Divider */}
      <hr className="border-gray-200 my-1" />

      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
        Protocol
      </h2>
      {PROTOCOL_NODE_TYPES.map((nodeType) => (
        <NodePaletteItem key={nodeType.type} {...nodeType} />
      ))}
    </aside>
  )
}
