import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Chip } from './Chip'
import { InlineCode } from './CodeText'
import { Kbd } from './Kbd'
import { Hint } from './Help'
import { StateLine } from './StateLine'
import { stateLineStyle } from './state-line'
import { StatusCell } from './StatusCell'
import { StatusLegend } from './StatusLegend'
import { Toggle } from './Forms'
import { Collapsible } from './Collapsible'
import { Code } from './Layout'
import { ErrorState } from './ErrorState'
import { LoadingState } from './LoadingState'
import { StatusDot } from './StatusDot'
import {
  errorMessageText,
  failureReasonText,
  formatRunTime,
  humanizeError,
} from './status'
import { DENSITY, THEMES, statusColor } from '../theme/tokens'
import { emptyCell } from '../../shared/types'
import { Ico } from './icons'
import { ICONS } from './icon-set'
import { RefreshButton } from './RefreshButton'
import { ScopeChip } from './ScopeChip'
import { formatAgeYears } from './status'

const t = THEMES.dark
const density = DENSITY.cozy

describe('Chip', () => {
  it('should render the default label for a status', () => {
    render(<Chip t={t} status="found" />)
    expect(screen.getByText('Found')).toBeInTheDocument()
  })

  it('should honor a custom label', () => {
    render(<Chip t={t} status="missing" label="3 missing" />)
    expect(screen.getByText('3 missing')).toBeInTheDocument()
  })

  it('sets a status word in sans and a code in mono only on request', () => {
    render(
      <>
        <Chip t={t} status="running" label="Running" small />
        <Chip t={t} status="failed" label="rc=1" small mono />
      </>,
    )
    expect(screen.getByText('Running').style.fontFamily).toContain(
      'WebCM Sans 10',
    )
    expect(screen.getByText('rc=1').style.fontFamily).toContain('WebCM Mono 10')
  })
})

describe('Hint', () => {
  it('sets guidance in sans with an inline path in mono', () => {
    render(
      <Hint t={t}>
        {'Saved the example to '}
        <InlineCode>/data/example.csv</InlineCode>
        {'.'}
      </Hint>,
    )
    const path = screen.getByText('/data/example.csv')
    expect(path.style.fontFamily).toContain('WebCM Mono 10')
    expect(path.parentElement?.style.fontFamily).toContain('WebCM Sans 10')
    expect(path.parentElement).toHaveTextContent(
      'Saved the example to /data/example.csv.',
    )
  })
})

