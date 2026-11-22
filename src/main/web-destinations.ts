/** Defines the closed purpose-specific web destinations shipped by Supraspina. */

export type WebPurpose = 'documentation' | 'download' | 'releases' | 'support'

interface DestinationRule {
  origin: string
  path: RegExp
  purposes: readonly WebPurpose[]
}

const RULES: readonly DestinationRule[] = [
  {
    origin: 'https://github.com',
    path: /^\/qwareeq8\/supraspina\/releases(?:\/.*)?\/?$/,
    purposes: ['releases', 'download'],
  },
  {
    origin: 'https://github.com',
    path: /^\/ortizo-117\/SCI_Map\/?$/,
    purposes: ['documentation'],
  },
  // The sidecar publishes this pinned archive as the support-asset acquisition
  // source, so Diagnostics must be able to open the commit it names.
  {
    origin: 'https://github.com',
    path: /^\/ortizo-117\/SCI_Map\/archive\/[0-9a-f]{40}\.tar\.gz$/,
    purposes: ['download'],
  },
  // The sidecar publishes this pinned micromamba build as the sole supported
  // Linux x86_64 download.
  {
    origin: 'https://github.com',
    path: /^\/mamba-org\/micromamba-releases\/releases\/download\/\d+\.\d+\.\d+-\d+\/micromamba-linux-64$/,
    purposes: ['download'],
  },
  {
    origin: 'https://github.com',
    path: /^\/james-cole\/PyBrainAge\/?$/,
    purposes: ['documentation', 'download'],
  },
  // The installation guide names this page as the Apptainer source, so the
  // resources panel can send an operator there when the runtime is not ready.
  {
    origin: 'https://github.com',
    path: /^\/apptainer\/apptainer\/releases\/?$/,
    purposes: ['documentation', 'download'],
  },
  {
    origin: 'https://github.com',
    path: /^\/qwareeq8\/?$/,
    purposes: ['documentation', 'support'],
  },
  {
    origin: 'https://surfer.nmr.mgh.harvard.edu',
    path: /^\/$/,
    purposes: ['documentation'],
  },
  {
    origin: 'https://surfer.nmr.mgh.harvard.edu',
    path: /^\/(?:registration\.html|fswiki\/rel8downloads)$/,
    purposes: ['download'],
  },
  {
    origin: 'https://surfer.nmr.mgh.harvard.edu',
    path: /^\/fswiki\/FreeSurfer(?:OpenSource|Software)License$/,
    purposes: ['documentation'],
  },
  {
    origin: 'https://enigma.ini.usc.edu',
    path: /^\/protocols\/imaging-protocols\/?$/,
    purposes: ['documentation'],
  },
  {
    origin: 'https://qwareeq.com',
    path: /^\/$/,
    purposes: ['documentation', 'support'],
  },
  {
    origin: 'https://doi.org',
    path: /^\/10\.5281\/zenodo\.10406573$/,
    purposes: ['documentation', 'download'],
  },
  {
    origin: 'https://zenodo.org',
    path: /^\/records\/10406573(?:\/files\/PyBrainAge\.zip)?$/,
    purposes: ['documentation', 'download'],
  },
  {
    origin: 'https://www.mathworks.com',
    path: /^\/products\/compiler\/matlab-runtime\.html$/,
    purposes: ['download'],
  },
  {
    origin: 'https://www.mathworks.com',
    path: /^\/products\/matlab\.html$/,
    purposes: ['download'],
  },
  {
    origin: 'https://conda-forge.org',
    path: /^\/$/,
    purposes: ['download'],
  },
  {
    origin: 'https://www.r-project.org',
    path: /^\/$/,
    purposes: ['download'],
  },
  {
    origin: 'https://pandoc.org',
    path: /^\/installing\.html$/,
    purposes: ['download'],
  },
]

/** Validate one HTTPS destination against its declared UI purpose. */
export function isAllowedWebDestination(
  raw: string,
  purpose?: WebPurpose,
): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return false
  }
  return RULES.some(
    (rule) =>
      rule.origin === url.origin &&
      rule.path.test(url.pathname) &&
      (purpose === undefined || rule.purposes.includes(purpose)),
  )
}
