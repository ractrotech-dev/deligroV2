/**
 * The shape of one feature-switch change, shared by the client panel and the
 * server. Browser-safe: no server imports.
 */
export interface SwitchInput {
  feature: string;
  /** A shop or person id; null means role-wide. */
  subjectId: string | null;
  /** null clears the switch back to "inherit". */
  enabled: boolean | null;
}

export interface SwitchResult {
  ok: boolean;
  error?: string;
}
