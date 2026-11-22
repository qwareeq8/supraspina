/**
 * Splits a sentence into the prose and code-like runs that CodeText renders.
 * It lives outside the component module, which exports components only.
 */

/** A run of a sentence and whether it is a code-like token. */
export interface CodeTextPart {
  text: string
  code: boolean
}

/**
 * An absolute POSIX or home path, a Windows drive path, or an environment
 * assignment such as `DISPLAY=:0`. A lone slash, as in "sub-101 / Recon", is
 * prose. An assignment needs a name of two or more characters, so a count
 * such as "N=82 subjects" stays prose.
 */
const CODE_TOKEN = /^(?:~?\/[^\s/]\S*|~\/|[A-Za-z]:\\\S*|[A-Z_][A-Z0-9_]+=\S*)$/

/** Punctuation that closes a sentence or a parenthesis after a token. */
const TRAILING = /[.,;:!?)\]"']+$/

/** Punctuation that opens a parenthesis or a quotation before a token. */
const LEADING = /^[(["']+/

/**
 * Split a sentence into prose and code-like runs. Punctuation around a token,
 * such as the period that ends a sentence after a path, stays in the prose.
 * The split is per whitespace-separated word, so only the first word of a path
 * that contains spaces is set as code; that partial mono is accepted.
 *
 * @param extra - Further words to treat as code, such as a known commit hash.
 * @returns The runs in order; adjacent prose runs are merged.
 * @example
 * splitCodeText('Apptainer at /usr/bin/apptainer.')
 * // [{ text: 'Apptainer at ', code: false },
 * //  { text: '/usr/bin/apptainer', code: true },
 * //  { text: '.', code: false }]
 */
export function splitCodeText(
  text: string,
  extra: readonly string[] = [],
): CodeTextPart[] {
  const parts: CodeTextPart[] = []
  const push = (run: string, code: boolean): void => {
    if (run === '') return
    const last = parts.at(-1)
    if (last && !last.code && !code) last.text += run
    else parts.push({ text: run, code })
  }
  for (const word of text.split(/(\s+)/)) {
    const lead = LEADING.exec(word)?.[0] ?? ''
    const rest = word.slice(lead.length)
    const trail = TRAILING.exec(rest)?.[0] ?? ''
    const core = rest.slice(0, rest.length - trail.length)
    if (core !== '' && (CODE_TOKEN.test(core) || extra.includes(core))) {
      push(lead, false)
      push(core, true)
      push(trail, false)
    } else {
      push(word, false)
    }
  }
  return parts
}
