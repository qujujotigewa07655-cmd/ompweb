import { NextResponse } from "next/server";
import { resolveSessionPath } from "./session-reader";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to its file path, or a 404 JSON response. Replaces the
 * repeated `resolveSessionPath(id)` + "Session not found" guard across routes. */
export async function resolveSessionPathOr404(
  id: string,
): Promise<{ filePath: string } | { response: NextResponse }> {
  const filePath = await resolveSessionPath(id);
  if (!filePath) return { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  return { filePath };
}

/** Uniform JSON error body used by most API routes. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  return NextResponse.json({ error: String(error) }, { status });
}

/** Below this, compression costs more than it saves. */
const GZIP_MIN_BYTES = 1024;

/**
 * Serve a JSON string gzip-encoded when the client asked for it.
 *
 * Next's server-level compression covers rendered pages and middleware
 * responses but not App Router route handlers: measured on this install,
 * `/api/sessions` (1.07 MB), `/api/models` (248 KB) and `/api/usage` (17 KB)
 * all arrive uncompressed while `/` and static chunks arrive gzipped. Encoding
 * in the handler is the documented way to compress a handler's own body —
 * 1.07 MB becomes 92 KB for the list that every tab refetches on each agent
 * turn.
 */
export async function jsonBodyResponse(
  body: string,
  request: Request,
  init: { status?: number; headers?: Record<string, string> } = {},
): Promise<NextResponse> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const accepts = request.headers.get("accept-encoding") ?? "";
  const bytes = Buffer.byteLength(body);
  if (bytes >= GZIP_MIN_BYTES && /\bgzip\b/i.test(accepts)) {
    const { gzipSync } = await import("node:zlib");
    const compressed = gzipSync(body);
    return new NextResponse(new Uint8Array(compressed), {
      status: init.status ?? 200,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.length),
        Vary: headers.Vary ? `${headers.Vary}, Accept-Encoding` : "Accept-Encoding",
      },
    });
  }
  return new NextResponse(body, {
    status: init.status ?? 200,
    headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(bytes) },
  });
}
