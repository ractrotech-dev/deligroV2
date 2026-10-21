/**
 * How long an order may sit without a rider before it counts as a dispatch
 * failure. Matches the reassignment window the settings screen describes.
 *
 * Its own module so the dispatch sweep can read it without importing the admin
 * data layer (and, through it, the request-bound auth helpers).
 */
export const UNASSIGNED_AFTER_MIN = 8;
