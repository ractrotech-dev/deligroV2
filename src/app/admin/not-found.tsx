import Link from "next/link";
import { SearchX } from "lucide-react";
import { EmptyState } from "@/components/admin/admin-ui";

/**
 * 404 inside the admin section.
 *
 * This is a routine screen, not an edge case: `/admin/orders/[id]` and
 * `/admin/customers/[id]` both call `notFound()` for an id that does not exist,
 * one that is not a uuid, and (for customers) one belonging to a non-customer
 * profile. All three answer identically on purpose, so the page never confirms
 * that an id exists somewhere else in the system.
 */
export default function AdminNotFound() {
  return (
    <EmptyState
      icon={SearchX}
      title="Not found"
      description="This record doesn't exist, or it has been removed since the link was made."
      action={
        <Link href="/admin" className="c-btn c-btn-outline">
          Back to dashboard
        </Link>
      }
    />
  );
}
