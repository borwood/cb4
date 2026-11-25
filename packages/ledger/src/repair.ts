// Repair for baselines reconciled before cb4 0.5.0, when a deferred update verified after a newer
// update of the same entity was applied over it: the committed value then came from the older
// change set. Derived from the ledger and evidence alone, like reconciliation: for each property
// of each entity, the newest applied operation that sets it decides the value. A value is only
// restored when the committed one matches an older applied operation, so text whose origin the
// ledger cannot explain is never touched.
import { join } from 'node:path'
import { Git } from './git.js'
import { IdentityRegistry, STABLE_ID_KEY } from './identity.js'
import { Ledger } from './ledger.js'
import { loadModel, MODEL_DIR, type ParsedModelData } from './model.js'
import { patchProps } from './operations.js'
import { isReservedMetadataKey } from './reserved.js'
import type { ChangeSet, Operation } from './schema.js'
import { finalizeBaseline, promotedOrder, readPending, supersessions } from './status.js'
import { targetVerification } from './evidence.js'
import { generateAndCheck, readWorkspace, sameWorkspace, summarizeErrors, writeWorkspace } from './workspace.js'

export interface RestoredValue {
  entityId: string
  /** `title`, `summary`, `description`, `technology`, or `metadata.<key>`. */
  field: string
  /** Change set whose value is restored: the newest applied one setting the field. */
  from: string
  /** Change set whose older value was committed instead. */
  was: string
}

export interface RepairUpdateOrderOptions {
  actor: string
  dryRun?: boolean
  expectedHead?: string
  date?: string
}

export interface RepairUpdateOrderResult {
  restored: RestoredValue[]
  /** False on a dry run or when nothing needed restoring. */
  changed: boolean
  sha: string | null
}

type Value = string | null
const TEXT_FIELDS = ['title', 'summary', 'description', 'technology'] as const

const text = (v: unknown): Value => {
  if (v === undefined || v === null) return null
  const t = typeof v === 'string' ? v : ((v as { txt?: string; md?: string }).txt ?? (v as { md?: string }).md ?? '')
  return t.trim() || null
}
const mdValue = (v: unknown): Value => (v === undefined || v === null ? null : JSON.stringify(v))

/** Values an operation sets, by field. Undefined fields are not set. */
function valuesOf(op: Operation): Map<string, Value> {
  const out = new Map<string, Value>()
  const props: Record<string, any> | undefined =
    op.op === 'add_element' ? { ...op, title: op.title ?? op.name } :
    op.op === 'add_relationship' ? op :
    op.op === 'update_element' || op.op === 'update_relationship' ? op.set : undefined
  if (!props) return out
  for (const f of TEXT_FIELDS) if (props[f] !== undefined) out.set(f, text(props[f]))
  for (const [k, v] of Object.entries<unknown>(props.metadata ?? {})) {
    if (k !== STABLE_ID_KEY && !isReservedMetadataKey(k)) out.set(`metadata.${k}`, mdValue(v))
  }
  return out
}

