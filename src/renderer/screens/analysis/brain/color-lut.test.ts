import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BRAINSTEM_SUBFIELDS,
  isAmygdalaNucleus,
  isHippocampalSubfield,
  isThalamicNucleus,
  parseColorLut,
} from './color-lut'

const LUT = '/usr/local/freesurfer/8.2.0/FreeSurferColorLUT.txt'

describe('FreeSurfer color table', () => {
  it('parses entries, skips comments and junk, and keeps the first name', () => {
    const lut = parseColorLut(
      [
        '# comment',
        '',
        '  0  Unknown  0 0 0 0',
        '175 Medulla 119 159 176 0',
        '176 Medulla 1 2 3 0',
        'x  Broken 1 2 3 0',
        '9 Short 1 2',
        '10 BadColor 1 2 300 0',
      ].join('\n'),
    )
    expect([...lut.byIndex.keys()]).toEqual([0, 175, 176])
    expect(lut.byName.get('Medulla')).toEqual({
      index: 175,
      name: 'Medulla',
      rgb: [119, 159, 176],
    })
    expect(() => parseColorLut('# nothing\n')).toThrow(/no entries/)
  })

  it('classifies the subfield and nucleus ranges', () => {
    expect(isAmygdalaNucleus(7001)).toBe(true)
    expect(isAmygdalaNucleus(7100)).toBe(false)
    expect(isThalamicNucleus(8001)).toBe(true)
    expect(isThalamicNucleus(8103)).toBe(true)
    expect(isThalamicNucleus(8233)).toBe(true)
    expect(isThalamicNucleus(8100)).toBe(false)
    expect(isHippocampalSubfield(226)).toBe(true)
    expect(isHippocampalSubfield(215)).toBe(false)
    expect(isHippocampalSubfield(213)).toBe(false)
    expect(isHippocampalSubfield(220)).toBe(false)
  })

  it.skipIf(!existsSync(LUT))('matches the FreeSurfer 8.2.0 table', () => {
    const lut = parseColorLut(readFileSync(LUT, 'utf8'))
    const name = (index: number): string | undefined =>
      lut.byIndex.get(index)?.name
    expect(name(BRAINSTEM_SUBFIELDS.midbrain)).toBe('Midbrain')
    expect(name(BRAINSTEM_SUBFIELDS.pons)).toBe('Pons')
    expect(name(BRAINSTEM_SUBFIELDS.medulla)).toBe('Medulla')
    expect(name(BRAINSTEM_SUBFIELDS.scp)).toBe('SCP')
    expect(name(7001)).toBe('Lateral-nucleus')
    expect(name(8001)).toBe('Thalamus-Anterior')
    expect(name(8103)).toBe('Left-AV')
    expect(name(8203)).toBe('Right-AV')
    expect(name(226)).toBe('HP_tail')
    expect(lut.byName.get('wm-lh-precentral')?.index).toBe(3024)
    expect(lut.byName.get('ctx_lh_G_and_S_frontomargin')?.index).toBe(11101)
    expect(lut.byName.get('ctx-lh-precentral')?.index).toBe(1024)
  })
})
