import { describe, expect, it } from 'vitest'
import type { GroupAnalysisRow } from '../../../../shared/group-analysis'
import {
  CORTEX_GRAY,
  DIVERGING_STOPS,
  SELECTED_OUTLINE,
  SIGNIFICANT_OUTLINE,
  buildBrainMap,
  corticalLayers,
  divergingColor,
  formatStat,
  labelCentroid,
  labelOverlay,
  layerKeyForMeasure,
  measureAtLabel,
  measureAtParcel,
  niceLimit,
  parcelBorders,
  parcelColor,
  statValue,
  surfaceColors,
  unmappedMeasures,
  isDrawableMeasure,
  layerAtlas,
  volumeSources,
  type BrainMap,
} from './brain-map'
import { parseColorLut } from './color-lut'
import type { Annotation } from './freesurfer'

function row(
  measureId: string,
  d: number | null,
  significant = false,
  t = (d ?? 1) * 3,
): GroupAnalysisRow {
  return {
    measureId,
    family: 'dk:ThickAvg',
    nTotal: 90,
    nFocal: 30,
    nReference: 60,
    estimate: d ?? 0,
    se: 1,
    t,
    df: 85,
    p: 0.01,
    pCorrected: 0.02,
    significant,
    d,
    dLow: null,
    dHigh: null,
    dRawSd: null,
    partialEta2: 0.01,
    pctOfReference: null,
    pHc3: 0.01,
    pPermutation: null,
  }
}

const ROWS = [
  row('dk:bi:precentral:ThickAvg', -0.68, true),
  row('dk:bi:insula:ThickAvg', 0.1),
  row('dk:lh:precentral:ThickAvg', -0.4),
  row('dk:bi:precentral:GrayVol', 0.2),
  row('aseg:Brain-Stem', -0.48, true),
  row('aseg:bi:Thalamus', 0.3),
  row('aseg:Left-Thalamus', -0.2),
  row('global:meanThickness', -0.5),
  row('brainage:BrainPAD', 1.2),
]

describe('cortical layers', () => {
  it('groups DK rows by metric and hemisphere mode, most rows first', () => {
    expect(
      corticalLayers(ROWS).map((layer) => [
        layer.key,
        layer.count,
        layer.label,
      ]),
    ).toEqual([
      ['ThickAvg:bi', 2, 'Thickness, bilateral mean'],
      ['ThickAvg:hemi', 1, 'Thickness, per hemisphere'],
      ['GrayVol:bi', 1, 'Gray-matter volume, bilateral mean'],
    ])
  })

  it('names the layer of a measure', () => {
    expect(layerKeyForMeasure('dk:rh:insula:SurfArea')).toBe('SurfArea:hemi')
    expect(layerKeyForMeasure('aseg:Brain-Stem')).toBeNull()
    expect(layerKeyForMeasure(null)).toBeNull()
  })

  it('lists the measures without a place on the map', () => {
    expect(unmappedMeasures(ROWS)).toEqual([
      'Mean cortical thickness',
      'Brain-PAD',
    ])
  })
})

describe('buildBrainMap', () => {
  it('places the chosen layer on both hemispheres and every aseg row', () => {
    const map = buildBrainMap({ rows: ROWS }, 'd', 'ThickAvg:bi', null)
    expect(map.cortex.lh.get('precentral')?.value).toBe(-0.68)
    expect(map.cortex.rh.get('precentral')?.value).toBe(-0.68)
    expect(map.labels.get(1024)?.measureId).toBe('dk:bi:precentral:ThickAvg')
    expect(map.labels.get(2024)?.measureId).toBe('dk:bi:precentral:ThickAvg')
    expect(map.labels.get(16)?.measureId).toBe('aseg:Brain-Stem')
    // A single-structure row wins over the bilateral mean.
    expect(map.labels.get(10)?.measureId).toBe('aseg:Left-Thalamus')
    expect(map.labels.get(49)?.measureId).toBe('aseg:bi:Thalamus')
    expect(map.limit).toBe(0.8)
  })

  it('prefers the selected aseg row and fills one hemisphere per row', () => {
    const map = buildBrainMap(
      { rows: ROWS },
      't',
      'ThickAvg:hemi',
      'aseg:bi:Thalamus',
    )
    expect(map.labels.get(10)?.measureId).toBe('aseg:bi:Thalamus')
    expect(map.cortex.lh.get('precentral')?.measureId).toBe(
      'dk:lh:precentral:ThickAvg',
    )
    expect(map.cortex.rh.size).toBe(0)
    expect(map.stat).toBe('t')
  })

  it('skips rows without the statistic and keeps a floor on the limit', () => {
    const map = buildBrainMap(
      {
        rows: [
          row('aseg:Brain-Stem', null),
          row('dk:bi:insula:ThickAvg', 0.01),
        ],
      },
      'd',
      'ThickAvg:bi',
      null,
    )
    expect(map.labels.has(16)).toBe(false)
    expect(map.limit).toBe(0.5)
    expect(buildBrainMap({ rows: [] }, 't', null, null).limit).toBe(2)
  })

  it('finds the measure drawn at a parcel or label', () => {
    const map = buildBrainMap({ rows: ROWS }, 'd', 'ThickAvg:bi', null)
    expect(measureAtParcel(map, 'lh', 'insula')).toBe('dk:bi:insula:ThickAvg')
    expect(measureAtParcel(map, 'rh', 'cuneus')).toBeNull()
    expect(measureAtLabel(map, 16)).toBe('aseg:Brain-Stem')
    expect(measureAtLabel(map, 2)).toBeNull()
  })
})

