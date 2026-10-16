import { requireRole } from "@/lib/auth";
import { listCategories } from "@/lib/data-access/vendor-categories";
import { loadDraft, listDrafts } from "@/lib/data-access/vendor-registration";
import { AdminHero } from "@/components/admin/admin-ui";
import { ConsoleOnly } from "@/components/admin/console-only";
import { RegistrationWizard } from "./registration-wizard";
import { DraftRow } from "./draft-row";

export const dynamic = "force-dynamic";

const STEP_LABELS = [
  "Basic info",
  "Business",
  "Location",
  "Payment",
  "Legal",
  "Menu",
  "Terms",
  "Review",
];

const dateFmt = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function NewVendorPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ draft?: string }>;
}>) {
  // The layout is not a guard: Next skips it when the client already holds that
  // segment, so the page that reads service-role data checks for itself.
  await requireRole("admin");

  const { draft: draftId } = await searchParams;

  const [categories, draft, drafts] = await Promise.all([
    listCategories(),
    draftId ? loadDraft(draftId) : Promise.resolve(null),
    draftId ? Promise.resolve([]) : listDrafts(),
  ]);

  const categoryNames = categories.map((c) => c.name);

  return (
    <div className="admin-measure space-y-4">
      <AdminHero
        backHref="/admin/vendors"
        backLabel="Vendors"
        title={draft ? "Resume registration" : "New vendor"}
        subtitle="Onboard a shop step by step"
      />

      {/* Console-only: eight steps of forms with autosaving drafts. Gating the
          draft list too is deliberate — offering "resume" on a phone would lead
          straight back into the wizard it can't run. */}
      <ConsoleOnly
        variant="page"
        tool="Vendor onboarding"
        why="Eight steps of forms, papers and photos want a keyboard. Approving a shop that has already signed up works fine on a phone."
      >
        {!draftId && drafts.length > 0 ? (
          <section className="rounded-xl border border-line bg-surface px-4 py-3.5">
            <h2 className="text-label mb-2">Resume a draft</h2>
            <ul className="space-y-1.5">
              {drafts.map((d) => (
                <DraftRow
                  key={d.id}
                  id={d.id}
                  shopName={d.shopName}
                  meta={`${STEP_LABELS[Math.min(d.step, STEP_LABELS.length - 1)]} · ${dateFmt.format(
                    new Date(d.updatedAt)
                  )}`}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <RegistrationWizard
          initialData={draft?.data ?? {}}
          initialStep={draft?.step ?? 0}
          draftId={draft?.id}
          categories={categoryNames}
        />
      </ConsoleOnly>
    </div>
  );
}
