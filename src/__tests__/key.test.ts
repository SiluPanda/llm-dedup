import { describe, it, expect } from 'vitest'
import { canonicalizeKey, sortedStringify, hashString } from '../key'

describe('canonicalizeKey', () => {
  it('produces same hash for same params regardless of key order', () => {
    const a = canonicalizeKey({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 })
    const b = canonicalizeKey({ temperature: 0.7, messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4' })
    expect(a).toBe(b)
  })

  it('produces different hashes for different models', () => {
    const a = canonicalizeKey({ model: 'gpt-4', messages: [] })
    const b = canonicalizeKey({ model: 'gpt-3.5-turbo', messages: [] })
    expect(a).not.toBe(b)
  })

  it('applies normalizer before hashing', () => {
    const normalizer = (text: string) => text.toLowerCase()
    const a = canonicalizeKey({ model: 'GPT-4', messages: [] }, normalizer)
    const b = canonicalizeKey({ model: 'gpt-4', messages: [] }, normalizer)
    // Normalizer lowercases, but model values are inside JSON strings so quoted
    // Both will produce the same normalized string → same hash
    // Actually model values in JSON are case-sensitive strings; normalizer applies to final JSON string
    // "GPT-4" lowercased → "gpt-4" → same as "gpt-4"
    expect(a).toBe(b)
  })

  it('ignores fields not in the relevant set', () => {
    const a = canonicalizeKey({ model: 'gpt-4', messages: [], user: 'alice', stream: true })
    const b = canonicalizeKey({ model: 'gpt-4', messages: [], user: 'bob', stream: false })
    expect(a).toBe(b)
  })

  it('includes temperature differences in the hash', () => {
    const a = canonicalizeKey({ model: 'gpt-4', messages: [], temperature: 0.0 })
    const b = canonicalizeKey({ model: 'gpt-4', messages: [], temperature: 1.0 })
    expect(a).not.toBe(b)
  })

  it('includes messages content in the hash', () => {
    const a = canonicalizeKey({ model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] })
    const b = canonicalizeKey({ model: 'gpt-4', messages: [{ role: 'user', content: 'world' }] })
    expect(a).not.toBe(b)
  })

  it('handles Anthropic system field', () => {
    const a = canonicalizeKey({ model: 'claude-3', messages: [], system: 'You are helpful.' })
    const b = canonicalizeKey({ model: 'claude-3', messages: [], system: 'You are harmful.' })
    expect(a).not.toBe(b)
  })

  it('handles non-object params via _raw wrapping', () => {
    const a = canonicalizeKey('raw-string')
    const b = canonicalizeKey('raw-string')
    const c = canonicalizeKey('other-string')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('sortedStringify', () => {
  it('sorts object keys alphabetically', () => {
    const result = sortedStringify({ z: 1, a: 2, m: 3 })
    expect(result).toBe('{"a":2,"m":3,"z":1}')
  })

  it('recursively sorts nested object keys', () => {
    const result = sortedStringify({ b: { y: 1, x: 2 }, a: 0 })
    expect(result).toBe('{"a":0,"b":{"x":2,"y":1}}')
  })

  it('preserves array order', () => {
    const result = sortedStringify([3, 1, 2])
    expect(result).toBe('[3,1,2]')
  })

  it('handles primitives', () => {
    expect(sortedStringify(42)).toBe('42')
    expect(sortedStringify('hello')).toBe('"hello"')
    expect(sortedStringify(null)).toBe('null')
    expect(sortedStringify(true)).toBe('true')
  })
})

describe('hashString', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const h = hashString('test')
    expect(h).toHaveLength(64)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
  })

  it('differs for different inputs', () => {
    expect(hashString('abc')).not.toBe(hashString('def'))
  })
})
