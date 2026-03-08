import type { StepPayload } from './serialize'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000/api'

// ─── Response types ────────────────────────────────────────────────────────

export interface StepResult {
  op: string
  passed: boolean
  // read_bytes result fields
  data?: number[]
  match?: boolean
  // scan result fields
  found?: boolean
  [key: string]: unknown
}

export interface SimulationResult {
  passed: boolean
  steps: StepResult[]
  /** 256-element array of register values (indices 0–255) */
  register_dump: number[]
  waveform_id?: string
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

  return response.json() as Promise<SimulationResult>
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
