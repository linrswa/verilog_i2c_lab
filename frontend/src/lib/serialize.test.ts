import { describe, it, expect } from 'vitest'
import { serializeFlow, serializeFlowWithOrder } from './serialize'
import type { FlowNode, StepPayload } from './serialize'
import type { Edge } from '@xyflow/react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startNode(id: string): FlowNode {
  return { id, type: 'i2c_start', data: {} }
}

function stopNode(id: string): FlowNode {
  return { id, type: 'i2c_stop', data: {} }
}

function repeatedStartNode(id: string): FlowNode {
  return { id, type: 'repeated_start', data: {} }
}

function sendByteNode(id: string, data = '0xA0'): FlowNode {
  return { id, type: 'send_byte', data: { data } }
}

function recvByteNode(id: string, ack = true): FlowNode {
  return { id, type: 'recv_byte', data: { ack } }
}

function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('serializeFlow', () => {
  // ── Empty canvas ──────────────────────────────────────────────────────────

  it('returns an empty array for an empty canvas', () => {
    expect(serializeFlow([], [])).toEqual([])
  })

  // ── Single nodes ──────────────────────────────────────────────────────────

  it('serializes a single i2c_start node', () => {
    const result = serializeFlow([startNode('s1')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'start' }])
  })

  it('serializes a single i2c_stop node', () => {
    const result = serializeFlow([stopNode('s1')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'stop' }])
  })

  it('serializes a single repeated_start node', () => {
    const result = serializeFlow([repeatedStartNode('rs1')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'repeated_start' }])
  })

  it('serializes a send_byte node with hex data', () => {
    const result = serializeFlow([sendByteNode('sb1', '0xa0')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'send_byte', data: '0xA0' }])
  })

  it('serializes a send_byte node formatting bare hex without prefix', () => {
    const result = serializeFlow([sendByteNode('sb1', 'ff')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'send_byte', data: '0xFF' }])
  })

  it('serializes a recv_byte node with ack=true', () => {
    const result = serializeFlow([recvByteNode('rb1', true)], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'recv_byte', ack: true }])
  })

  it('serializes a recv_byte node with ack=false', () => {
    const result = serializeFlow([recvByteNode('rb1', false)], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'recv_byte', ack: false }])
  })

  // ── Protocol chains ───────────────────────────────────────────────────────

  it('serializes a protocol chain: start → send_byte → recv_byte → stop', () => {
    const nodes: FlowNode[] = [
      startNode('n1'),
      sendByteNode('n2', '0x50'),
      recvByteNode('n3', true),
      stopNode('n4'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n3', 'n4'),
    ]
    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ op: 'start' })
    expect(result[1]).toEqual({ op: 'send_byte', data: '0x50' })
    expect(result[2]).toEqual({ op: 'recv_byte', ack: true })
    expect(result[3]).toEqual({ op: 'stop' })
  })

  it('serializes a chain with repeated_start: start → send_byte → repeated_start → recv_byte → stop', () => {
    const nodes: FlowNode[] = [
      startNode('n1'),
      sendByteNode('n2', '0xA0'),
      repeatedStartNode('n3'),
      recvByteNode('n4', false),
      stopNode('n5'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n3', 'n4'),
      edge('n4', 'n5'),
    ]
    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(5)
    const ops = result.map((s) => s.op)
    expect(ops).toEqual(['start', 'send_byte', 'repeated_start', 'recv_byte', 'stop'])
  })

  it('handles an empty protocol section (start immediately followed by stop)', () => {
    const nodes: FlowNode[] = [
      startNode('n1'),
      stopNode('n2'),
    ]
    const edges: Edge[] = [edge('n1', 'n2')]
    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ op: 'start' })
    expect(result[1]).toEqual({ op: 'stop' })
  })

  // ── Disconnected nodes filtering ──────────────────────────────────────────

  it('includes only the longest connected chain when disconnected nodes exist', () => {
    // Chain A: n1 → n2 → n3  (length 3)
    // Chain B: n4 → n5        (length 2)
    const nodes: FlowNode[] = [
      startNode('n1'),
      sendByteNode('n2'),
      stopNode('n3'),
      startNode('n4'),
      stopNode('n5'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n4', 'n5'),
    ]

    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ op: 'start' })
    expect(result[1]).toEqual({ op: 'send_byte', data: '0xA0' })
    expect(result[2]).toEqual({ op: 'stop' })
  })

  // ── serializeFlowWithOrder ─────────────────────────────────────────────────

  it('serializeFlowWithOrder returns parallel node IDs and steps', () => {
    const nodes: FlowNode[] = [
      startNode('s1'),
      sendByteNode('sb1', '0x60'),
      stopNode('st1'),
    ]
    const edges: Edge[] = [
      edge('s1', 'sb1'),
      edge('sb1', 'st1'),
    ]
    const { orderedNodeIds, steps } = serializeFlowWithOrder(nodes, edges)
    expect(orderedNodeIds).toEqual(['s1', 'sb1', 'st1'])
    expect(steps).toEqual([
      { op: 'start' },
      { op: 'send_byte', data: '0x60' },
      { op: 'stop' },
    ])
  })
})
