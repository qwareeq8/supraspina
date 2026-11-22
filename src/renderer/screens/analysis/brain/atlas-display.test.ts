import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ATLAS_CACHE_VIEWER_FILES,
  ATLAS_RECIPE_IDS,
  expandAtlasFile,
} from '../../../../shared/atlas-labeling'
import {
  TEMPLATE_ATLAS_ASSET_IDS,
  isBrainAssetId,
} from '../../../../shared/brain-atlas'
import {
  RIGHT_FILE_OFFSET,
  atlasName,
  atlasRules,
  isWholeStructure,
  measureVolumeSource,
  measureVolumeValues,
  missingSurfaceAtlas,
  regionName,
  surfaceAtlasFiles,
  surfaceRegion,
  volumeSourceFiles,
  volumeSourceNeedsLut,
} from './atlas-display'
import { parseColorLut } from './color-lut'
import { readAnnotation } from './freesurfer'

const LUT = parseColorLut(
  [
    '16 Brain-Stem 1 1 1 0',
    '173 Midbrain 1 1 1 0',
    '174 Pons 1 1 1 0',
    '175 Medulla 1 1 1 0',
    '178 SCP 1 1 1 0',
    '203 parasubiculum 1 1 1 0',
    '226 HP_tail 1 1 1 0',
    '237 CA1-head 1 1 1 0',
    '238 CA1-body 1 1 1 0',
    '7001 Lateral-nucleus 1 1 1 0',
    '7003 Basal-nucleus 1 1 1 0',
    '8103 Left-AV 1 1 1 0',
    '8104 Left-CeM 1 1 1 0',
    '8203 Right-AV 1 1 1 0',
    '3024 wm-lh-precentral 1 1 1 0',
    '4024 wm-rh-precentral 1 1 1 0',
    '5001 Left-UnsegmentedWhiteMatter 1 1 1 0',
    '11101 ctx_lh_G_and_S_frontomargin 1 1 1 0',
    '12101 ctx_rh_G_and_S_frontomargin 1 1 1 0',
    '1024 ctx-lh-precentral 1 1 1 0',
  ].join('\n'),
)

/** Every cache file some recipe lets the viewer read for an atlas. */
function viewerFiles(atlasId: string, scope: 'subject' | 'template'): string[] {
  return ATLAS_RECIPE_IDS.flatMap((recipe) =>
    ATLAS_CACHE_VIEWER_FILES[recipe][scope].flatMap((pattern) =>
      expandAtlasFile(pattern, atlasId),
    ),
  )
}

describe('atlas names and regions', () => {
  it('spells regions as the sidecar does', () => {
    expect(regionName('G_and_S_frontomargin')).toBe('G_and_S_frontomargin')
    expect(regionName('MV(Re)')).toBe('MV_Re_')
    expect(regionName('Medial_Wall')).toBeNull()
    expect(regionName('unknown')).toBeNull()
    expect(regionName('x'.repeat(80))).toHaveLength(64)
  })

  it('strips the hemisphere token of the surface hemisphere', () => {
    const rules = atlasRules('schaefer100-7')
    expect(rules).toEqual(['lh-rh-underscore-infix'])
    expect(surfaceRegion('7Networks_LH_Vis_1', rules, 'lh')).toBe(
      '7Networks_Vis_1',
    )
    // A token of the other hemisphere is not stripped.
    expect(surfaceRegion('7Networks_RH_Vis_1', rules, 'lh')).toBe(
      '7Networks_RH_Vis_1',
    )
    expect(
      surfaceRegion('Background+FreeSurfer_Defined_Medial_Wall', rules, 'lh'),
    ).toBeNull()
    // An added atlas tries every rule.
    expect(surfaceRegion('A8m_L', atlasRules('user-0a1b2c3d'), 'lh')).toBe(
      'A8m',
    )
  })

  it('names atlases for the controls', () => {
    expect(atlasName('dk')).toBe('Desikan-Killiany')
    expect(atlasName('a2009s')).toBe('Destrieux (aparc.a2009s)')
    expect(atlasName('schaefer200-17')).toBe(
      'Schaefer 2018, 200 parcels, 17 networks',
    )
    expect(atlasName('user-0a1b2c3d')).toBe('Added atlas user-0a1b2c3d')
    expect(
      atlasName('user-0a1b2c3d', new Map([['user-0a1b2c3d', 'Mine']])),
    ).toBe('Mine')
  })
})

