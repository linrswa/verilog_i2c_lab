import { useState, useEffect, useRef } from 'react'
import { getWaveformSignals } from '../lib/api'
import type { WaveformSignalsResponse } from '../lib/api'
import { buildTimeToX } from '../lib/waveform'

// ── Layout constants ──────────────────────────────────────────────────────────

/** Width of the label column (left side of the SVG) in pixels. */
const LABEL_WIDTH = 60

/** Height of each signal row in pixels. */
const ROW_HEIGHT = 40

/** Vertical padding inside each row above/below the signal trace. */
const ROW_PADDING = 10

/** Minimum panel height in pixels when expanded. */
const PANEL_HEIGHT = 160

/** Signals to render by default (in order). */
const DEFAULT_SIGNALS = ['sda', 'scl']

// ── SVG path builder ──────────────────────────────────────────────────────────

/**
 * Build an SVG path string for a single digital signal.
 *
 * Iterates the ordered change events and draws:
 *   - a horizontal segment from the current time to the next change time
 *   - a vertical transition to the new value
 *
 * Values '0' and '1' are mapped to low/high y-positions.  Unknown ('x', 'z')
 * values are rendered at mid-height.
 */
function buildSignalPath(
  changes: [number, string][],
  endTimePs: number,
  timeToX: (t: number) => number,
  rowTop: number,
): string {
  if (changes.length === 0) return ''

  const yHigh = rowTop + ROW_PADDING
  const yLow = rowTop + ROW_HEIGHT - ROW_PADDING
  const yMid = rowTop + ROW_HEIGHT / 2

  function valueToY(value: string): number {
    if (value === '1') return yHigh
    if (value === '0') return yLow
    return yMid
  }

  const parts: string[] = []
  let x = timeToX(changes[0][0])
  let y = valueToY(changes[0][1])

  // Move to the start of the first change
  parts.push(`M ${x} ${y}`)

  for (let i = 1; i < changes.length; i++) {
    const [nextTimePs, nextValue] = changes[i]
    const nextX = timeToX(nextTimePs)
    const nextY = valueToY(nextValue)

    // Horizontal hold until next transition
    parts.push(`H ${nextX}`)
    // Vertical transition to new value
    parts.push(`V ${nextY}`)

    x = nextX
    y = nextY
  }

  // Hold until end of simulation
  parts.push(`H ${timeToX(endTimePs)}`)

  return parts.join(' ')
}

// ── Signal row ─────────────────────────────────────────────────────────────────

interface SignalRowProps {
  name: string
  changes: [number, string][]
  endTimePs: number
  timeToX: (t: number) => number
  rowIndex: number
  svgWidth: number
}

function SignalRow({ name, changes, endTimePs, timeToX, rowIndex, svgWidth }: SignalRowProps) {
  const rowTop = rowIndex * ROW_HEIGHT
  const pathD = buildSignalPath(changes, endTimePs, timeToX, rowTop)

  return (
    <g>
      {/* Label background */}
      <rect
        x={0}
        y={rowTop}
        width={LABEL_WIDTH}
        height={ROW_HEIGHT}
        fill="#f9fafb"
        stroke="#e5e7eb"
        strokeWidth={0.5}
      />
      {/* Label text */}
      <text
        x={LABEL_WIDTH - 6}
        y={rowTop + ROW_HEIGHT / 2}
        dominantBaseline="middle"
        textAnchor="end"
        fontSize={10}
        fontFamily="monospace"
        fill="#374151"
        fontWeight="600"
      >
        {name.toUpperCase()}
      </text>

      {/* Horizontal grid line */}
      <line
        x1={LABEL_WIDTH}
        y1={rowTop + ROW_HEIGHT}
        x2={svgWidth}
        y2={rowTop + ROW_HEIGHT}
        stroke="#e5e7eb"
        strokeWidth={0.5}
      />

      {/* Signal path */}
      {pathD && (
        <path
          d={pathD}
          stroke="#4f46e5"
          strokeWidth={1.5}
          fill="none"
          strokeLinejoin="miter"
        />
      )}
    </g>
  )
}

