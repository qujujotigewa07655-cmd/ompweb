import { handleAttachmentUpload } from "@/lib/file-upload-server";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) { return handleAttachmentUpload(request); }
export async function PUT(request: Request) { return handleAttachmentUpload(request); }
export async function DELETE(request: Request) { return handleAttachmentUpload(request); }