describe('surface atlas files', () => {
  it('reads FreeSurfer, label-set, and labeling-cache drawings', () => {
    expect(surfaceAtlasFiles('dkpial')).toEqual({
      kind: 'annot',
      lh: 'fsaverage5/label/lh.aparc.annot',
      rh: 'fsaverage5/label/rh.aparc.annot',
    })
    expect(surfaceAtlasFiles('yeo17')).toMatchObject({
      lh: 'fsaverage5/label/lh.Yeo2011_17Networks_N1000.annot',
    })
    const ba = surfaceAtlasFiles('bathresh')
    expect(ba?.kind).toBe('labels')
    if (ba?.kind !== 'labels') throw new Error('labels')
    expect(ba.lh).toHaveLength(14)
    expect(ba.lh[0]).toEqual({
      name: 'BA1_exvivo.thresh',
      assetId: 'fsaverage/label/lh.BA1_exvivo.thresh.label',
    })
    expect(surfaceAtlasFiles('schaefer100-7')).toMatchObject({
      rh: 'atlas/schaefer100-7/templates-fsaverage5/rh.schaefer100-7.annot',
    })
    expect(surfaceAtlasFiles('synthseg')).toBeNull()
  })

  it('names only allowlisted assets', () => {
    for (const atlasId of [
      'a2009s',
      'yeo7',
      'yeo17',
      'ba',
      'bathresh',
      'dkt',
      'schaefer400-17',
      'user-0a1b2c3d',
    ]) {
      const files = surfaceAtlasFiles(atlasId)!
      const ids =
        files.kind === 'annot'
          ? [files.lh, files.rh]
          : [...files.lh, ...files.rh].map((item) => item.assetId)
      for (const id of ids) {
        expect(isBrainAssetId(id)).toBe(true)
        if (id.startsWith('atlas/')) {
          // Main lets the viewer read this template file of the atlas.
          const file = id.split('/')[3]!
          expect(viewerFiles(atlasId, 'template')).toContain(file)
        } else {
          expect(
            (TEMPLATE_ATLAS_ASSET_IDS as readonly string[]).includes(id) ||
              id.startsWith('fsaverage5/label/lh.aparc.') ||
              id.startsWith('fsaverage5/label/rh.aparc.'),
          ).toBe(true)
        }
      }
    }
    for (const sourceId of [
      'aseg',
      'a2009s',
      'dkt',
      'wmparc',
      'entowm',
      'brainstem-ss',
      'hippo-amygdala',
      'thalamic',
      'user-0a1b2c3d',
    ]) {
      const files = volumeSourceFiles(sourceId)!
      for (const assetId of [
        ...files.labels.map((file) => file.assetId),
        ...(files.colorTable ? [files.colorTable] : []),
      ]) {
        expect(isBrainAssetId(assetId)).toBe(true)
        if (assetId.startsWith('atlas/')) {
          expect(viewerFiles(sourceId, 'subject')).toContain(
            assetId.split('/')[3],
          )
        }
      }
    }
    // An added map is named by its own table, not FreeSurfer's.
    expect(volumeSourceFiles('user-0a1b2c3d')!.colorTable).toBe(
      'atlas/user-0a1b2c3d/subject/user-0a1b2c3d.ctab',
    )
    expect(volumeSourceNeedsLut('user-0a1b2c3d')).toBe(false)
    expect(volumeSourceNeedsLut('wmparc')).toBe(true)
    expect(volumeSourceFiles('thalamic')!.colorTable).toBeUndefined()
    expect(volumeSourceFiles('synthseg')).toBeNull()
  })

  it('says why a known atlas cannot be drawn', () => {
    expect(missingSurfaceAtlas('dkt', new Set())).toBe(
      'DKT (aparc.DKTatlas) has no fsaverage5 template labels yet; label the template in Choose measures to draw it.',
    )
    expect(missingSurfaceAtlas('a2009s', new Set())).toBe(
      'The FreeSurfer home lacks the fsaverage files of Destrieux (aparc.a2009s).',
    )
    expect(
      missingSurfaceAtlas(
        'yeo7',
        new Set([
          'fsaverage5/label/lh.Yeo2011_7Networks_N1000.annot',
          'fsaverage5/label/rh.Yeo2011_7Networks_N1000.annot',
        ]),
      ),
    ).toBeNull()
    expect(missingSurfaceAtlas('synthseg', new Set())).toMatch(/no fsaverage5/)
  })
})