describe('colors', () => {
  it('rounds limits to readable values', () => {
    expect(niceLimit(0.68, 0.5)).toBe(0.8)
    expect(niceLimit(0.3, 0.5)).toBe(0.5)
    expect(niceLimit(3.7, 2)).toBe(4)
    expect(niceLimit(12, 2)).toBe(15)
    expect(niceLimit(Number.NaN, 2)).toBe(2)
  })

  it('maps the symmetric scale with blue for negative values', () => {
    expect(divergingColor(-1, 1)).toEqual(DIVERGING_STOPS[0])
    expect(divergingColor(0, 1)).toEqual(DIVERGING_STOPS[4])
    expect(divergingColor(5, 1)).toEqual(DIVERGING_STOPS[8])
    expect(divergingColor(1, 0)).toEqual(DIVERGING_STOPS[4])
    const [r, , b] = divergingColor(-0.5, 1)
    expect(b).toBeGreaterThan(r)
  })

  it('mutes non-significant parcels toward the cortex gray', () => {
    const strong = parcelColor(
      { measureId: 'x', value: -1, significant: true },
      1,
    )
    const muted = parcelColor(
      { measureId: 'x', value: -1, significant: false },
      1,
    )
    expect(strong).toEqual(DIVERGING_STOPS[0])
    for (const channel of [0, 1, 2]) {
      expect(Math.abs(muted[channel]! - CORTEX_GRAY)).toBeLessThan(
        Math.abs(strong[channel]! - CORTEX_GRAY),
      )
    }
    // Muted keeps more than half its saturation, so its sign still reads,
    // and loses a clear share of it, so it stays apart from significant.
    const chroma = (c: readonly number[]): number =>
      Math.max(...c) - Math.min(...c)
    expect(chroma(muted) / chroma(strong)).toBeGreaterThan(0.55)
    expect(chroma(muted) / chroma(strong)).toBeLessThan(0.75)
  })

  it('formats statistics with a true minus sign', () => {
    expect(formatStat(-0.684)).toBe('\u22120.68')
    expect(formatStat(0.5, 1)).toBe('0.5')
    expect(formatStat(-0.001)).toBe('0.00')
    expect(statValue(row('aseg:Brain-Stem', null), 'd')).toBeNull()
    expect(statValue(row('aseg:Brain-Stem', 0.2), 't')).toBeCloseTo(0.6)
  })
})

describe('surface colors', () => {
  // Four vertices, two triangles; vertices 0-1 in precentral, 2-3 in insula.
  const annotation: Annotation = {
    vertexEntry: Int32Array.from([0, 0, 1, 1, -1]),
    entries: [
      { name: 'precentral', value: 1, rgb: [1, 0, 0] },
      { name: 'insula', value: 2, rgb: [2, 0, 0] },
    ],
  }
  const triangles = Uint32Array.from([0, 1, 2, 0, 1, 1])
  const sulc = new Float32Array(5)

  it('marks vertices that touch another parcel', () => {
    expect(Array.from(parcelBorders(annotation, triangles))).toEqual([
      1, 1, 1, 0, 0,
    ])
  })

  it('outlines significant and selected parcels and grays the rest', () => {
    const border = parcelBorders(annotation, triangles)
    const values = new Map([
      ['precentral', { measureId: 'a', value: -1, significant: true }],
      ['insula', { measureId: 'b', value: 1, significant: false }],
    ])
    const rgba = surfaceColors({
      annotation,
      sulc,
      border,
      values,
      limit: 1,
      selection: 'b',
    })
    const color = (v: number): number[] =>
      Array.from(rgba.slice(v * 4, v * 4 + 3))
    expect(color(0)).toEqual([...SIGNIFICANT_OUTLINE])
    expect(color(2)).toEqual([...SELECTED_OUTLINE])
    expect(color(3)).toEqual([
      ...parcelColor({ measureId: 'b', value: 1, significant: false }, 1),
    ])
    expect(color(4)).toEqual([CORTEX_GRAY, CORTEX_GRAY, CORTEX_GRAY])
    expect(rgba[19]).toBe(255)
  })

  it('shades deep vertices darker', () => {
    const deep = surfaceColors({
      annotation,
      sulc: Float32Array.from([0, 0, 0, 0, 8]),
      border: new Uint8Array(5),
      values: new Map(),
      limit: 1,
      selection: null,
    })
    expect(deep[16]!).toBeLessThan(CORTEX_GRAY)
  })
})