/** Restorations the ledger calls for, applied to `data` in place. */
export function findOutOfOrderValues(data: ParsedModelData, registry: IdentityRegistry, ledger: Ledger): RestoredValue[] {
  const order: ChangeSet[] = promotedOrder(ledger)
  const supersededBy = supersessions(order)
  const restored: RestoredValue[] = []
  const entities = [
    ...registry.elements().map(r => ({ id: r.stableId, raw: data.elements[r.fqn] as Record<string, any> | undefined })),
    ...registry.relationships().map(r => ({ id: r.stableId, raw: data.relations[r.relationId] as Record<string, any> | undefined })),
  ]
  for (const { id, raw } of entities) {
    if (!raw) continue
    const pending = readPending(raw)
    // Applied operations on this entity, oldest first: additions always; updates unless still waiting or dropped as superseded.
    const applied: { changeId: string; values: Map<string, Value> }[] = []
    for (const cs of order) {
      for (const op of cs.operations) {
        if (op.id !== id || !(op.op.startsWith('add_') || op.op.startsWith('update_'))) continue
        if (op.op.startsWith('update_')) {
          if (pending.includes(cs.id)) continue
          const verification = ledger.get(cs.id)?.verification
          if (supersededBy.has(cs.id) && (!verification || targetVerification(verification, id) !== 'verified')) continue
        }
        applied.push({ changeId: cs.id, values: valuesOf(op) })
      }
    }
    const fields = new Set(applied.flatMap(a => [...a.values.keys()]))
    for (const field of fields) {
      const setters = applied.filter(a => a.values.has(field))
      const newest = setters[setters.length - 1]!
      const expected = newest.values.get(field)!
      const current = field.startsWith('metadata.') ? mdValue(raw.metadata?.[field.slice('metadata.'.length)]) : text(raw[field])
      if (current === expected || (field === 'title' && expected === null)) continue
      const stale = [...setters].reverse().find(a => a !== newest && a.values.get(field) === current)
      if (!stale) continue
      if (field.startsWith('metadata.')) patchProps(raw, { metadata: { [field.slice('metadata.'.length)]: expected === null ? null : JSON.parse(expected) } })
      else patchProps(raw, { [field]: expected })
      restored.push({ entityId: id, field, from: newest.changeId, was: stale.changeId })
    }
  }
  return restored
}

/** Restore values an out-of-order verification overwrote, and commit the model when any changed. */
export async function repairUpdateOrder(repoDir: string, opts: RepairUpdateOrderOptions): Promise<RepairUpdateOrderResult> {
  const git = new Git(repoDir)
  if (!(await Git.isRepo(repoDir))) throw new Error(`${repoDir} is not a git repository`)
  const head = await git.headSha()
  if (!head) throw new Error('repository has no commits')
  if (opts.expectedHead !== undefined && head !== opts.expectedHead) throw new Error(`repository moved: expected HEAD ${opts.expectedHead}, found ${head}`)
  const dirty = (await git.exec(['status', '--porcelain', '--', MODEL_DIR])).trim()
  if (dirty) throw new Error(`uncommitted changes under ${MODEL_DIR}/ must be committed or discarded first:\n${dirty}`)

  const ledger = await Ledger.load(repoDir)
  const loaded = await loadModel(repoDir)
  const data = structuredClone(loaded.parsedData) as ParsedModelData
  const restored = findOutOfOrderValues(data, IdentityRegistry.fromModel(loaded.model), ledger)
  if (opts.dryRun || !restored.length) return { restored, changed: false, sha: null }

  await finalizeBaseline(data, ledger)
  const check = await generateAndCheck(data, ledger)
  if (check.errors.length) throw new Error(`repaired model is invalid; baseline left unchanged:\n  ${summarizeErrors(check.errors).join('\n  ')}`)
  const modelDir = join(repoDir, MODEL_DIR)
  if (sameWorkspace(await readWorkspace(modelDir), check.files)) return { restored, changed: false, sha: null }
  try {
    await writeWorkspace(modelDir, check.files)
    await git.exec(['add', '-A', '--', MODEL_DIR])
    const lines = restored.map(r => `Restored: ${r.entityId} ${r.field} from ${r.from} (was ${r.was})`)
    const message = [
      `repair baseline: ${restored.length} value${restored.length === 1 ? '' : 's'} overwritten by out-of-order verification restored`,
      [...lines, `Repaired-From: ${head}`, `Actor: ${opts.actor}`].join('\n'),
    ].join('\n\n') + '\n'
    return { restored, changed: true, sha: await git.commit(message, { date: opts.date }) }
  } catch (e) {
    await git.exec(['reset', '-q', '--', MODEL_DIR]).catch(() => {})
    await git.exec(['checkout', '-q', '--', MODEL_DIR]).catch(() => {})
    await git.exec(['clean', '-fdq', '--', MODEL_DIR]).catch(() => {})
    throw e
  }
}
