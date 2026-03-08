import type { Edge } from '@xyflow/react'

// ─── Node data shapes (mirrors the component interfaces) ─────────────────────

interface ResetData {
  [key: string]: unknown
}

interface WriteData {
  address: string
  register: string
  data: string
  [key: string]: unknown
}

interface ReadData {
  address: string
  register: string
  n: string
  expect: string
  [key: string]: unknown
}

interface ScanData {
  address: string
  expect: string
  [key: string]: unknown
}

interface DelayData {
  cycles: string
  [key: string]: unknown
}

// A minimal Node shape — we only need id, type, and data.
export interface FlowNode {
  id: string
  type?: string
  data: ResetData | WriteData | ReadData | ScanData | DelayData
}

// ─── Backend step payloads ────────────────────────────────────────────────────

export interface ResetStep {
  op: 'reset'
}

export interface WriteStep {
  op: 'write_bytes'
  addr: string
  reg: string
  data: string[]
}

export interface ReadStep {
  op: 'read_bytes'
  addr: string
  reg: string
  n: number
  expect?: string[]
}

export interface ScanStep {
  op: 'scan'
  addr: string
  expect?: boolean
}

export interface DelayStep {
  op: 'delay'
  cycles: number
}

export type StepPayload = ResetStep | WriteStep | ReadStep | ScanStep | DelayStep

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise a user-entered hex string to the canonical '0x' + uppercase form.
 * Accepts inputs like "50", "0x50", "0X50" — always returns e.g. "0x50".
 * Returns the original value unchanged if it cannot be parsed as a hex integer.
 */
function formatHex(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return trimmed
  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed)) return trimmed
  return '0x' + parsed.toString(16).toUpperCase()
}

/**
 * Split a comma-separated hex string into an array of formatted hex strings.
 * Empty tokens (e.g. trailing comma) are filtered out.
 */
function parseHexList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(formatHex)
}

// ─── Topological sort & chain selection ──────────────────────────────────────

/**
 * Build a map from nodeId → list of successor nodeIds using the edge list.
 */
function buildAdjacency(nodeIds: Set<string>, edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) adj.set(id, [])
  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adj.get(edge.source)!.push(edge.target)
    }
  }
  return adj
}

/**
 * Collect all node ids reachable from `startId` via a DFS over `adj`.
 * Returns them in DFS visit order (i.e. topological order for a DAG / linear chain).
 */
function dfsChain(startId: string, adj: Map<string, string[]>): string[] {
  const visited = new Set<string>()
  const order: string[] = []

  function dfs(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    order.push(id)
    for (const neighbour of (adj.get(id) ?? [])) {
      dfs(neighbour)
    }
  }

  dfs(startId)
  return order
}

/**
 * Find root nodes — nodes with no incoming edges within the provided set.
 */
function findRoots(nodeIds: Set<string>, edges: Edge[]): string[] {
  const hasIncoming = new Set<string>()
  for (const edge of edges) {
    if (nodeIds.has(edge.target)) hasIncoming.add(edge.target)
  }
  return [...nodeIds].filter((id) => !hasIncoming.has(id))
}

// ─── Node-to-step mapping ─────────────────────────────────────────────────────

function mapNodeToStep(node: FlowNode): StepPayload | null {
  const { type, data } = node

  switch (type) {
    case 'reset':
      return { op: 'reset' }

    case 'write': {
      const d = data as WriteData
      const step: WriteStep = {
        op: 'write_bytes',
        addr: formatHex(d.address ?? ''),
        reg: formatHex(d.register ?? ''),
        data: parseHexList(d.data ?? ''),
      }
      return step
    }

    case 'read': {
      const d = data as ReadData
      const step: ReadStep = {
        op: 'read_bytes',
        addr: formatHex(d.address ?? ''),
        reg: formatHex(d.register ?? ''),
        n: parseInt(d.n ?? '1', 10) || 1,
      }
      const expectList = parseHexList(d.expect ?? '')
      if (expectList.length > 0) step.expect = expectList
      return step
    }

    case 'scan': {
      const d = data as ScanData
      const step: ScanStep = {
        op: 'scan',
        addr: formatHex(d.address ?? ''),
      }
      const expectRaw = (d.expect ?? '').trim()
      if (expectRaw === 'true') step.expect = true
      else if (expectRaw === 'false') step.expect = false
      return step
    }

    case 'delay': {
      const d = data as DelayData
      return {
        op: 'delay',
        cycles: parseInt(d.cycles ?? '100', 10) || 100,
      }
    }

    default:
      return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Internal helper: resolve the longest connected chain and return the ordered
 * node IDs alongside the serialized step payloads.  Both arrays are parallel —
 * orderedNodeIds[i] is the node that produced steps[i].
 */
function serializeFlowInternal(
  nodes: FlowNode[],
  edges: Edge[],
): { orderedNodeIds: string[]; steps: StepPayload[] } {
  if (nodes.length === 0) return { orderedNodeIds: [], steps: [] }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const adj = buildAdjacency(nodeIds, edges)
  const roots = findRoots(nodeIds, edges)

  if (roots.length === 0) {
    return { orderedNodeIds: [], steps: [] }
  }

  let longestChain: string[] = []
  for (const rootId of roots) {
    const chain = dfsChain(rootId, adj)
    if (chain.length > longestChain.length) {
      longestChain = chain
    }
  }

  const orderedNodeIds: string[] = []
  const steps: StepPayload[] = []
  for (const id of longestChain) {
    const node = nodeById.get(id)
    if (!node) continue
    const step = mapNodeToStep(node)
    if (step !== null) {
      orderedNodeIds.push(id)
      steps.push(step)
    }
  }

  return { orderedNodeIds, steps }
}

/**
 * Convert a React Flow graph into an ordered array of backend step objects.
 *
 * Algorithm:
 * 1. Build an adjacency list from edges.
 * 2. Find all root nodes (no incoming edges).
 * 3. For each root, walk the chain via DFS and record its length.
 * 4. Keep only the longest chain; if tied, keep the first one found.
 * 5. Map each node in the chain to its corresponding step payload.
 *
 * Disconnected nodes (not part of any chain reachable from a root, or nodes
 * that form isolated islands) are excluded from the output.
 */
export function serializeFlow(nodes: FlowNode[], edges: Edge[]): StepPayload[] {
  return serializeFlowInternal(nodes, edges).steps
}

/**
 * Same as serializeFlow but also returns the ordered node IDs that correspond
 * to each step (parallel arrays: orderedNodeIds[i] → steps[i]).
 *
 * Used by the UI to map simulation step results back to canvas node IDs.
 */
export function serializeFlowWithOrder(
  nodes: FlowNode[],
  edges: Edge[],
): { orderedNodeIds: string[]; steps: StepPayload[] } {
  return serializeFlowInternal(nodes, edges)
}
