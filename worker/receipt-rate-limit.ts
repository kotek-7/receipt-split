const UNKNOWN_KEY = 'receipt-scan:unknown';

/** Keep one quota per IPv4 address or IPv6 /64, independent of address notation. */
export function receiptRateLimitKey(address: string | null | undefined): string {
  if (!address || address.length > 45) return UNKNOWN_KEY;
  if (!address.includes(':')) {
    // Reject legacy octal/hex/short IPv4 notation instead of creating extra buckets.
    const parts = address.split('.');
    if (
      parts.length !== 4 ||
      parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
    )
      return UNKNOWN_KEY;
    return `receipt-scan:${address}`;
  }

  // The platform URL parser validates IPv6 compression and dotted IPv4 tails.
  // Forbid URL syntax and scoped addresses; this input is an IP, not a URL.
  if (!/^[\da-f:.]+$/i.test(address)) return UNKNOWN_KEY;
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return UNKNOWN_KEY;
  }
  const [left, right] = canonical.split('::');
  const leading = left ? left.split(':').map((part) => Number.parseInt(part, 16)) : [];
  const trailing = right ? right.split(':').map((part) => Number.parseInt(part, 16)) : [];
  const words =
    right === undefined
      ? leading
      : [...leading, ...Array<number>(8 - leading.length - trailing.length).fill(0), ...trailing];

  // ::ffff:a.b.c.d and its hexadecimal spelling represent the same IPv4 client.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `receipt-scan:${[words[6] >>> 8, words[6] & 255, words[7] >>> 8, words[7] & 255].join('.')}`;
  }
  return `receipt-scan:${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(':')}::/64`;
}
