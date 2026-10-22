import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// Unread chunks a stuck consumer may accumulate before the stream is closed.
// All enqueue paths share this budget, including snapshot flushes and comments.
const MAX_BLOCKED_FRAMES = 500;
// Snapshot slots kept for a blocked consumer. One slot per running tool plus
// the message: a session with more concurrent tools than this is already
// pathological, and an unbounded map would grow with the accumulated partial
// results of every tool that ever reported.
const MAX_PENDING_SLOTS = 64;

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // SSE is observer-only: listing or opening a saved session must not create
  // another omp process for a terminal-owned session. Explicit commands use
  // POST /api/agent/[id], which starts the wrapper before this route attaches.
  const existing = getRpcSession(id);
  const session = existing?.isAlive() ? existing : undefined;
  if (!session) return new Response("Session is not managed by omp-web", { status: 409 });

  const encoder = new TextEncoder();
  // Hoisted so the stream's cancel() (half-open disconnects that never fire
  // the abort signal) can release the heartbeat and the RpcProcess listener.
  let streamCleanup: (() => void) | null = null;
  // Hoisted flush handle: pull() (slow-consumer resume) needs to flush the
  // coalesced message_update, but the controller and `closed` state live
  // inside start(). The handle is wired up there.
  let streamFlush: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let cleaned = false;
      let unsubscribe: (() => void) | null = null;
      // Backpressure slots: while the consumer is behind (desiredSize < 0),
      // frames that carry a FULL snapshot collapse to the newest one in their
      // slot — `message_update` (omp resends the whole accumulated message) and
      // `tool_execution_update` keyed by toolCallId (whole accumulated partial
      // result). Everything else is a delta, a terminal frame or a dialog, so
      // it is never replaced; it flushes the slots first to keep the order.
      const pendingUpdates = new Map<string, unknown>();
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const blocked = () => controller.desiredSize !== null && controller.desiredSize < 0;

      // The default queuing strategy has a high-water mark of one chunk:
      // unread depth is 1 - desiredSize; desiredSize goes negative when behind.
      const backlog = () => (controller.desiredSize === null ? 0 : 1 - controller.desiredSize);

      /** The coalescing slot for a full-snapshot frame, or null for any other. */
      const snapshotSlot = (data: unknown): string | null => {
        const event = data as { type?: string; toolCallId?: unknown } | null;
        if (event?.type === "message_update") return "message";
        if (event?.type === "tool_execution_update") {
          // A frame without an id cannot be keyed: two tools would overwrite
          // each other's slot, so it is dispatched straight away.
          return typeof event.toolCallId === "string" ? `tool:${event.toolCallId}` : null;
        }
        return null;
      };

      const cleanup = () => {
        if (cleaned) return;
        closed = true;
        cleaned = true;
        pendingUpdates.clear();
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
          unsubscribe = null;
        }
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      };
      streamCleanup = cleanup;
      streamFlush = () => {
        if (closed) return;
        flushPendingUpdates();
      };

      // An omitted payload emits a heartbeat comment. Keep serialization and
      // every enqueue under the same error handling and unread-queue budget.
      const enqueueFrame = (data?: unknown): boolean => {
        if (closed) return false;
        try {
          const frame = data === undefined ? ":\n\n" : `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          cleanup();
          return false;
        }
        if (backlog() >= MAX_BLOCKED_FRAMES) {
          // Closing preserves already queued frames. The client reconnects
          // after draining them and recovers newer state from its snapshot.
          cleanup();
          return false;
        }
        return true;
      };

      const flushPendingUpdates = (): boolean => {
        if (pendingUpdates.size === 0) return true;
        const queued = [...pendingUpdates.values()];
        pendingUpdates.clear();
        if (closed) return false;
        for (const data of queued) {
          if (!enqueueFrame(data)) return false;
        }
        return true;
      };

      const encode = (data: unknown) => {
        if (closed) return;
        const slot = blocked() ? snapshotSlot(data) : null;
        if (slot !== null) {
          // Re-inserting keeps the newest payload in the slot's original order.
          pendingUpdates.set(slot, data);
          if (pendingUpdates.size > MAX_PENDING_SLOTS) {
            // Only intermediate snapshots are evicted; a tool's end frame
            // still carries its final result and is never coalesced.
            const oldest = pendingUpdates.keys().next().value;
            if (oldest !== undefined) pendingUpdates.delete(oldest);
          }
          return;
        }
        if (!flushPendingUpdates()) return;
        enqueueFrame(data);
      };

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      heartbeatTimer = setInterval(() => {
        // Do not add comments or flush snapshots while the reader is behind.
        if (closed || blocked()) return;
        if (!flushPendingUpdates()) return;
        enqueueFrame();
      }, 30_000);

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      // onEvent can synchronously replay pending UI requests. Subscribe before
      // sampling the cursor/announcing readiness so catch-up has no event gap.
      const detach = session.onEvent((event) => encode(event));
      if (closed) {
        detach();
        return;
      }
      unsubscribe = detach;
      encode({ type: "connected", sessionId: id, web: session.getStreamSnapshot().cursor });
    },
    // When a slow consumer resumes reading, the stream calls pull() as soon
    // as queue space is available. Flush any coalesced message_update here so
    // the latest snapshot is delivered without waiting for a new event or the
    // 30s heartbeat.
    pull() {
      streamFlush?.();
    },
    cancel() {
      streamCleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
