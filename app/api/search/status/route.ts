import { NextResponse } from "next/server";
import { indexStatus } from "@/lib/full-text-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Progress for the first search: the transcript index is built once, then refreshed by mtime. */
export function GET() {
  return NextResponse.json(indexStatus(), { headers: { "Cache-Control": "no-store" } });
}
