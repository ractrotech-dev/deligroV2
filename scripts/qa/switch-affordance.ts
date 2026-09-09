/**
 * QA — a Switch's visible pill is actually clickable.
 *
 * `Switch` (components/ui/field.tsx) draws nothing itself. It renders a
 * visually-hidden checkbox plus a decorative `<span class="c-switch">`, and the
 * span is what an operator sees and aims at. A span is inert: it toggles the
 * checkbox only when a `<label>` reaches it — either an ancestor label wrapping
 * both, or its own `htmlFor` pointing at the input's id.
 *
 * The bug this file exists to catch: on /admin/settings/platform every switch
 * was rendered by `Row`, which closes its `<label>` *before* the control —
 *
 *     <div><label htmlFor="…">text</label>{children}</div>
 *
 * so the pill sat outside every label and clicking it did nothing at all. Only
 * the label *text* toggled the setting. `.c-switch` sets `cursor: pointer`, so
 * the dead control advertised itself as live. Four switches were affected —
 * accepting orders, grocery, pick & drop, and online payment — and the
 * platform-wide master switch was among them.
 *
 * `Toggle` in the same file never had the bug: it wraps label text *and*
 * `Switch` in one `<label>`, which is why it was the working reference that
 * located this.
 *
 * The contract asserted here:
 *   - given an `id`, the pill is a `<label for="that id">` — self-sufficient,
 *     clickable wherever a consumer puts it;
 *   - given no `id`, the pill stays an inert `aria-hidden` span, because the
 *     only consumer in that shape (`Toggle`) already encloses it in a label and
 *     nesting a second one there is invalid HTML;
 *   - the input and the pill stay adjacent siblings in that order, because the
 *     checked/disabled/focus styling is all `input:checked + .c-switch`;
 *   - no consumer passes an `id` from inside an enclosing label, which would
 *     nest labels.
 *
 * Renders for real via react-dom/server rather than grepping source, so it
 * asserts the markup a browser receives. Runs offline. No Supabase, no network.
 *
 * Usage:
 *   npm run test:switch
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { join } from "node:path";

import { Switch, Toggle } from "../../src/components/ui/field";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ""}`);
  }
}

console.log("\nSwitch affordance\n");

// ---------------------------------------------------------------------------
// 1. With an id: the pill must be a label bound to the input.
// ---------------------------------------------------------------------------
const withId = renderToStaticMarkup(
  createElement(Switch, { id: "featureOnlinePayment", name: "featureOnlinePayment" })
);

check(
  "pill is a <label>, not an inert span, when an id is given",
  /<label[^>]*class="[^"]*c-switch/.test(withId),
  `got: ${withId}`
);

check(
  "that label points at the input's id",
  /<label[^>]*for="featureOnlinePayment"/.test(withId),
  `got: ${withId}`
);

check(
  "the pill is not aria-hidden when it is the click target",
  !/<label[^>]*class="[^"]*c-switch[^"]*"[^>]*aria-hidden/.test(withId),
  "an interactive control hidden from assistive tech is unreachable by keyboard-and-screen-reader users"
);

// The styling is entirely `input:checked + .c-switch`, so order and adjacency
// are load-bearing, not incidental.
check(
  "input immediately precedes the pill (input:checked + .c-switch)",
  /<input[^>]*>\s*<(?:label|span)[^>]*class="[^"]*c-switch/.test(withId),
  `got: ${withId}`
);

check(
  "the input is still the form value carrier (name preserved, visually hidden)",
  /<input[^>]*name="featureOnlinePayment"/.test(withId) &&
    /<input[^>]*class="[^"]*sr-only/.test(withId),
  `got: ${withId}`
);

// ---------------------------------------------------------------------------
// 2. Without an id: stay an inert span. `Toggle` supplies the label itself, and
//    a <label> nested inside a <label> is invalid HTML.
// ---------------------------------------------------------------------------
const noId = renderToStaticMarkup(createElement(Switch, { name: "plain" }));

check(
  "pill stays a <span> when no id is given",
  /<span[^>]*class="[^"]*c-switch/.test(noId) && !/<label/.test(noId),
  `got: ${noId}`
);

check(
  "that span is aria-hidden (an ancestor label carries the semantics)",
  /<span[^>]*class="[^"]*c-switch[^"]*"[^>]*aria-hidden|aria-hidden[^>]*class="[^"]*c-switch/.test(
    noId
  ),
  `got: ${noId}`
);

const toggle = renderToStaticMarkup(
  createElement(Toggle, { name: "featureGrocery", label: "Grocery" })
);

check(
  "Toggle renders exactly one label — no nesting",
  (toggle.match(/<label/g) ?? []).length === 1,
  `got ${(toggle.match(/<label/g) ?? []).length} labels: ${toggle}`
);

check(
  "Toggle's single label encloses the pill",
  /<label[\s\S]*c-switch[\s\S]*<\/label>/.test(toggle),
  `got: ${toggle}`
);

// ---------------------------------------------------------------------------
// 3. No consumer may pass an id from inside an enclosing label — that is the
//    one arrangement this design cannot serve, and it would nest labels.
// ---------------------------------------------------------------------------
const consumers = ["src/app/admin/settings/settings-form.tsx", "src/components/ui/field.tsx"];

for (const file of consumers) {
  const src = read(file);
  // Every <Switch …> occurrence, with the JSX that opened before it still on
  // the stack: a crude but sufficient check that `Toggle` is the only place a
  // Switch sits inside a label, and that it is the one without an id.
  const switches = [...src.matchAll(/<Switch\b[^>]*?(\/?)>/gs)];
  for (const m of switches) {
    const before = src.slice(0, m.index ?? 0);
    const openLabels =
      (before.match(/<label\b/g) ?? []).length - (before.match(/<\/label>/g) ?? []).length;
    const hasId = /\bid=/.test(m[0]);
    check(
      `${file}: <Switch> ${hasId ? "with" : "without"} id is ${
        openLabels > 0 ? "inside" : "outside"
      } a label — compatible`,
      !(hasId && openLabels > 0),
      "a Switch with an id renders its own <label>; putting it inside another one nests labels"
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
