export interface InflightEntry<T> {
    key: string;
    promise: Promise<T>;
    subscribers: Array<{
        resolve: (v: T) => void;
        reject: (e: unknown) => void;
        timeoutTimer?: ReturnType<typeof setTimeout>;
        abortCleanup?: () => void;
    }>;
    createdAt: number;
    settled: boolean;
}
export declare class InflightRegistry {
    private entries;
    has(key: string): boolean;
    get<T>(key: string): InflightEntry<T> | undefined;
    set<T>(key: string, entry: InflightEntry<T>): void;
    delete(key: string): void;
    size(): number;
    all(): InflightEntry<unknown>[];
    clear(): void;
}
//# sourceMappingURL=registry.d.ts.map