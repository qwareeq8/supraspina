/**
 * Sets a sentence in the surrounding sans face and only its code-like tokens,
 * such as absolute paths and environment assignments, in inline mono.
 */

import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { FONTS } from '../theme/tokens'
import { splitCodeText } from './code-text'

/** Configuration for {@link InlineCode}. */
export interface InlineCodeProps {
  children: ReactNode
}

/**
 * Render one code-like value, such as a path or an identifier, in inline mono
 * at the size of the sentence around it.
 */
export function InlineCode({ children }: InlineCodeProps): ReactNode {
  return (
    <code
      style={{
        fontFamily: FONTS.mono,
        fontSize: 'inherit',
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </code>
  )
}

/** Configuration for {@link CodeText}. */
export interface CodeTextProps {
  text: string
  /** Further words to set in mono, such as a known commit hash. */
  code?: readonly string[] | undefined
}

/**
 * Render a sentence in the inherited face with its paths and environment
 * assignments in inline mono, so a status or error sentence reads as prose
 * while the values it names stay recognizable as code.
 */
export function CodeText({ text, code }: CodeTextProps): ReactNode {
  return splitCodeText(text, code).map((part, index) =>
    part.code ? (
      <InlineCode key={index}>{part.text}</InlineCode>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  )
}
