# Manager app terminology

The Manager app speaks the client document's words. English only; no Hindi anywhere
on the manager side. `npm run test:manager-english` checks Hindi and `tr()`;
`npm run test:manager-english -- --strict-terms` also checks the table below;
`npm run test:manager-spec-labels` checks the 18 dashboard figures and 12 report
names against the document.

| Say (the document's term) | Do not say, in text a manager reads |
|---|---|
| Order ID | order code, order number, receipt code (the short code is shown *as* the Order ID) |
| Vendor | shop, restaurant, kitchen (as a noun for the business) |
| Rider | driver, courier, delivery boy |
| Delivery Zone (or Zone) | area, region, territory |
| Platform Commission | cut, fee kept, take |
| Vendor Payments Due | shop dues, amounts owed to shops |
| Rider Payments Due | driver dues |
| Settlement | payout batch, statement (a *vendor* settlement; riders have *payouts*) |
| Marketing Request | promo request, ad request |
| Support Ticket | complaint ticket, case |
| Cancelled Orders | dropped orders, failed orders (failed = a delivery that could not be completed) |
| Gross Sales / Net Sales | revenue, takings, turnover |
| Deligro-funded / Vendor-funded discount | platform-funded |

**"Store" stays.** The document itself says "store information" (§4.6) and "store
opening hours" (§4.7), so those two phrases keep the word.

**Exact wording.** The dashboard's eighteen figures (§1) and the twelve report names
(§13) are copied from the document, word for word. The app writes the report names in
sentence case ("Sales report"); the words are the same.

**Not covered.** Field names in JSON, database columns, route paths and permission keys
keep their code names (`driver_id`, `/api/manager/riders`, `manager.riders.view`). Only
text a person reads follows this table.

## Status of the copy pass (2026-10-23)

`--strict-terms` currently reports 88 user-facing strings, almost all the word "shop"
where the table says "Vendor", in the marketing, offers, finance, vendors and orders
screens, three report descriptions and three alert descriptions. They were left alone
while the Phase 7 fixes and Phase 9 were still changing the same files; the final
release pass fixes them and turns `--strict-terms` on in the full QA run.
