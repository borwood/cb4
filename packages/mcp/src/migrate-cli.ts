// cb4 migrate summaries|update-order [repoDir] [--actor <name>] [--dry-run]
//
// One-off upgrade steps live on the command line, not in the MCP tool list: an agent should run
// them because an upgrade (the changelog) says so, not because a read suggested it.
import { migrateSummaries, repairUpdateOrder } from 'cb4-ledger'
import { resolveRepoDir } from './paths.js'

export const MIGRATE_USAGE = `  cb4 migrate summaries [repoDir] [--actor <name>] [--dry-run]
            store the summaries reads derive from older elements' descriptions as one
            editorial change set (wording only; statuses untouched). Idempotent.
  cb4 migrate update-order [repoDir] [--actor <name>] [--dry-run]
            restore values a pre-0.5.0 reconcile overwrote when an older update was
            verified after a newer one; derived from the ledger. Idempotent.
`

/** Run a migration; returns the process exit code. */
export async function migrateCommand(args: string[], out: (s: string) => void = s => process.stdout.write(s), err: (s: string) => void = s => process.stderr.write(s)): Promise<number> {
  const [what, ...rest] = args
  if (what !== 'summaries' && what !== 'update-order') { err(`unknown migration ${what ?? '(none)'}; available: summaries, update-order\nusage:\n${MIGRATE_USAGE}`); return 2 }
  let repoDir = process.env.CB4_REPO ?? process.cwd()
  let actor = process.env.CB4_ACTOR
  let dryRun = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === '--actor') actor = rest[++i]
    else if (a === '--dry-run') dryRun = true
    else if (a.startsWith('-')) { err(`unknown option ${a}\nusage:\n${MIGRATE_USAGE}`); return 2 }
    else repoDir = a
  }
  if (!actor) { err('an actor is required: pass --actor <name> or set CB4_ACTOR\n'); return 2 }

  const { dir } = await resolveRepoDir(repoDir)
  if (what === 'update-order') {
    const u = await repairUpdateOrder(dir, { actor, dryRun })
    if (!u.restored.length) { out(`${dir}: nothing to restore; every value matches the newest applied update\n`); return 0 }
    out(`${dir}: ${dryRun ? 'would restore' : 'restored'} ${u.restored.length} value${u.restored.length === 1 ? '' : 's'}${u.sha ? ` (head ${u.sha.slice(0, 7)})` : ''}\n`)
    for (const x of u.restored) out(`  ${x.entityId} ${x.field}: ${x.from} (was ${x.was})\n`)
    return 0
  }
  const r = await migrateSummaries(dir, { actor, dryRun })
  const skipped = r.skipped.noDescription.length + r.skipped.withoutStableId.length
  const skippedNote = skipped ? `; ${r.skipped.noDescription.length} without a description, ${r.skipped.withoutStableId.length} without a stable id left as they are` : ''
  if (dryRun) {
    out(`${dir}: would store ${r.operations.length} summar${r.operations.length === 1 ? 'y' : 'ies'}${skippedNote}\n`)
    for (const op of r.operations) out(`  ${op.id}: ${(op as { set: { summary?: string } }).set.summary}\n`)
  } else if (r.changeId) {
    out(`${dir}: stored ${r.operations.length} summar${r.operations.length === 1 ? 'y' : 'ies'} in ${r.changeId} (head ${r.head?.slice(0, 7)})${skippedNote}\n`)
  } else {
    out(`${dir}: nothing to store; every element with a description has a summary${skippedNote}\n`)
  }
  return 0
}
