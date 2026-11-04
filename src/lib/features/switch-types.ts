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

/** The four sections of Admin → App features. */
export type AccountFeatureRole = "customer" | "vendor" | "driver" | "manager";

/** One customer, shop, rider or manager in the panel. */
export interface FeatureAccount {
  id: string;
  name: string;
  /** A phone number or an address, to tell two of the same name apart. */
  detail: string | null;
}

/** One row of a section's table. */
export interface FeatureRow {
  key: string;
  group: string;
  label: string;
  offMeans: string;
  /** Why it can't be changed yet (FeatureDef.pending), or null. */
  pending: string | null;
  defaultOn: boolean;
  /** What everyone gets. */
  on: boolean;
  /** How many accounts have a different setting. */
  different: number;
}

export interface FeatureAccountExceptions {
  account: FeatureAccount;
  /** The features where this account differs from everyone. */
  features: string[];
}

/** One feature for one account, with who set it where that is recorded. */
export interface AccountSwitch {
  feature: string;
  /** Null: same as everyone. */
  own: boolean | null;
  changedBy: string | null;
  changedAt: string | null;
}

/**
 * The Server Actions the panel calls. Each page passes its own, gated on its own
 * role (admin or developer).
 */
export interface FeatureActions {
  save: (input: SwitchInput) => Promise<SwitchResult>;
  saveMany: (inputs: SwitchInput[]) => Promise<SwitchResult>;
  search: (role: AccountFeatureRole, q: string) => Promise<FeatureAccount[]>;
  loadAccount: (role: AccountFeatureRole, id: string) => Promise<AccountSwitch[]>;
}
