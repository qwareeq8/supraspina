import { describe, expect, it } from 'vitest'
import { releasePageUrl } from '../shared/releases'
import { isAllowedWebDestination } from './web-destinations'

describe('closed web destination policy', () => {
  it('allows only shipped HTTPS paths for their declared purpose', () => {
    expect(
      isAllowedWebDestination(
        'https://github.com/qwareeq8/supraspina/releases',
        'releases',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://zenodo.org/records/10406573/files/PyBrainAge.zip',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination('https://www.r-project.org/', 'download'),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://doi.org/10.5281/zenodo.10406573',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://github.com/james-cole/PyBrainAge',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination('https://github.com/qwareeq8', 'documentation'),
    ).toBe(true)
    expect(
      isAllowedWebDestination('https://qwareeq.com/', 'documentation'),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://github.com/qwareeq8/supraspina/releases',
        'support',
      ),
    ).toBe(false)
  })

  it.each([
    'not a URL',
    'http://github.com/qwareeq8/supraspina/releases',
    'file:///data/private/result.txt',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'supraspina://open/project',
    'https://attacker.test/',
    'https://octave.org/download/',
    'https://github.com/other/repository/releases',
    'https://github.com/qwareeq8/supraspina/issues',
    'https://user:password@github.com/qwareeq8/supraspina/releases',
    'https://github.com:444/qwareeq8/supraspina/releases',
    'https://github.com/qwareeq8/supraspina/releases?token=secret',
    'https://github.com/qwareeq8/supraspina/releases#fragment',
  ])('rejects %s', (url) => {
    expect(isAllowedWebDestination(url)).toBe(false)
  })
})

describe('pinned upstream download destinations', () => {
  it('allows the exact archive and micromamba downloads the sidecar publishes', () => {
    expect(
      isAllowedWebDestination(
        'https://github.com/ortizo-117/SCI_Map/archive/8a8c2d3586a37bb896bd8bdc3743b43e602827e3.tar.gz',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://github.com/mamba-org/micromamba-releases/releases/download/2.7.0-0/micromamba-linux-64',
        'download',
      ),
    ).toBe(true)
  })

  it('keeps the widened rules narrow', () => {
    expect(
      isAllowedWebDestination(
        'https://github.com/ortizo-117/SCI_Map/archive/main.tar.gz',
        'download',
      ),
    ).toBe(false)
    expect(
      isAllowedWebDestination(
        'https://github.com/mamba-org/micromamba-releases/releases/download/2.7.0-0/micromamba-osx-64',
        'download',
      ),
    ).toBe(false)
    expect(
      isAllowedWebDestination(
        'https://github.com/ortizo-117/SCI_Map/archive/8a8c2d3586a37bb896bd8bdc3743b43e602827e3.tar.gz',
        'documentation',
      ),
    ).toBe(false)
  })
})

describe('Apptainer releases page', () => {
  it('allows exactly the releases index the installation guide names', () => {
    expect(
      isAllowedWebDestination(
        'https://github.com/apptainer/apptainer/releases',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://github.com/apptainer/apptainer/releases/',
        'documentation',
      ),
    ).toBe(true)
  })

  it.each([
    'https://github.com/apptainer/apptainer',
    'https://github.com/apptainer/apptainer/releases/tag/v1.5.3',
    'https://github.com/apptainer/apptainer/releases?page=2',
    'http://github.com/apptainer/apptainer/releases',
  ])('rejects %s', (url) => {
    expect(isAllowedWebDestination(url, 'download')).toBe(false)
  })
})

describe('Pandoc installation page', () => {
  it('allows exactly the official installation instructions for download', () => {
    expect(
      isAllowedWebDestination('https://pandoc.org/installing.html', 'download'),
    ).toBe(true)
  })

  it.each([
    'https://pandoc.org/',
    'https://pandoc.org/index.html',
    'https://pandoc.org/installing.html?os=linux',
    'https://pandoc.org/installing.html#linux',
    'http://pandoc.org/installing.html',
  ])('rejects %s', (url) => {
    expect(isAllowedWebDestination(url, 'download')).toBe(false)
  })
})

describe('MathWorks landing pages', () => {
  it('allows exactly the MATLAB product and Runtime landing pages for download', () => {
    expect(
      isAllowedWebDestination(
        'https://www.mathworks.com/products/matlab.html',
        'download',
      ),
    ).toBe(true)
    expect(
      isAllowedWebDestination(
        'https://www.mathworks.com/products/compiler/matlab-runtime.html',
        'download',
      ),
    ).toBe(true)
  })

  it.each([
    // The Runtime installer zip host stays copy-only, never openable.
    'https://ssd.mathworks.com/supportfiles/downloads/R2019b/Release/9/deployment_files/installer/complete/glnxa64/MATLAB_Runtime_R2019b_Update_9_glnxa64.zip',
    'https://www.mathworks.com/products/matlab.html?requestedDomain=true',
    'https://www.mathworks.com/products/matlab.html#pricing',
    'https://www.mathworks.com/products/simulink.html',
    'https://www.mathworks.com/',
  ])('rejects %s', (url) => {
    expect(isAllowedWebDestination(url, 'download')).toBe(false)
  })
})

describe('release pages', () => {
  it('opens every release page link through the releases purpose', () => {
    expect(
      isAllowedWebDestination(releasePageUrl('20261121.1830.0'), 'releases'),
    ).toBe(true)
    expect(isAllowedWebDestination(releasePageUrl(null), 'releases')).toBe(true)
  })
})
