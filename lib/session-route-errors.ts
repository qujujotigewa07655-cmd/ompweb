import { NextResponse } from "next/server";
import { apiErrorResponse } from "./api-utils";
import { SessionChangedError, SessionFileTooLargeError } from "./session-reader";

/**
 * Shared error mapping for the session read routes (`/api/sessions/[id]` and
 * its `/context`).
 *
 * - `SessionFileTooLargeError` must stay 413: answering 200 with an empty
 *   transcript made history look deleted.
 * - `SessionChangedError` is a normal race with omp appending to the file, so
 *   it answers 409 with a stable code the client retries immediately — not the
 *   bare 500 that produced 321 blank-transcript responses in production
 *   (`{"error":"Error: Session changed while indexing history"}`, 57 bytes).
 */
export function sessionReadErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionFileTooLargeError) {
    return NextResponse.json(
      { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
      { status: 413 },
    );
  }
  if (error instanceof SessionChangedError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  return apiErrorResponse(error);
}
