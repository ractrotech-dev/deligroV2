"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { setPlatformLock } from "@/lib/platform-lock";
import { isLockLevel } from "@/lib/platform-lock-rules";

/** Developer → Operations. Developer only; the RPC checks the role again. */
export async function setPlatformLockAction(form: FormData): Promise<void> {
  const developer = await requireRole("developer");
  const limit = await rateLimit(`dev-lock:${developer.id}`, 10, 60_000);
  if (!limit.ok) redirect("/developer/operations?error=" + encodeURIComponent("Too many changes in a minute. Wait and try again."));

  const level = form.get("level");
  const message = String(form.get("message") ?? "").slice(0, 500);
  if (!isLockLevel(level)) redirect("/developer/operations?error=" + encodeURIComponent("Pick a level."));
  if (level !== "off" && form.get("confirm") !== "yes") {
    redirect("/developer/operations?error=" + encodeURIComponent("Tick the box to confirm the pause."));
  }

  const result = await setPlatformLock(developer.id, level, message);
  revalidatePath("/", "layout");
  redirect(result.ok ? "/developer/operations?saved=1" : "/developer/operations?error=" + encodeURIComponent(result.error));
}
