import type { Edge } from '@xyflow/react'

// ─── Node data shapes ────────────────────────────────────────────────────────

export interface SendByteData {
  data: string  // hex string e.g. "0xA0"
  [key: string]: unknown
}

export interface RecvByteData {
  ack: boolean
  [key: string]: unknown
}

// A minimal Node shape — we only need id, type, and data.
export interface FlowNode {
  id: string
  type?: string
  data: SendByteData | RecvByteData | Record<string, unknown>
}

// ─── Backend step payloads ────────────────────────────────────────────────────

export interface StartStep {
  op: 'start'
}

export interface StopStep {
  op: 'stop'
}

export interface RepeatedStartStep {
  op: 'repeated_start'
}

export interface SendByteStep {
  op: 'send_byte'
  data: string  // hex string e.g. "0xA0"
}

export interface RecvByteStep {
  op: 'recv_byte'
  ack: boolean
}

export type StepPayload =
  | StartStep
  | StopStep
  | RepeatedStartStep
  | SendByteStep
  | RecvByteStep

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
    case 'i2c_start':
      return { op: 'start' }

    case 'i2c_stop':
      return { op: 'stop' }

    case 'repeated_start':
      return { op: 'repeated_start' }

    case 'send_byte': {
      const d = data as SendByteData
      return { op: 'send_byte', data: formatHex(d.data ?? '') }
    }

    case 'recv_byte': {
      const d = data as RecvByteData
      return { op: 'recv_byte', ack: d.ack ?? false }
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
