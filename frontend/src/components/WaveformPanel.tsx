import { useState, useEffect, useRef, useCallback } from 'react'
import { getWaveformSignals, getWaveformUrl } from '../lib/api'
import type { WaveformSignalsResponse } from '../lib/api'
import { buildTimeToX } from '../lib/waveform'

// ── Layout constants ──────────────────────────────────────────────────────────

/** Width of the label column (left side) in pixels. */
const LABEL_WIDTH = 60

/** Height of each signal row in pixels. */
const ROW_HEIGHT = 40

/** Vertical padding inside each row above/below the signal trace. */
const ROW_PADDING = 10

/** Default panel height in pixels when expanded. */
const DEFAULT_PANEL_HEIGHT = 200

/** Signals enabled by default. */
const DEFAULT_SIGNALS = ['sda', 'scl']

// ── SVG path builder ──────────────────────────────────────────────────────────

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
    if (value === '1' || value === 'z' || value === 'Z') return yHigh
    if (value === '0') return yLow
    return yMid // 'x' only
  }

  const parts: string[] = []
  let x = timeToX(changes[0][0])
  let y = valueToY(changes[0][1])
  parts.push(`M ${x} ${y}`)

  for (let i = 1; i < changes.length; i++) {
    const [nextTimePs, nextValue] = changes[i]
    const nextX = timeToX(nextTimePs)
    const nextY = valueToY(nextValue)
    parts.push(`H ${nextX}`)
    parts.push(`V ${nextY}`)
    x = nextX
    y = nextY
  }

  parts.push(`H ${timeToX(endTimePs)}`)
  return parts.join(' ')
}

// ── Signal row content (SVG, inside viewport transform) ─────────────────────

