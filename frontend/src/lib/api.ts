import type { StepPayload } from './serialize'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'

// ─── Response types ────────────────────────────────────────────────────────

export interface StepResult {
  op: string
  /** Derived from backend `status` field: true when status === 'ok'. */
  passed: boolean
  status?: string
  /** Byte value sent/received (hex string, e.g. "0xA0") */
  data?: string | number[]
  /** ACK status — for send_byte: slave ACK'd; for recv_byte: master sent ACK */
  ack?: boolean
  /** Decoded address (hex string) — only on address byte (first send_byte after start) */
  addr?: string
  /** Read/write direction — only on address byte */
  rw?: string
  /** Error message when status is "error" */
  message?: string
  /**
   * Simulation time range for this step in picoseconds: [start_ps, end_ps].
   * Present when the step was executed under cocotb with timing capture enabled.
   */
  time_range_ps?: [number, number]
  [key: string]: unknown
}

export interface SimulationResult {
  passed: boolean
  steps: StepResult[]
  /** Slave EEPROM snapshot: address (as string key) → byte value */
  register_dump: Record<string, number>
  /** Current slave register pointer (0–255) */
  reg_pointer: number
  waveform_id?: string
  /**
   * Total simulation time in picoseconds at the end of the run.
   * Present when timing capture was active during the simulation.
   */
  sim_time_total_ps?: number
}

export interface TemplateItem {
  id: string
  name: string
  description?: string
  step_count?: number
  [key: string]: unknown
}

export interface TemplateDetail extends TemplateItem {
  steps: StepPayload[]
}

// ─── Error helper ──────────────────────────────────────────────────────────

/**
 * Extract a human-readable error message from a failed fetch response.
 * FastAPI returns `{ "detail": "..." }` for 4xx/5xx errors.
 */
async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (typeof body?.detail === 'string') return body.detail
    if (typeof body?.detail === 'object') return JSON.stringify(body.detail)
    return response.statusText || `HTTP ${response.status}`
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

// ─── API functions ─────────────────────────────────────────────────────────

/**
 * POST /api/run — execute a simulation for the given step list.
 * Throws an Error with a descriptive message on 422 / 500 / 503.
 */
export async function runSimulation(steps: StepPayload[]): Promise<SimulationResult> {
  const response = await fetch(`${API_BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  })

  if (!response.ok) {
    const message = await extractErrorMessage(response)
    throw new Error(message)
  }

  const data = await response.json() as SimulationResult
  // Normalize: backend sends `status: "ok"|"fail"` per step, but the frontend
  // interface uses `passed: boolean`.  Derive `passed` from `status` when missing.
  if (data.steps) {
    for (const step of data.steps) {
      if (step.passed === undefined && step.status !== undefined) {
        step.passed = step.status === 'ok'
      }
    }
  }
  return data
}

/**
 * GET /api/templates — fetch all available test templates.
 */
export async function fetchTemplates(): Promise<TemplateItem[]> {
  const response = await fetch(`${API_BASE}/templates`)

  if (!response.ok) {
    const message = await extractErrorMessage(response)
    throw new Error(message)
  }

  return response.json() as Promise<TemplateItem[]>
}

/**
 * GET /api/templates/{id} — fetch the full detail of one template, including its steps array.
 */
export async function getTemplate(id: string): Promise<TemplateDetail> {
  const response = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`)

  if (!response.ok) {
    const message = await extractErrorMessage(response)
    throw new Error(message)
  }

  return response.json() as Promise<TemplateDetail>
}

/**
 * Returns the URL to download a waveform VCD file by its id.
 * The caller is responsible for initiating the download (e.g. via an <a> tag).
 */
export function getWaveformUrl(id: string): string {
  return `${API_BASE}/waveform/${encodeURIComponent(id)}`
}

// ─── Waveform signals types (mirrors backend WaveformSignals schema) ────────

export interface SignalData {
  width: number
  changes: [number, string][]
}

export interface WaveformSignalsResponse {
  timescale: string
  end_time: number
  signals: Record<string, SignalData>
}

/**
 * GET /api/waveform/{id}/signals — fetch parsed VCD signal data for rendering.
 *
 * @param waveformId - UUID returned in the simulation run response.
 * @param signals    - Optional comma-separated signal leaf names to filter.
 *                     When omitted, all available signals are returned.
 *
 * Throws an Error on 404 (waveform not found) or 400 (unknown signal name).
 */
export async function getWaveformSignals(
  waveformId: string,
  signals?: string[],
): Promise<WaveformSignalsResponse> {
  const url = new URL(`${API_BASE}/waveform/${encodeURIComponent(waveformId)}/signals`)
  if (signals && signals.length > 0) {
    url.searchParams.set('signals', signals.join(','))
  }

  const response = await fetch(url.toString())

  if (!response.ok) {
    const message = await extractErrorMessage(response)
    throw new Error(message)
  }

  return response.json() as Promise<WaveformSignalsResponse>
}
