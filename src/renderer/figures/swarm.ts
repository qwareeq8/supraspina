/**
 * Beeswarm layout: place markers at their value along one axis and push them
 * sideways just enough that no two overlap, closest to the center line first.
 */

/** One placed marker: its offset from the center line and its value axis position. */
export interface SwarmPoint {
  index: number
  /** The sideways offset from the group's center line. */
  dx: number
  /** The position along the value axis. */
  y: number
}

/**
 * Lay out a beeswarm.
 *
 * Markers are placed in order of position; each takes the offset nearest
 * the center line that keeps its center at least `diameter` from every
 * marker already placed. Ties alternate sides so the swarm stays balanced.
 *
 * @param positions - Each marker's position along the value axis.
 * @param diameter - The least center-to-center distance.
 * @returns One point per input, in input order.
 */
export function beeswarm(
  positions: readonly number[],
  diameter: number,
): SwarmPoint[] {
  const order = positions
    .map((y, index) => ({ y, index }))
    .sort((a, b) => a.y - b.y || a.index - b.index)
  const placed: SwarmPoint[] = []
  const out = new Array<SwarmPoint>(positions.length)
  const d2 = diameter * diameter
  let flip = false
  for (const { y, index } of order) {
    const blocked: [number, number][] = []
    for (const other of placed) {
      const dy = y - other.y
      if (Math.abs(dy) >= diameter) continue
      const half = Math.sqrt(d2 - dy * dy)
      blocked.push([other.dx - half, other.dx + half])
    }
    const candidates = [0]
    for (const [lo, hi] of blocked) candidates.push(lo, hi)
    const free = (x: number): boolean =>
      blocked.every(([lo, hi]) => x <= lo + 1e-9 || x >= hi - 1e-9)
    let best: number | null = null
    for (const x of candidates) {
      if (!free(x)) continue
      if (
        best === null ||
        Math.abs(x) < Math.abs(best) - 1e-9 ||
        (Math.abs(Math.abs(x) - Math.abs(best)) <= 1e-9 &&
          (flip ? x < best : x > best))
      ) {
        best = x
      }
    }
    const dx = best ?? 0
    if (dx !== 0) flip = !flip
    const point = { index, dx, y }
    placed.push(point)
    out[index] = point
  }
  return out
}

/** Where one group's swarm and its mean-and-CI bar sit. */
export interface SwarmUnit {
  /** The swarm's center line. */
  swarm: number
  /** The bar's position, or null for a group without a mean. */
  cross: number | null
}

/**
 * Place a swarm and its adjusted-mean bar as one unit centered on its slot:
 * the bar stands `gap` beyond the swarm's widest marker, so it reads as the
 * swarm's own, and the group label centered on the slot sits under both.
 *
 * @param halfWidth - The swarm's half width, markers included.
 * @param crossHalf - The half width of the bar's mean tick.
 * @param gap - The space between swarm and bar.
 * @param hasMean - Whether the group has a bar.
 * @returns The swarm center and the bar position.
 */
export function swarmUnit(
  center: number,
  halfWidth: number,
  crossHalf: number,
  gap: number,
  hasMean: boolean,
): SwarmUnit {
  if (!hasMean) return { swarm: center, cross: null }
  const swarm = center - (gap + 2 * crossHalf) / 2
  return { swarm, cross: swarm + halfWidth + gap + crossHalf }
}
