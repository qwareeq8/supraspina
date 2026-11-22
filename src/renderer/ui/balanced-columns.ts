/**
 * Count the columns that wrap a band of equal tiles into even rows, so a
 * narrow band splits 8 tiles 4 + 4 rather than 7 + 1 or 6 + 2.
 *
 * @param width - The band's content width (px).
 * @param count - The number of tiles.
 * @param minTile - The narrowest a tile may draw (px).
 * @param gap - The gap between tiles (px).
 * @returns The column count, at least 1.
 */
export function balancedColumns(
  width: number,
  count: number,
  minTile: number,
  gap: number,
): number {
  if (count <= 0) return 1
  const fit = Math.max(1, Math.floor((width + gap) / (minTile + gap)))
  const rows = Math.ceil(count / fit)
  return Math.ceil(count / rows)
}
