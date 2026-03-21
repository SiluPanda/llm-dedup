import { createHash } from 'crypto'

const RELEVANT_FIELDS = [
  'messages',
  'model',
  'temperature',
  'top_p',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'tools',
  'tool_choice',
  'response_format',
  'stop',
  'system',
]

export function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(sortedStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map(k => JSON.stringify(k) + ':' + sortedStringify(obj[k]))
  return '{' + parts.join(',') + '}'
}

export function hashString(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function canonicalizeKey(
  params: unknown,
  normalizer?: (text: string) => string,
): string {
  let extracted: Record<string, unknown> = {}

  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const p = params as Record<string, unknown>
    for (const field of RELEVANT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(p, field)) {
        extracted[field] = p[field]
      }
    }
  } else {
    extracted = { _raw: params }
  }

  let text = sortedStringify(extracted)

  if (normalizer) {
    text = normalizer(text)
  }

  return hashString(text)
}
