import { Empty, Fact, FactList, Panel, Section, StatusText, type Tone } from "@/components/admin/console";
import type { AdminDocument, AdminRiderProfile } from "@/lib/data-access/admin-rider-profile";
import { DOC_TYPE_LABEL, type RiderDocType } from "@/lib/rider/profile-rules";
import { formatDateTime } from "@/lib/utils/relative-time";
import { DocumentReviewForm } from "./profile-forms";

/**
 * The rider's Documents tab (Phase 6): each live document with its file, its
 * number (in full for PAN, licence and RC; Aadhaar exists only as its last
 * four), expiry and days left, and Verify / Reject for a pending one. Then the
 * required documents still missing, and the replaced ones as history.
 *
 * Images show inline from the 10-minute link made for this render and open
 * full size in a new tab (zoom); PDFs open in the browser's viewer through
 * the "Open" route, which signs a fresh link each time (the console's CSP
 * does not allow a storage URL to be framed). Server component: numbers are
 * rendered here, never passed to the client forms. Platform: BOTH.
 */

const STATUS_TONE: Record<string, Tone> = { verified: "green", pending: "amber", rejected: "red", expired: "red", replaced: "neutral" };
const STATUS_LABEL: Record<string, string> = {
  verified: "Verified",
  pending: "Waiting for review",
  rejected: "Rejected",
  expired: "Expired",
  replaced: "Replaced",
};
const label = (t: string) => DOC_TYPE_LABEL[t as RiderDocType] ?? t;

function expiry(d: AdminDocument) {
  if (!d.expiresOn || d.daysLeft === null) return "No expiry";
  if (d.daysLeft < 0) return <StatusText tone="red">{`Expired ${d.expiresOn}`}</StatusText>;
  if (d.daysLeft <= 30) return <StatusText tone="amber">{`${d.expiresOn} · ${d.daysLeft === 0 ? "expires today" : `${d.daysLeft} days left`}`}</StatusText>;
  return `${d.expiresOn} · ${d.daysLeft} days left`;
}

function Preview({ d, openHref }: Readonly<{ d: AdminDocument; openHref: string }>) {
  if (d.kind === "image" && d.viewUrl) {
    return (
      <a href={openHref} target="_blank" rel="noopener noreferrer" className="block" title="Open full size">
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image would cache it */}
        <img
          src={d.viewUrl}
          alt={`${label(d.type)} uploaded ${formatDateTime(d.uploadedAt)}`}
          referrerPolicy="no-referrer"
          className="max-h-56 w-full rounded-md border border-line bg-surface-2 object-contain"
        />
      </a>
    );
  }
  return (
    <a href={openHref} target="_blank" rel="noopener noreferrer" className="c-btn c-btn-outline press">
      Open PDF
    </a>
  );
}

export function DocumentsTab({ profile: p }: Readonly<{ profile: AdminRiderProfile }>) {
  const base = `/admin/riders/${p.driverId}/documents`;
  const s = p.documentsStatus;
  const notUploaded = s.missing;

  return (
    <div className="space-y-5">
      {notUploaded.length > 0 ? (
        <p>
          <StatusText tone="amber">{`Not uploaded yet: ${notUploaded.map(label).join(", ")}`}</StatusText>
        </p>
      ) : null}

      {p.documents.length === 0 ? (
        <Empty>No documents uploaded yet.</Empty>
      ) : (
        <div className="grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {p.documents.map((d) => (
            <Panel
              key={d.id}
              title={label(d.type)}
              actions={<StatusText tone={STATUS_TONE[d.status] ?? "neutral"}>{STATUS_LABEL[d.status] ?? d.status}</StatusText>}
            >
              <div className="space-y-3">
                <Preview d={d} openHref={`${base}/${d.id}`} />
                <FactList>
                  {d.type === "photo" ? null : (
                    <Fact label="Number">
                      <span className="text-data">{d.number ?? d.numberMasked ?? "Not given"}</span>
                    </Fact>
                  )}
                  <Fact label="Expiry">{expiry(d)}</Fact>
                  <Fact label="Uploaded">{formatDateTime(d.uploadedAt)}</Fact>
                  {d.reviewedAt ? <Fact label="Reviewed">{`${formatDateTime(d.reviewedAt)}${d.reviewedBy ? ` by ${d.reviewedBy}` : ""}`}</Fact> : null}
                  {d.remarks ? <Fact label="Remarks">{d.remarks}</Fact> : null}
                </FactList>
                {d.status === "pending" ? <DocumentReviewForm driverId={p.driverId} documentId={d.id} /> : null}
              </div>
            </Panel>
          ))}
        </div>
      )}

      {p.history.length > 0 ? (
        <Section title="Replaced" meta={`${p.history.length}`}>
          <ul className="divide-y divide-line">
            {p.history.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                <span>
                  <span className="font-semibold">{label(d.type)}</span>{" "}
                  <span className="text-muted">{`uploaded ${formatDateTime(d.uploadedAt)}`}</span>
                </span>
                <a href={`${base}/${d.id}`} target="_blank" rel="noopener noreferrer" className="c-btn-quiet press">
                  Open
                </a>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
