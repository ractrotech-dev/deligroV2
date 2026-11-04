"use server";


export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Non-blocking: the action succeeded, but there's something to know about it. */
  warning?: string;
  /** The machine-readable outcome, where the screen acts on it. */
  code?: string;
}

