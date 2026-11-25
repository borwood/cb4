// What a change set's author should be building on: an element's description as it will be once
// everything already in flight lands. That is the committed value, then promoted updates still
// deferred (pending), then the unpromoted change sets it depends on. Proposals compare against
// this, not the committed value, so a pending description is neither silently dropped nor appended
// to in its stale form.
import type { IdentityRegistry } from './identity.js'
import type { Ledger } from './ledger.js'
import type { ParsedModelData } from './model.js'
import type { ChangeSet } from './schema.js'
import { pendingUpdates, promotedOrder, readPending } from './status.js'

export type DescriptionLookup = (stableId: string) => string | null

type RawText = { txt?: string; md?: string } | string | null | undefined
const text = (v: RawText): string | null => {
  if (!v) return null
  const t = (typeof v === 'string' ? v : (v.txt ?? v.md ?? '')).trim()
  return t || null
}

/** Intended descriptions over the baseline, pending updates and the given dependencies (in dependency order). */
export function intendedDescriptions(data: ParsedModelData, registry: IdentityRegistry, ledger: Ledger, deps: ChangeSet[] = []): DescriptionLookup {
  const order = promotedOrder(ledger)
  const fromDeps = new Map<string, string | null>()
  for (const cs of deps) {
    for (const op of cs.operations) {
      if (op.op === 'add_element') fromDeps.set(op.id, op.description ?? null)
      else if (op.op === 'update_element' && op.set.description !== undefined) fromDeps.set(op.id, op.set.description)
    }
  }
  return (id) => {
    if (fromDeps.has(id)) return fromDeps.get(id)!
    const rec = registry.element(id)
    const raw = rec ? data.elements[rec.fqn] : undefined
    if (!raw) return null
    let desc = text(raw.description)
    for (const op of pendingUpdates(order, id, readPending(raw))) {
      if (op.op === 'update_element' && op.set.description !== undefined) desc = op.set.description
    }
    return desc
  }
}

/**
 * Sentences of `before` that `after` no longer contains, compared with whitespace collapsed. A
 * sentence ends at `.`, `!` or `?` followed by whitespace, or at a line break.
 */
export function droppedSentences(before: string, after: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const kept = norm(after)
  return before.split(/(?<=[.!?])\s+|\n+/).map(norm).filter(s => s.length > 0 && !kept.includes(s))
}

/**
 * Expand `set.description_append` on update_element operations into a full `set.description`: the
 * intended description, a blank line, then the appended text. Resolved at proposal time so the
 * recorded change set says exactly what the description becomes. Works on raw input, before schema
 * parsing; operations earlier in the same change set count.
 */
export function expandDescriptionAppends(input: unknown, lookup: DescriptionLookup): { input: unknown; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input, errors }
  const ops = (input as { operations?: unknown }).operations
  if (!Array.isArray(ops) || !ops.some(hasAppend)) return { input, errors }

  const local = new Map<string, string | null>()
  const current = (id: string) => (local.has(id) ? local.get(id)! : lookup(id))
  const out = ops.map((op, i) => {
    if (!op || typeof op !== 'object') return op
    const o = op as Record<string, any>
    if (o.op === 'add_element' && typeof o.id === 'string') local.set(o.id, typeof o.description === 'string' ? o.description : null)
    if (o.op !== 'update_element' || typeof o.id !== 'string' || !o.set || typeof o.set !== 'object') return op
    const set = { ...o.set }
    if ('description_append' in set) {
      const add = set.description_append
      delete set.description_append
      if (typeof add !== 'string' || !add.trim()) errors.push({ path: `/operations/${i}/set/description_append`, message: 'description_append must be non-empty text' })
      else if (set.description !== undefined) errors.push({ path: `/operations/${i}/set/description_append`, message: 'set description or description_append, not both' })
      else {
        const base = current(o.id)
        set.description = base ? `${base}\n\n${add.trim()}` : add.trim()
      }
    }
    if (set.description !== undefined) local.set(o.id, set.description)
    return { ...o, set }
  })
  return { input: { ...(input as object), operations: out }, errors }
}

const hasAppend = (op: unknown) => !!op && typeof op === 'object' && (op as any).op === 'update_element' && !!(op as any).set && typeof (op as any).set === 'object' && 'description_append' in (op as any).set
