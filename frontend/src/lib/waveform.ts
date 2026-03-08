/**
 * waveform.ts — Shared utilities for time-to-pixel mapping and waveform layout.
 *
 * This module is the single source of truth for the coordinate system that
 * bridges the React Flow canvas (node positions) and the WaveformPanel (SVG
 * signal traces).  Both consumers import `timeToX` so that nodes and waveform
 * regions are guaranteed to be drawn with identical scaling.
 *
 * Pre-simulation layout
 * ---------------------
 * Before a simulation run, nodes are arranged by `applyHorizontalLayout` in
 * App.tsx using fixed NODE_WIDTH / GAP constants.  No waveform data exists, so
 * `timeToX` is not needed.
 *
 * Post-simulation layout (US-010)
 * --------------------------------
 * After a run, each step result contains `time_range_ps: [start_ps, end_ps]`.
 * `timeToX` maps picosecond timestamps to canvas x-coordinates using linear
 * scaling derived from the total simulation duration and the available canvas
 * width.
 *
 * Viewport synchronisation (US-011)
 * -----------------------------------
 * WaveformPanel applies the same React Flow viewport transform (zoom + pan) to
 * its SVG so that horizontal scroll and zoom stay perfectly aligned.
 */

// ── Default pre-simulation layout constants (shared with App.tsx) ────────────
/** Width of each protocol step node in pixels. */
export const NODE_WIDTH = 160

/** Height of each node (estimated) for vertical gap calculation. */
export const NODE_HEIGHT = 80

/** Vertical gap between consecutive nodes in pixels. */
export const GAP = 40

/** Fixed x-coordinate for all nodes in the vertical pipeline layout. */
export const LAYOUT_X = 100

/**
 * Width of the waveform label column in pixels.  Exported so that the node
 * layout (App.tsx) can offset nodes by the same amount, ensuring that node
 * x-positions and waveform x-positions share the same coordinate origin.
 */
export const LABEL_WIDTH = 60

// ── Time-to-pixel conversion ─────────────────────────────────────────────────

/**
 * Parameters for the linear time-to-x mapping.
 *
 * @property totalDurationPs - Total simulation duration in picoseconds
 *   (equal to the `end_time` value from the VCD parser / `sim_time_total_ps`
 *   from the run response).
 * @property canvasWidthPx - Pixel width of the drawable canvas area (excluding
 *   any label column or scrollbar).
 * @property originOffsetPx - X pixel offset of the timeline origin (left edge
 *   of the first node).  Defaults to 0.
 */
export interface TimeScaleParams {
  totalDurationPs: number
  canvasWidthPx: number
  originOffsetPx?: number
}

/**
 * Build a `timeToX` function from the given scale parameters.
 *
 * The returned function converts a picosecond timestamp to an x-coordinate in
 * the canvas pixel space.  Both the node layout (US-010) and the WaveformPanel
 * SVG renderer (US-007) call `timeToX` so that their coordinate systems stay
 * in sync without additional synchronisation logic.
 *
 * @example
 * ```ts
 * const timeToX = buildTimeToX({ totalDurationPs: 1_000_000, canvasWidthPx: 1200 })
 * const xStart = timeToX(step.time_range_ps[0])
 * const xEnd   = timeToX(step.time_range_ps[1])
 * ```
 */
export function buildTimeToX(params: TimeScaleParams): (timePs: number) => number {
  const { totalDurationPs, canvasWidthPx, originOffsetPx = 0 } = params
  if (totalDurationPs <= 0) {
    // Degenerate case — all times map to the origin.
    return () => originOffsetPx
  }
  const scale = canvasWidthPx / totalDurationPs
  return (timePs: number) => originOffsetPx + timePs * scale
}

// ── Signal data types ─────────────────────────────────────────────────────────

/**
 * A single signal change event: [time_ps, value].
 * `value` is a string (e.g. "0", "1", "x", "z") matching the VCD parser output.
 */
export type SignalChange = [number, string]

/**
 * Per-signal data returned by the `GET /api/waveform/{id}/signals` endpoint.
 */
export interface SignalData {
  /** Bit width of the signal. */
  width: number
  /** Ordered list of change events: [time_ps, value]. */
  changes: SignalChange[]
}

/**
 * Full response from `GET /api/waveform/{id}/signals`.
 */
export interface WaveformSignals {
  /** Human-readable timescale string, e.g. "1ns". */
  timescale: string
  /** Simulation end time in picoseconds. */
  end_time: number
  /** Map from signal leaf name to its data. */
  signals: Record<string, SignalData>
}
