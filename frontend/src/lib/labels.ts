// Outcome labels by launch kind. Outcome 0/1 is the same storage for both kinds (SPEC "Question
// launches"); only the words differ: Up/Down for a price launch, YES/NO for a question launch.

export type LaunchKind = 'price' | 'question'

export interface OutcomeLabels {
  kind: LaunchKind
  /** [outcome 0, outcome 1] */
  names: readonly [string, string]
  /** Settled-result marks, e.g. "Up ▲" / "YES". */
  marks: readonly [string, string]
}

export const PRICE_LABELS: OutcomeLabels = { kind: 'price', names: ['Up', 'Down'], marks: ['Up ▲', 'Down ▼'] }
export const QUESTION_LABELS: OutcomeLabels = { kind: 'question', names: ['YES', 'NO'], marks: ['YES', 'NO'] }

const ZERO = /^0x0{40}$/i

/** The launch kind: the sequencer's `kind` when present, else feed = address(0) marks a question launch. */
export function kindOf(l: { kind?: string | null; feed?: string | null } | null | undefined): LaunchKind {
  if (l?.kind === 'question' || l?.kind === 'price') return l.kind
  return l?.feed && ZERO.test(l.feed) ? 'question' : 'price'
}

export const labelsFor = (l: LaunchKind | { kind?: string | null; feed?: string | null } | null | undefined): OutcomeLabels =>
  (typeof l === 'string' ? l : kindOf(l)) === 'question' ? QUESTION_LABELS : PRICE_LABELS

/** Name of outcome 0/1 (anything else, e.g. 2 = Void, is "Void"). */
export const outcomeName = (labels: OutcomeLabels, outcome: number) => (outcome === 0 || outcome === 1 ? labels.names[outcome] : 'Void')
