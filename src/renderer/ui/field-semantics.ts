import { createContext, useContext } from 'react'

/** The shared ARIA relationships for one form field. */
export interface FieldSemantics {
  controlId: string
  labelId: string
  hintId?: string | undefined
  errorId?: string | undefined
}

/** Field-level ARIA relationships shared with nested controls. */
export const FieldSemanticsContext = createContext<FieldSemantics | null>(null)

function joinIds(...values: Array<string | undefined>): string | undefined {
  const ids = values
    .flatMap((value) => value?.split(/\s+/) ?? [])
    .filter(Boolean)
  return ids.length > 0 ? [...new Set(ids)].join(' ') : undefined
}

/**
 * Resolve native ARIA wiring for a control nested in a shared form Field.
 *
 * @returns Merged field and control ARIA relationships.
 */
export function useFieldControlSemantics(options: {
  id?: string | undefined
  ariaDescribedBy?: string | undefined
  ariaErrorMessage?: string | undefined
  invalid?: boolean | undefined
}): {
  id?: string | undefined
  labelledBy?: string | undefined
  describedBy?: string | undefined
  errorMessage?: string | undefined
  invalid?: boolean | undefined
} {
  const field = useContext(FieldSemanticsContext)
  const invalid = options.invalid || field?.errorId !== undefined
  return {
    id: options.id ?? field?.controlId,
    labelledBy: field?.labelId,
    describedBy: joinIds(
      options.ariaDescribedBy,
      field?.hintId,
      invalid ? field?.errorId : undefined,
    ),
    errorMessage:
      options.ariaErrorMessage ?? (invalid ? field?.errorId : undefined),
    invalid,
  }
}
