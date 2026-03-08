import { useState, useEffect, useRef } from 'react'
import { fetchTemplates } from '../lib/api'
import type { TemplateItem } from '../lib/api'

interface TemplateDropdownProps {
  onSelect: (templateId: string) => void
}

type FetchState = 'idle' | 'loading' | 'error'

export function TemplateDropdown({ onSelect }: TemplateDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [fetchState, setFetchState] = useState<FetchState>('idle')
  const [fetchError, setFetchError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Fetch the template list whenever the dropdown is opened for the first time
  // (or after an error). If already loaded, no-op.
  useEffect(() => {
    if (!isOpen) return
    if (fetchState === 'loading') return
    if (templates.length > 0) return

    setFetchState('loading')
    setFetchError(null)

    fetchTemplates()
      .then((list) => {
        setTemplates(list)
        setFetchState('idle')
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load templates'
        setFetchError(message)
        setFetchState('error')
      })
  }, [isOpen, fetchState, templates.length])

  // Close the dropdown when the user clicks outside of it
  useEffect(() => {
    if (!isOpen) return

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  function handleSelect(templateId: string) {
    setIsOpen(false)
    onSelect(templateId)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 transition-colors"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        Templates
        <svg
          className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-50 min-w-[260px] bg-white border border-gray-200 rounded-md shadow-lg py-1"
        >
          {fetchState === 'loading' && (
            <div className="px-4 py-3 text-sm text-gray-500">Loading templates…</div>
          )}

          {fetchState === 'error' && fetchError !== null && (
            <div className="px-4 py-3 text-sm text-red-600">
              <span>{fetchError}</span>
              <button
                className="ml-2 underline hover:no-underline"
                onClick={() => {
                  setTemplates([])
                  setFetchState('idle')
                }}
              >
                Retry
              </button>
            </div>
          )}

          {fetchState === 'idle' && templates.length === 0 && (
            <div className="px-4 py-3 text-sm text-gray-500">No templates available.</div>
          )}

          {fetchState === 'idle' &&
            templates.map((tpl) => (
              <button
                key={tpl.id}
                role="option"
                aria-selected={false}
                onClick={() => handleSelect(tpl.id)}
                className="w-full text-left px-4 py-2 hover:bg-indigo-50 focus:bg-indigo-50 outline-none transition-colors"
              >
                <div className="text-sm font-semibold text-gray-800">{tpl.name ?? tpl.id}</div>
                {tpl.description && (
                  <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{tpl.description}</div>
                )}
                {tpl.step_count !== undefined && (
                  <div className="text-xs text-indigo-400 mt-0.5">{tpl.step_count} steps</div>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
