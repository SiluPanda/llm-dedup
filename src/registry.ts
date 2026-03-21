export interface InflightEntry<T> {
  key: string
  promise: Promise<T>
  subscribers: Array<{
    resolve: (v: T) => void
    reject: (e: unknown) => void
    timeoutTimer?: ReturnType<typeof setTimeout>
  }>
  createdAt: number
  settled: boolean
}

export class InflightRegistry {
  private entries = new Map<string, InflightEntry<unknown>>()

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get<T>(key: string): InflightEntry<T> | undefined {
    return this.entries.get(key) as InflightEntry<T> | undefined
  }

  set<T>(key: string, entry: InflightEntry<T>): void {
    this.entries.set(key, entry as InflightEntry<unknown>)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  size(): number {
    return this.entries.size
  }

  all(): InflightEntry<unknown>[] {
    return Array.from(this.entries.values())
  }

  clear(): void {
    this.entries.clear()
  }
}