describe('volume label values', () => {
  it('maps measures to their label maps', () => {
    expect(measureVolumeSource('dk:lh:precentral:ThickAvg')).toBe('aseg')
    expect(measureVolumeSource('aseg:Brain-Stem')).toBe('aseg')
    expect(
      measureVolumeSource('parc:a2009s:lh:G_and_S_frontomargin:ThickAvg'),
    ).toBe('a2009s')
    expect(measureVolumeSource('parc:yeo7:lh:7Networks_1:ThickAvg')).toBeNull()
    expect(measureVolumeSource('vol:brainstem-ss:mid:Medulla')).toBe(
      'brainstem-ss',
    )
    expect(measureVolumeSource('vol:user-0a1b2c3d:mid:X')).toBe('user-0a1b2c3d')
    expect(measureVolumeSource('vol:synthseg:lh:cerebral-cortex')).toBeNull()
    expect(measureVolumeSource('global:eTIV')).toBeNull()
    expect(volumeSourceNeedsLut('aseg')).toBe(false)
    expect(volumeSourceNeedsLut('entowm')).toBe(false)
    expect(volumeSourceNeedsLut('thalamic')).toBe(true)
  })

  it('names the label values of each map', () => {
    const values = (source: string, id: string) =>
      measureVolumeValues(source, id, LUT)
    expect(values('aseg', 'dk:bi:precentral:ThickAvg')).toEqual([1024, 2024])
    expect(values('wmparc', 'aseg:bi:Thalamus')).toEqual([10, 49])
    expect(values('brainstem-ss', 'aseg:Brain-Stem')).toEqual([])
    expect(values('brainstem-ss', 'vol:brainstem-ss:mid:Medulla')).toEqual([
      175,
    ])
    expect(
      values('brainstem-ss', 'vol:brainstem-ss:mid:Whole_brainstem'),
    ).toEqual([173, 174, 175, 178])
    expect(
      values('hippo-amygdala', 'vol:hippo-amygdala:rh:Hippocampal_tail'),
    ).toEqual([226 + RIGHT_FILE_OFFSET])
    expect(
      values('hippo-amygdala', 'vol:hippo-amygdala:lh:Whole_hippocampal_head'),
    ).toEqual([237])
    expect(
      values('hippo-amygdala', 'vol:hippo-amygdala:bi:Whole_amygdala'),
    ).toEqual([7001, 7003, 7001 + RIGHT_FILE_OFFSET, 7003 + RIGHT_FILE_OFFSET])
    expect(values('thalamic', 'vol:thalamic:bi:AV')).toEqual([8103, 8203])
    expect(values('thalamic', 'vol:thalamic:lh:Whole_thalamus')).toEqual([
      8103, 8104,
    ])
    expect(values('wmparc', 'vol:wmparc:bi:wm-precentral')).toEqual([
      3024, 4024,
    ])
    expect(values('wmparc', 'vol:wmparc:lh:UnsegmentedWhiteMatter')).toEqual([
      5001,
    ])
    expect(values('entowm', 'vol:entowm:rh:wm-gyrus-ambiens')).toEqual([4201])
    expect(
      values('a2009s', 'parc:a2009s:bi:G_and_S_frontomargin:ThickAvg'),
    ).toEqual([11101, 12101])
    expect(values('dkt', 'parc:dkt:lh:precentral:GrayVol')).toEqual([1024])
    expect(values('aseg', 'parc:dkt:lh:precentral:GrayVol')).toEqual([])
    expect(values('user-0a1b2c3d', 'vol:user-0a1b2c3d:mid:Pons')).toEqual([174])
    expect(values('brainstem-ss', 'vol:wmparc:lh:wm-precentral')).toEqual([])
    expect(
      measureVolumeValues('brainstem-ss', 'vol:brainstem-ss:mid:Medulla', null),
    ).toEqual([])
    expect(values('aseg', 'bogus')).toEqual([])
    expect(isWholeStructure('Left-Whole_thalamus')).toBe(true)
    expect(isWholeStructure('Medulla')).toBe(false)
  })

  const FS5 = '/usr/local/freesurfer/8.2.0/subjects/fsaverage5/label'
  const STATS =
    '/data/projects/supraspina/local/harness/template/precomputed/freesurfer/sub-101/stats'
  it.skipIf(
    !existsSync(`${FS5}/lh.aparc.a2009s.annot`) ||
      !existsSync(`${STATS}/lh.aparc.a2009s.stats`),
  )('meets the regions a real Destrieux stats file names', () => {
    const annotation = readAnnotation(
      readFileSync(`${FS5}/lh.aparc.a2009s.annot`),
    )
    const regions = new Set(
      annotation.entries.map((entry) =>
        surfaceRegion(entry.name, atlasRules('a2009s'), 'lh'),
      ),
    )
    const stats = readFileSync(`${STATS}/lh.aparc.a2009s.stats`, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/)[0]!)
    expect(stats.length).toBe(74)
    for (const name of stats) expect(regions.has(name)).toBe(true)
  })
})
