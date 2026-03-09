import { useState, useEffect } from 'react'
import type { SimulationResult, StepResult } from '../lib/api'

interface ResultPanelProps {
  result: SimulationResult | null
  width?: number
}

// ─── EEPROM memory dump ──────────────────────────────────────────────────────

/**
 * Renders a 16-column × 16-row hex table showing the slave EEPROM contents.
 * Non-zero cells are highlighted so the user can quickly see which addresses
 * were written to during the simulation.
 */
function EepromDump({ dump, regPointer }: { dump: Record<string, number>; regPointer: number }) {
  const COLS = 16
  const bytes = Array.from({ length: 256 }, (_, i) => dump[String(i)] ?? 0)
  const hasData = bytes.some((b) => b !== 0)

  const colHeaders = Array.from({ length: COLS }, (_, i) =>
    i.toString(16).toUpperCase(),
  )

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 mb-1 uppercase tracking-wide">
        Slave EEPROM Memory (256 bytes)
      </p>
      <p className="text-xs text-gray-600 mb-1 font-mono">
        reg_pointer → <span className="font-semibold text-indigo-600">0x{regPointer.toString(16).toUpperCase().padStart(2, '0')}</span>
        <span className="text-gray-400 ml-1">({regPointer})</span>
      </p>
      {!hasData && (
        <p className="text-xs text-gray-400 italic mb-2">
          All zeros — no data was written to the slave.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="text-xs font-mono border-collapse">
          <thead>
            <tr>
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
                <td className="px-1.5 py-0.5 text-gray-400 border border-gray-200 bg-gray-50 font-semibold">
                  {(row * COLS).toString(16).toUpperCase().padStart(2, '0')}
                </td>
                {Array.from({ length: COLS }, (_, col) => {
                  const addr = row * COLS + col
                  const value = bytes[addr]
                  const isPointer = addr === regPointer
                  const isNonZero = value !== 0
                  return (
                    <td
                      key={col}
                      className={`px-1.5 py-0.5 border text-center ${
                        isPointer
                          ? 'text-orange-700 bg-orange-100 font-bold border-orange-400 ring-1 ring-orange-400'
                          : isNonZero
                            ? 'text-indigo-700 bg-indigo-50 font-semibold border-gray-200'
                            : 'text-gray-300 border-gray-200'
                      }`}
                      title={isPointer ? `reg_pointer → 0x${addr.toString(16).toUpperCase().padStart(2, '0')}` : undefined}
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

// ─── Step table helpers ───────────────────────────────────────────────────────

/** Human-readable label for each op */
function opLabel(op: string): string {
  switch (op) {
    case 'start':           return 'START'
    case 'stop':            return 'STOP'
    case 'repeated_start':  return 'Sr'
    case 'send_byte':       return 'SEND'
    case 'recv_byte':       return 'RECV'
    default:                return op
  }
}

/**
 * Break a step into { master, slave } columns based on I2C protocol roles.
 *
 * - START / STOP / Sr → master-initiated bus conditions, slave is empty.
 * - SEND (send_byte)  → master transmits data, slave responds with ACK/NACK.
 * - RECV (recv_byte)  → slave transmits data, master responds with ACK/NACK.
 */
function stepColumns(step: StepResult): { master: string; slave: string } {
  switch (step.op) {
    case 'start':
    case 'stop':
    case 'repeated_start':
      return { master: '', slave: '' }

    case 'send_byte': {
      // Master sends the byte
      const parts: string[] = []
      if (typeof step.data === 'string') {
        parts.push(step.data)
      }
      if (step.addr) {
        parts.push(`(Addr ${step.addr} ${step.rw ?? ''})`)
      }
      const master = parts.join(' ')
      const slave = step.passed ? 'ACK' : 'NACK'
      return { master, slave }
    }

    case 'recv_byte': {
      // Slave sends the byte, master sends ACK/NACK
      const slaveData = typeof step.data === 'string' ? step.data : '--'
      const masterAck = typeof step.ack === 'boolean'
        ? (step.ack ? 'ACK' : 'NACK')
        : ''
      return { master: masterAck, slave: slaveData }
    }

    default:
      return { master: '', slave: '' }
  }
}

function StepTable({ steps }: { steps: StepResult[] }) {
  return (
    <table className="w-full text-xs font-mono border-collapse">
      <thead>
        <tr className="text-gray-500 border-b border-gray-200">
          <th className="w-4 px-1 py-1 text-left" />
          <th className="w-5 px-1 py-1 text-right">#</th>
          <th className="w-14 px-2 py-1 text-left">Op</th>
          <th className="px-2 py-1 text-left">Master</th>
          <th className="px-2 py-1 text-left">Slave</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step, idx) => {
          const isPassed = step.passed
          const { master, slave } = stepColumns(step)
          return (
            <tr
              key={idx}
              className={isPassed ? 'bg-green-50 text-green-800' : 'bg-red-100 text-red-800'}
              title={step.message ?? undefined}
            >
              {/* Status dot */}
              <td className="px-1 py-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    isPassed ? 'bg-green-500' : 'bg-red-500'
                  }`}
                />
              </td>
              {/* Index */}
              <td className="px-1 py-1.5 text-right text-gray-400">{idx}</td>
              {/* Op label */}
              <td className="px-2 py-1.5 font-semibold">{opLabel(step.op)}</td>
              {/* Master column */}
              <td className="px-2 py-1.5">{master}</td>
              {/* Slave column */}
              <td className="px-2 py-1.5">{slave}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Result panel ─────────────────────────────────────────────────────────────

export function ResultPanel({ result, width }: ResultPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Auto-expand when simulation results become available
  useEffect(() => {
    if (result !== null) {
      setIsExpanded(true)
    }
  }, [result])

  return (
    <aside
      className="flex flex-col border-l border-gray-200 bg-white flex-shrink-0 h-full"
      style={{ width: isExpanded ? (width ?? 320) : 40 }}
    >
      {/* Toggle bar — vertical strip when collapsed */}
      <button
        onClick={() => setIsExpanded((prev) => !prev)}
        className={`flex items-center gap-2 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors ${
          isExpanded
            ? 'px-3 py-2 border-b border-gray-200 w-full text-left'
            : 'flex-col justify-center w-full h-full'
        }`}
        aria-expanded={isExpanded}
      >
        <span
          className="text-gray-400 transition-transform duration-200"
          style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(-90deg)' }}
        >
          ▲
        </span>
        {!isExpanded && (
          <>
            <span className="writing-vertical text-xs tracking-widest">Results</span>
            {result !== null && (
              <span
                className={`w-3 h-3 rounded-full mt-2 ${
                  result.passed ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
            )}
          </>
        )}
        {isExpanded && (
          <>
            Results
            {result !== null && (
              <span
                className={`ml-auto text-xs font-semibold px-2 py-0.5 rounded ${
                  result.passed
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                }`}
              >
                {result.passed ? 'PASS' : 'FAIL'}
              </span>
            )}
          </>
        )}
      </button>

      {/* Expanded body: EEPROM on top (fixed), Results on bottom (scrollable) */}
      {isExpanded && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* ── Top: EEPROM table (always visible, never scrolls) ── */}
          {result !== null && Object.keys(result.register_dump).length > 0 && (
            <div className="flex-shrink-0 px-3 py-2 border-b border-gray-200 overflow-x-auto">
              <EepromDump dump={result.register_dump} regPointer={result.reg_pointer} />
            </div>
          )}

          {/* ── Bottom: Step results + download (scrollable) ── */}
          <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2 text-sm">
            {result === null ? (
              <p className="text-gray-500 italic text-xs">No results yet. Build a flow and click Run.</p>
            ) : (
              <div className="space-y-3">
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
                  {result.passed ? 'PASS' : 'FAIL'}
                </div>

                {/* Per-step results — 3-column table */}
                {result.steps.length > 0 && (
                  <StepTable steps={result.steps} />
                )}

              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
