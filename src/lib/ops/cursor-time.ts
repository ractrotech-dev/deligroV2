/**
 * A cursor's timestamp goes into a PostgREST `.or()` filter, so it must be
 * exactly a timestamp and nothing else: `Date.parse` accepts text such as
 * "2026-10-21 (a,b)" that would bend the filter into a 400 or an odd query
 * (review #18). Browser-safe.
 */
export const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export const isCursorTime = (v: string): boolean => CURSOR_TIME.test(v) && !Number.isNaN(Date.parse(v));
