/**
 * Where a staff notice opens in the Manager app. Older ops notices (an order
 * stuck, a rider's SOS, a cash deposit) were written with the website's path —
 * "/manager", "/manager/support/<id>", "/admin/orders/<id>" — which the app
 * cannot open from its inbox; the inbox row now carries an app path and the ids
 * the app routes on (review #12). Pure, so it is tested offline.
 */

const ID = /^[0-9a-fA-F-]{8,}$/;
/** App routes that may be kept exactly as given. */
const APP_PATH = /^\/(orders|live|finance|more|alerts|inbox|stats)(\/[A-Za-z0-9_:.\-]+)*\/?(\?[A-Za-z0-9_=&.%\-]*)?$/;

export interface OpsLink {
  /** The app path (a relative link; never another site). */
  url: string;
  /** Ids the app routes on, beside the path. */
  data: Record<string, string>;
}

export function opsAppLink(url: string, ids: { orderId?: string | null; ticketId?: string | null } = {}): OpsLink {
  const order = ids.orderId && ID.test(ids.orderId) ? ids.orderId : null;
  const fromUrlOrder = /^\/(?:admin\/)?orders\/([0-9a-fA-F-]{8,})$/.exec(url)?.[1] ?? null;
  const ticket = ids.ticketId && ID.test(ids.ticketId)
    ? ids.ticketId
    : (/^\/(?:manager|admin)\/(?:support|tickets)\/([0-9a-fA-F-]{8,})$/.exec(url)?.[1] ?? null);

  if (ticket) return { url: `/more/tickets/${ticket}`, data: { ticketId: ticket, ...(order ? { orderId: order } : {}) } };
  const orderId = order ?? fromUrlOrder;
  if (orderId) return { url: `/orders/${orderId}`, data: { orderId } };
  if (url === "/manager/cash") return { url: "/more/cash", data: {} };
  if (APP_PATH.test(url) && !url.includes("..")) return { url, data: {} };
  return { url: "/", data: {} };
}
