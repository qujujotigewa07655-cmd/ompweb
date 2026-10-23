/**
 * Shapes `get_state` for the polled state endpoint.
 *
 * omp joins the entire system prompt into `state.systemPrompt` — measured
 * 133 KB of a 135 KB response. Every poll (2 s token gauge, 15 s reconcile,
 * terminal resync, 65 878 requests / 4.5 GB over four days) neither reads it
 * nor needs it, so `GET /api/agent/[id]` drops it. The System panel asks for
 * the prompt explicitly with `POST { type: "get_state" }`, which is untouched.
 */

/** Fields the per-second indicator polls read (token gauge, shell watchdog). */
export const INDICATOR_FIELDS = [
  "isStreaming", "isPromptRunning", "isBashRunning", "isCompacting", "tokensPerSecond", "usageLimit",
] as const;

export function indicatorState(state: unknown): Record<string, unknown> {
  const source = (state ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of INDICATOR_FIELDS) if (source[field] !== undefined) picked[field] = source[field];
  return picked;
}

/**
 * Full state minus the joined system prompt, for the reconcilers.
 *
 * `state.systemPrompt` is the whole joined prompt — measured 133 KB of a
 * 135 KB response — and the 15 s reconcile, the terminal resync and the
 * settle watchdog all write it back into the same React state the mount load
 * already filled. They ask for `?omitPrompt=1`; the plain GET keeps its full
 * contract, and the System panel always reads the prompt through
 * `POST { type: "get_state" }`.
 */
export function stateWithoutSystemPrompt(state: unknown): Record<string, unknown> {
  const source = (state ?? {}) as Record<string, unknown>;
  if (!("systemPrompt" in source)) return source;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== "systemPrompt") rest[key] = value;
  }
  return rest;
}
