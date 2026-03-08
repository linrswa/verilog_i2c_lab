import { useEffect, useRef } from 'react'
import type { Node, Edge, Viewport } from '@xyflow/react'

export const FLOW_STORAGE_KEY = 'i2c-demo-flow'

export interface PersistedFlow {
  nodes: Node[]
  edges: Edge[]
  viewport: Viewport
}

/** Read the persisted flow from localStorage, or return null if absent/corrupt. */
export function loadPersistedFlow(): PersistedFlow | null {
  try {
    const raw = localStorage.getItem(FLOW_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    // Basic shape validation — ensure the three required arrays/objects exist
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'nodes' in parsed &&
      'edges' in parsed &&
      'viewport' in parsed &&
      Array.isArray((parsed as PersistedFlow).nodes) &&
      Array.isArray((parsed as PersistedFlow).edges)
    ) {
      return parsed as PersistedFlow
    }
    return null
  } catch {
    return null
  }
}

/** Clear persisted flow from localStorage. */
export function clearPersistedFlow(): void {
  localStorage.removeItem(FLOW_STORAGE_KEY)
}

/**
 * Debounced auto-save hook.
 *
 * Writes `{ nodes, edges, viewport }` to localStorage ~500 ms after the last
 * change. Viewport is sourced from ReactFlow via the `getViewport` callback so
 * the caller can pass `useReactFlow().getViewport` directly.
 */
export function useFlowAutosave(
  nodes: Node[],
  edges: Edge[],
  getViewport: () => Viewport,
): void {
  // Keep a stable ref to getViewport to avoid listing it as a dependency that
  // changes on every render (the function identity from useReactFlow is stable,
  // but this guards against it regardless).
  const getViewportRef = useRef(getViewport)
  getViewportRef.current = getViewport

  useEffect(() => {
    const id = setTimeout(() => {
      const flow: PersistedFlow = {
        nodes,
        edges,
        viewport: getViewportRef.current(),
      }
      try {
        localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(flow))
      } catch {
        // Ignore quota errors — persistence is best-effort
      }
    }, 500)

    return () => clearTimeout(id)
  }, [nodes, edges])
}
