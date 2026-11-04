/**
 * Every action written to `ops_audit_log` (§16), by an audited RPC or by the
 * server through `logOpsAction` / `auditedChange` — its code, a plain label and
 * the group the audit screen files it under. The catalog is held equal to those
 * writers by scripts/qa/manager-audit-coverage.ts: a logged code that is missing
 * here, or a code here that nothing writes, fails the check.
 *
 * Browser-safe. English only.
 */

export type AuditGroup =
  | "Orders" | "Deliveries" | "Vendors" | "Products" | "Riders" | "Finance"
  | "Marketing" | "Offers" | "Customers" | "Support" | "Alerts" | "Access";

export interface AuditActionDef {
  code: string;
  label: string;
  group: AuditGroup;
  /** Money, accounts or personal data: shown first on the audit screen. */
  sensitive: boolean;
}

export const AUDIT_ACTIONS: readonly AuditActionDef[] = [
  // Orders (0142)
  { code: "order.advance", label: "Order moved to its next step", group: "Orders", sensitive: false },
  { code: "order.cancel", label: "Order cancelled", group: "Orders", sensitive: true },
  { code: "order.correct.status", label: "Order status corrected", group: "Orders", sensitive: true },
  { code: "order.correct.delivery_status", label: "Delivery status corrected", group: "Orders", sensitive: true },
  { code: "order.correct.item_unavailable", label: "Item marked unavailable", group: "Orders", sensitive: true },
  { code: "order.correct.address_note", label: "Delivery note for the rider", group: "Orders", sensitive: false },
  { code: "order.note", label: "Order note added", group: "Orders", sensitive: false },
  { code: "order.contact_view", label: "Customer number shown on an order in flight", group: "Orders", sensitive: true },
  { code: "order.escalate", label: "Order escalated", group: "Orders", sensitive: false },
  // Deliveries (0142)
  { code: "delivery.assign", label: "Rider assigned", group: "Deliveries", sensitive: false },
  { code: "delivery.assign.override", label: "Rider assigned (override)", group: "Deliveries", sensitive: true },
  { code: "delivery.reassign", label: "Rider reassigned", group: "Deliveries", sensitive: false },
  { code: "delivery.reassign.override", label: "Rider reassigned (override)", group: "Deliveries", sensitive: true },
  { code: "delivery.exception.approve", label: "Rider's request approved", group: "Deliveries", sensitive: true },
  { code: "delivery.exception.reject", label: "Rider's request rejected", group: "Deliveries", sensitive: false },
  // Vendors (0145)
  { code: "vendor.approve", label: "Vendor approved", group: "Vendors", sensitive: true },
  { code: "vendor.reject", label: "Vendor rejected", group: "Vendors", sensitive: true },
  { code: "vendor.suspend", label: "Vendor suspended", group: "Vendors", sensitive: true },
  { code: "vendor.reactivate", label: "Vendor reactivated", group: "Vendors", sensitive: true },
  { code: "vendor.status", label: "Vendor status set by an admin", group: "Vendors", sensitive: true },
  { code: "vendor.onboard", label: "Vendor onboarded", group: "Vendors", sensitive: true },
  { code: "vendor.document.verified", label: "Vendor document verified", group: "Vendors", sensitive: false },
  { code: "vendor.document.rejected", label: "Vendor document rejected", group: "Vendors", sensitive: false },
  { code: "vendor.document.upload", label: "Vendor document uploaded", group: "Vendors", sensitive: false },
  // Written by the admin console through auditedChange().
  { code: "vendor.edit", label: "Shop details changed", group: "Vendors", sensitive: true },
  { code: "vendor.delete", label: "Shop deleted", group: "Vendors", sensitive: true },
  { code: "vendor.open_set", label: "Shop opened or closed by an admin", group: "Vendors", sensitive: false },
  { code: "category.create", label: "Shop category added", group: "Vendors", sensitive: false },
  { code: "category.update", label: "Shop category changed", group: "Vendors", sensitive: false },
  { code: "category.enable", label: "Shop category switched on or off", group: "Vendors", sensitive: false },
  { code: "category.delete", label: "Shop category deleted", group: "Vendors", sensitive: false },
  { code: "category.image", label: "Category picture changed", group: "Vendors", sensitive: false },
  // Products (0146)
  { code: "product.flag", label: "Listing flagged", group: "Products", sensitive: false },
  { code: "product.flag.resolved", label: "Listing flag resolved", group: "Products", sensitive: false },
  { code: "product.flag.dismissed", label: "Listing flag dismissed", group: "Products", sensitive: false },
  { code: "product.hide", label: "Dish hidden from customers", group: "Products", sensitive: false },
  { code: "product.unhide", label: "Dish shown again", group: "Products", sensitive: false },
  { code: "product.approve", label: "Restricted change approved", group: "Products", sensitive: false },
  { code: "product.reject", label: "Restricted change rejected", group: "Products", sensitive: false },
  { code: "product.stock", label: "Stock adjusted", group: "Products", sensitive: true },
  { code: "product.restricted_category", label: "Restricted categories changed", group: "Products", sensitive: false },
  { code: "product.image_review", label: "Dish photo reviewed", group: "Products", sensitive: false },
  { code: "product.photo_replace", label: "Dish photo replaced", group: "Products", sensitive: true },
  { code: "product.bulk_menu", label: "Menu sheet uploaded", group: "Products", sensitive: true },
  { code: "zone.weather", label: "Zone weather set", group: "Alerts", sensitive: false },
  // Riders (0151)
  { code: "rider.verify", label: "Rider verified", group: "Riders", sensitive: true },
  { code: "rider.reject", label: "Rider rejected", group: "Riders", sensitive: true },
  { code: "rider.suspend", label: "Rider suspended", group: "Riders", sensitive: true },
  { code: "rider.reactivate", label: "Rider reactivated", group: "Riders", sensitive: true },
  { code: "rider.force_offline", label: "Rider taken offline", group: "Riders", sensitive: false },
  { code: "rider.onboard", label: "Rider onboarded", group: "Riders", sensitive: true },
  { code: "rider.adjustment", label: "Rider pay adjustment", group: "Riders", sensitive: true },
  { code: "rider.document.verify", label: "Rider document verified", group: "Riders", sensitive: false },
  { code: "rider.document.reject", label: "Rider document rejected", group: "Riders", sensitive: false },
  { code: "rider.document.upload", label: "Rider document uploaded", group: "Riders", sensitive: false },
  // Finance (0152, 0156)
  { code: "payment.request", label: "Payment requested", group: "Finance", sensitive: true },
  { code: "payment.approve", label: "Payment approved", group: "Finance", sensitive: true },
  { code: "payment.reject", label: "Payment rejected", group: "Finance", sensitive: true },
  { code: "payment.cancel", label: "Payment request withdrawn", group: "Finance", sensitive: true },
  { code: "payment.detach", label: "Payment request detached from a stale draft", group: "Finance", sensitive: true },
  { code: "payment.repoint", label: "Payment request moved to a rebuilt draft", group: "Finance", sensitive: true },
  { code: "settlement.void", label: "Settlement voided", group: "Finance", sensitive: true },
  { code: "settlement.correction", label: "Settlement correction recorded (refund after payout)", group: "Finance", sensitive: true },
  { code: "settlement.reverse", label: "Paid settlement reversed (second person approved)", group: "Finance", sensitive: true },
  { code: "refund.release", label: "Stuck refund released after checking the gateway", group: "Finance", sensitive: true },
  { code: "refund.approve", label: "Refund approved", group: "Finance", sensitive: true },
  { code: "refund.deny", label: "Refund denied", group: "Finance", sensitive: true },
  { code: "cash.deposit.confirm", label: "Cash deposit confirmed", group: "Finance", sensitive: true },
  { code: "cash.deposit.dispute", label: "Cash deposit disputed", group: "Finance", sensitive: true },
  { code: "cash.dispute.resolve", label: "Cash dispute resolved", group: "Finance", sensitive: true },
  { code: "cash.received", label: "Cash recorded as received by the owner", group: "Finance", sensitive: true },
  { code: "cash.handover.confirm", label: "Manager's cash handover confirmed by the owner", group: "Finance", sensitive: true },
  { code: "settings.single_admin_payments", label: "Sole-admin payments switch changed", group: "Finance", sensitive: true },
  // Marketing (0160)
  { code: "marketing.request_create", label: "Marketing request recorded for a vendor", group: "Marketing", sensitive: false },
  { code: "marketing.request_approve", label: "Marketing request approved", group: "Marketing", sensitive: false },
  { code: "marketing.request_reject", label: "Marketing request rejected", group: "Marketing", sensitive: false },
  { code: "marketing.request_progress", label: "Marketing request progress updated", group: "Marketing", sensitive: false },
  { code: "campaign.create", label: "Campaign created", group: "Marketing", sensitive: false },
  { code: "campaign.update", label: "Campaign changed", group: "Marketing", sensitive: false },
  { code: "campaign.cancel", label: "Campaign cancelled", group: "Marketing", sensitive: false },
  { code: "campaign.end_now", label: "Campaign ended early", group: "Marketing", sensitive: false },
  // Written by the admin console through auditedChange().
  { code: "banner.create", label: "Banner created", group: "Marketing", sensitive: false },
  { code: "banner.update", label: "Banner changed", group: "Marketing", sensitive: false },
  { code: "banner.status", label: "Banner status changed", group: "Marketing", sensitive: false },
  { code: "banner.delete", label: "Banner deleted", group: "Marketing", sensitive: false },
  // Offers (0161)
  { code: "offer.create", label: "Offer created", group: "Offers", sensitive: false },
  { code: "offer.update", label: "Offer rules changed", group: "Offers", sensitive: false },
  { code: "offer.activate", label: "Offer switched on", group: "Offers", sensitive: false },
  { code: "offer.deactivate", label: "Offer switched off", group: "Offers", sensitive: false },
  { code: "offer.delete", label: "Offer deleted", group: "Offers", sensitive: true },
  // Customers (0162)
  { code: "customer.phone_search", label: "Customer looked up by phone number", group: "Customers", sensitive: true },
  { code: "customer.contact_reveal", label: "Customer phone number revealed", group: "Customers", sensitive: true },
  { code: "customer.suspend", label: "Customer account suspended", group: "Customers", sensitive: true },
  { code: "customer.restrict", label: "Customer account restricted", group: "Customers", sensitive: true },
  { code: "customer.reactivate", label: "Customer account reactivated", group: "Customers", sensitive: true },
  // Support (0145, 0165)
  { code: "ticket.message", label: "Ticket reply or note", group: "Support", sensitive: false },
  { code: "ticket.status", label: "Ticket status changed", group: "Support", sensitive: false },
  { code: "ticket.reopen", label: "Ticket reopened", group: "Support", sensitive: false },
  { code: "ticket.assign", label: "Ticket assigned", group: "Support", sensitive: false },
  { code: "ticket.priority", label: "Ticket priority changed", group: "Support", sensitive: false },
  { code: "ticket.escalate", label: "Ticket escalated", group: "Support", sensitive: false },
  // Alerts (0166)
  { code: "alert.acknowledge", label: "Alert acknowledged", group: "Alerts", sensitive: false },
  { code: "alert.resolve", label: "Alert resolved", group: "Alerts", sensitive: false },
  { code: "alert.incident", label: "Incident raised", group: "Alerts", sensitive: false },
  { code: "alert_rule.set", label: "Alert threshold changed", group: "Alerts", sensitive: false },
  { code: "alert_rule.reset", label: "Alert threshold reset", group: "Alerts", sensitive: false },
  // Access (0141)
  { code: "city.create", label: "City added", group: "Access", sensitive: false },
  { code: "zone.create", label: "Zone added", group: "Access", sensitive: false },
  { code: "zone.update", label: "Zone changed", group: "Access", sensitive: false },
  { code: "staff.zones_set", label: "Staff zones changed", group: "Access", sensitive: true },
  { code: "feature.switch_set", label: "Permission switch changed", group: "Access", sensitive: true },
  { code: "session.revoke", label: "Device signed out", group: "Access", sensitive: true },
  { code: "session.revoke_others", label: "Other devices signed out", group: "Access", sensitive: true },
  // Team and rider access (0190): the change and its entry are one RPC.
  { code: "staff.stop", label: "Team member stopped", group: "Access", sensitive: true },
  { code: "staff.start", label: "Team member started again", group: "Access", sensitive: true },
  // Written by the server through log_ops_action() (the change itself is Supabase Auth's).
  { code: "password.change", label: "Password changed", group: "Access", sensitive: true },
  { code: "password.change_failed", label: "Password change refused", group: "Access", sensitive: true },
  { code: "staff.password_reset", label: "Team member's password reset", group: "Access", sensitive: true },
  { code: "audit.change_failed", label: "A logged change did not go through", group: "Access", sensitive: false },
];

export function auditActionDef(code: string): AuditActionDef | null {
  return AUDIT_ACTIONS.find((a) => a.code === code) ?? null;
}
