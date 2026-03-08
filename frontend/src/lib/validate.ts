// Shared validation utilities for node input fields.
// Each function returns { valid: true } on success or { valid: false, error: string } on failure.

export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate a 7-bit I2C address in hex format.
 * Accepts "0x" prefix or bare hex digits.
 * Valid range: 0x00–0x7F (0–127).
 */
export function validateHexAddr(v: string): ValidationResult {
  const trimmed = v.trim()
  if (trimmed === '') return { valid: false, error: 'Address is required' }

  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed)) return { valid: false, error: 'Must be hex (e.g. 0x50)' }
  if (parsed < 0x00 || parsed > 0x7f) return { valid: false, error: 'Range: 0x00–0x7F' }

  return { valid: true }
}

/**
 * Validate an 8-bit register address in hex format.
 * Accepts "0x" prefix or bare hex digits.
 * Valid range: 0x00–0xFF (0–255).
 */
export function validateHexReg(v: string): ValidationResult {
  const trimmed = v.trim()
  if (trimmed === '') return { valid: false, error: 'Register is required' }

  const parsed = parseInt(trimmed, 16)
  if (isNaN(parsed)) return { valid: false, error: 'Must be hex (e.g. 0x00)' }
  if (parsed < 0x00 || parsed > 0xff) return { valid: false, error: 'Range: 0x00–0xFF' }

  return { valid: true }
}

/**
 * Validate a comma-separated list of hex byte values.
 * Each token must be in range 0x00–0xFF.
 * An empty string is valid (no data bytes).
 */
export function validateHexDataList(v: string): ValidationResult {
  const trimmed = v.trim()
  if (trimmed === '') return { valid: true }

  const tokens = trimmed.split(',').map((s) => s.trim())
  for (const token of tokens) {
    if (token === '') return { valid: false, error: 'Remove trailing comma' }
    const parsed = parseInt(token, 16)
    if (isNaN(parsed)) return { valid: false, error: `"${token}" is not valid hex` }
    if (parsed < 0x00 || parsed > 0xff) return { valid: false, error: `"${token}": range 0x00–0xFF` }
  }

  return { valid: true }
}

/**
 * Validate that the value is a positive integer (> 0).
 */
export function validatePositiveInt(v: string): ValidationResult {
  const trimmed = v.trim()
  if (trimmed === '') return { valid: false, error: 'Value is required' }

  const parsed = parseInt(trimmed, 10)
  if (isNaN(parsed) || trimmed !== String(parsed)) {
    return { valid: false, error: 'Must be a whole number' }
  }
  if (parsed <= 0) return { valid: false, error: 'Must be > 0' }

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
