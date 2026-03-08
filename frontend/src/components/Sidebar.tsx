interface NodeType {
  type: string
  label: string
  color: string
  description: string
}

const PROTOCOL_NODE_TYPES: NodeType[] = [
  { type: 'i2c_start', label: 'START', color: '#10b981', description: 'I2C Start condition' },
  { type: 'i2c_stop', label: 'STOP', color: '#f43f5e', description: 'I2C Stop condition' },
  { type: 'repeated_start', label: 'Sr (Repeated Start)', color: '#f97316', description: 'I2C Repeated Start condition' },
  { type: 'send_byte', label: 'Send Byte', color: '#a855f7', description: 'Send a raw byte on the I2C bus' },
  { type: 'recv_byte', label: 'Recv Byte', color: '#14b8a6', description: 'Receive a byte from the I2C bus' },
]

interface NodePaletteItemProps extends NodeType {
  onAdd: (type: string) => void
}

function NodePaletteItem({ type, label, color, description, onAdd }: NodePaletteItemProps) {
  return (
    <button
      onClick={() => onAdd(type)}
      className="flex items-center gap-2 px-3 py-2 rounded-md bg-white border border-gray-200 shadow-sm hover:shadow-md hover:border-gray-300 transition-all select-none text-left w-full cursor-pointer"
      title={description}
    >
      <span
        className="w-3 h-3 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-sm font-medium text-gray-700">{label}</span>
    </button>
  )
}

interface SidebarProps {
  onAddNode: (type: string) => void
  width: number
}

export function Sidebar({ onAddNode, width }: SidebarProps) {
  return (
    <aside
      style={{ width: `${width}px`, minWidth: '120px' }}
      className="flex flex-col border-r border-gray-200 bg-gray-50 p-3 gap-2 overflow-y-auto flex-shrink-0"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">
        Protocol
      </h2>
      {PROTOCOL_NODE_TYPES.map((nodeType) => (
        <NodePaletteItem key={nodeType.type} {...nodeType} onAdd={onAddNode} />
      ))}
    </aside>
  )
}