describe('Ico', () => {
  it('Keeps decorative SVG paths out of the accessibility tree.', () => {
    const { container } = render(<Ico d={ICONS.info} />)
    const icon = container.querySelector('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveAttribute('focusable', 'false')
  })
})

describe('StatusCell', () => {
  it('should expose an accessible label combining step and state', () => {
    const cell = { ...emptyCell(), st: 'failed' as const, rc: 137 }
    render(
      <StatusCell cell={cell} density={density} t={t} stepLabel="recon-all" />,
    )
    expect(screen.getByLabelText('recon-all: failed')).toBeInTheDocument()
  })

  it('should fill the running ring to the step progress', () => {
    const cell = { ...emptyCell(), st: 'running' as const, progress: 42 }
    const { container } = render(
      <StatusCell cell={cell} density={density} t={t} stepLabel="recon-all" />,
    )
    const running = container.querySelector('[aria-label="recon-all: running"]')
    expect(running).not.toBeNull()
    const arc = running?.querySelector('circle[stroke-dasharray]')
    expect(arc).toHaveAttribute('stroke-dasharray', '42 100')
  })
})

describe('StatusLegend', () => {
  it.each(['done', 'failed', 'pending', 'skipped', 'outdated'] as const)(
    'draws the %s sample with the glyph its cell draws',
    (st) => {
      const { container } = render(<StatusLegend t={t} />)
      const sample = container.querySelector(`[data-legend-glyph="${st}"]`)
      const { container: cellHost } = render(
        <StatusCell cell={{ ...emptyCell(), st }} density={density} t={t} />,
      )
      const cell = cellHost.querySelector('[role="img"]')
      expect(sample).not.toBeNull()
      expect(sample?.innerHTML).toBe(cell?.innerHTML)
    },
  )

  it('draws Running as the cell progress ring without the pulse', () => {
    const { container } = render(<StatusLegend t={t} />)
    const sample = container.querySelector('[data-legend-glyph="running"]')
    const ring = sample?.firstElementChild as SVGElement
    expect(sample?.children).toHaveLength(1)
    expect(ring).toHaveAttribute('data-glyph-shape', 'progress-ring')
    expect(ring.style.animation).toBe('')
  })

  it('draws Out of date as a shape of its own, unlike the done check', () => {
    const { container } = render(<StatusLegend t={t} />)
    const outdated = container.querySelector('[data-legend-glyph="outdated"]')
    const done = container.querySelector('[data-legend-glyph="done"]')
    expect(outdated?.parentElement).toHaveTextContent('Out of date')
    expect(outdated?.querySelector('svg')).not.toBeNull()
    expect(outdated?.innerHTML).not.toBe(done?.innerHTML)
    const { container: cellHost } = render(
      <StatusCell
        cell={{ ...emptyCell(), st: 'outdated' }}
        density={density}
        t={t}
        stepLabel="Subcortical QC"
      />,
    )
    const cell = cellHost.querySelector('[role="img"]')
    expect(cell).toHaveAttribute('title', 'Subcortical QC: out of date')
    expect(cell).toHaveAttribute('data-nontext-contrast', 'status-glyph')
  })

  it('keeps the Pending empty ring distinct from the Skipped minus ring', () => {
    const { container } = render(<StatusLegend t={t} />)
    const pending = container.querySelector('[data-legend-glyph="pending"]')
    const skipped = container.querySelector('[data-legend-glyph="skipped"]')
    expect(pending?.querySelector('svg')).toHaveAttribute(
      'data-glyph-shape',
      'ring',
    )
    expect(skipped?.querySelector('svg')).toHaveAttribute(
      'data-glyph-shape',
      'minus-ring',
    )
  })
})

describe('Toggle', () => {
  it('should render as an accessible switch reflecting checked state', () => {
    render(<Toggle t={t} checked label="Dry run" />)
    const sw = screen.getByRole('switch', { name: 'Dry run' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
  })
})

describe('Collapsible', () => {
  it('should expose aria-expanded and hide the region when collapsed', () => {
    const onToggle = vi.fn()
    render(
      <Collapsible
        t={t}
        id="region-1"
        open={false}
        onToggle={onToggle}
        header={<span>FreeSurfer</span>}
      >
        <div>body content</div>
      </Collapsible>,
    )
    const button = screen.getByRole('button', { name: /FreeSurfer/ })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('aria-controls', 'region-1')
    expect(screen.queryByText('body content')).not.toBeInTheDocument()
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('should reveal the controlled region when open', () => {
    render(
      <Collapsible
        t={t}
        id="region-2"
        open
        onToggle={() => undefined}
        header={<span>MATLAB</span>}
      >
        <div>body content</div>
      </Collapsible>,
    )
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('body content')).toBeInTheDocument()
  })
})

describe('ErrorState', () => {
  it('should announce as an alert and fire retry', () => {
    const onRetry = vi.fn()
    render(
      <ErrorState
        t={t}
        title="Could not load"
        detail="boom"
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('should announce one message when the detail repeats the title', () => {
    render(
      <ErrorState
        t={t}
        title="Keep paths.outputDir separate from paths.rawdataDir."
        detail="Keep paths.outputDir separate from paths.rawdataDir."
      />,
    )
    expect(
      screen.getAllByText(
        'Keep paths.outputDir separate from paths.rawdataDir.',
      ),
    ).toHaveLength(1)
  })

  it('sets a detail sentence in sans and raw output in mono on request', () => {
    const { rerender } = render(
      <ErrorState
        t={t}
        title="Could not load results."
        detail="Could not read /data/project/outputs."
      />,
    )
    const path = screen.getByText('/data/project/outputs')
    expect(path.style.fontFamily).toContain('WebCM Mono 10')
    expect(path.parentElement?.style.fontFamily).toContain('WebCM Sans 10')

    rerender(
      <ErrorState t={t} title="Out of memory" detail="oom_killed" mono />,
    )
    expect(screen.getByText('oom_killed').style.fontFamily).toContain(
      'WebCM Mono 10',
    )
  })
})

describe('StateLine', () => {
  it('sets a state sentence in sans with the dim color and span attributes', () => {
    render(
      <StateLine t={t} size={11.5} title="Counts" data-stage-counts="">
        0 done of 4
      </StateLine>,
    )
    const line = screen.getByText('0 done of 4')
    expect(line.style.fontFamily).toContain('WebCM Sans 10')
    expect(line.style.fontSize).toBe('11.5px')
    expect(line).toHaveAttribute('title', 'Counts')
    expect(line).toHaveAttribute('data-stage-counts', '')
    expect(stateLineStyle(t)).toMatchObject({ fontSize: 11, color: t.dimText })
  })
})

describe('formatAgeYears', () => {
  it('shows completed years and keeps whole ages as they are', () => {
    expect(formatAgeYears(54.67)).toBe('54')
    expect(formatAgeYears(54.99)).toBe('54')
    expect(formatAgeYears(41)).toBe('41')
    expect(formatAgeYears(0.5)).toBe('0')
  })

  it('shows the unknown text for an unrecorded age', () => {
    expect(formatAgeYears(null)).toBe('-')
    expect(formatAgeYears(null, 'Unknown')).toBe('Unknown')
    expect(formatAgeYears(Number.NaN)).toBe('-')
  })
})

describe('RefreshButton', () => {
  it('shows a busy refresh in the running color, still and disabled', () => {
    // A rediscovery runs for many seconds, so its busy glyph holds still, as
    // LoadingState's dot does, instead of pulsing.
    render(
      <RefreshButton
        t={t}
        ariaLabel="Re-discover the cohort"
        busy
        busyLabel="Re-discovering the cohort..."
        onClick={() => undefined}
      />,
    )
    const button = screen.getByRole('button', {
      name: 'Re-discover the cohort',
    })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('title', 'Re-discovering the cohort...')
    expect(button).toBeDisabled()
    expect(button).toHaveStyle({ color: statusColor(t, 'running') })
    expect(button.innerHTML).not.toContain('animation')
  })

  it('shows an idle refresh without a busy state', () => {
    render(<RefreshButton t={t} onClick={() => undefined} />)
    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).not.toHaveAttribute('aria-busy')
    expect(button).toBeEnabled()
  })
})

describe('ScopeChip', () => {
  it('names the clear control of a selection as a focusable button', () => {
    // Without a named control in reach, clearing a selection would take
    // row-by-row unchecking.
    const clear = vi.fn()
    const all = vi.fn()
    render(
      <ScopeChip
        t={t}
        target={{ mode: 'explicit', subjectIds: ['sub-001', 'sub-002'] }}
        label="2 of 5 selected"
        onClearSelection={clear}
        onSelectAll={all}
      />,
    )
    expect(screen.getByText('2 of 5 selected')).toBeInTheDocument()
    const button = screen.getByRole('button', {
      name: 'Clear selected subjects',
    })
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(clear).toHaveBeenCalledOnce()
    expect(all).not.toHaveBeenCalled()
  })

  it('offers the full cohort for an empty selection and nothing for all', () => {
    const all = vi.fn()
    const { rerender } = render(
      <ScopeChip
        t={t}
        target={{ mode: 'explicit', subjectIds: [] }}
        label="No subjects selected"
        onClearSelection={() => undefined}
        onSelectAll={all}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Use the full analysis cohort' }),
    )
    expect(all).toHaveBeenCalledOnce()
    rerender(
      <ScopeChip
        t={t}
        target={{ mode: 'all' }}
        label="All 5 subjects"
        onClearSelection={() => undefined}
        onSelectAll={all}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('LoadingState', () => {
  it('should announce as a polite status with its label', () => {
    render(<LoadingState t={t} label="Loading the cohort..." />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Loading the cohort...')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('should show a silent repeat without a live region', () => {
    render(
      <LoadingState
        t={t}
        label="Planning the workflow..."
        block
        live={false}
      />,
    )
    const row = screen.getByText('Planning the workflow...')
    expect(row).not.toHaveAttribute('role')
    expect(row).not.toHaveAttribute('aria-live')
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.querySelector('[aria-live]')).toBeNull()
  })

  it('draws a still dot, so a long wait keeps the compositor idle', () => {
    const { container } = render(
      <LoadingState t={t} label="Restoring run history..." />,
    )
    const dot = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(dot).not.toBeNull()
    expect(dot.style.animation).toBe('none')
  })
})

describe('StatusDot', () => {
  it('pulses for active work and holds still when asked to', () => {
    const { container } = render(
      <>
        <StatusDot t={t} status="running" />
        <StatusDot t={t} status="running" still />
        <StatusDot t={t} status="done" />
      </>,
    )
    const animations = Array.from(
      container.querySelectorAll<HTMLElement>('span'),
      (dot) => dot.style.animation,
    )
    expect(animations).toEqual([
      'sciwPulse 1.3s ease-in-out infinite',
      'none',
      'none',
    ])
  })
})

describe('formatRunTime', () => {
  it('should return "unknown time" for a null value', () => {
    expect(formatRunTime(null)).toBe('unknown time')
  })

  it('should return "unknown time" for an unparseable date string', () => {
    expect(formatRunTime('not-a-date')).toBe('unknown time')
  })
})

describe('failureReasonText', () => {
  it('states a reason code as its sentence without humanizing it again', () => {
    expect(failureReasonText('operator_cancelled')).toBe(
      "Canceled at the operator's request.",
    )
    expect(failureReasonText(' persistence_error ')).toBe(
      "Supraspina could not persist this job's state.",
    )
  })

  it('humanizes a machine tag that has no sentence', () => {
    expect(failureReasonText('oom_killed')).toBe('Out of memory')
    expect(failureReasonText('feature_error')).toBe('Feature error')
  })

  it('keeps recorded prose as recorded', () => {
    expect(failureReasonText('mri_surf2surf ended with exit code 255.')).toBe(
      'mri_surf2surf ended with exit code 255.',
    )
  })

  it('reads a reason with no letter or digit as no reason', () => {
    expect(failureReasonText('-'.repeat(58))).toBeNull()
    expect(failureReasonText('   ')).toBeNull()
    expect(failureReasonText(null)).toBeNull()
    expect(failureReasonText(undefined)).toBeNull()
  })
})

describe('errorMessageText', () => {
  it('keeps the underscores of a tool or path named in an error message', () => {
    // Humanizing free text would turn "mri_surf2surf" into "Mri surf2surf"
    // and drop the underscores of a path.
    expect(errorMessageText('mri_surf2surf ended with exit code 255.')).toBe(
      'mri_surf2surf ended with exit code 255.',
    )
    expect(
      errorMessageText(
        'Could not write /data/my_study/supraspina.project.json.',
      ),
    ).toBe('Could not write /data/my_study/supraspina.project.json.')
  })

  it('states a reason code or a bare machine tag as the reason helpers do', () => {
    expect(errorMessageText('operator_cancelled')).toBe(
      "Canceled at the operator's request.",
    )
    expect(errorMessageText('oom_killed')).toBe('Out of memory')
    expect(errorMessageText('feature_error')).toBe('Feature error')
  })

  it('keeps a message with nothing readable as written', () => {
    expect(errorMessageText('---')).toBe('---')
    expect(errorMessageText('')).toBe('')
  })
})

describe('humanizeError', () => {
  it('never reads a tag named like an object property from the prototype', () => {
    expect(humanizeError('constructor')).toBe('Constructor')
    expect(humanizeError('to_string')).toBe('To string')
    expect(failureReasonText('constructor')).toBe('Constructor')
  })
})

describe('Code', () => {
  it('gives a height-capped block keyboard access to its scroll region', () => {
    render(<Code t={THEMES.dark} value="supraspina run" maxHeight={120} />)

    // A block holds a shell command unless it names another kind.
    const block = screen.getByRole('group', { name: 'Shell command' })
    expect(block.tabIndex).toBe(0)
    expect(block.style.overflow).toBe('auto')
    expect(block).toHaveTextContent(/^Bash/)
  })

  it.each([
    ['command', 'Shell command', 'Bash'],
    ['json-config', 'JSON configuration', 'JSON'],
    ['output', 'Command output', 'OUTPUT'],
    ['stdout', 'Standard output', 'STDOUT'],
    ['stderr', 'Standard error', 'STDERR'],
    ['paths', 'File locations', 'PATHS'],
  ] as const)(
    'names a %s block by its kind, never as a command of another kind',
    (kind, name, tag) => {
      render(<Code t={THEMES.dark} value="{}" kind={kind} maxHeight={120} />)

      const block = screen.getByRole('group', { name })
      expect(block).toHaveAccessibleName(name)
      expect(block).toHaveTextContent(new RegExp(`^${tag}`))
      if (kind !== 'command') {
        expect(block.getAttribute('aria-label')).not.toMatch(/command$/)
      }
    },
  )

  it('adds no tab stop for a block that cannot scroll', () => {
    render(<Code t={THEMES.dark} value="supraspina run" />)

    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('Kbd', () => {
  const hexToRgb = (hex: string): string => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return `rgb(${r}, ${g}, ${b})`
  }

  it('sets the keys as a mono key cap and dims a muted one', () => {
    const view = render(<Kbd t={t}>J/K</Kbd>)
    const key = screen.getByText('J/K')
    expect(key.tagName).toBe('KBD')
    expect(key.style.fontFamily).toContain('WebCM Mono 10')
    expect(key.style.color).toBe(hexToRgb(t.text))
    view.rerender(
      <Kbd t={t} muted>
        J/K
      </Kbd>,
    )
    expect(screen.getByText('J/K').style.color).toBe(hexToRgb(t.dim))
  })
})
