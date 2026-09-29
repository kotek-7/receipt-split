/** Row IDs are identifiers, not credentials. getRandomValues also works on LAN HTTP. */
export function createItemId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
