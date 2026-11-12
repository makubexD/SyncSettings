import type { Os } from "./config/types.ts";

const NUL = 0x00;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const VERTICAL_TAB = 0x0b;
const FORM_FEED = 0x0c;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;

export interface CompareOptions {
  readonly os: Os;
  readonly shared: boolean;
  readonly sanitized: boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function containsNul(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === NUL) {
      return true;
    }
  }
  return false;
}

/** CRLF pairs become LF; a carriage return on its own stays. */
export function foldCrlf(bytes: Uint8Array): Uint8Array {
  const folded = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) {
      break;
    }
    if (byte === CARRIAGE_RETURN && bytes[i + 1] === LINE_FEED) {
      continue;
    }
    folded[length] = byte;
    length++;
  }
  return folded.subarray(0, length);
}

/** Every carriage return goes, as bash `a=${a//$'\r'/}` does. */
function withoutCarriageReturns(bytes: Uint8Array): Uint8Array {
  const kept = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === undefined) {
      break;
    }
    if (byte !== CARRIAGE_RETURN) {
      kept[length] = byte;
      length++;
    }
  }
  return kept.subarray(0, length);
}

/** The bytes `[[:space:]]` matches in the C locale. */
function isWhitespace(byte: number): boolean {
  return (
    byte === SPACE ||
    byte === TAB ||
    byte === LINE_FEED ||
    byte === VERTICAL_TAB ||
    byte === FORM_FEED ||
    byte === CARRIAGE_RETURN
  );
}

function trimTrailingWhitespace(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0) {
    const byte = bytes[end - 1];
    if (byte === undefined || !isWhitespace(byte)) {
      break;
    }
    end--;
  }
  return bytes.subarray(0, end);
}

/** `same_normalized` in `scripts/linux/sync.sh`, on bytes. */
function normalizeSanitized(bytes: Uint8Array): Uint8Array {
  return trimTrailingWhitespace(withoutCarriageReturns(bytes));
}

/**
 * Whether a local and a repo file hold the same content.
 *
 * Sanitized entries compare the already sanitized or hydrated text with line
 * endings folded and trailing whitespace trimmed. Shared files without rules
 * fold CRLF on Windows unless either side holds a NUL byte. Everything else is
 * byte for byte.
 */
export function same(
  repo: Uint8Array,
  local: Uint8Array,
  options: CompareOptions,
): boolean {
  if (options.sanitized) {
    return sameBytes(normalizeSanitized(repo), normalizeSanitized(local));
  }
  if (
    options.os === "windows" &&
    options.shared &&
    !containsNul(repo) &&
    !containsNul(local)
  ) {
    return sameBytes(foldCrlf(repo), foldCrlf(local));
  }
  return sameBytes(repo, local);
}
