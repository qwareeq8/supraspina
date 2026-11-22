import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  annotationFromLabels,
  readAnnotation,
  readCurvature,
  readLabel,
  readSurface,
} from './freesurfer'

/** A big-endian byte writer for synthetic FreeSurfer files. */
class Writer {
  private readonly parts: number[] = []

  bytes(...values: number[]): this {
    this.parts.push(...values)
    return this
  }

  text(value: string): this {
    for (const char of value) this.parts.push(char.charCodeAt(0))
    return this
  }

  i32(value: number): this {
    const view = new DataView(new ArrayBuffer(4))
    view.setInt32(0, value, false)
    return this.bytes(...new Uint8Array(view.buffer))
  }

  f32(value: number): this {
    const view = new DataView(new ArrayBuffer(4))
    view.setFloat32(0, value, false)
    return this.bytes(...new Uint8Array(view.buffer))
  }

  name(value: string): this {
    return this.i32(value.length + 1)
      .text(value)
      .bytes(0)
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

function surface(footer = ''): Uint8Array {
  const writer = new Writer()
    .bytes(0xff, 0xff, 0xfe)
    .text('created by test\n\n')
    .i32(3)
    .i32(1)
  for (const value of [0, 0, 0, 1, 0, 0, 0, 1, 0]) writer.f32(value)
  writer.i32(0).i32(1).i32(2)
  return writer.text(footer).done()
}

function annotation(version: 'old' | 'v2'): Uint8Array {
  const red = 255
  const blue = 255 * 65536
  const writer = new Writer().i32(3)
  writer.i32(0).i32(red).i32(1).i32(blue).i32(2).i32(12345)
  writer.i32(1)
  if (version === 'old') {
    writer.i32(2).name('table.txt')
    writer.name('precentral').i32(255).i32(0).i32(0).i32(0)
    writer.name('insula').i32(0).i32(0).i32(255).i32(0)
  } else {
    writer.i32(-2).i32(2).name('table.txt').i32(2)
    writer.i32(0).name('precentral').i32(255).i32(0).i32(0).i32(0)
    writer.i32(1).name('insula').i32(0).i32(0).i32(255).i32(0)
  }
  return writer.done()
}

describe('FreeSurfer readers', () => {
  it('reads a triangle surface and applies its cras offset', () => {
    const plain = readSurface(surface())
    expect(plain.vertexCount).toBe(3)
    expect(Array.from(plain.triangles)).toEqual([0, 1, 2])
    expect(Array.from(plain.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])

    const shifted = readSurface(surface('valid = 1\ncras   = 1 2 3\n'))
    expect(Array.from(shifted.positions.slice(0, 3))).toEqual([1, 2, 3])
  })

  it('refuses a surface with a bad magic, a short body, or a stray index', () => {
    const bytes = surface()
    const badMagic = bytes.slice()
    badMagic[2] = 0xff
    expect(() => readSurface(badMagic)).toThrow(/not a FreeSurfer triangle/)
    expect(() => readSurface(bytes.slice(0, 40))).toThrow(/ends early/)
    const stray = bytes.slice()
    stray[stray.length - 1] = 9
    expect(() => readSurface(stray)).toThrow(/vertex it does not have/)
    expect(() =>
      readSurface(new Writer().bytes(0xff, 0xff, 0xfe).text('x').done()),
    ).toThrow(/header ends early/)
  })

  it('reads a curvature file with one value per vertex', () => {
    const bytes = new Writer()
      .bytes(0xff, 0xff, 0xff)
      .i32(2)
      .i32(1)
      .i32(1)
      .f32(-1.5)
      .f32(2)
      .done()
    expect(Array.from(readCurvature(bytes))).toEqual([-1.5, 2])
    const multi = bytes.slice()
    multi[14] = 2
    expect(() => readCurvature(multi)).toThrow(/more than one value/)
    expect(() => readCurvature(surface())).toThrow(/not a FreeSurfer curvature/)
    expect(() =>
      readCurvature(new Writer().bytes(0xff, 0xff, 0xff).i32(0).done()),
    ).toThrow(/invalid element count/)
  })

  it.each(['old', 'v2'] as const)(
    'reads an annotation with a %s color table',
    (version) => {
      const parsed = readAnnotation(annotation(version))
      expect(parsed.entries.map((entry) => entry.name)).toEqual([
        'precentral',
        'insula',
      ])
      expect(parsed.entries[1]!.rgb).toEqual([0, 0, 255])
      expect(Array.from(parsed.vertexEntry)).toEqual([0, 1, -1])
    },
  )

  it('refuses an annotation with an unknown table or a stray vertex', () => {
    const unknown = new Writer().i32(1).i32(0).i32(0).i32(1).i32(-3).done()
    expect(() => readAnnotation(unknown)).toThrow(/unknown version/)
    const stray = new Writer().i32(1).i32(4).i32(0).done()
    expect(() => readAnnotation(stray)).toThrow(/vertex it does not have/)
    const badColor = new Writer()
      .i32(1)
      .i32(0)
      .i32(0)
      .i32(1)
      .i32(1)
      .name('t')
      .name('x')
      .i32(300)
      .i32(0)
      .i32(0)
      .i32(0)
      .done()
    expect(() => readAnnotation(badColor)).toThrow(/invalid color/)
  })

  const FS = '/usr/local/freesurfer/8.2.0/subjects/fsaverage5'
  it.skipIf(!existsSync(`${FS}/surf/lh.pial`))(
    'reads the real fsaverage5 files',
    () => {
      const pial = readSurface(readFileSync(`${FS}/surf/lh.pial`))
      const sulc = readCurvature(readFileSync(`${FS}/surf/lh.sulc`))
      const annot = readAnnotation(readFileSync(`${FS}/label/lh.aparc.annot`))
      expect(pial.vertexCount).toBe(10242)
      expect(pial.triangles.length / 3).toBe(20480)
      expect(sulc.length).toBe(10242)
      expect(annot.vertexEntry.length).toBe(10242)
      expect(annot.entries.map((entry) => entry.name)).toContain('precentral')
    },
  )

  it('reads an ASCII label and refuses a malformed one', () => {
    const text = (body: string): Uint8Array => new TextEncoder().encode(body)
    const label = readLabel(
      text(
        '#!ascii label, from subject fsaverage\n2\n5 1 2 3 0.5\n12000 0 0 0 0.9\n',
      ),
    )
    expect(Array.from(label.vertices)).toEqual([5, 12000])
    expect(Array.from(label.values)).toEqual([0.5, Math.fround(0.9)])
    expect(() => readLabel(text('2\n'))).toThrow(/not a FreeSurfer/)
    expect(() => readLabel(text('#\n3\n1 0 0 0 1\n'))).toThrow(/ends early/)
    expect(() => readLabel(text('#\n1\n-1 0 0 0 1\n'))).toThrow(
      /invalid vertex/,
    )
    expect(() => readLabel(text('#\n1\n1 0 0 0 x\n'))).toThrow(/invalid vertex/)
  })

  it('combines labels by the largest value and subsamples to fsaverage5', () => {
    const label = (pairs: [number, number][]) => ({
      vertices: Int32Array.from(pairs.map(([v]) => v)),
      values: Float32Array.from(pairs.map(([, p]) => p)),
    })
    const annotation = annotationFromLabels(
      [
        {
          name: 'BA1_exvivo',
          rgb: [1, 0, 0],
          label: label([
            [0, 0.5],
            [1, 0.9],
            [20000, 1],
          ]),
        },
        {
          name: 'BA2_exvivo',
          rgb: [2, 0, 0],
          label: label([
            [1, 0.4],
            [2, 0.7],
            [0, 0.5],
          ]),
        },
      ],
      4,
    )
    // Vertex 0 ties and keeps the first label; 20000 is beyond fsaverage5.
    expect(Array.from(annotation.vertexEntry)).toEqual([0, 0, 1, -1])
    expect(
      annotation.entries.map((entry) => [entry.name, entry.value]),
    ).toEqual([
      ['BA1_exvivo', 1],
      ['BA2_exvivo', 2],
    ])
  })

  const FSAVERAGE = '/usr/local/freesurfer/8.2.0/subjects/fsaverage'
  it.skipIf(
    !existsSync(`${FSAVERAGE}/surf/lh.sphere`) ||
      !existsSync(`${FS}/surf/lh.sphere`),
  )(
    'nests fsaverage5 in fsaverage: the first 10242 sphere vertices agree',
    () => {
      for (const hemi of ['lh', 'rh']) {
        const big = readSurface(
          readFileSync(`${FSAVERAGE}/surf/${hemi}.sphere`),
        )
        const small = readSurface(readFileSync(`${FS}/surf/${hemi}.sphere`))
        expect(big.vertexCount).toBe(163842)
        expect(small.vertexCount).toBe(10242)
        let worst = 0
        for (let i = 0; i < small.positions.length; i += 1) {
          worst = Math.max(
            worst,
            Math.abs(big.positions[i]! - small.positions[i]!),
          )
        }
        expect(worst).toBe(0)
      }
    },
  )

  it.skipIf(!existsSync(`${FSAVERAGE}/label/lh.BA1_exvivo.label`))(
    'builds the Brodmann areas of fsaverage5 from the fsaverage labels',
    () => {
      const names = [
        'BA1',
        'BA2',
        'BA3a',
        'BA3b',
        'BA4a',
        'BA4p',
        'BA6',
        'BA44',
        'BA45',
        'V1',
        'V2',
        'MT',
        'entorhinal',
        'perirhinal',
      ]
      const annotation = annotationFromLabels(
        names.map((name, index) => ({
          name: `${name}_exvivo`,
          rgb: [index + 1, 0, 0],
          label: readLabel(
            readFileSync(`${FSAVERAGE}/label/lh.${name}_exvivo.label`),
          ),
        })),
        10242,
      )
      const counts = new Map<number, number>()
      for (const entry of annotation.vertexEntry) {
        counts.set(entry, (counts.get(entry) ?? 0) + 1)
      }
      // Every area keeps vertices on fsaverage5, and most of the cortex
      // stays unlabeled.
      for (let index = 0; index < names.length; index += 1) {
        expect(counts.get(index) ?? 0).toBeGreaterThan(5)
      }
      expect(counts.get(-1)! / 10242).toBeGreaterThan(0.4)
      // Before the largest-value vote, the subsampled V1 lies inside
      // FreeSurfer's own fsaverage5 V1 label and covers most of it.
      const own = new Set(
        readLabel(readFileSync(`${FS}/label/lh.V1_exvivo.label`)).vertices,
      )
      const sub = Array.from(
        readLabel(readFileSync(`${FSAVERAGE}/label/lh.V1_exvivo.label`))
          .vertices,
      ).filter((vertex) => vertex < 10242)
      expect(sub.every((vertex) => own.has(vertex))).toBe(true)
      expect(sub.length / own.size).toBeGreaterThan(0.85)
    },
  )
})
