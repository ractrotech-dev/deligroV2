/**
 * Small text checks written as plain loops instead of backtracking regular
 * expressions, so their running time grows in step with the text and a long
 * hostile string cannot make a server request crawl. Pure and browser-safe.
 */

/** "https://x.test///" → "https://x.test". */
export function stripTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 47) end -= 1;
  return text.slice(0, end);
}

/** Removes one kind of character from both ends: ("--a-b--", "-") → "a-b". */
export function trimEdges(text: string, char: string): string {
  const code = char.codePointAt(0);
  let start = 0;
  let end = text.length;
  while (start < end && text.codePointAt(start) === code) start += 1;
  while (end > start && text.codePointAt(end - 1) === code) end -= 1;
  return text.slice(start, end);
}

/** Removes hyphens from both ends: "--a-b--" → "a-b". */
export function trimHyphens(text: string): string {
  return trimEdges(text, "-");
}

/** Removes every "( ... )" note: "veg (yes/no) x" → "veg  x". An unclosed "(" stays. */
export function removeParentheticals(text: string): string {
  let out = text;
  for (let open = out.indexOf("("); open !== -1; open = out.indexOf("(", open)) {
    const close = out.indexOf(")", open + 1);
    if (close === -1) break;
    out = out.slice(0, open) + out.slice(close + 1);
  }
  return out;
}

/**
 * Drops a trailing "(...)" note from a name: "Paneer Tikka (Half)  " →
 * "Paneer Tikka". The note starts at the first "(" after which nothing but
 * that one closing ")" and spaces follow, exactly as `/\s*\([^)]*\)\s*$/` did.
 */
export function stripTrailingParenthetical(name: string): string {
  const text = name.trimEnd();
  if (!text.endsWith(")")) return name;
  const close = text.length - 1;
  let open = text.indexOf("(");
  while (open !== -1) {
    if (text.indexOf(")", open) === close) return text.slice(0, open).trimEnd();
    open = text.indexOf("(", open + 1);
  }
  return name;
}

/**
 * A whole string shaped like an email address: something@domain.tld, with no
 * spaces or second "@", and no empty part between dots in the domain.
 */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Whether the text has an email address anywhere in it: some "@" with a name
 * right before it and, in the unbroken run after it, a dot with a character on
 * both sides. Deliberately loose, for a privacy filter that would sooner hide
 * too much than too little.
 */
export function containsEmail(text: string): boolean {
  const space = /\s/;
  let at = text.indexOf("@");
  while (at !== -1) {
    const before = at > 0 ? text[at - 1] : "";
    if (before !== "" && before !== "@" && !space.test(before)) {
      let end = at + 1;
      while (end < text.length && text[end] !== "@" && !space.test(text[end])) end += 1;
      for (let dot = at + 2; dot <= end - 2; dot += 1) if (text[dot] === ".") return true;
    }
    at = text.indexOf("@", at + 1);
  }
  return false;
}
