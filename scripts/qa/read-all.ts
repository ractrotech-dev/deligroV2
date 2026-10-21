/**
 * QA — readAllRows pages past PostgREST's 1000-row cap without losing or
 * repeating a row. Offline. Usage:  npm run test:read-all
 */
import { readAllRows, readInChunks, READ_PAGE } from "../../src/lib/data-access/read-all";

let failed = 0, passed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}`, detail ?? ""); }
}

/** A table of `n` rows that, like PostgREST, never returns more than READ_PAGE per request. */
function table(n: number) {
  const calls: Array<[number, number]> = [];
  const page = (from: number, to: number) => {
    calls.push([from, to]);
    const end = Math.min(to, n - 1, from + READ_PAGE - 1);
    const data = from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => ({ id: from + i }));
    return Promise.resolve({ data, error: null as unknown });
  };
  return { page, calls };
}

async function main() {
  for (const n of [0, 1, 999, 1000, 1001, 2000, 2500]) {
    const t = table(n);
    const r = await readAllRows(t.page);
    const ids = r.data.map((x) => x.id);
    check(`${n} rows: all returned, in order, no duplicates, no error`,
      r.error === null && r.data.length === n && ids.every((id, i) => id === i), { got: r.data.length });
    const expectedCalls = Math.floor(n / READ_PAGE) + 1;
    check(`${n} rows: ${expectedCalls} request(s)`, t.calls.length === expectedCalls, t.calls.length);
  }

  // A sum over a 1000-row cut is the bug this exists for.
  const t = table(2500);
  const total = (await readAllRows(t.page)).data.length;
  check("a count over 2500 rows is 2500, not 1000", total === 2500, total);

  // An error on page 2 is reported, with what was read so far, never thrown.
  let n = 0;
  const failing = await readAllRows(() => {
    n++;
    return Promise.resolve(n === 2 ? { data: null, error: { message: "boom" } } : { data: Array.from({ length: READ_PAGE }, () => ({ id: n })), error: null });
  });
  check("an error mid-way is returned, not thrown", (failing.error as { message?: string })?.message === "boom");
  check("...with the rows read before it", failing.data.length === READ_PAGE);

  // A query that never ends reports it instead of looping or going quiet.
  const runaway = await readAllRows(() => Promise.resolve({ data: Array.from({ length: READ_PAGE }, () => ({ id: 1 })), error: null }));
  check("a runaway query stops with an error", runaway.error instanceof Error && /ceiling/.test(runaway.error.message));

  // A deliberate ceiling: report exactly what was cut, and only when something was.
  for (const [rows, cap, expectTruncated] of [[5000, 5000, false], [5001, 5000, true], [2500, 5000, false], [12000, 5000, true], [1000, 1000, false], [1001, 1000, true]] as const) {
    const r = await readAllRows(table(rows).page, { maxRows: cap });
    check(`${rows} rows with maxRows ${cap}: ${r.data.length} returned, truncated=${expectTruncated}`,
      r.error === null && r.truncated === expectTruncated && r.data.length === Math.min(rows, cap), { len: r.data.length, truncated: r.truncated });
  }
  const capped = await readAllRows(table(12000).page, { maxRows: 5000 });
  check("a capped read is the FIRST rows, in order", capped.data.every((x, i) => x.id === i));
  const tcalls = table(12000);
  await readAllRows(tcalls.page, { maxRows: 5000 });
  check("a capped read stops early instead of reading all 12 pages", tcalls.calls.length === 6, tcalls.calls.length);

  // IN lists: chunked so no URL carries thousands of ids.
  const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
  const seen: number[] = [];
  const chunked = await readInChunks(ids, (chunk) => { seen.push(chunk.length); return Promise.resolve({ data: chunk.map((id) => ({ id })), error: null }); });
  check("5000 ids go out in chunks of 100", seen.length === 50 && seen.every((n) => n === 100), seen.length);
  check("every id comes back exactly once, in order", chunked.error === null && chunked.data.length === 5000 && chunked.data.every((x, i) => x.id === `id-${i}`));
  check("no ids means no requests", (await readInChunks([], () => Promise.reject(new Error("must not be called")))).data.length === 0);
  check("a partial last chunk is sent", (await (async () => { const s: number[] = []; await readInChunks(ids.slice(0, 250), (c) => { s.push(c.length); return Promise.resolve({ data: [], error: null }); }); return s.join(); })()) === "100,100,50");
  const bad = await readInChunks(ids.slice(0, 300), (c) => Promise.resolve(c[0] === "id-100" ? { data: null, error: { message: "boom" } } : { data: [], error: null }));
  check("an error in one chunk is returned", (bad.error as { message?: string })?.message === "boom");

  // Bounded concurrency: 5000 ids are 50 chunks, never more than 6 in flight.
  {
    let inFlight = 0;
    let peak = 0;
    const many = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
    const r = await readInChunks(many, async (c) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 1));
      inFlight--;
      return { data: c.map((id) => ({ id })), error: null };
    });
    check("never more than 6 chunk requests at once", peak <= 6 && peak > 1, { peak });
    check("chunk results keep their order", r.data.length === 5000 && r.data.every((x, i) => x.id === `id-${i}`));
  }
  {
    let calls = 0;
    const many = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
    const r = await readInChunks(many, async (c) => {
      calls++;
      return c[0] === "id-0" ? { data: null, error: { message: "first" } } : { data: [], error: null };
    });
    check("an early error stops further chunks", (r.error as { message?: string })?.message === "first" && calls <= 6, { calls });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
