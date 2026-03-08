import { describe, it, expect } from 'vitest'
import { serializeFlow, serializeFlowWithOrder } from './serialize'
import type { FlowNode, StepPayload } from './serialize'
import type { Edge } from '@xyflow/react'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetNode(id: string): FlowNode {
  return { id, type: 'reset', data: {} }
}

function writeNode(id: string, overrides?: Partial<{ address: string; register: string; data: string }>): FlowNode {
  return {
    id,
    type: 'write',
    data: {
      address: '0x50',
      register: '0x00',
      data: '0xA5',
      ...overrides,
    },
  }
}

function readNode(id: string, overrides?: Partial<{ address: string; register: string; n: string; expect: string }>): FlowNode {
  return {
    id,
    type: 'read',
    data: {
      address: '0x50',
      register: '0x00',
      n: '1',
      expect: '',
      ...overrides,
    },
  }
}

function scanNode(id: string, overrides?: Partial<{ address: string; expect: string }>): FlowNode {
  return {
    id,
    type: 'scan',
    data: {
      address: '0x50',
      expect: '',
      ...overrides,
    },
  }
}

function delayNode(id: string, cycles = '100'): FlowNode {
  return { id, type: 'delay', data: { cycles } }
}

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

  // ── Single node ───────────────────────────────────────────────────────────

  it('serializes a single reset node', () => {
    const result = serializeFlow([resetNode('r1')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'reset' }])
  })

  it('serializes a single write node with correct hex formatting', () => {
    const result = serializeFlow([writeNode('w1', { address: '0x50', register: '0x10', data: '0xA5, 0xB6' })], [])
    expect(result).toEqual<StepPayload[]>([
      { op: 'write_bytes', addr: '0x50', reg: '0x10', data: ['0xA5', '0xB6'] },
    ])
  })

  it('serializes a single read node without expected data', () => {
    const result = serializeFlow([readNode('rd1', { n: '2', expect: '' })], [])
    expect(result).toEqual<StepPayload[]>([
      { op: 'read_bytes', addr: '0x50', reg: '0x0', n: 2 },
    ])
  })

  it('serializes a single read node with expected data', () => {
    const result = serializeFlow([readNode('rd1', { expect: '0xA5, 0xB6' })], [])
    const step = result[0] as { op: string; expect?: string[] }
    expect(step.op).toBe('read_bytes')
    expect(step.expect).toEqual(['0xA5', '0xB6'])
  })

  it('serializes a single scan node with expect=true', () => {
    const result = serializeFlow([scanNode('s1', { expect: 'true' })], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'scan', addr: '0x50', expect: true }])
  })

  it('serializes a single scan node with no expect (omits the field)', () => {
    const result = serializeFlow([scanNode('s1', { expect: '' })], [])
    const step = result[0] as { op: string; expect?: boolean }
    expect(step.op).toBe('scan')
    expect('expect' in step).toBe(false)
  })

  it('serializes a single delay node', () => {
    const result = serializeFlow([delayNode('d1', '200')], [])
    expect(result).toEqual<StepPayload[]>([{ op: 'delay', cycles: 200 }])
  })

  // ── Linear chain ──────────────────────────────────────────────────────────

  it('serializes a linear chain in topological order', () => {
    const nodes: FlowNode[] = [
      resetNode('n1'),
      writeNode('n2'),
      delayNode('n3'),
      readNode('n4'),
      scanNode('n5'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n3', 'n4'),
      edge('n4', 'n5'),
    ]

    const result = serializeFlow(nodes, edges)

    expect(result).toHaveLength(5)
    expect(result[0].op).toBe('reset')
    expect(result[1].op).toBe('write_bytes')
    expect(result[2].op).toBe('delay')
    expect(result[3].op).toBe('read_bytes')
    expect(result[4].op).toBe('scan')
  })

  // ── Hex formatting ────────────────────────────────────────────────────────

  it('formats address / register to canonical hex regardless of input case', () => {
    const node = writeNode('w1', { address: '50', register: 'a5', data: 'ff' })
    const result = serializeFlow([node], [])
    const step = result[0] as { op: string; addr: string; reg: string; data: string[] }
    expect(step.addr).toBe('0x50')
    expect(step.reg).toBe('0xA5')
    expect(step.data).toEqual(['0xFF'])
  })

  it('formats hex values with 0x prefix in upper case', () => {
    const node = writeNode('w1', { address: '0x50', data: '0xa5, 0xb6' })
    const result = serializeFlow([node], [])
    const step = result[0] as { data: string[] }
    expect(step.data).toEqual(['0xA5', '0xB6'])
  })

  // ── Disconnected nodes filtering ──────────────────────────────────────────

  it('includes only the longest connected chain when disconnected nodes exist', () => {
    // Chain A: n1 → n2 → n3  (length 3)
    // Chain B: n4 → n5        (length 2)
    // Isolated: n6             (length 1)
    const nodes: FlowNode[] = [
      resetNode('n1'),
      writeNode('n2'),
      delayNode('n3'),
      resetNode('n4'),
      writeNode('n5'),
      scanNode('n6'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n4', 'n5'),
    ]

    const result = serializeFlow(nodes, edges)

    expect(result).toHaveLength(3)
    expect(result[0].op).toBe('reset')
    expect(result[1].op).toBe('write_bytes')
    expect(result[2].op).toBe('delay')
  })

  it('serializes the only node when the canvas has one isolated node', () => {
    const result = serializeFlow([delayNode('d1', '50')], [])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ op: 'delay', cycles: 50 })
  })

  it('excludes all disconnected nodes when one chain is clearly longer', () => {
    // Long chain: a → b → c → d
    // Orphan: x
    const nodes: FlowNode[] = [
      resetNode('a'),
      writeNode('b'),
      delayNode('c'),
      readNode('d'),
      scanNode('x'),
    ]
    const edges: Edge[] = [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'd'),
    ]

    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(4)
    const ops = result.map((s) => s.op)
    expect(ops).toEqual(['reset', 'write_bytes', 'delay', 'read_bytes'])
  })

  // ── Protocol-level nodes ──────────────────────────────────────────────────

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

  it('serializes a protocol-only chain: start → send_byte → recv_byte → stop', () => {
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

  it('serializes a protocol-only chain with repeated_start: start → send_byte → repeated_start → recv_byte → stop', () => {
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

  it('serializes a mixed flow: reset → start → send_byte → stop → delay', () => {
    const nodes: FlowNode[] = [
      resetNode('n1'),
      startNode('n2'),
      sendByteNode('n3', '0xD0'),
      stopNode('n4'),
      delayNode('n5', '50'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n3', 'n4'),
      edge('n4', 'n5'),
    ]
    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual({ op: 'reset' })
    expect(result[1]).toEqual({ op: 'start' })
    expect(result[2]).toEqual({ op: 'send_byte', data: '0xD0' })
    expect(result[3]).toEqual({ op: 'stop' })
    expect(result[4]).toEqual({ op: 'delay', cycles: 50 })
  })

  it('mixed flow with write and protocol nodes coexist correctly', () => {
    const nodes: FlowNode[] = [
      resetNode('n1'),
      writeNode('n2', { address: '0x50', register: '0x01', data: '0xFF' }),
      startNode('n3'),
      sendByteNode('n4', '0xA1'),
      recvByteNode('n5', true),
      stopNode('n6'),
    ]
    const edges: Edge[] = [
      edge('n1', 'n2'),
      edge('n2', 'n3'),
      edge('n3', 'n4'),
      edge('n4', 'n5'),
      edge('n5', 'n6'),
    ]
    const result = serializeFlow(nodes, edges)
    expect(result).toHaveLength(6)
    const ops = result.map((s) => s.op)
    expect(ops).toEqual(['reset', 'write_bytes', 'start', 'send_byte', 'recv_byte', 'stop'])
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

  it('serializeFlowWithOrder returns parallel node IDs and steps for protocol nodes', () => {
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
