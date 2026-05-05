/**
 * Tiny in-process LRU. Designed for the hot path:
 *   - embedding cache keyed on the full embed text (semantic_query)
 *   - intent cache keyed on (state hash + user turn)
 *
 * Single-process: each Vercel function instance keeps its own. That's
 * intentional — cross-instance coherence isn't needed (cache misses just
 * trigger another LLM call) and a Redis hop would cost more than it saves
 * on a sub-second hot path.
 */

export class LRU<V> {
  private readonly max: number;
  private readonly map = new Map<string, V>();

  constructor(max: number) {
    this.max = max;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // Re-insert to move to most-recent.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      // Evict oldest. Map iteration order = insertion order in JS.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  size(): number {
    return this.map.size;
  }
}
