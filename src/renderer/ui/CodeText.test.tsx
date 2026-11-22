import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CheckRow } from '../screens/env/CheckRow'
import { THEMES } from '../theme/tokens'
import { CodeText } from './CodeText'
import { splitCodeText } from './code-text'

describe('splitCodeText', () => {
  it('marks paths and environment assignments and keeps punctuation in prose', () => {
    expect(splitCodeText('Apptainer 1.5.4 at /usr/bin/apptainer.')).toEqual([
      { text: 'Apptainer 1.5.4 at ', code: false },
      { text: '/usr/bin/apptainer', code: true },
      { text: '.', code: false },
    ])
    expect(splitCodeText('DISPLAY=:0')).toEqual([
      { text: 'DISPLAY=:0', code: true },
    ])
    expect(splitCodeText('Saved (~/x.csv), C:\\data\\a.csv too')).toEqual([
      { text: 'Saved (', code: false },
      { text: '~/x.csv', code: true },
      { text: '), ', code: false },
      { text: 'C:\\data\\a.csv', code: true },
      { text: ' too', code: false },
    ])
  })

  it('also marks the extra words it is given, such as a commit hash', () => {
    expect(
      splitCodeText(
        '2026-11-21 18:30 UTC, development build 0123456 (modified)',
        ['0123456'],
      ),
    ).toEqual([
      { text: '2026-11-21 18:30 UTC, development build ', code: false },
      { text: '0123456', code: true },
      { text: ' (modified)', code: false },
    ])
  })

  it('needs a name of two or more characters before an assignment', () => {
    expect(splitCodeText('N=82 subjects in the model.')).toEqual([
      { text: 'N=82 subjects in the model.', code: false },
    ])
    expect(splitCodeText('Set FS_LICENSE=/opt/license.txt first.')).toEqual([
      { text: 'Set ', code: false },
      { text: 'FS_LICENSE=/opt/license.txt', code: true },
      { text: ' first.', code: false },
    ])
  })

  it('sets only the first word of a path with spaces in mono', () => {
    // An accepted limitation: the split is per whitespace-separated word.
    expect(splitCodeText('Saved to /data/My Study/out.csv.')).toEqual([
      { text: 'Saved to ', code: false },
      { text: '/data/My', code: true },
      { text: ' Study/out.csv.', code: false },
    ])
  })

  it('leaves a sentence without code-like tokens as one prose run', () => {
    const sentence = 'Reconstruction / sub-101 needs and/or 3 of 4 subjects.'
    expect(splitCodeText(sentence)).toEqual([{ text: sentence, code: false }])
  })
})

describe('CodeText', () => {
  it('sets only the path in mono', () => {
    const { container } = render(
      <p>
        <CodeText text="The CRLF converter is at /usr/bin/dos2unix." />
      </p>,
    )
    expect(container.textContent).toBe(
      'The CRLF converter is at /usr/bin/dos2unix.',
    )
    const code = screen.getByText('/usr/bin/dos2unix')
    expect(code.tagName).toBe('CODE')
    expect(code.style.fontFamily).toContain('WebCM Mono 10')
    expect(container.querySelectorAll('code')).toHaveLength(1)
  })
})

describe('CheckRow detail', () => {
  it('sets the detail sentence in sans with its path in mono', () => {
    render(
      <CheckRow
        t={THEMES.light}
        check={{
          id: 'dos2unix',
          label: 'dos2unix',
          status: 'found',
          detail: 'The CRLF converter is at /usr/bin/dos2unix.',
        }}
        requirement="required"
        first
        safeExecution={false}
        installBusy={false}
        copied={false}
        onCopyFix={vi.fn()}
        onGetIt={vi.fn()}
        onInstall={vi.fn()}
      />,
    )
    const code = screen.getByText('/usr/bin/dos2unix')
    const detail = code.parentElement
    expect(detail?.style.fontFamily).toContain('WebCM Sans 10')
    expect(detail).toHaveTextContent(
      'The CRLF converter is at /usr/bin/dos2unix.',
    )
    expect(code.style.fontFamily).toContain('WebCM Mono 10')
  })
})