describe('labelOverlay', () => {
  // A 5 x 5 x 5 volume with a 3 x 3 x 3 cube of label 16 (brainstem) and
  // one voxel of label 10 (left thalamus) in a corner.
  const dims = [5, 5, 5] as const
  const labels = new Int16Array(125)
  for (let z = 1; z <= 3; z++) {
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) labels[x + 5 * (y + 5 * z)] = 16
    }
  }
  labels[0] = 10
  const map: Pick<BrainMap, 'labels' | 'limit'> = {
    limit: 1,
    labels: new Map([
      [16, { measureId: 'aseg:Brain-Stem', value: -0.7, significant: true }],
      [10, { measureId: 'aseg:Left-Thalamus', value: 0.2, significant: false }],
    ]),
  }

  it('recodes labels and paints outlines only around significant ones', () => {
    const overlay = labelOverlay(labels, dims, map, null)
    expect(overlay.table.I).toEqual([0, 1, 2, 3, 4])
    // Codes follow label order: 10 -> 1, 16 -> 2; outlines are 3 and 4.
    expect(overlay.codes[0]).toBe(1)
    expect(overlay.codes[2 + 5 * (2 + 5 * 2)]).toBe(2)
    // The clear face neighbors of the cube become its outline; a clear
    // voxel away from it stays clear.
    expect(overlay.codes[2 + 5 * (2 + 5 * 0)]).toBe(3)
    expect(overlay.codes[0 + 5 * (2 + 5 * 2)]).toBe(3)
    expect(overlay.codes[4 + 5 * (4 + 5 * 4)]).toBe(0)
    expect(overlay.table.A).toEqual([0, 150, 255, 255, 255])
    expect(overlay.selectedCentroid).toBeNull()
  })

  it('outlines the selection in its own color and gives its centroid', () => {
    const overlay = labelOverlay(labels, dims, map, 'aseg:Brain-Stem')
    expect(overlay.codes[0 + 5 * (2 + 5 * 2)]).toBe(4)
    expect(overlay.selectedCentroid).toEqual([2, 2, 2])
    expect([
      overlay.table.R[4],
      overlay.table.G[4],
      overlay.table.B[4],
    ]).toEqual([...SELECTED_OUTLINE])
  })

  it('keeps only the cut-face slab, opaque', () => {
    const overlay = labelOverlay(labels, dims, map, null, {
      v0: -2,
      vi: 1,
      vj: 0,
      vk: 0,
      thickness: 0.5,
    })
    // Only x = 2 lies within [0, 0.5] of x - 2.
    expect(overlay.codes[1 + 5 * (2 + 5 * 2)]).toBe(0)
    expect(overlay.codes[2 + 5 * (2 + 5 * 2)]).toBe(2)
    expect(overlay.codes[3 + 5 * (2 + 5 * 2)]).toBe(0)
    expect(overlay.table.A).toEqual([0, 255, 255, 255, 255])
  })

  it('refuses a volume smaller than its dimensions', () => {
    expect(() => labelOverlay(new Int16Array(3), dims, map, null)).toThrow(
      /smaller than its dimensions/,
    )
  })
})

describe('labelCentroid', () => {
  it('finds the mean voxel of a label and null without it', () => {
    const labels = new Uint8Array(4 * 3 * 2)
    labels[1 + 4 * (2 + 3 * 1)] = 16
    labels[3 + 4 * (2 + 3 * 1)] = 16
    expect(labelCentroid(labels, [4, 3, 2], 16)).toEqual([2, 2, 1])
    expect(labelCentroid(labels, [4, 3, 2], 17)).toBeNull()
  })
})

