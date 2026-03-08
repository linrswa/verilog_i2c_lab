// Shared validation utilities for node input fields.
// Each function returns { valid: true } on success or { valid: false, error: string } on failure.

export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate a single 8-bit byte value in hex format.
 * Accepts "0x" prefix or bare hex digits.
 * Valid range: 0x00–0xFF (0–255).
 */
export function validateHexByte(v: string): ValidationResult {
  const trimmed = v.trim()
  if (trimmed === '') return { valid: false, error: 'Byte value is required' }

  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed)) return { valid: false, error: 'Must be hex (e.g. 0xA0)' }
  if (parsed < 0x00 || parsed > 0xff) return { valid: false, error: 'Range: 0x00–0xFF' }

  return { valid: true }
}

/**
 * Returns true if every node in the provided data map has no validation errors.
 * `errorsMap` is a map of nodeId → errors object where any truthy string value
 * means that field is invalid.
 */
export function chainHasErrors(errors: Record<string, string | undefined>[]): boolean {
  return errors.some((nodeErrors) =>
    Object.values(nodeErrors).some((e) => typeof e === 'string' && e.length > 0),
  )
}
