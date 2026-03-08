import { useState, useEffect } from 'react'
import type { SimulationResult, StepResult } from '../lib/api'
import { getWaveformUrl } from '../lib/api'

interface ResultPanelProps {
  result: SimulationResult | null
}

// ─── Register dump grid ───────────────────────────────────────────────────────

/**
 * Renders a 16-column × 16-row hex table for the 256-byte register file.
 * Row headers are the high nibble (0x00, 0x10, ...) and column headers are
 * the low nibble (0–F).
 */
function RegisterDump({ dump }: { dump: number[] }) {
  const COLS = 16

  // Pad or trim to exactly 256 entries
  const bytes = Array.from({ length: 256 }, (_, i) => dump[i] ?? 0)

  const colHeaders = Array.from({ length: COLS }, (_, i) =>
    i.toString(16).toUpperCase(),
  )

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">
        Register Dump
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs font-mono border-collapse">
          <thead>
            <tr>
              {/* empty corner */}
              <th className="px-1.5 py-0.5 text-gray-400 border border-gray-200 bg-gray-50" />
              {colHeaders.map((h) => (
                <th
                  key={h}
                  className="px-1.5 py-0.5 text-gray-400 border border-gray-200 bg-gray-50 text-center"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: COLS }, (_, row) => (
              <tr key={row}>
                {/* Row address label */}
                <td className="px-1.5 py-0.5 text-gray-400 border border-gray-200 bg-gray-50 font-semibold">
                  {(row * COLS).toString(16).toUpperCase().padStart(2, '0')}
                </td>
                {Array.from({ length: COLS }, (_, col) => {
                  const value = bytes[row * COLS + col]
                  const isNonZero = value !== 0
                  return (
                    <td
                      key={col}
                      className={`px-1.5 py-0.5 border border-gray-200 text-center ${
                        isNonZero ? 'text-indigo-700 bg-indigo-50' : 'text-gray-400'
                      }`}
                    >
                      {value.toString(16).toUpperCase().padStart(2, '0')}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Step detail renderer ─────────────────────────────────────────────────────

function stepDetails(step: StepResult): string {
  switch (step.op) {
    case 'read_bytes': {
      const parts: string[] = []
      if (Array.isArray(step.data)) {
        const hex = (step.data as number[]).map(
          (b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0'),
        )
        parts.push(`data=[${hex.join(', ')}]`)
      }
      if (typeof step.match === 'boolean') {
        parts.push(`match=${step.match ? 'pass' : 'fail'}`)
      }
      return parts.join('  ')
    }
    case 'scan': {
      const parts: string[] = []
      if (typeof step.found === 'boolean') {
        parts.push(`found=${step.found}`)
      }
      if (typeof step.match === 'boolean') {
        parts.push(`match=${step.match ? 'pass' : 'fail'}`)
      }
      return parts.join('  ')
    }
    default:
      return ''
  }
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({ step, index }: { step: StepResult; index: number }) {
  const details = stepDetails(step)
  const isPassed = step.passed

  return (
    <div
      className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs font-mono ${
        isPassed
          ? 'bg-green-50 text-green-800'
          : 'bg-red-100 text-red-800'
      }`}
    >
      {/* Status dot */}
      <span
        className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
          isPassed ? 'bg-green-500' : 'bg-red-500'
        }`}
      />

      {/* Step index */}
      <span className="text-gray-400 w-5 flex-shrink-0">{index}</span>

      {/* Operation name */}
      <span className="font-semibold w-24 flex-shrink-0">{step.op}</span>

      {/* ok / fail badge */}
      <span
        className={`flex-shrink-0 font-semibold ${
          isPassed ? 'text-green-700' : 'text-red-700'
        }`}
      >
        {isPassed ? 'ok' : 'fail'}
      </span>

      {/* Extra details */}
      {details && <span className="opacity-80">{details}</span>}
    </div>
  )
}

// ─── Download VCD button ──────────────────────────────────────────────────────

function DownloadVcdButton({ waveformId }: { waveformId: string }) {
  function handleClick() {
    const url = getWaveformUrl(waveformId)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${waveformId}.vcd`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  }

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
    >
      Download VCD
    </button>
  )
}

// ─── Result panel ─────────────────────────────────────────────────────────────

export function ResultPanel({ result }: ResultPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Auto-expand when simulation results become available
  useEffect(() => {
    if (result !== null) {
      setIsExpanded(true)
    }
  }, [result])

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
            className={`ml-2 text-xs font-semibold px-2 py-0.5 rounded ${
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
        <div className="px-4 pb-4 pt-1 max-h-72 overflow-y-auto text-sm">
          {result === null ? (
            <p className="text-gray-500 italic">No results yet. Build a flow and click Run.</p>
          ) : (
            <div className="space-y-4">
              {/* Overall status banner */}
              <div
                className={`flex items-center gap-2 px-3 py-2 rounded font-semibold text-sm ${
                  result.passed
                    ? 'bg-green-100 text-green-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                <span
                  className={`w-3 h-3 rounded-full ${
                    result.passed ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
                Overall: {result.passed ? 'PASS' : 'FAIL'}
              </div>

              {/* Per-step results */}
              {result.steps.length > 0 && (
                <div className="space-y-1">
                  {result.steps.map((step, idx) => (
                    <StepRow key={idx} step={step} index={idx} />
                  ))}
                </div>
              )}

              {/* Register dump */}
              {result.register_dump.length > 0 && (
                <RegisterDump dump={result.register_dump} />
              )}

              {/* Download VCD */}
              {result.waveform_id !== undefined && (
                <DownloadVcdButton waveformId={result.waveform_id} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
