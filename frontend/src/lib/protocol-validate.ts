/**
 * Protocol sequence validation for I2C flow canvas.
 *
 * Walks the serialized chain and checks structural validity:
 * 1. Every i2c_start has a matching i2c_stop reachable in the chain (or ends).
 * 2. send_byte / recv_byte must be between an i2c_start and i2c_stop.
 * 3. After i2c_start (or repeated_start), the first send_byte is the address byte —
 *    decode and show R/W direction as helper text.
 * 4. recv_byte is only valid in read mode (address byte LSB=1).
 * 5. send_byte (after the address byte) is only valid in write mode (address byte LSB=0).
 *
 * Results are stored in node.data.warning (string) or node.data.addrHelper (string).
 * Cleared to undefined when there is no issue.
 */

import type { Edge } from '@xyflow/react'
import type { FlowNode } from './serialize'

// ─── Internal chain helpers (mirrors serialize.ts) ───────────────────────────

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

function dfsChain(startId: string, adj: Map<string, string[]>): string[] {
  const visited = new Set<string>()
  const order: string[] = []
  function dfs(id: string): void {
    if (visited.has(id)) return
    visited.add(id)
    order.push(id)
    for (const neighbour of adj.get(id) ?? []) dfs(neighbour)
  }
  dfs(startId)
  return order
}

function findRoots(nodeIds: Set<string>, edges: Edge[]): string[] {
  const hasIncoming = new Set<string>()
  for (const edge of edges) {
    if (nodeIds.has(edge.target)) hasIncoming.add(edge.target)
  }
  return [...nodeIds].filter((id) => !hasIncoming.has(id))
}

/** Return the longest connected chain of node IDs in order. */
function longestChain(nodes: FlowNode[], edges: Edge[]): string[] {
  if (nodes.length === 0) return []
  const nodeIds = new Set(nodes.map((n) => n.id))
  const adj = buildAdjacency(nodeIds, edges)
  const roots = findRoots(nodeIds, edges)
  if (roots.length === 0) return []

  let best: string[] = []
  for (const root of roots) {
    const chain = dfsChain(root, adj)
    if (chain.length > best.length) best = chain
  }
  return best
}

// ─── Address byte decoding ────────────────────────────────────────────────────

/**
 * Parse an 8-bit address byte from a hex string.
 * Returns null if the string cannot be parsed as a valid byte.
 */
function parseAddressByte(hexStr: string): number | null {
  const trimmed = (hexStr ?? '').trim()
  if (trimmed === '') return null
  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed) || parsed < 0x00 || parsed > 0xff) return null
  return parsed
}

/**
 * Decode an 8-bit I2C address byte into a human-readable helper string.
 * Returns e.g. "Addr: 0x50 W" or "Addr: 0x50 R".
 */
