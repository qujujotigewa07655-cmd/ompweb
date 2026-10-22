import { NextResponse } from "next/server";
import { searchFullText, validateSearchQuery } from "@/lib/full-text-search";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isRecord } from "@/lib/type-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input: unknown = await parseJsonWithinLimit(request, 4096);
    if (!isRecord(input) || typeof input.query !== "string" || (input.cursor !== undefined && (typeof input.cursor !== "number" || !Number.isSafeInteger(input.cursor) || input.cursor < 0))) {
      return NextResponse.json({ error: "Invalid search query or cursor" }, { status: 400 });
    }
    const query = validateSearchQuery(input.query);
    const result = await searchFullText(query, { cursor: input.cursor as number | undefined, signal: request.signal });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "Search request is too large" }, { status: 413 });
    return NextResponse.json({ error: request.signal.aborted ? "Search cancelled" : error instanceof Error ? error.message : "Search failed" }, { status: request.signal.aborted ? 499 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
