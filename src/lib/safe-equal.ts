/** Compares two strings in time independent of how early they differ. */
export function safeEqual(a: string, b: string): boolean {
  // Lengths are compared through the accumulator too, so an early length
  // mismatch does not shortcut the loop.
  let mismatch = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