function SignalRowContent({ changes, endTimePs, timeToX, rowIndex, svgWidth }: {
  changes: [number, string][]
  endTimePs: number
  timeToX: (t: number) => number
  rowIndex: number
  svgWidth: number
}) {
  const rowTop = rowIndex * ROW_HEIGHT
  const pathD = buildSignalPath(changes, endTimePs, timeToX, rowTop)

  return (
    <g>
      <line
        x1={0}
        y1={rowTop + ROW_HEIGHT}
        x2={svgWidth}
        y2={rowTop + ROW_HEIGHT}
        stroke="#e5e7eb"
        strokeWidth={0.5}
      />
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

// ── Draggable signal label (HTML overlay) ───────────────────────────────────

interface SignalLabelRowProps {
  name: string
  rowIndex: number
  onRemove: (name: string) => void
  onDragStart: (index: number, e: React.MouseEvent) => void
  isDragTarget: boolean
  isDragging: boolean
  dragFrom: number | null
}

function SignalLabelRow({
  name, rowIndex, onRemove,
  onDragStart,
  isDragTarget, isDragging, dragFrom,
}: SignalLabelRowProps) {
  // Show a blue drop indicator line at top or bottom edge
  const showDropAbove = isDragTarget && dragFrom !== null && dragFrom > rowIndex
  const showDropBelow = isDragTarget && dragFrom !== null && dragFrom < rowIndex

  return (
    <div
      style={{
        height: ROW_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        borderBottom: '0.5px solid #e5e7eb',
        background: '#f9fafb',
        opacity: isDragging ? 0.3 : 1,
        boxShadow: showDropAbove
          ? 'inset 0 2px 0 0 #3b82f6'
          : showDropBelow
            ? 'inset 0 -2px 0 0 #3b82f6'
            : 'none',
        cursor: 'grab',
        userSelect: 'none',
        position: 'relative',
        transition: 'background 0.1s',
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        onDragStart(rowIndex, e)
      }}
    >
      {/* Drag grip */}
      <span
        style={{
          fontSize: 9,
          color: '#9ca3af',
          padding: '0 2px 0 3px',
          lineHeight: 1,
          letterSpacing: '1px',
        }}
      >
        ⠿
      </span>

      {/* Signal name */}
      <span
        style={{
          flex: 1,
          fontSize: 10,
          fontFamily: 'monospace',
          fontWeight: 600,
          color: '#374151',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name.toUpperCase()}
      </span>

      {/* Remove button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove(name)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 11,
          color: '#9ca3af',
          padding: '0 4px',
          lineHeight: 1,
        }}
        title={`Remove ${name.toUpperCase()}`}
      >
        ×
      </button>
    </div>
  )
}

// ── Searchable signal picker popup ──────────────────────────────────────────

interface SignalPickerProps {
  available: string[]
  selected: string[]
  onAdd: (name: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

function SignalPicker({ available, selected, onAdd, onClose, anchorRef }: SignalPickerProps) {
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)

  // Position the popup above the + button using fixed positioning
  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 })
    }
  }, [anchorRef])

  // Focus search input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        popupRef.current && !popupRef.current.contains(e.target as Node) &&
        anchorRef.current && !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose, anchorRef])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const unselected = available.filter((s) => !selected.includes(s))
  const query = search.toLowerCase().trim()
  const filtered = query
    ? unselected.filter((s) => s.toLowerCase().includes(query))
    : unselected

  if (!pos) return null

  return (
    <div
      ref={popupRef}
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        width: 220,
        maxHeight: 280,
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Search input */}
      <div style={{ padding: '8px 8px 4px' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search signals..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            padding: '5px 8px',
            fontSize: 12,
            border: '1px solid #d1d5db',
            borderRadius: 4,
            outline: 'none',
            fontFamily: 'monospace',
          }}
          onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
          onBlur={(e) => e.target.style.borderColor = '#d1d5db'}
        />
      </div>

      {/* Signal list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
            {query ? 'No matching signals' : 'All signals added'}
          </div>
        )}
        {filtered.map((name) => (
          <button
            key={name}
            onClick={() => {
              onAdd(name)
              setSearch('')
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '5px 12px',
              fontSize: 12,
              fontFamily: 'monospace',
              fontWeight: 500,
              color: '#374151',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#f3f4f6')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
          >
            <span style={{ color: '#9ca3af', fontSize: 14 }}>+</span>
            {name.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── WaveformPanel ─────────────────────────────────────────────────────────────

interface WaveformPanelProps {
  waveformId: string | null
  panelHeight?: number
}

export function WaveformPanel({ waveformId, panelHeight = DEFAULT_PANEL_HEIGHT }: WaveformPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const [waveformData, setWaveformData] = useState<WaveformSignalsResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [availableSignals, setAvailableSignals] = useState<string[]>([])
  const [selectedSignals, setSelectedSignals] = useState<string[]>(DEFAULT_SIGNALS)

  // Signal picker popup state
  const [pickerOpen, setPickerOpen] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)


  // Independent pan/zoom state for waveform area
  const [wvZoom, setWvZoom] = useState(1)
  const [wvPanX, setWvPanX] = useState(0)
  const wvPanRef = useRef({ panX: 0 })
  const svgAreaRef = useRef<HTMLDivElement>(null)

  // Keep ref in sync with state
  useEffect(() => { wvPanRef.current.panX = wvPanX }, [wvPanX])

  // Reset pan/zoom when waveform data changes
  useEffect(() => {
    setWvZoom(1)
    setWvPanX(0)
  }, [waveformId])


  // Wheel zoom — horizontal only, centered on cursor
  const handleWheelZoom = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setWvZoom((prev) => {
      const next = Math.min(Math.max(prev * factor, 0.1), 50)
      // Adjust panX so the point under the cursor stays fixed
      const rect = svgAreaRef.current?.getBoundingClientRect()
      if (rect) {
        const cursorX = e.clientX - rect.left
        const currentPanX = wvPanRef.current.panX
        const pointInContent = (cursorX - currentPanX) / prev
        const newPanX = cursorX - pointInContent * next
        setWvPanX(newPanX)
      }
      return next
    })
  }, [])

  // Drag-to-pan on the SVG area — attach listeners directly in mousedown
  // so they are guaranteed to be active regardless of React render timing.
  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startPanX = wvPanRef.current.panX

    document.body.style.cursor = 'grabbing'

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX
      const newPanX = startPanX + dx
      wvPanRef.current.panX = newPanX
      setWvPanX(newPanX)
    }
    function onUp() {
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // Drag reorder state
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [dragMouseY, setDragMouseY] = useState(0)
  const [dragMouseX, setDragMouseX] = useState(0)
  const labelColumnRef = useRef<HTMLDivElement>(null)

  // Measure the actual SVG area width (the flex:1 div right of the label column).
  // Re-attach observer when waveformData becomes available (svgAreaRef mounts).
  const [svgAreaWidth, setSvgAreaWidth] = useState(800)
  useEffect(() => {
    const el = svgAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSvgAreaWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    setSvgAreaWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [waveformData, isExpanded])

  // Fetch signal data
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
        const data = await getWaveformSignals(waveformId!)
        if (!cancelled) {
          setWaveformData(data)
          const allNames = Object.keys(data.signals)
          setAvailableSignals(allNames)
          setSelectedSignals((prev) => {
            const defaultEnabled = DEFAULT_SIGNALS.filter((s) => allNames.includes(s))
            const extras = prev.filter(
              (s) => !defaultEnabled.includes(s) && allNames.includes(s),
            )
            return [...defaultEnabled, ...extras]
          })
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load waveform signals')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void fetchSignals()
    return () => { cancelled = true }
  }, [waveformId])

  const handleRemoveSignal = useCallback((name: string) => {
    setSelectedSignals((prev) => prev.filter((s) => s !== name))
  }, [])

  const handleAddSignal = useCallback((name: string) => {
    setSelectedSignals((prev) => prev.includes(name) ? prev : [...prev, name])
  }, [])

  // Drag reorder handlers — store latest values in refs for stable callbacks
  const dragFromRef = useRef<number | null>(null)
  const dragOverRef = useRef<number | null>(null)

  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    setDragFrom(index)
    setDragOver(index)
    setDragMouseY(e.clientY)
    setDragMouseX(e.clientX)
    dragFromRef.current = index
    dragOverRef.current = index
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  const commitDrag = useCallback(() => {
    const from = dragFromRef.current
    const over = dragOverRef.current
    if (from !== null && over !== null && from !== over) {
      setSelectedSignals((prev) => {
        const result = [...prev]
        const [moved] = result.splice(from, 1)
        result.splice(over, 0, moved)
        return result
      })
    }
    dragFromRef.current = null
    dragOverRef.current = null
    setDragFrom(null)
    setDragOver(null)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  // Global mousemove + mouseup during drag
  useEffect(() => {
    if (dragFrom === null) return

    function onMove(e: MouseEvent) {
      setDragMouseY(e.clientY)
      setDragMouseX(e.clientX)
      // Calculate which row the mouse is over
      const col = labelColumnRef.current
      if (!col) return
      const rect = col.getBoundingClientRect()
      const relY = e.clientY - rect.top + col.scrollTop
      const targetIdx = Math.max(0, Math.min(
        Math.floor(relY / ROW_HEIGHT),
        ((col.children[0] as HTMLElement)?.childElementCount ?? 1) - 1,
      ))
      setDragOver(targetIdx)
      dragOverRef.current = targetIdx
    }

    function onUp() { commitDrag() }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragFrom, commitDrag])

  if (!waveformId) return null

  const visibleSignals = waveformData
    ? selectedSignals.filter((s) => s in waveformData.signals)
    : []

  const endTimePs = waveformData?.end_time ?? 0
  const svgWidth = svgAreaWidth
  const svgHeight = Math.max(visibleSignals.length * ROW_HEIGHT, ROW_HEIGHT)

  const timeToX = buildTimeToX({
    totalDurationPs: endTimePs,
    canvasWidthPx: svgAreaWidth,
    originOffsetPx: 0,
  })

  const bodyHeight = panelHeight - 36 // subtract header height

  return (
    <div
      className="border-t border-gray-200 bg-white flex-shrink-0"
      style={{ minHeight: isExpanded ? panelHeight : undefined }}
    >
      {/* Toggle bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            Waveform Viewer
          </span>
          {waveformId && (
            <a
              href={`/surfer/index.html?load_url=${encodeURIComponent(getWaveformUrl(waveformId))}#dev`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:text-blue-700 hover:underline transition-colors"
              title="Open VCD in Surfer waveform viewer (new tab)"
            >
              (open in Surfer)
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isLoading && (
            <span className="text-xs text-gray-400 italic">Loading...</span>
          )}
          {error && (
            <span className="text-xs text-red-500 max-w-xs truncate" title={error}>
              {error}
            </span>
          )}
          {waveformData && wvZoom !== 1 && (
            <button
              onClick={() => { setWvZoom(1); setWvPanX(0) }}
              className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
              title="Reset zoom"
            >
              {Math.round(wvZoom * 100)}% — Reset
            </button>
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
          style={{ height: bodyHeight, position: 'relative', overflow: 'hidden' }}
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

          {waveformData && visibleSignals.length === 0 && !pickerOpen && (
            <div className="flex items-center justify-center h-full text-sm text-gray-400 italic">
              <span>No signals selected.</span>
              <button
                onClick={() => setPickerOpen(true)}
                className="ml-2 text-blue-500 hover:text-blue-700 font-medium"
              >
                Add signals
              </button>
            </div>
          )}

          {waveformData && (visibleSignals.length > 0 || pickerOpen) && (() => {
            return (
              <div style={{ display: 'flex', height: '100%' }}>
                {/* HTML label column + add button */}
                <div
                  ref={labelColumnRef}
                  style={{
                    width: LABEL_WIDTH,
                    minWidth: LABEL_WIDTH,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    borderRight: '0.5px solid #e5e7eb',
                    background: '#f9fafb',
                    zIndex: 5,
                    overflow: 'hidden',
                  }}
                >
                  {/* Draggable signal labels */}
                  <div style={{ flex: 1, overflowY: 'auto' }}>
                    {visibleSignals.map((name, i) => (
                      <SignalLabelRow
                        key={name}
                        name={name}
                        rowIndex={i}
                        onRemove={handleRemoveSignal}
                        onDragStart={handleDragStart}
                        isDragTarget={dragFrom !== null && dragOver === i && dragFrom !== i}
                        isDragging={dragFrom === i}
                        dragFrom={dragFrom}
                      />
                    ))}
                  </div>

                  {/* Add signal button */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <button
                      ref={addBtnRef}
                      onClick={() => setPickerOpen((v) => !v)}
                      title="Add signal"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: 28,
                        border: 'none',
                        borderTop: '1px solid #e5e7eb',
                        background: pickerOpen ? '#eff6ff' : '#f9fafb',
                        cursor: 'pointer',
                        fontSize: 16,
                        color: pickerOpen ? '#3b82f6' : '#9ca3af',
                        transition: 'background 0.15s, color 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!pickerOpen) {
                          e.currentTarget.style.background = '#f3f4f6'
                          e.currentTarget.style.color = '#6b7280'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!pickerOpen) {
                          e.currentTarget.style.background = '#f9fafb'
                          e.currentTarget.style.color = '#9ca3af'
                        }
                      }}
                    >
                      +
                    </button>

                    {/* Searchable signal picker popup */}
                    {pickerOpen && (
                      <SignalPicker
                        available={availableSignals}
                        selected={selectedSignals}
                        onAdd={handleAddSignal}
                        onClose={() => setPickerOpen(false)}
                        anchorRef={addBtnRef}
                      />
                    )}
                  </div>
                </div>

                {/* Floating ghost during drag */}
                {dragFrom !== null && visibleSignals[dragFrom] && (
                  <div
                    style={{
                      position: 'fixed',
                      left: dragMouseX - 20,
                      top: dragMouseY - ROW_HEIGHT / 2,
                      width: LABEL_WIDTH,
                      height: ROW_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '0 6px',
                      background: 'rgba(255,255,255,0.92)',
                      border: '1px solid #93c5fd',
                      borderRadius: 6,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                      fontSize: 10,
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      color: '#374151',
                      pointerEvents: 'none',
                      zIndex: 1000,
                      transform: 'rotate(-1deg)',
                      transition: 'none',
                    }}
                  >
                    <span style={{ fontSize: 9, color: '#9ca3af' }}>⠿</span>
                    {visibleSignals[dragFrom].toUpperCase()}
                  </div>
                )}

                {/* SVG waveform area — independent pan/zoom */}
                <div
                  ref={svgAreaRef}
                  style={{ flex: 1, overflow: 'hidden', cursor: 'grab' }}
                  onWheel={handleWheelZoom}
                  onMouseDown={handlePanStart}
                >
                  <svg
                    width={svgWidth}
                    height={svgHeight}
                    style={{ display: 'block', minWidth: svgWidth }}
                  >
                    <defs>
                      <clipPath id="waveform-area-clip">
                        <rect x={0} y={0} width={svgWidth} height={svgHeight} />
                      </clipPath>
                    </defs>

                    <rect x={0} y={0} width={svgWidth} height={svgHeight} fill="#ffffff" />

                    <g transform={`translate(${wvPanX}, 0) scale(${wvZoom}, 1)`} clipPath="url(#waveform-area-clip)">
                      {visibleSignals.map((signalName, rowIndex) => {
                        const sigData = waveformData.signals[signalName]
                        return (
                          <SignalRowContent
                            key={signalName}
                            changes={sigData.changes}
                            endTimePs={endTimePs}
                            timeToX={timeToX}
                            rowIndex={rowIndex}
                            svgWidth={svgWidth}
                          />
                        )
                      })}
                      {/* Start / end marker lines */}
                      <line x1={timeToX(0)} y1={0} x2={timeToX(0)} y2={svgHeight} stroke="red" strokeWidth={1} />
                      <line x1={timeToX(endTimePs)} y1={0} x2={timeToX(endTimePs)} y2={svgHeight} stroke="red" strokeWidth={1} />
                    </g>

                  </svg>
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
