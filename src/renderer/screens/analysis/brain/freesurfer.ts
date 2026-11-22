/**
 * Readers for the FreeSurfer surface files the brain viewer draws: triangle
 * surfaces (`lh.pial`), per-vertex curvature files (`lh.sulc`), and
 * annotations (`lh.aparc.annot`). Every file is big-endian. The bytes come
 * from main's allowlisted asset reader, so each reader bounds-checks the
 * layout and throws a TypeError instead of reading past the buffer.
 */

/** A triangle surface in FreeSurfer's surface RAS, in millimeters. */
export interface Surface {
  /** The x, y, z of each vertex. */
  positions: Float32Array
  /** Three vertex indices per triangle. */
  triangles: Uint32Array
  vertexCount: number
}

/** One annotation color-table entry. */
export interface AnnotationEntry {
  /** The structure name, for example `precentral`. */
  name: string
  /** The packed label value, r + g * 2^8 + b * 2^16. */
  value: number
  rgb: [number, number, number]
}

/** A per-vertex parcellation. */
export interface Annotation {
  /** The index into `entries` of each vertex, or -1 when unlabeled. */
  vertexEntry: Int32Array
  entries: AnnotationEntry[]
}

/** The largest vertex or triangle count a reader accepts. */
const MAX_ELEMENTS = 4_000_000
const MAX_NAME_BYTES = 4096

class Reader {
  private offset = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get position(): number {
    return this.offset
  }

  remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  need(count: number, what: string): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength) {
      throw new TypeError(`The ${what} ends early.`)
    }
  }

  u8(what: string): number {
    this.need(1, what)
    const value = this.view.getUint8(this.offset)
    this.offset += 1
    return value
  }

  i32(what: string): number {
    this.need(4, what)
    const value = this.view.getInt32(this.offset, false)
    this.offset += 4
    return value
  }

  f32(what: string): number {
    this.need(4, what)
    const value = this.view.getFloat32(this.offset, false)
    this.offset += 4
    return value
  }

  text(length: number, what: string): string {
    if (length < 0 || length > MAX_NAME_BYTES) {
      throw new TypeError(`The ${what} has an invalid name length.`)
    }
    this.need(length, what)
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    const end = slice.indexOf(0)
    return new TextDecoder('latin1').decode(
      end >= 0 ? slice.subarray(0, end) : slice,
    )
  }

  skip(count: number, what: string): void {
    this.need(count, what)
    this.offset += count
  }

  indexOf(sequence: readonly number[], from: number): number {
    outer: for (let i = from; i + sequence.length <= this.bytes.length; i++) {
      for (let j = 0; j < sequence.length; j++) {
        if (this.bytes[i + j] !== sequence[j]) continue outer
      }
      return i
    }
    return -1
  }

  tailText(): string {
    return new TextDecoder('latin1').decode(this.bytes.subarray(this.offset))
  }
}

function count(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_ELEMENTS) {
    throw new TypeError(`The ${what} has an invalid element count.`)
  }
  return value
}

/**
 * Read a FreeSurfer triangle surface, applying the `cras` offset of its
 * volume-geometry footer when one is present.
 *
 * @throws TypeError when the bytes are not a valid triangle surface.
 */
export function readSurface(bytes: Uint8Array): Surface {
  const reader = new Reader(bytes)
  const magic = [
    reader.u8('surface'),
    reader.u8('surface'),
    reader.u8('surface'),
  ]
  if (magic[0] !== 0xff || magic[1] !== 0xff || magic[2] !== 0xfe) {
    throw new TypeError('The file is not a FreeSurfer triangle surface.')
  }
  const commentEnd = reader.indexOf([0x0a, 0x0a], reader.position)
  if (commentEnd < 0) throw new TypeError('The surface header ends early.')
  reader.skip(commentEnd + 2 - reader.position, 'surface header')
  const vertexCount = count(reader.i32('surface'), 'surface')
  const triangleCount = count(reader.i32('surface'), 'surface')
  reader.need(vertexCount * 12 + triangleCount * 12, 'surface')
  const positions = new Float32Array(vertexCount * 3)
  for (let i = 0; i < positions.length; i++)
    positions[i] = reader.f32('surface')
  const triangles = new Uint32Array(triangleCount * 3)
  for (let i = 0; i < triangles.length; i++) {
    const index = reader.i32('surface')
    if (index < 0 || index >= vertexCount) {
      throw new TypeError('The surface names a vertex it does not have.')
    }
    triangles[i] = index
  }
  const cras = /cras\s*=\s*(\S+)\s+(\S+)\s+(\S+)/.exec(reader.tailText())
  if (cras) {
    const offset = cras.slice(1, 4).map(Number)
    if (offset.every(Number.isFinite) && offset.some((v) => v !== 0)) {
      for (let i = 0; i < positions.length; i++) {
        positions[i] = positions[i]! + offset[i % 3]!
      }
    }
  }
  return { positions, triangles, vertexCount }
}

/**
 * Read a FreeSurfer per-vertex curvature file (the "new" format of
 * `lh.sulc`).
 *
 * @returns One value per vertex.
 * @throws TypeError when the bytes are not a valid curvature file.
 */
export function readCurvature(bytes: Uint8Array): Float32Array {
  const reader = new Reader(bytes)
  const magic = [
    reader.u8('curvature'),
    reader.u8('curvature'),
    reader.u8('curvature'),
  ]
  if (magic[0] !== 0xff || magic[1] !== 0xff || magic[2] !== 0xff) {
    throw new TypeError('The file is not a FreeSurfer curvature file.')
  }
  const vertexCount = count(reader.i32('curvature'), 'curvature')
  reader.i32('curvature')
  if (reader.i32('curvature') !== 1) {
    throw new TypeError(
      'The curvature file has more than one value per vertex.',
    )
  }
  reader.need(vertexCount * 4, 'curvature')
  const values = new Float32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) values[i] = reader.f32('curvature')
  return values
}

