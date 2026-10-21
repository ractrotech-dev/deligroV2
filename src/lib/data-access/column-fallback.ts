/**
 * Writing columns a database may not have yet, and recovering when it does.
 *
 * Deliberately free of `server-only` and of any import: it only decides what to
 * retry, on a write function the caller supplies, so `scripts/qa/driver-app.ts`
 * can run it against a mocked write. The latch itself stays in `schema-probe`.
 */

interface WriteError {
  code?: string;
  message?: string;
}

/**
 * A missing column looks different on a write than on a read. A SELECT reaches
 * Postgres and fails with 42703 (`isMissingColumn`); an INSERT or UPDATE naming
 * an unknown column never gets that far — PostgREST checks it against its
 * schema cache and answers PGRST204. Checking 42703 alone on a write meant the
 * fallback never fired (see the same note in admin-commission.ts).
 */
export function isMissingColumnOnWrite(error: WriteError | null): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/** The per-process "does this database have the column?" memory, by key. */
export interface ColumnLatch {
  knownMissing: () => boolean;
  remember: (present: boolean) => void;
}

/**
 * Run `write(true)` (with the optional columns) unless they are known missing;
 * on a missing-column answer, latch them missing and run `write(false)`.
 *
 * `reprobeOn` covers the other direction. The latch lives for the process, so
 * an instance that wrote before a migration keeps writing without its columns
 * after it — and when the migration also added a rule those columns satisfy,
 * the database now refuses the write. An error `reprobeOn` recognises, while
 * latched missing, is taken as that: the columns are tried once more, and the
 * latch follows the answer. If they really are still missing, the original
 * error is what the caller gets.
 */
export async function writeWithColumnFallback<R extends { error: WriteError | null }>(
  latch: ColumnLatch,
  write: (withColumns: boolean) => PromiseLike<R>,
  reprobeOn?: (error: WriteError) => boolean
): Promise<R> {
  if (latch.knownMissing()) {
    const first = await write(false);
    if (!first.error || !reprobeOn?.(first.error)) return first;

    const probe = await write(true);
    if (isMissingColumnOnWrite(probe.error)) return first;
    // Any other answer got past PostgREST's column check, so the columns exist
    // — even if the database refused the write itself for a reason of its own.
    latch.remember(true);
    return probe;
  }

  const result = await write(true);
  if (result.error && isMissingColumnOnWrite(result.error)) {
    latch.remember(false);
    return write(false);
  }
  if (!result.error) latch.remember(true);
  return result;
}
