import { createContext, useContext } from 'react'

/**
 * Cross-highlighting state shared between the waveform panel and node components.
 * Hovering/clicking a step overlay highlights the corresponding canvas node and
 * vice versa.
 */
export interface HighlightContextValue {
  hoveredStepIndex: number | null
  selectedStepIndex: number | null
  setHoveredStepIndex: (index: number | null) => void
  setSelectedStepIndex: (index: number | null) => void
}

const HighlightContext = createContext<HighlightContextValue>({
  hoveredStepIndex: null,
  selectedStepIndex: null,
  setHoveredStepIndex: () => {},
  setSelectedStepIndex: () => {},
})

export function useHighlight(): HighlightContextValue {
  return useContext(HighlightContext)
}

export { HighlightContext }
