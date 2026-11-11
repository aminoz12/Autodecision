/** « 3 pièces », « 1 ligne » — the small French plural used by the shelving page. */
export function countOf(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}