describe('atlas layers and label maps', () => {
  const V2 = [
    row('dk:bi:precentral:ThickAvg', -0.5, true),
    row('parc:a2009s:lh:G_precentral:ThickAvg', -0.9, true),
    row('parc:a2009s:rh:G_precentral:ThickAvg', -0.3),
    row('parc:yeo7:bi:7Networks_2:SurfArea', 0.4),
    row('vol:brainstem-ss:mid:Medulla', -1.2, true),
    row('vol:brainstem-ss:mid:Whole_brainstem', -0.6),
    row('vol:synthseg:lh:cerebral-cortex', 0.1),
  ]
  const LUT = parseColorLut(
    '173 Midbrain 1 1 1 0\n174 Pons 1 1 1 0\n175 Medulla 1 1 1 0\n178 SCP 1 1 1 0\n',
  )

  it('lists layers per atlas, DK first, and the label maps', () => {
    expect(corticalLayers(V2).map((layer) => [layer.key, layer.label])).toEqual(
      [
        ['ThickAvg:bi', 'Thickness, bilateral mean'],
        [
          'a2009s:ThickAvg:hemi',
          'Destrieux (aparc.a2009s): thickness, per hemisphere',
        ],
        ['yeo7:SurfArea:bi', 'Yeo 2011, 7 networks: area, bilateral mean'],
      ],
    )
    expect(layerAtlas('a2009s:ThickAvg:hemi')).toBe('a2009s')
    expect(layerAtlas('ThickAvg:bi')).toBe('dk')
    expect(layerKeyForMeasure('parc:yeo7:bi:7Networks_2:SurfArea')).toBe(
      'yeo7:SurfArea:bi',
    )
    expect(volumeSources(V2)).toEqual(['aseg', 'a2009s', 'brainstem-ss'])
    expect(isDrawableMeasure('vol:synthseg:lh:cerebral-cortex')).toBe(false)
    expect(unmappedMeasures(V2)).toEqual([
      'cerebral-cortex volume (SynthSeg volumes), left',
    ])
  })

  it('places a layer of a parc atlas and a subfield label map', () => {
    const map = buildBrainMap({ rows: V2 }, 'd', 'a2009s:ThickAvg:hemi', null, {
      sourceId: 'brainstem-ss',
      lut: LUT,
    })
    expect(map.surfaceAtlas).toBe('a2009s')
    expect(map.volumeSource).toBe('brainstem-ss')
    expect(map.cortex.lh.get('G_precentral')!.value).toBe(-0.9)
    expect(map.cortex.rh.get('G_precentral')!.value).toBe(-0.3)
    expect(map.cortex.lh.has('precentral')).toBe(false)
    // The medulla keeps its own row; the union fills the other subfields.
    expect(map.labels.get(175)!.measureId).toBe('vol:brainstem-ss:mid:Medulla')
    expect(map.labels.get(174)!.measureId).toBe(
      'vol:brainstem-ss:mid:Whole_brainstem',
    )
    // The selected union wins everywhere.
    const selected = buildBrainMap(
      { rows: V2 },
      'd',
      null,
      'vol:brainstem-ss:mid:Whole_brainstem',
      { sourceId: 'brainstem-ss', lut: LUT },
    )
    expect(selected.labels.get(175)!.measureId).toBe(
      'vol:brainstem-ss:mid:Whole_brainstem',
    )
    expect(selected.surfaceAtlas).toBeNull()
    expect(map.limit).toBe(1.5)
  })

  it('takes v2 rows whose t is null', () => {
    const map = buildBrainMap(
      {
        rows: [
          { measureId: 'aseg:Brain-Stem', d: null, t: null, significant: true },
        ],
      },
      't',
      null,
      null,
    )
    expect(map.labels.size).toBe(0)
  })

  it('colors annotation entries by their regions', () => {
    const annotation: Annotation = {
      vertexEntry: Int32Array.of(0, 1),
      entries: [
        { name: '7Networks_LH_Vis_1', value: 1, rgb: [1, 0, 0] },
        { name: 'Background', value: 2, rgb: [2, 0, 0] },
      ],
    }
    const rgba = surfaceColors({
      annotation,
      regions: ['7Networks_Vis_1', null],
      sulc: new Float32Array(2),
      border: new Uint8Array(2),
      values: new Map([
        [
          '7Networks_Vis_1',
          { measureId: 'parc:x', value: -1, significant: true },
        ],
      ]),
      limit: 1,
      selection: null,
    })
    expect(Array.from(rgba.slice(0, 3))).toEqual([...DIVERGING_STOPS[0]!])
    expect(Array.from(rgba.slice(4, 7))).toEqual([
      CORTEX_GRAY,
      CORTEX_GRAY,
      CORTEX_GRAY,
    ])
  })

  it('finds a voxel inside a curved structure and masks the overlay', () => {
    // A C-shaped label whose centroid (1, 1, 0) is not in it.
    const labels = Int16Array.from([5, 5, 5, 5, 0, 0, 5, 5, 5])
    const map = {
      labels: new Map([[5, { measureId: 'm', value: 1, significant: true }]]),
      limit: 1,
    }
    const overlay = labelOverlay(labels, [3, 3, 1], map, 'm')
    expect(overlay.selectedCentroid![0]).toBeCloseTo(0.857, 2)
    expect(overlay.selectedPoint).toEqual([0, 1, 0])
    const masked = labelOverlay(
      labels,
      [3, 3, 1],
      map,
      null,
      null,
      Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
    )
    expect(Array.from(masked.codes)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0])
  })
})
