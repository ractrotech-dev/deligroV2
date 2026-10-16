/**
 * Callback ref that focuses an element when it mounts — what `autoFocus` does,
 * without the attribute. Module-level, so its identity is stable: React calls
 * it once on mount (and with `null` on unmount), never again on re-render,
 * which an inline `ref={(el) => el?.focus()}` would.
 */
export function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}
