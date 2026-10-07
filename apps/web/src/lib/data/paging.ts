/*
 * Supabase answers at most 1000 rows per request, whatever `.limit()` asks
 * (checked on the live project: limit(5000) returned 1000). A screen that
 * reads a whole table must therefore page — and in a stable order, else a
 * busy day's rows are the ones that fall off (Suivi des commandes lost the
 * day's orders once the magasin passed 500 lines).
 */

export type PageResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Reads page after page until a page comes back short. `query(from, to)` must
 * end with a stable `.order(...)` (an `id` tiebreak at least) and `.range(from, to)`.
 */
export async function pageAll(
  query: (from: number, to: number) => PromiseLike<PageResult>,
  maxPages = 10,
): Promise<PageResult> {
  const PAGE = 1000;
  const rows: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await query(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return { data: rows, error: null };
}
