// Store the summaries list reads have been deriving. Reads never write; this is the one explicit
// path that does, recorded like any other change: one editorial change set (wording only, so it
// applies at once and leaves every status alone), proposed, accepted and promoted in a row.
import { Git } from './git.js'
import { IdentityRegistry } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel } from './model.js'
import { promoteChangeSet } from './promote.js'
import { proposeChangeSet, setDisposition } from './propose.js'
import type { ChangeSet, Operation } from './schema.js'
import { firstSentence, rawDescription, rawSummary } from './summary.js'

export interface MigrateSummariesOptions {
  actor: string
  /** Refuse unless HEAD is this sha. */
  expectedHead?: string
  /** List what would be stored; write nothing. */
  dryRun?: boolean
  date?: string
}

export interface MigrateSummariesResult {
  /** The editorial change set recorded, or null when nothing was stored (dry run, or nothing to do). */
  changeId: string | null
  /** update_element operations setting each summary, in model order. */
  operations: Operation[]
  /** Elements left without a summary: no description to derive one from, or no stable id to address them. */
  skipped: { noDescription: string[]; withoutStableId: string[] }
  /** HEAD after the promotion (unchanged on a dry run or when nothing was stored). */
  head: string | null
}

export async function migrateSummaries(repoDir: string, opts: MigrateSummariesOptions): Promise<MigrateSummariesResult> {
  const git = new Git(repoDir)
  const head = await git.headSha()
  if (opts.expectedHead !== undefined && head !== opts.expectedHead) throw new Error(`repository moved: expected HEAD ${opts.expectedHead}, found ${head}`)
  const loaded = await loadModel(repoDir)
  const registry = IdentityRegistry.fromModel(loaded.model)
  const operations: Operation[] = []
  const skipped = { noDescription: [] as string[], withoutStableId: [] as string[] }
  for (const el of loaded.model.elements()) {
    if (rawSummary(el)) continue
    const rec = registry.elementByFqn(el.id)
    if (!rec) { skipped.withoutStableId.push(el.id); continue }
    const description = rawDescription(el)
    if (!description) { skipped.noDescription.push(rec.stableId); continue }
    operations.push({ op: 'update_element', id: rec.stableId, set: { summary: firstSentence(description) } })
  }
  if (opts.dryRun || !operations.length) return { changeId: null, operations, skipped, head }

  const ledger = await Ledger.load(repoDir)
  const changeId = `CHG-${1 + Math.max(0, ...[...ledger.records.keys()].map(id => Number(id.slice(4)) || 0))}`
  const cs: ChangeSet = {
    id: changeId,
    title: 'Store element summaries',
    intent: `Store the summaries list reads derived from the first sentence of each description (${operations.length} element${operations.length === 1 ? '' : 's'}). Wording only: no architectural change, no status change.`,
    sources: [], depends_on: [], supersedes: [], references: [],
    disposition: 'proposed', editorial: true, operations,
  }
  const proposed = await proposeChangeSet(repoDir, cs, { actor: opts.actor, expectedBaseRevision: head ?? undefined, date: opts.date })
  const accepted = await setDisposition(repoDir, changeId, 'accepted', { actor: opts.actor, expectedHead: proposed.record.sha, date: opts.date })
  const promoted = await promoteChangeSet(repoDir, changeId, { actor: opts.actor, expectedHead: accepted.sha, date: opts.date })
  return { changeId, operations, skipped, head: promoted.sha }
}
