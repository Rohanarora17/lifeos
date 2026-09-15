type CircuitState = { failures: number[]; openUntil: number; probeInFlight: boolean };

function isCapacityFailure(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null)?.status || 0);
  const message = String((error as { message?: unknown } | null)?.message || '').toUpperCase();
  return status === 429 || status === 503 || message.includes('RESOURCE_EXHAUSTED') || message.includes('UNAVAILABLE') || message.includes('OVERLOADED');
}

export class AiCircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(private readonly options = { failureThreshold: 3, windowMs: 10 * 60_000, openMs: 30 * 60_000 }) {}

  canAttempt(model: string, now = Date.now()): boolean {
    const state = this.states.get(model);
    if (!state) return true;
    if (state.openUntil > now) return false;
    if (state.openUntil > 0) {
      if (state.probeInFlight) return false;
      state.openUntil = 0;
      state.failures = [];
      state.probeInFlight = true;
      return true;
    }
    return !state.probeInFlight;
  }

  isHalfOpenProbe(model: string): boolean {
    return this.states.get(model)?.probeInFlight === true;
  }

  recordFailure(model: string, error: unknown, now = Date.now()): void {
    const existing = this.states.get(model);
    if (!isCapacityFailure(error) && !existing?.probeInFlight) return;
    const state = existing ?? { failures: [], openUntil: 0, probeInFlight: false };
    if (state.probeInFlight) {
      state.probeInFlight = false;
      state.openUntil = now + this.options.openMs;
    }
    state.failures = state.failures.filter(timestamp => timestamp >= now - this.options.windowMs);
    state.failures.push(now);
    if (state.failures.length >= this.options.failureThreshold) state.openUntil = now + this.options.openMs;
    this.states.set(model, state);
  }

  recordSuccess(model: string): void {
    this.states.delete(model);
  }

  snapshot(now = Date.now()) {
    return Array.from(this.states.entries()).flatMap(([model, state]) => {
      const failures = state.failures.filter(timestamp => timestamp >= now - this.options.windowMs);
      if (failures.length === 0 && state.openUntil <= now) return [];
      return [{ model, failuresInWindow: failures.length, open: state.openUntil > now, halfOpen: state.probeInFlight, openUntil: state.openUntil || null }];
    });
  }
}

const circuitGlobal = globalThis as typeof globalThis & { lifeosAiCircuitBreaker?: AiCircuitBreaker };

/** One shared provider circuit for every LifeOS route and scheduler in this server process. */
export const unifiedAiCircuitBreaker = circuitGlobal.lifeosAiCircuitBreaker ?? new AiCircuitBreaker();
circuitGlobal.lifeosAiCircuitBreaker = unifiedAiCircuitBreaker;
