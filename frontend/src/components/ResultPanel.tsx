import { useState } from 'react'
import type { SimulationResult } from '../lib/api'
import { getWaveformUrl } from '../lib/api'

interface ResultPanelProps {
  result: SimulationResult | null
}

export function ResultPanel({ result }: ResultPanelProps) {
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
        {result !== null && (
          <span
            className={`ml-2 text-xs font-semibold px-1.5 py-0.5 rounded ${
              result.passed
                ? 'bg-green-100 text-green-700'
                : 'bg-red-100 text-red-700'
            }`}
          >
            {result.passed ? 'PASS' : 'FAIL'}
          </span>
        )}
      </button>

      {/* Collapsible body */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-1 h-48 overflow-y-auto text-sm">
          {result === null ? (
            <p className="text-gray-500 italic">No results yet. Build a flow and click Run.</p>
          ) : (
            <div className="space-y-3">
              {/* Per-step results */}
              <div className="space-y-1">
                {result.steps.map((step, idx) => (
                  <div
                    key={idx}
                    className={`flex items-center gap-2 px-2 py-1 rounded text-xs font-mono ${
                      step.passed ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        step.passed ? 'bg-green-500' : 'bg-red-500'
                      }`}
                    />
                    <span className="font-semibold">{step.op}</span>
                    <span className="opacity-70">{step.passed ? 'PASS' : 'FAIL'}</span>
                  </div>
                ))}
              </div>

              {/* Register dump */}
              {Object.keys(result.register_dump).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 mb-1">Register Dump</p>
                  <pre className="text-xs bg-gray-50 rounded p-2 overflow-x-auto">
                    {JSON.stringify(result.register_dump, null, 2)}
                  </pre>
                </div>
              )}

              {/* Waveform download */}
              <div>
                <a
                  href={getWaveformUrl(result.waveform_id)}
                  download={`${result.waveform_id}.vcd`}
                  className="text-xs text-indigo-600 hover:underline"
                >
                  Download waveform (.vcd)
                </a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
