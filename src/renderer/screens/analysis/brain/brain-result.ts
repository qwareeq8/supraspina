/**
 * What the Brain tab says about the result it draws, for either result
 * version: the color-scale ends and the exported figure's contrast and
 * correction lines. A v1 result reads its contrast; a v2 result reads the
 * drawn term (its first when none is chosen).
 */

import type {
  AnyGroupAnalysisResult,
  GroupAnalysisTerm,
} from '../../../../shared/group-analysis'
import { CORRECTION_SHORT } from '../../../figures/format'
import { resultSubtitle } from '../../../figures/forest-model'
import type { Rich } from '../../../figures/rich'

/** The words around a drawn result. */
export interface BrainResultText {
  /** The color scale's negative end, for example "Smaller in SCI". */
  negative: string
  positive: string
  /** The figure's contrast line. */
  contrast: Rich
  /** The figure's correction line, naming the outline. */
  correction: Rich
}

/**
 * Describe a result (and, for v2, one term) for the Brain tab.
 *
 * @param term - The drawn term of a v2 result, or null for its first.
 * @param rowCount - The number of drawn term rows (v2).
 */
export function brainResultText(
  result: AnyGroupAnalysisResult,
  term: GroupAnalysisTerm | null = null,
  rowCount = result.rows.length,
): BrainResultText {
  if (result.schemaVersion === 1) {
    const [contrast, correction] = resultSubtitle(result, 'outlined')
    const groups = result.spec.contrast
    const [negative, positive] =
      groups.type === 'groups'
        ? [`Smaller in ${groups.focal}`, `Larger in ${groups.focal}`]
        : ['Negative association', 'Positive association']
    return { negative, positive, contrast: contrast!, correction: correction! }
  }
  const drawn = term ?? result.terms[0] ?? null
  const test = drawn
    ? result.spec.tests.find((item) => item.id === drawn.testId)
    : undefined
  const focal = drawn?.pair?.focal ?? test?.factor?.focal ?? null
  const [negative, positive] =
    drawn?.kind === 't' && focal
      ? [`Smaller in ${focal}`, `Larger in ${focal}`]
      : test?.kind === 'association'
        ? ['Negative association', 'Positive association']
        : ['Negative', 'Positive']
  const { correction, alpha } = result.spec.inference
  const family = `over the ${rowCount} ${rowCount === 1 ? 'measure' : 'measures'} of this term`
  return {
    negative,
    positive,
    contrast: [
      `${drawn?.label ?? result.name}, `,
      { i: 'n' },
      ` = ${result.sample.included}`,
    ],
    // A sensitivity term sits outside the correction family, and the engine
    // marks none of its rows significant unless nothing is corrected.
    correction:
      correction === 'none'
        ? ['outlined: ', { i: 'p' }, ` < ${alpha} uncorrected`]
        : drawn?.family === null
          ? ['not outlined: a sensitivity term, outside the correction family']
          : [
              'outlined: ',
              `${CORRECTION_SHORT[correction]} `,
              { i: 'p' },
              ` < ${alpha} ${family}`,
            ],
  }
}
