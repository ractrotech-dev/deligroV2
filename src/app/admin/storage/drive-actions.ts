"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { DriveAccessEnded, disconnectDrive, setDriveFolder } from "@/lib/data-access/google-drive";
import { logOpsAction } from "@/lib/data-access/ops-audit";

export type DriveActionResult = { ok: true } | { ok: false; error: string };

const TOO_MANY = "Too many requests at once. Wait a moment and try again.";

const audit = (actorId: string, action: string, after: Record<string, unknown>) =>
  logOpsAction({ actorId, action, entityType: "platform", entityId: null, after }).catch(() => undefined);

/** Forgets the Google account. Photos already on dishes stay there. */
export async function disconnectDriveAction(): Promise<DriveActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`drive-change:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_MANY };
  try {
    await disconnectDrive();
  } catch {
    return { ok: false, error: "Couldn't disconnect. Try again." };
  }
  await audit(admin.id, "storage.drive_disconnected", {});
  revalidatePath("/admin/storage");
  return { ok: true };
}

export async function setDriveFolderAction(link: string): Promise<DriveActionResult> {
  const admin = await requireRole("admin");
  const limit = await rateLimit(`drive-change:${admin.id}`, 30, 60_000);
  if (!limit.ok) return { ok: false, error: TOO_MANY };
  try {
    const res = await setDriveFolder(String(link));
    if (!res.ok) return res;
    await audit(admin.id, "storage.drive_folder", { name: res.name });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof DriveAccessEnded ? "Google Drive access ended. Connect it again." : "Couldn't save that folder. Try again.",
    };
  }
  revalidatePath("/admin/storage");
  return { ok: true };
}