// ── WaveformPanel ─────────────────────────────────────────────────────────────

interface WaveformPanelProps {
  /** The waveform UUID returned by the simulation run. Null hides the panel. */
  waveformId: string | null
}

/**
 * WaveformPanel renders digital square-wave SVG traces for I2C bus signals
 * (SDA and SCL by default) fetched from the backend after a simulation run.
 *
 * It sits below the ReactFlow canvas in the same flex column and is
 * collapsible via a toggle button.
 */
export function WaveformPanel({ waveformId }: WaveformPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const [waveformData, setWaveformData] = useState<WaveformSignalsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)

  // Measure container width for SVG scaling
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    setContainerWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  // Fetch signal data whenever waveformId changes
  useEffect(() => {
    if (!waveformId) {
      setWaveformData(null)
      setError(null)
      return
    }

    let cancelled = false

    async function fetchSignals() {
      setIsLoading(true)
      setError(null)
      try {
        const data = await getWaveformSignals(waveformId!, DEFAULT_SIGNALS)
        if (!cancelled) {
          setWaveformData(data)
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Failed to load waveform signals'
          setError(message)
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void fetchSignals()
    return () => {
      cancelled = true
    }
  }, [waveformId])

  // Panel only appears when a waveform_id is available
  if (!waveformId) return null

  // Determine which signals are present
  const availableSignals = waveformData
    ? DEFAULT_SIGNALS.filter((s) => s in waveformData.signals)
    : []

  const endTimePs = waveformData?.end_time ?? 0
  const waveformAreaWidth = containerWidth - LABEL_WIDTH
  const svgWidth = containerWidth
  const svgHeight = availableSignals.length * ROW_HEIGHT

  const timeToX = buildTimeToX({
    totalDurationPs: endTimePs,
    canvasWidthPx: waveformAreaWidth,
    originOffsetPx: LABEL_WIDTH,
  })

  return (
    <div
      className="border-t border-gray-200 bg-white flex-shrink-0"
      style={{ minHeight: isExpanded ? PANEL_HEIGHT : undefined }}
    >
      {/* Toggle bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 bg-gray-50">
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
          Waveform Viewer
        </span>
        <div className="flex items-center gap-2">
          {isLoading && (
            <span className="text-xs text-gray-400 italic">Loading...</span>
          )}
          {error && (
            <span className="text-xs text-red-500 max-w-xs truncate" title={error}>
              {error}
            </span>
          )}
          <button
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? 'Collapse waveform panel' : 'Expand waveform panel'}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            <span
              style={{
                display: 'inline-block',
                transform: isExpanded ? 'rotate(0deg)' : 'rotate(180deg)',
                transition: 'transform 0.2s',
              }}
            >
              ▼
            </span>
            {isExpanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>

      {/* Panel body */}
      {isExpanded && (
        <div
          ref={containerRef}
          className="overflow-x-auto"
          style={{ height: PANEL_HEIGHT - 36 }}
        >
          {isLoading && !waveformData && (
            <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
              Loading waveform data...
            </div>
          )}

          {!isLoading && error && !waveformData && (
            <div className="flex items-center justify-center h-full text-sm text-red-500 italic">
              {error}
            </div>
          )}

          {waveformData && availableSignals.length === 0 && (
            <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
              No SDA/SCL signals found in waveform data.
            </div>
          )}

          {waveformData && availableSignals.length > 0 && (
            <svg
              width={svgWidth}
              height={svgHeight}
              style={{ display: 'block', minWidth: svgWidth }}
            >
              {/* Background */}
              <rect x={0} y={0} width={svgWidth} height={svgHeight} fill="#ffffff" />

              {/* Signal rows */}
              {availableSignals.map((signalName, rowIndex) => {
                const sigData = waveformData.signals[signalName]
                return (
                  <SignalRow
                    key={signalName}
                    name={signalName}
                    changes={sigData.changes}
                    endTimePs={endTimePs}
                    timeToX={timeToX}
                    rowIndex={rowIndex}
                    svgWidth={svgWidth}
                  />
                )
              })}
            </svg>
          )}
        </div>
      )}
    </div>
  )
}
