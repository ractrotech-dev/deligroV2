/**
 * Structured data for search engines.
 *
 * Separate from `InlineScript` on purpose: that one exists to *execute* before
 * paint and deliberately renders inert on the client to dodge a React warning.
 * This is data, never executed by the browser at all, and must render
 * identically on both sides — a crawler reads it out of the server HTML, and
 * flipping its type on hydration would be pointless noise.
 *
 * `JSON.stringify` is the escaping story. The one sequence it does not escape
 * that matters inside a <script> element is `</`, which would close the tag
 * early and let a restaurant name containing `</script>` inject markup — so
 * that is handled explicitly below.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, String.raw`\u003c`),
      }}
    />
  );
}
