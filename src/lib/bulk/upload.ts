import { NextResponse } from "next/server";
import { MAX_SHEET_BYTES } from "@/lib/bulk/menu-sheet";

export interface SheetUpload {
  bytes: Uint8Array;
  filename: string;
  mode: "preview" | "apply";
  /** Any other text field of the form (e.g. the shop a manager picked). */
  fields: Record<string, string>;
}

/**
 * Reads `multipart/form-data` with a `file`, a `mode` (preview | apply) and any
 * other text fields. The refusal to return as-is when it is not one.
 */
export async function readSheetUpload(request: Request): Promise<SheetUpload | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_SHEET_BYTES + 64 * 1024) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request", field: "body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "bad_request", field: "file" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "bad_request", field: "file" }, { status: 400 });
  if (file.size > MAX_SHEET_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  const mode = form.get("mode");
  if (mode !== "preview" && mode !== "apply") return NextResponse.json({ error: "bad_request", field: "mode" }, { status: 400 });

  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name || "sheet.csv", mode, fields };
}

/** A download response for a generated sheet. */
export function sheetResponse(file: { body: Uint8Array | string; contentType: string; filename: string }): Response {
  return new Response(file.body as BodyInit, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function formatOf(url: string): "csv" | "xlsx" {
  return new URL(url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
}
