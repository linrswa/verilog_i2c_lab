import { describe, it, expect } from 'vitest'
import { serializeFlow } from './serialize'
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
})
