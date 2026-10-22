import { Fact, FactList, Panel, Section, StatusBadge, StatusText, Empty, type Tone } from "@/components/admin/console";
import type { AdminRiderProfile } from "@/lib/data-access/admin-rider-profile";
import { CHANGE_FIELD_LABEL, DOC_TYPE_LABEL, VEHICLE_TYPE_LABEL, type ChangeField, type RiderDocType, type VehicleType } from "@/lib/rider/profile-rules";
import { unverifiedRequired } from "@/lib/rider/admin-profile";
import { formatDateTime } from "@/lib/utils/relative-time";
import { ChangeDecisionForm, PayoutAccountForm, VerificationForm } from "./profile-forms";

/**
 * The rider's Profile tab (Phase 6): everything on file, the overall
 * verification, the payout account IN FULL (admins only — this tab is the one
 * place it is shown) with any pending change beside it, and the change
 * requests waiting for a decision, old against new.
 *
 * A server component on purpose: the full account and licence numbers are
 * rendered here and never handed to a client component as props. Platform:
 * BOTH (container queries; forms sized against their own panel).
 */

export const VERIFICATION_TONE: Record<string, Tone> = { verified: "green", pending: "amber", rejected: "red", unverified: "neutral" };
export const VERIFICATION_LABEL: Record<string, string> = {
  verified: "Verified",
  pending: "Waiting for review",
  rejected: "Rejected",
  unverified: "Not verified",
};

const dash = (v: string | null | undefined) => (v && v.trim() ? v : "—");

export function ProfileTab({ profile: p }: Readonly<{ profile: AdminRiderProfile }>) {
  const missing = unverifiedRequired(p.documents.map((d) => ({ type: d.type, status: d.status, expiresOn: d.expiresOn })));
  const account = p.payout.account;
  const pending = p.payout.pending;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 @3xl:grid-cols-2">
        <Panel
          title="Verification"
          actions={<StatusBadge tone={VERIFICATION_TONE[p.verification]}>{VERIFICATION_LABEL[p.verification]}</StatusBadge>}
        >
          <FactList>
            {p.verificationNote ? <Fact label="Note">{p.verificationNote}</Fact> : null}
            {p.verifiedAt ? <Fact label="Verified">{`${formatDateTime(p.verifiedAt)}${p.verifiedBy ? ` by ${p.verifiedBy}` : ""}`}</Fact> : null}
            <Fact label="Required documents">
              {missing.length === 0 ? (
                <StatusText tone="green">Aadhaar, licence and photo verified</StatusText>
              ) : (
                <StatusText tone="amber">{`Still to verify: ${missing.map((t) => DOC_TYPE_LABEL[t as RiderDocType]).join(", ")}`}</StatusText>
              )}
            </Fact>
            {p.vehicle.owner === "rider" ? (
              <Fact label="Own vehicle">RC, insurance and PUC are needed too (see Documents).</Fact>
            ) : null}
          </FactList>
          {p.verification === "verified" ? (
            <p className="mt-3 text-[12px] text-muted">A verified rider who should stop working is suspended from Team, not un-verified.</p>
          ) : (
            <div className="admin-measure mt-3">
              <VerificationForm driverId={p.driverId} current={p.verification} missing={missing} />
            </div>
          )}
        </Panel>

        <Panel title="Payout account" description="Shown in full only here. The rider sees the last four digits.">
          {account ? (
            <FactList>
              <Fact label="Type">{account.kind === "bank" ? "Bank account" : "UPI"}</Fact>
              {account.kind === "bank" ? (
                <>
                  <Fact label="Holder">{dash(account.holderName)}</Fact>
                  <Fact label="Account number">
                    <span className="text-data">{account.accountNumber}</span>
                  </Fact>
                  <Fact label="IFSC">
                    <span className="text-data">{account.ifsc}</span>
                  </Fact>
                </>
              ) : (
                <>
                  <Fact label="UPI ID">
                    <span className="text-data">{account.upiId}</span>
                  </Fact>
                  {account.holderName ? <Fact label="Name">{account.holderName}</Fact> : null}
                </>
              )}
              <Fact label="Last changed">{formatDateTime(account.updatedAt)}</Fact>
            </FactList>
          ) : (
            <Empty>No payout account on file.</Empty>
          )}
          {pending ? (
            <p className="mt-3">
              <StatusText tone="amber">{`Change pending since ${formatDateTime(pending.requestedAt)} — pay the account above until it is approved`}</StatusText>
            </p>
          ) : null}
          <details className="mt-3">
            <summary className="cursor-pointer text-[12.5px] font-semibold text-accent-ink">Set the account for the rider</summary>
            <div className="admin-measure mt-3">
              <PayoutAccountForm driverId={p.driverId} />
            </div>
          </details>
        </Panel>
      </div>

      <Section title="Changes waiting" meta={p.changes.length > 0 ? `${p.changes.length}` : undefined}>
        {p.changes.length === 0 ? (
          <Empty>No change requests waiting.</Empty>
        ) : (
          <div className="grid gap-4 @3xl:grid-cols-2">
            {p.changes.map((c) => (
              <Panel key={c.id} title={CHANGE_FIELD_LABEL[c.field as ChangeField] ?? c.field} meta={formatDateTime(c.createdAt)}>
                <FactList>
                  <Fact label="Now">{c.current}</Fact>
                  <Fact label="Asked for">
                    <span className="font-semibold">{c.proposed}</span>
                  </Fact>
                </FactList>
                <div className="admin-measure mt-3">
                  <ChangeDecisionForm driverId={p.driverId} requestId={c.id} />
                </div>
              </Panel>
            ))}
          </div>
        )}
      </Section>

      <Section title="On file">
        <div className="grid gap-4 @3xl:grid-cols-3">
          <FactList>
            <Fact label="Name">{dash(p.name)}</Fact>
            <Fact label="Rider ID">{dash(p.riderCode)}</Fact>
            <Fact label="Address">{dash([p.address.line, p.address.city, p.address.pincode].filter(Boolean).join(", "))}</Fact>
          </FactList>
          <FactList>
            <Fact label="Vehicle">
              {p.vehicle.type ? VEHICLE_TYPE_LABEL[p.vehicle.type as VehicleType] ?? p.vehicle.type : "—"}
            </Fact>
            <Fact label="Owned by">{p.vehicle.owner === "rider" ? "The rider" : "Deligro"}</Fact>
            <Fact label="Registration">
              <span className="text-data">{dash(p.vehicle.registration)}</span>
            </Fact>
            <Fact label="Licence">
              <span className="text-data">{dash(p.licence.number)}</span>
            </Fact>
            <Fact label="Licence valid to">{dash(p.licence.expiresOn)}</Fact>
          </FactList>
          <FactList>
            <Fact label="Emergency contact">{dash(p.emergency.name)}</Fact>
            <Fact label="Relation">{dash(p.emergency.relation)}</Fact>
            <Fact label="Their phone">
              {p.emergency.phone ? (
                <a href={`tel:${p.emergency.phone}`} className="text-data font-semibold text-accent-ink hover:underline">
                  {p.emergency.phone}
                </a>
              ) : (
                "—"
              )}
            </Fact>
          </FactList>
        </div>
      </Section>
    </div>
  );
}
