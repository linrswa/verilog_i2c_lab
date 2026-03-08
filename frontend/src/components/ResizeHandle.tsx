import { useState, useCallback, useRef, useEffect } from 'react'

interface ResizeHandleProps {
  /** Direction of resize: 'horizontal' drags left/right, 'vertical' drags up/down. */
  direction: 'horizontal' | 'vertical'
  /** Called continuously during drag with the delta in pixels from the start. */
  onResize: (delta: number) => void
  /** Called when drag ends. */
  onResizeEnd?: () => void
}

/**
 * A draggable handle for resizing adjacent panels.
 * Place between two flex children to allow the user to drag-resize them.
 */
export function ResizeHandle({ direction, onResize, onResizeEnd }: ResizeHandleProps) {
  const startPos = useRef(0)
  const isDragging = useRef(false)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Store callbacks in refs to avoid re-registering listeners
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  const onResizeEndRef = useRef(onResizeEnd)
  onResizeEndRef.current = onResizeEnd

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      setDragging(true)
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [direction],
  )

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      if (!isDragging.current) return
      const current = direction === 'horizontal' ? e.clientX : e.clientY
      onResizeRef.current(current - startPos.current)
    }

    function handleMouseUp() {
      if (!isDragging.current) return
      isDragging.current = false
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeEndRef.current?.()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [direction])

  const isHorizontal = direction === 'horizontal'
  const active = hovered || dragging

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        [isHorizontal ? 'width' : 'height']: '6px',
        [isHorizontal ? 'minWidth' : 'minHeight']: '6px',
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
        zIndex: 10,
      }}
    >
      {/* Visible indicator — becomes blue on hover/drag */}
      <div
        style={{
          position: 'absolute',
          [isHorizontal ? 'left' : 'top']: '1px',
          [isHorizontal ? 'width' : 'height']: active ? '4px' : '2px',
          [isHorizontal ? 'top' : 'left']: '0',
          [isHorizontal ? 'bottom' : 'right']: '0',
          borderRadius: '2px',
          background: active ? '#3b82f6' : '#d1d5db',
          transition: 'background 0.15s, width 0.15s, height 0.15s',
        }}
      />
    </div>
  )
}