function readEntry(reader: Reader): AnnotationEntry {
  const name = reader.text(reader.i32('annotation'), 'annotation')
  const r = reader.i32('annotation')
  const g = reader.i32('annotation')
  const b = reader.i32('annotation')
  reader.i32('annotation')
  if ([r, g, b].some((c) => c < 0 || c > 255)) {
    throw new TypeError('The annotation has an invalid color.')
  }
  return { name, value: r + g * 256 + b * 65536, rgb: [r, g, b] }
}

/**
 * Read a FreeSurfer annotation with its embedded color table (both the
 * original and the version-2 table layout).
 *
 * @throws TypeError when the bytes are not a valid annotation.
 */
export function readAnnotation(bytes: Uint8Array): Annotation {
  const reader = new Reader(bytes)
  const vertexCount = count(reader.i32('annotation'), 'annotation')
  reader.need(vertexCount * 8, 'annotation')
  const labels = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    const vertex = reader.i32('annotation')
    const label = reader.i32('annotation')
    if (vertex < 0 || vertex >= vertexCount) {
      throw new TypeError('The annotation names a vertex it does not have.')
    }
    labels[vertex] = label
  }
  const entries: AnnotationEntry[] = []
  if (reader.remaining() >= 4 && reader.i32('annotation') === 1) {
    const first = reader.i32('annotation')
    if (first > 0) {
      reader.text(reader.i32('annotation'), 'annotation')
      for (let i = 0; i < Math.min(first, 10_000); i++) {
        entries.push(readEntry(reader))
      }
    } else if (first === -2) {
      reader.i32('annotation')
      reader.text(reader.i32('annotation'), 'annotation')
      const total = reader.i32('annotation')
      if (total < 0 || total > 10_000) {
        throw new TypeError('The annotation has an invalid color table.')
      }
      for (let i = 0; i < total; i++) {
        reader.i32('annotation')
        entries.push(readEntry(reader))
      }
    } else {
      throw new TypeError('The annotation color table has an unknown version.')
    }
  }
  const byValue = new Map(entries.map((entry, index) => [entry.value, index]))
  const vertexEntry = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) {
    vertexEntry[i] = byValue.get(labels[i]!) ?? -1
  }
  return { vertexEntry, entries }
}

/** One ASCII surface label (`lh.BA1_exvivo.label`). */
export interface SurfaceLabel {
  /** The labeled vertex indices. */
  vertices: Int32Array
  /** The value column of each vertex (a probability for `*_exvivo`). */
  values: Float32Array
}

/**
 * Read a FreeSurfer ASCII surface label: a comment line, the vertex count,
 * then `vertex x y z value` per line.
 *
 * @throws TypeError when the bytes are not a valid ASCII label.
 */
export function readLabel(bytes: Uint8Array): SurfaceLabel {
  const lines = new TextDecoder('latin1').decode(bytes).split('\n')
  if (!lines[0]?.startsWith('#')) {
    throw new TypeError('The file is not a FreeSurfer surface label.')
  }
  const total = count(Number(lines[1]?.trim()), 'label')
  if (lines.length < total + 2) throw new TypeError('The label ends early.')
  const vertices = new Int32Array(total)
  const values = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    const cells = lines[i + 2]!.trim().split(/\s+/)
    const vertex = Number(cells[0])
    const value = Number(cells[4])
    if (
      cells.length < 5 ||
      !Number.isInteger(vertex) ||
      vertex < 0 ||
      vertex >= MAX_ELEMENTS ||
      !Number.isFinite(value)
    ) {
      throw new TypeError('The label has an invalid vertex line.')
    }
    vertices[i] = vertex
    values[i] = value
  }
  return { vertices, values }
}

/** One label of a label set, as `annotationFromLabels` combines them. */
export interface NamedLabel {
  name: string
  rgb: [number, number, number]
  label: SurfaceLabel
}

/**
 * Combine surface labels into one parcellation of the first `vertexCount`
 * vertices, as `mris_label2annot --maxstatwinner` does: a vertex in
 * several labels takes the one with the largest value (the first on a
 * tie). Because the fsaverage icosahedra nest, the first 10242 vertices of
 * fsaverage are the vertices of fsaverage5, so labels drawn on fsaverage
 * subsample to fsaverage5 by keeping the vertices below 10242.
 *
 * @param labels - The labels in color-table order.
 * @returns The annotation; unlabeled vertices read -1.
 */
export function annotationFromLabels(
  labels: readonly NamedLabel[],
  vertexCount: number,
): Annotation {
  const vertexEntry = new Int32Array(count(vertexCount, 'surface')).fill(-1)
  const best = new Float32Array(vertexCount).fill(-Infinity)
  labels.forEach(({ label }, entry) => {
    for (let i = 0; i < label.vertices.length; i++) {
      const vertex = label.vertices[i]!
      if (vertex >= vertexCount) continue
      const value = label.values[i]!
      if (value > best[vertex]!) {
        best[vertex] = value
        vertexEntry[vertex] = entry
      }
    }
  })
  const entries = labels.map(({ name, rgb }) => ({
    name,
    rgb,
    value: rgb[0] + rgb[1] * 256 + rgb[2] * 65536,
  }))
  return { vertexEntry, entries }
}
