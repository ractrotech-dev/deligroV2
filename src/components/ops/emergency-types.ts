/**
 * One open rider emergency as the red banner shows it (admin home, manager
 * board). Plain data, so a server page and the polling action can both hand
 * it to the client banner.
 */
export interface EmergencyItem {
  id: string;
  number: number;
  categoryLabel: string;
  subject: string;
  status: string;
  riderName: string;
  riderCode: string | null;
  /** Null when the viewer may not call riders (manager.call_customer off). */
  riderPhone: string | null;
  orderId: string | null;
  orderCode: string | null;
  locationUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** A staff member has taken it. */
  assigned: boolean;
}
