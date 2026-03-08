import { useState, useEffect, useRef } from 'react'
import { getWaveformSignals } from '../lib/api'
import type { WaveformSignalsResponse, StepResult } from '../lib/api'
import { buildTimeToX } from '../lib/waveform'

// ── Layout constants ──────────────────────────────────────────────────────────

/** Width of the label column (left side of the SVG) in pixels. */
const LABEL_WIDTH = 60

/** Height of each signal row in pixels. */
const ROW_HEIGHT = 40

/** Vertical padding inside each row above/below the signal trace. */
const ROW_PADDING = 10

/** Minimum panel height in pixels when expanded. */
const PANEL_HEIGHT = 200

/** Signals enabled by default. */
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

// ── Signal selector chip ───────────────────────────────────────────────────────

interface SignalChipProps {
  name: string
  isSelected: boolean
  onToggle: (name: string) => void
}

function SignalChip({ name, isSelected, onToggle }: SignalChipProps) {
  return (
    <button
      onClick={() => onToggle(name)}
      aria-pressed={isSelected}
      title={isSelected ? `Hide ${name.toUpperCase()}` : `Show ${name.toUpperCase()}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '11px',
        fontFamily: 'monospace',
        fontWeight: 600,
        border: '1.5px solid',
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s',
        background: isSelected ? '#4f46e5' : '#f3f4f6',
        color: isSelected ? '#ffffff' : '#6b7280',
        borderColor: isSelected ? '#4f46e5' : '#d1d5db',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: isSelected ? '#ffffff' : '#9ca3af',
          flexShrink: 0,
        }}
      />
      {name.toUpperCase()}
    </button>
  )
}

// ── Step overlay color map ────────────────────────────────────────────────────

/**
 * Maps a protocol step op name to a semi-transparent fill color.
 * Colors are chosen to match the node color scheme used in the canvas.
 */
const STEP_OVERLAY_COLORS: Record<string, string> = {
  start:          'rgba(59, 130, 246, 0.15)',   // blue  — matches StartNode
  repeated_start: 'rgba(139, 92, 246, 0.15)',   // purple — matches RepeatedStartNode
  send_byte:      'rgba(34, 197, 94, 0.15)',    // green — matches SendByteNode
  recv_byte:      'rgba(249, 115, 22, 0.15)',   // orange — matches RecvByteNode
  stop:           'rgba(239, 68, 68, 0.15)',    // red   — matches StopNode
  reset:          'rgba(107, 114, 128, 0.15)',  // gray  — internal reset step
}

const STEP_OVERLAY_STROKE_COLORS: Record<string, string> = {
  start:          'rgba(59, 130, 246, 0.4)',
  repeated_start: 'rgba(139, 92, 246, 0.4)',
  send_byte:      'rgba(34, 197, 94, 0.4)',
  recv_byte:      'rgba(249, 115, 22, 0.4)',
  stop:           'rgba(239, 68, 68, 0.4)',
  reset:          'rgba(107, 114, 128, 0.4)',
}

const STEP_LABEL_COLORS: Record<string, string> = {
  start:          '#1d4ed8',
  repeated_start: '#6d28d9',
  send_byte:      '#15803d',
  recv_byte:      '#c2410c',
  stop:           '#b91c1c',
  reset:          '#374151',
}

function stepFillColor(op: string): string {
  return STEP_OVERLAY_COLORS[op] ?? 'rgba(107, 114, 128, 0.12)'
}

function stepStrokeColor(op: string): string {
  return STEP_OVERLAY_STROKE_COLORS[op] ?? 'rgba(107, 114, 128, 0.35)'
}

function stepLabelColor(op: string): string {
  return STEP_LABEL_COLORS[op] ?? '#374151'
}

/** Human-readable label for a step op. */
function stepLabel(op: string): string {
  switch (op) {
    case 'start':          return 'START'
    case 'repeated_start': return 'R-START'
    case 'send_byte':      return 'SEND'
    case 'recv_byte':      return 'RECV'
    case 'stop':           return 'STOP'
    case 'reset':          return 'RST'
    default:               return op.toUpperCase()
  }
}

// ── Step overlay layer ────────────────────────────────────────────────────────

interface StepOverlaysProps {
  steps: StepResult[]
  timeToX: (t: number) => number
  svgHeight: number
  svgWidth: number
}

/**
 * Renders semi-transparent colored rectangles and centered labels for each
 * protocol step that has a `time_range_ps` value.  These overlays sit behind
 * the signal path elements so the waveform traces remain readable.
 */
function StepOverlays({ steps, timeToX, svgHeight, svgWidth }: StepOverlaysProps) {
  const overlays = steps.filter((s) => s.time_range_ps != null)

  if (overlays.length === 0) return null

  return (
    <g data-testid="step-overlays">
      {overlays.map((step, idx) => {
        const [startPs, endPs] = step.time_range_ps!
        const x1 = timeToX(startPs)
        const x2 = timeToX(endPs)
        const width = Math.max(x2 - x1, 1)

        // Clamp to waveform area (past the label column)
        const clampedX = Math.max(x1, 0)
        const clampedWidth = Math.min(width, svgWidth - clampedX)

        if (clampedWidth <= 0) return null

        const labelX = clampedX + clampedWidth / 2
        const labelY = 9

        return (
          <g key={`${step.op}-${idx}`}>
            <rect
              x={clampedX}
              y={0}
              width={clampedWidth}
              height={svgHeight}
              fill={stepFillColor(step.op)}
              stroke={stepStrokeColor(step.op)}
              strokeWidth={0.8}
            />
            <text
              x={labelX}
              y={labelY}
              textAnchor="middle"
              dominantBaseline="hanging"
              fontSize={8}
              fontFamily="monospace"
              fontWeight="600"
              fill={stepLabelColor(step.op)}
            >
              {stepLabel(step.op)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

// ── WaveformPanel ─────────────────────────────────────────────────────────────

interface WaveformPanelProps {
  /** The waveform UUID returned by the simulation run. Null hides the panel. */
  waveformId: string | null
  /**
   * Step results from the simulation run.  Steps with a `time_range_ps` field
   * will be rendered as semi-transparent overlay regions on the waveform.
   */
  steps?: StepResult[]
}

/**
 * WaveformPanel renders digital square-wave SVG traces for I2C bus signals.
 * SDA and SCL are shown by default; additional signals can be toggled via
 * the signal selector bar above the waveform area.
 *
 * It sits below the ReactFlow canvas in the same flex column and is
 * collapsible via a toggle button.
 */
export function WaveformPanel({ waveformId, steps = [] }: WaveformPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const [waveformData, setWaveformData] = useState<WaveformSignalsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(800)

  // All signal names returned by the API (preserved in insertion order)
  const [availableSignals, setAvailableSignals] = useState<string[]>([])

  // Which signals are currently enabled; order here determines render order
  const [selectedSignals, setSelectedSignals] = useState<string[]>(DEFAULT_SIGNALS)

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

  // Fetch ALL signal data whenever waveformId changes (no filter — we need the
  // full signal list to populate the selector)
  useEffect(() => {
    if (!waveformId) {
      setWaveformData(null)
      setError(null)
      setAvailableSignals([])
      setSelectedSignals(DEFAULT_SIGNALS)
      return
    }

    let cancelled = false

    async function fetchSignals() {
      setIsLoading(true)
      setError(null)
      try {
        // Fetch all signals (no filter param) so we know what's available
        const data = await getWaveformSignals(waveformId!)
        if (!cancelled) {
          setWaveformData(data)

          const allNames = Object.keys(data.signals)
          setAvailableSignals(allNames)

          // Keep DEFAULT_SIGNALS that are actually present; add any extras that
          // were already selected (e.g. from a previous run with same id).
          setSelectedSignals((prev) => {
            const defaultEnabled = DEFAULT_SIGNALS.filter((s) => allNames.includes(s))
            // Preserve any previously selected extras that still exist
            const extras = prev.filter(
              (s) => !defaultEnabled.includes(s) && allNames.includes(s),
            )
            return [...defaultEnabled, ...extras]
          })
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

  // Toggle a signal on/off.  When turning on, append to end (preserves order
  // of activation).  When turning off, remove from list.
  function handleToggleSignal(name: string) {
    setSelectedSignals((prev) => {
      if (prev.includes(name)) {
        return prev.filter((s) => s !== name)
      }
      return [...prev, name]
    })
  }

  // Panel only appears when a waveform_id is available
  if (!waveformId) return null

  // Determine which selected signals are actually present in the data
  const visibleSignals = waveformData
    ? selectedSignals.filter((s) => s in waveformData.signals)
    : []

  const endTimePs = waveformData?.end_time ?? 0
  const waveformAreaWidth = containerWidth - LABEL_WIDTH
  const svgWidth = containerWidth
  const svgHeight = visibleSignals.length * ROW_HEIGHT

  const timeToX = buildTimeToX({
    totalDurationPs: endTimePs,
    canvasWidthPx: waveformAreaWidth,
    originOffsetPx: LABEL_WIDTH,
  })

  // Height for the panel body: selector bar (32px) + waveform area
  const selectorBarHeight = 32

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
        <>
          {/* Signal selector bar */}
          {availableSignals.length > 0 && (
            <div
              className="flex items-center gap-1.5 px-3 border-b border-gray-100 bg-gray-50"
              style={{ height: selectorBarHeight, overflowX: 'auto', flexShrink: 0 }}
              aria-label="Signal selector"
            >
              <span className="text-xs text-gray-400 mr-1 whitespace-nowrap">Signals:</span>
              {availableSignals.map((name) => (
                <SignalChip
                  key={name}
                  name={name}
                  isSelected={selectedSignals.includes(name)}
                  onToggle={handleToggleSignal}
                />
              ))}
            </div>
          )}

          <div
            ref={containerRef}
            className="overflow-x-auto"
            style={{ height: PANEL_HEIGHT - 36 - (availableSignals.length > 0 ? selectorBarHeight : 0) }}
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

            {waveformData && visibleSignals.length === 0 && (
              <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
                {selectedSignals.length === 0
                  ? 'No signals selected. Use the selector above to add signals.'
                  : 'No matching signals found in waveform data.'}
              </div>
            )}

            {waveformData && visibleSignals.length > 0 && (
              <svg
                width={svgWidth}
                height={svgHeight}
                style={{ display: 'block', minWidth: svgWidth }}
              >
                {/* Background */}
                <rect x={0} y={0} width={svgWidth} height={svgHeight} fill="#ffffff" />

                {/* Step overlays — rendered behind signal paths */}
                <StepOverlays
                  steps={steps}
                  timeToX={timeToX}
                  svgHeight={svgHeight}
                  svgWidth={svgWidth}
                />

                {/* Signal rows */}
                {visibleSignals.map((signalName, rowIndex) => {
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
        </>
      )}
    </div>
  )
}
