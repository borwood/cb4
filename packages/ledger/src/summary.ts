// Element summaries: a short, author-written line that list reads show instead of the full
// description (LikeC4's native `summary` property). New elements must carry one (see validate.ts);
// elements recorded before the rule get one derived on read from the first sentence of their
// description, flagged as derived and never written back by a read.
//
// LikeC4's `summary` and `description` getters fall back to each other, so presence is always read
// from the raw element data, never from the getters.
import type { ElementModel } from '@likec4/core/model'

/** Longest summary list reads show; longer stored summaries are cut there, and validation warns about them. */
export const SUMMARY_MAX = 200

type RawText = { txt?: string; md?: string } | string | null | undefined

function rawText(v: RawText): string | null {
  if (!v) return null
  const t = typeof v === 'string' ? v : (v.txt ?? v.md ?? '')
  const trimmed = t.trim()
  return trimmed ? trimmed : null
}

/** The element's own description, without LikeC4's fallback to the summary. */
export function rawDescription(el: ElementModel): string | null {
  return rawText((el.$element as { description?: RawText }).description)
}

/** The element's stored summary, without LikeC4's fallback to the description. */
export function rawSummary(el: ElementModel): string | null {
  return rawText((el.$element as { summary?: RawText }).summary)
}

/**
 * The first sentence of a text, on one line, at most SUMMARY_MAX characters. A sentence ends at
 * `.`, `!` or `?` followed by whitespace and an uppercase letter, digit or opening mark, or at a
 * blank line; abbreviations such as "e.g. the" do not end one.
 */
export function firstSentence(text: string): string {
  const para = text.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').trim()
  const m = /[.!?](?=\s+[A-Z0-9"'(`[*_])/.exec(para)
  const sentence = m ? para.slice(0, m.index + 1) : para
  return clip(sentence)
}

/** One line, cut at SUMMARY_MAX with an ellipsis. */
export function clip(text: string, max = SUMMARY_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…'
}

export interface SummaryValue { text: string; derived: boolean }

/** The summary list reads show: the stored one, else one derived from the description, else null. */
export function summaryOf(el: ElementModel): SummaryValue | null {
  const stored = rawSummary(el)
  if (stored) return { text: clip(stored), derived: false }
  const desc = rawDescription(el)
  return desc ? { text: firstSentence(desc), derived: true } : null
}
