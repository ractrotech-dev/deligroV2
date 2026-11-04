import { Empty } from "@/components/admin/console";
import { countDrivePhotos, getDriveStatus, type DriveStatus } from "@/lib/data-access/google-drive";
import { DriveDisconnect, DriveFolderForm } from "./drive-controls";

const RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Drive connected." },
  denied: { ok: false, text: "Google sign-in was cancelled." },
  no_scope: { ok: false, text: "Tick the Google Drive box on Google's screen, then connect again." },
  no_refresh: { ok: false, text: "Google didn't give lasting access. Connect again." },
  failed: { ok: false, text: "Couldn't connect Google Drive. Try again." },
};

/**
 * Admin → Storage → Google Drive. WEB. The owner signs in with their own Google
 * account and names a folder of food photos, each named after its dish. A dish saved
 * with no photo is matched against them (`autoMatchImage`), and the image picker
 * offers them.
 */
export async function DrivePanel({ result }: Readonly<{ result?: string }>) {
  let status: DriveStatus;
  try {
    status = await getDriveStatus();
  } catch {
    return <p className="text-[13px] font-medium text-deal">Couldn&apos;t load this. Refresh to try again.</p>;
  }

  if (status.state === "not_set_up") return <Empty>Google Drive isn&apos;t set up on this server yet.</Empty>;
  if (status.state === "not_migrated") return <Empty>Google Drive needs migration 0204 applied.</Empty>;

  const message = result && Object.hasOwn(RESULT, result) ? RESULT[result] : null;
  const banner = message ? (
    <p role="status" className={`text-[13px] font-medium ${message.ok ? "text-green" : "text-deal"}`}>
      {message.text}
    </p>
  ) : null;

  if (status.state === "not_connected") {
    return (
      <div className="space-y-3">
        {banner}
        {/* A plain link: it leaves for Google, and must not be prefetched. */}
        <a href="/api/admin/drive/connect" className="c-btn c-btn-dark inline-flex w-fit">
          Connect Google Drive
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {banner}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[13.5px] text-ink">
          Connected to <span className="font-semibold">{status.email}</span>
        </p>
        <a href="/api/admin/drive/connect" className="text-[12.5px] font-semibold text-accent-ink hover:underline">
          Connect again
        </a>
        <DriveDisconnect email={status.email} />
      </div>
      <DriveFolderForm
        current={status.folderId ? status.folderName ?? "Drive folder" : null}
        count={status.folderId ? await countDrivePhotos() : 0}
      />
    </div>
  );
}
