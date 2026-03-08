import { useHighlight } from './highlightContext'

/**
 * Returns mouse event handlers and highlight state for a canvas node.
 *
 * Nodes receive their `stepIndex` via `node.data.stepIndex` after a simulation
 * run.  This hook wires up hover/click cross-highlighting with the waveform
 * step overlays.
 *
 * @param stepIndex - The index of this node in result.steps (null if no sim run yet)
 */
export function useNodeHighlight(stepIndex: number | null | undefined) {
  const { hoveredStepIndex, selectedStepIndex, setHoveredStepIndex, setSelectedStepIndex } =
    useHighlight()

  const hasStep = stepIndex != null
  const isHovered = hasStep && hoveredStepIndex === stepIndex
  const isSelected = hasStep && selectedStepIndex === stepIndex

  function onMouseEnter() {
    if (hasStep) setHoveredStepIndex(stepIndex)
  }

  function onMouseLeave() {
    if (hasStep) setHoveredStepIndex(null)
  }

  function onClick() {
    if (!hasStep) return
    setSelectedStepIndex(selectedStepIndex === stepIndex ? null : stepIndex)
  }

  return { isHovered, isSelected, onMouseEnter, onMouseLeave, onClick }
}
