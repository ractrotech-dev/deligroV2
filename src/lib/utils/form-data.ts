/**
 * A text field from a submitted form.
 *
 * `FormData.get` returns `string | File | null`. Only a string is a text value:
 * a missing field and a File posted where text was expected both read as
 * `fallback`, rather than `String()` turning the File into "[object File]".
 */
export function formString(form: FormData, key: string, fallback = ""): string {
  const value = form.get(key);
  return typeof value === "string" ? value : fallback;
}
