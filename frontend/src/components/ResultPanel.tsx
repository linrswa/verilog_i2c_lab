import { useState } from 'react'

export function ResultPanel() {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div className="flex flex-col border-t border-gray-200 bg-white flex-shrink-0">
      {/* Toggle bar — always visible */}
      <button
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors w-full text-left"
        aria-expanded={isExpanded}
      >
        <span
          className="text-gray-400 transition-transform duration-200"
          style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          ▲
        </span>
        Results
      </button>

      {/* Collapsible body */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-1 h-48 overflow-y-auto text-sm text-gray-500 italic">
          No results yet. Build a flow and click Run.
        </div>
      )}
    </div>
  )
}
