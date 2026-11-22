/** Set a rich figure line as SVG text with styled tspans. */

import type { ReactNode, SVGProps } from 'react'
import type { Rich } from './rich'

/** Where and how to set a rich line. */
export type RichTextProps = Omit<SVGProps<SVGTextElement>, 'children'> & {
  rich: Rich
}

/**
 * Set a rich line as one SVG text element with tspans for the styled runs.
 *
 * @param props - The line and the text element's attributes.
 */
export function RichText({ rich, ...props }: RichTextProps): ReactNode {
  return (
    <text {...props}>
      {rich.map((run, index) =>
        typeof run === 'string' ? (
          run
        ) : 'i' in run ? (
          <tspan key={index} fontStyle="italic">
            {run.i}
          </tspan>
        ) : (
          <tspan key={index} fontWeight={700}>
            {run.b}
          </tspan>
        ),
      )}
    </text>
  )
}