function decodeAddressByte(byte: number): string {
  const addr = byte >> 1
  const rw = (byte & 0x01) === 0 ? 'W' : 'R'
  const addrHex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`
  return `Addr: ${addrHex} ${rw}`
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ProtocolWarnings {
  /** Map from node ID → warning string (or undefined = no warning) */
  warnings: Map<string, string | undefined>
  /** Map from node ID → address helper text (for the first send_byte after start) */
  addrHelpers: Map<string, string | undefined>
}

/**
 * Walk the longest chain and compute protocol-level warnings for each node.
 *
 * Returns two maps:
 *   warnings    — node ID → warning message (or undefined)
 *   addrHelpers — node ID → decoded address helper text (or undefined)
 *
 * The caller is responsible for writing these into node.data.warning and
 * node.data.addrHelper respectively.
 */
export function validateProtocolFlow(
  nodes: FlowNode[],
  edges: Edge[],
): ProtocolWarnings {
  const warnings = new Map<string, string | undefined>()
  const addrHelpers = new Map<string, string | undefined>()

  // Initialise all nodes to no warning / no helper
  for (const node of nodes) {
    warnings.set(node.id, undefined)
    addrHelpers.set(node.id, undefined)
  }

  const chain = longestChain(nodes, edges)
  if (chain.length === 0) return { warnings, addrHelpers }

  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  // ── First pass: collect positions of i2c_start / i2c_stop to check pairing ──
  //
  // We track open "segments" — a segment begins at i2c_start (or repeated_start)
  // and ends at the next i2c_stop.  Any send_byte / recv_byte outside a segment
  // gets a warning.  An i2c_start that never reaches an i2c_stop gets a warning.

  // State machine:
  //   inSegment           — true after seeing i2c_start / repeated_start until i2c_stop
  //   currentStartId      — the ID of the currently open start node
  //   addressByteResolved — true once the first send_byte after start has been processed
  //   isReadMode          — derived from the first send_byte (address byte) LSB

  let inSegment = false
  let currentStartId: string | null = null
  let addressByteResolved = false
  let isReadMode: boolean | null = null

  for (const id of chain) {
    const node = nodeById.get(id)
    if (!node) continue
    const type = node.type ?? ''

    switch (type) {
      case 'i2c_start': {
        // If we were already in a segment, the previous start had no stop
        if (inSegment && currentStartId !== null) {
          warnings.set(currentStartId, 'Start has no matching Stop in chain')
        }
        inSegment = true
        currentStartId = id
        addressByteResolved = false
        isReadMode = null
        break
      }

      case 'repeated_start': {
        // Repeated start acts like a new start — also closes the previous segment
        // Note: repeated_start is valid inside a segment (it replaces a stop+start)
        if (!inSegment) {
          warnings.set(id, 'Repeated Start must follow a Start condition')
        }
        // Do NOT warn about unclosed segment here — repeated_start intentionally omits stop
        inSegment = true
        currentStartId = id
        addressByteResolved = false
        isReadMode = null
        break
      }

      case 'i2c_stop': {
        if (!inSegment) {
          warnings.set(id, 'Stop without a preceding Start in chain')
        } else {
          // Close the segment cleanly — no warning
          inSegment = false
          currentStartId = null
          isReadMode = null
          addressByteResolved = false
        }
        break
      }

      case 'send_byte': {
        if (!inSegment) {
          warnings.set(id, 'Send Byte must be between Start and Stop')
          break
        }

        const d = node.data as { data?: string }
        const byteStr = d.data ?? ''

        if (!addressByteResolved) {
          // This is the first send_byte after start — treat as address byte
          const addrByte = parseAddressByte(byteStr)
          if (addrByte !== null) {
            isReadMode = (addrByte & 0x01) === 1
            addrHelpers.set(id, decodeAddressByte(addrByte))
          }
          addressByteResolved = true
        } else {
          // Subsequent send_byte after address — only valid in write mode
          if (isReadMode === true) {
            warnings.set(id, 'Send Byte used in read mode (address LSB=1)')
          }
          // Show decoded helper for all subsequent send_bytes too (harmless)
          const addrByte = parseAddressByte(byteStr)
          if (addrByte !== null) {
            addrHelpers.set(id, decodeAddressByte(addrByte))
          }
        }
        break
      }

      case 'recv_byte': {
        if (!inSegment) {
          warnings.set(id, 'Recv Byte must be between Start and Stop')
          break
        }
        if (!addressByteResolved) {
          // recv_byte as the first byte after start (no address byte sent first)
          warnings.set(id, 'Recv Byte without a preceding address Send Byte')
          break
        }
        if (isReadMode === false) {
          warnings.set(id, 'Recv Byte used in write mode (address LSB=0)')
        }
        break
      }

      // Non-protocol nodes are silently ignored (reset, write, read, scan, delay)
    }
  }

  // If we reach end of chain and a segment is still open, warn the start
  if (inSegment && currentStartId !== null) {
    // Only warn if the last node isn't a repeated_start (repeated_start intentionally omits stop)
    const lastId = chain[chain.length - 1]
    const lastNode = nodeById.get(lastId)
    if (lastNode?.type !== 'repeated_start') {
      warnings.set(currentStartId, 'Start has no matching Stop in chain')
    }
  }

  return { warnings, addrHelpers }
}
