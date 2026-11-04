import { MetricRow } from "@/components/admin/console";
import type { VendorDetail } from "@/lib/data-access/admin-vendors";

/** The shop's legal numbers, as cards like the other tabs'. Each opens the edit page. */
export function LegalNumbers({
  v,
  editHref,
}: Readonly<{
  v: Pick<VendorDetail, "fssaiNumber" | "gstNumber" | "panNumber">;
  editHref: string;
}>) {
  const card = (label: string, value: string | null) => ({
    label,
    value: value || "Not added",
    note: value ? "Change on the edit page" : "Add on the edit page",
    href: editHref,
  });
  return (
    <MetricRow
      items={[
        card("FSSAI number", v.fssaiNumber),
        card("GST number", v.gstNumber),
        card("PAN number", v.panNumber),
      ]}
    />
  );
}
