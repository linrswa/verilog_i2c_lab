import { TemplateDropdown } from './TemplateDropdown'

interface ToolbarProps {
  onRun: () => void
  isRunDisabled: boolean
  isRunning: boolean
  onLoadTemplate: (templateId: string) => void
}

export function Toolbar({ onRun, isRunDisabled, isRunning, onLoadTemplate }: ToolbarProps) {
  return (
    <header className="flex items-center gap-3 px-4 py-2 bg-white border-b border-gray-200 shadow-sm flex-shrink-0">
      <span className="text-base font-bold text-gray-800 tracking-tight mr-auto">
        I2C Demo
      </span>
      <TemplateDropdown onSelect={onLoadTemplate} />
      <button
        onClick={onRun}
        disabled={isRunDisabled || isRunning}
        className="px-4 py-1.5 rounded-md text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
      >
        {isRunning ? 'Running…' : 'Run'}
      </button>
    </header>
  )
}
