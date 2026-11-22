import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The reviewed digest of every committed Supraspina brand asset. */
const CANONICAL_BRAND_DIGESTS = {
  'packaging/icon.png':
    '8b5ed1c768e00352ed6175a273af63c9fb33ec2a83b731b7314577b2f4b6373e',
  'src/renderer/assets/brand/supraspina_icon.svg':
    '12fe4431f3861e55eff2415dd7257b4d37d3c79cd1244297074e8b380d052d94',
}

const root = resolve(import.meta.dirname, '../..')

describe('Supraspina application icon', () => {
  it('keeps the canonical brain and brainstem mark in package metadata', async () => {
    const builder = await readFile(
      resolve(root, 'electron-builder.yml'),
      'utf8',
    )

    expect(builder).toContain('buildResources: packaging')
    expect(builder).toContain('from: packaging/icon.png')
    for (const [name, expected] of Object.entries(CANONICAL_BRAND_DIGESTS)) {
      const value = await readFile(resolve(root, name))
      expect(
        `${name}:${createHash('sha256').update(value).digest('hex')}`,
      ).toBe(`${name}:${expected}`)
    }
  })

  it('ships a square transparent 512-pixel launcher icon', async () => {
    const png = await readFile(resolve(root, 'packaging/icon.png'))

    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(512)
    expect(png.readUInt32BE(20)).toBe(512)
    // Require an RGBA color type so the desktop icon keeps its transparency.
    expect(png[25]).toBe(6)
  })

  it('ships the complete hicolor icon ladder', async () => {
    const directory = resolve(root, 'packaging/icons')
    const entries = (await readdir(directory)).sort()

    expect(entries).toEqual([
      '128x128.png',
      '16x16.png',
      '256x256.png',
      '32x32.png',
      '48x48.png',
      '512x512.png',
      '64x64.png',
    ])
    for (const name of entries) {
      const size = Number(name.split('x')[0])
      const png = await readFile(resolve(directory, name))
      expect(`${name}:${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(
        `${name}:${size}x${size}`,
      )
      expect(png[25]).toBe(6)
    }
    // Keep the largest rung byte-identical to the canonical packaged mark.
    expect(await readFile(resolve(directory, '512x512.png'))).toEqual(
      await readFile(resolve(root, 'packaging/icon.png')),
    )
  })

  it('names the canonical mark accessibly', async () => {
    const svg = await readFile(
      resolve(root, 'src/renderer/assets/brand/supraspina_icon.svg'),
      'utf8',
    )

    expect(svg).toContain('aria-label="Supraspina icon"')
    expect(svg).toContain('role="img"')
    expect(svg).toContain('viewBox="6.3 -17.8 505.5 505.5"')
  })

  it('ships one full-color mark and no monochrome variant', async () => {
    const svg = await readFile(
      resolve(root, 'src/renderer/assets/brand/supraspina_icon.svg'),
      'utf8',
    )
    const brandmark = await readFile(
      resolve(root, 'src/renderer/ui/Brandmark.tsx'),
      'utf8',
    )

    // The restyled Lynch drawing: outlines, gyri, folia, and brainstem lines.
    expect([...svg.matchAll(/\sd="([^"]+)"/g)]).toHaveLength(119)
    // Keep the green palette and the brainstem as the single red accent.
    expect(svg).toContain('#dcefe5')
    expect(svg).toContain('#9fd3bb')
    expect(svg).toContain('#2a7553')
    expect(svg).toContain('#e0533b')
    expect(await readdir(resolve(root, 'src/renderer/assets/brand'))).toEqual([
      'supraspina_icon.svg',
    ])
    expect(brandmark).not.toContain('_white')
    expect(brandmark).not.toContain('_mono')
    expect(brandmark).not.toContain('themeName')
  })
})
