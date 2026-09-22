// Minimal globals available in every JS runtime AIGE targets (Node, browsers, workers).
// Core is isomorphic, so it does not load DOM or Node type libraries.
declare function structuredClone<T>(value: T): T;
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}
declare const console: {
  log(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
};
