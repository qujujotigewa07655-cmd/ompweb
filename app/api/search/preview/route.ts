import { NextResponse } from "next/server";
import { readSearchPreview } from "@/lib/full-text-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get("source") ?? "";
  const section = params.get("section") ?? "0";
  const offset = params.get("offset") ?? "0";
  const entryId = params.get("entryId") ?? undefined;
  if (entryId && entryId.length > 256) return NextResponse.json({ error: "Invalid message entry" }, { status: 400 });
  if (source.length > 4096 || !/^\d+$/.test(section) || !/^\d+$/.test(offset)) return NextResponse.json({ error: "Invalid preview position" }, { status: 400 });
  try {
    const result = await readSearchPreview(source, Number(section), Number(offset), request.signal, entryId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: request.signal.aborted ? "Preview cancelled" : error instanceof Error ? error.message : "Preview failed" }, { status: request.signal.aborted ? 499 : 400, headers: { "Cache-Control": "no-store" } });
  }
}
