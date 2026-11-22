/** Tests for the atlas tables and the brain-viewer asset contract. */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ASEG_STRUCTURES,
  BA_LABEL_NAMES,
  DK_REGIONS,
  TEMPLATE_ATLAS_ASSET_IDS,
  asegLabelIndices,
  dkLabelIndices,
  isAtlasCacheAssetId,
  isBrainAssetId,
  isSubjectAssetId,
  isMappableMeasure,
  measureLabel,
  measureLabelIndices,
  measureUnit,
  parseBrainAsset,
  parseBrainAssetsReport,
} from './brain-atlas'

const LUT = '/usr/local/freesurfer/8.2.0/FreeSurferColorLUT.txt'

describe('atlas tables', () => {
  it('lists the 34 analyzable DK regions and the aseg structures once', () => {
    expect(DK_REGIONS).toHaveLength(34)
    expect(new Set(DK_REGIONS.map((r) => r.index)).size).toBe(34)
    expect(DK_REGIONS.some((r) => r.name === 'corpuscallosum')).toBe(false)
    expect(ASEG_STRUCTURES).toHaveLength(45)
    expect(new Set(ASEG_STRUCTURES.map((s) => s.index)).size).toBe(45)
  })

  it('maps measures to aparc+aseg label indices', () => {
    expect(dkLabelIndices('precentral', 'lh')).toEqual([1024])
    expect(dkLabelIndices('precentral', 'bi')).toEqual([1024, 2024])
    expect(dkLabelIndices('insula', 'rh')).toEqual([2035])
    expect(asegLabelIndices('Brain-Stem')).toEqual([16])
    expect(asegLabelIndices('Thalamus', true)).toEqual([10, 49])
    expect(measureLabelIndices('aseg:bi:Hippocampus')).toEqual([17, 53])
    expect(measureLabelIndices('global:eTIV')).toEqual([])
    expect(isMappableMeasure('brainage:BrainPAD')).toBe(false)
    expect(isMappableMeasure('dk:bi:cuneus:ThickAvg')).toBe(true)
  })

  it('names measures and their units', () => {
    expect(measureLabel('dk:lh:precentral:ThickAvg')).toBe(
      'Left precentral thickness',
    )
    expect(measureLabel('dk:bi:rostralanteriorcingulate:GrayVol')).toBe(
      'Rostral anterior cingulate gray-matter volume (bilateral mean)',
    )
    expect(measureLabel('aseg:bi:Thalamus')).toBe(
      'Thalamus volume (bilateral mean)',
    )
    expect(measureLabel('aseg:Brain-Stem')).toBe('Brainstem volume')
    expect(measureLabel('brainage:BrainPAD')).toBe('Brain-PAD')
    expect(measureLabel('not-an-id')).toBe('not-an-id')
    expect(measureUnit('dk:lh:precentral:SurfArea')).toBe('mm2')
    expect(measureUnit('aseg:Brain-Stem')).toBe('mm3')
    expect(measureUnit('brainage:BrainPAD')).toBe('years')
  })

  it.skipIf(!existsSync(LUT))('matches the FreeSurfer 8.2.0 LUT', () => {
    const names = new Map<number, string>()
    for (const line of readFileSync(LUT, 'utf8').split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)/.exec(line)
      if (match) names.set(Number(match[1]), match[2]!)
    }
    for (const region of DK_REGIONS) {
      expect(names.get(1000 + region.index)).toBe(`ctx-lh-${region.name}`)
      expect(names.get(2000 + region.index)).toBe(`ctx-rh-${region.name}`)
    }
    for (const structure of ASEG_STRUCTURES) {
      expect(names.get(structure.index)).toBe(structure.name)
    }
  })
})

describe('brain assets', () => {
  it('allowlists the template and subject files', () => {
    expect(isBrainAssetId('fsaverage5/surf/lh.pial')).toBe(true)
    expect(isBrainAssetId('subject/mri/aparc+aseg.mgz')).toBe(true)
    expect(isBrainAssetId('../etc/passwd')).toBe(false)
  })

  it('allowlists the v2 atlas assets', () => {
    for (const id of [
      'fsaverage5/label/lh.aparc.a2009s.annot',
      'fsaverage5/label/rh.Yeo2011_17Networks_N1000.annot',
      'fsaverage/label/lh.BA3a_exvivo.label',
      'fsaverage/label/rh.perirhinal_exvivo.thresh.label',
      'FreeSurferColorLUT.txt',
      'subject/mri/wmparc.mgz',
      'subject/mri/aparc.DKTatlas+aseg.mgz',
      'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      'atlas/user-0a1b2c3d/templates-fsaverage5/lh.user-0a1b2c3d.annot',
    ]) {
      expect(isBrainAssetId(id)).toBe(true)
    }
    for (const id of [
      'atlas/brainstem-ss/subject/../x.mgz',
      'atlas/brainstem-ss/other/x.mgz',
      'atlas/Brainstem/subject/x.mgz',
      'atlas/brainstem-ss/subject/x.sh',
      'atlas/brainstem-ss/subject/.hidden.mgz',
      'fsaverage/label/lh.BA99_exvivo.label',
      'subject/mri/norm.mgz',
    ]) {
      expect(isBrainAssetId(id)).toBe(false)
    }
    expect(TEMPLATE_ATLAS_ASSET_IDS).toHaveLength(
      6 + 2 * BA_LABEL_NAMES.length * 2,
    )
    expect(
      isSubjectAssetId(
        'atlas/brainstem-ss/subject/brainstemSsLabels.FSvoxelSpace.mgz',
      ),
    ).toBe(true)
    expect(
      isSubjectAssetId(
        'atlas/user-0a1b2c3d/templates-fsaverage5/lh.user-0a1b2c3d.annot',
      ),
    ).toBe(false)
    expect(isAtlasCacheAssetId('FreeSurferColorLUT.txt')).toBe(false)
  })

  it('labels and units the v2 measures', () => {
    expect(measureLabel('global:TotalGrayVol')).toBe('Total gray-matter volume')
    expect(measureLabel('vol:brainstem-ss:mid:Medulla')).toBe(
      'Medulla volume (Brainstem subfields)',
    )
    expect(measureLabel('parc:a2009s:bi:G_precentral:ThickAvg')).toBe(
      'G_precentral thickness (Destrieux) (bilateral mean)',
    )
    expect(measureUnit('parc:gwc:lh:precentral:GWC')).toBe('percent')
    expect(measureUnit('global:SurfaceHoles')).toBe('index')
    expect(measureUnit('vol:thalamic:lh:AV')).toBe('mm3')
  })

  it('validates reports and assets', () => {
    expect(
      parseBrainAssetsReport({
        available: false,
        unavailableReason: 'FreeSurfer home is not set.',
        subjectId: null,
        assets: [],
      }).available,
    ).toBe(false)
    expect(() =>
      parseBrainAssetsReport({
        available: true,
        unavailableReason: 'x',
        subjectId: null,
        assets: [],
      }),
    ).toThrow(/brain asset report/)
    const asset = parseBrainAsset({
      assetId: 'fsaverage/mri/brain.mgz',
      sha256: 'a'.repeat(64),
      data: new Uint8Array([1, 2]),
    })
    expect(asset.data.byteLength).toBe(2)
    expect(() =>
      parseBrainAsset({ assetId: 'x', sha256: 'a'.repeat(64), data: [] }),
    ).toThrow(/brain asset/)
  })
})
