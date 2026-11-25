// Deferred updates on one entity land in recorded order, whatever order their evidence arrives in:
// a newer verified value is never overwritten by an older change set verified later.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proposeChangeSet, setDisposition } from '../src/propose.js'
import { promoteChangeSet } from '../src/promote.js'
import { recordEvidence } from '../src/evidence.js'
import { reconcileBaseline } from '../src/reconcile.js'
import { loadModel } from '../src/model.js'
import { validateInContext } from '../src/propose.js'
import { Ledger } from '../src/ledger.js'
import { makeRepo, type Fixture } from './fixture.js'

let fx: Fixture
beforeAll(async () => { fx = await makeRepo() })
afterAll(async () => { await fx.cleanup() })

const actor = 'agent'
let clock = 0
const when = () => new Date(Date.UTC(2026, 6, 1, 10, 0, 0) + clock++ * 60_000).toISOString()
const land = async (cs: object) => {
  const r = await proposeChangeSet(fx.dir, cs, { actor, date: when() })
  await setDisposition(fx.dir, r.changeSet.id, 'accepted', { actor: 'reviewer', date: when() })
  return promoteChangeSet(fx.dir, r.changeSet.id, { actor, date: when() })
}
const verify = async (changeId: string) => {
  await recordEvidence(fx.dir, changeId, {
    id: `ev-${changeId.toLowerCase()}`, kind: 'test', result: 'pass', source_ref: `https://ci/${changeId}`,
    code_revision: 'c0ffee1', observed_at: when(), recorded_by: 'ci',
  }, { actor: 'ci', date: when() })
  return reconcileBaseline(fx.dir, { actor: 'ci', date: when() })
}
const customer = async () => (await loadModel(fx.dir)).model.element('customer')

describe('deferred update order', () => {
  it('an older update verified after a newer one does not overwrite the fields the newer one set', async () => {
    await land({ id: 'CHG-080', title: 'a', intent: 'i', operations: [{ op: 'update_element', id: 'ent-customer', set: { description: 'Old plan.', technology: 'Browser' } }] })
    await land({ id: 'CHG-081', title: 'b', intent: 'i', depends_on: ['CHG-080'], operations: [{ op: 'update_element', id: 'ent-customer', set: { description: 'Newer plan.' } }] })
    await verify('CHG-081')
    expect((await customer()).description.text).toBe('Newer plan.')
    await verify('CHG-080')
    const c = await customer()
    expect(c.description.text).toBe('Newer plan.')
    expect(c.technology).toBe('Browser')
  })
})

describe('replacing a description', () => {
  const update = (description: Record<string, string>, extra: object = {}) => ({
    id: 'CHG-091', title: 'c', intent: 'i', ...extra, operations: [{ op: 'update_element', id: 'ent-billing', set: { ...description, summary: 'Bills.' } }],
  })
  const validate = async (cs: object) => validateInContext(await loadModel(fx.dir), cs, await Ledger.load(fx.dir))

  it('warns when the new text leaves out sentences of the pending (not the committed) description', async () => {
    await land({ id: 'CHG-090', title: 'b', intent: 'i', operations: [{ op: 'update_element', id: 'ent-billing', set: { description: 'Bills customers. Retries failed charges.' } }] })
    const v = await validate(update({ description: 'Bills customers. Emits invoices.' }))
    expect(v.issues.filter(i => i.code === 'W_DESCRIPTION_DROPS_TEXT').map(i => i.message)).toEqual([expect.stringContaining('"Retries failed charges."')])
    expect((await validate(update({ description: 'Bills customers. Retries failed charges. Emits invoices.' }))).issues.map(i => i.code)).not.toContain('W_DESCRIPTION_DROPS_TEXT')
  })

  it('description_append is expanded at proposal time onto the intended description', async () => {
    const r = await proposeChangeSet(fx.dir, update({ description_append: 'Emits invoices.' }), { actor, date: when() })
    expect(r.validation.issues.map(i => i.code)).not.toContain('W_DESCRIPTION_DROPS_TEXT')
    const op = r.changeSet.operations[0]!
    expect(op.op === 'update_element' && op.set.description).toBe('Bills customers. Retries failed charges.\n\nEmits invoices.')
  })

  it('description_append cannot be combined with description', async () => {
    await expect(proposeChangeSet(fx.dir, update({ description: 'x', description_append: 'y' }), { actor, date: when() })).rejects.toThrow(/not both/)
  })
})

describe('superseded plans', () => {
  it('promoting a replacement drops the superseded set\'s pending operations; later evidence on it changes nothing', async () => {
    const api = async () => (await loadModel(fx.dir)).model.element('billing.billing_api')
    const before = (await api()).description.text
    await land({ id: 'CHG-095', title: 'plan', intent: 'i', operations: [{ op: 'update_element', id: 'ent-billing-api', set: { description: 'Old plan for the API.' } }] })
    expect((await api()).getMetadata()).toMatchObject({ b4_pending: 'CHG-095' })

    const r = await land({ id: 'CHG-096', title: 'as built', intent: 'i', supersedes: ['CHG-095'], operations: [{ op: 'update_element', id: 'ent-billing-api', set: { description: 'The API as built.' } }] })
    expect(r.abandoned).toEqual([{ changeId: 'CHG-095', entityId: 'ent-billing-api', supersededBy: 'CHG-096' }])
    expect((await api()).getMetadata()).toMatchObject({ b4_pending: 'CHG-096' })

    const ev = await recordEvidence(fx.dir, 'CHG-095', {
      id: 'ev-chg-095', kind: 'test', result: 'pass', source_ref: 'https://ci/95', code_revision: 'c0ffee1', observed_at: when(),
    }, { actor: 'ci', date: when() })
    expect(ev.warnings).toEqual([expect.stringContaining('superseded by CHG-096')])
    expect(ev.record.recorded_by).toBe('ci')
    await reconcileBaseline(fx.dir, { actor: 'ci', date: when() })
    expect((await api()).description.text).toBe(before)

    await verify('CHG-096')
    const after = await api()
    expect(after.description.text).toBe('The API as built.')
    expect(after.getMetadata()).not.toHaveProperty('b4_pending')
  })
})

describe('repairing baselines reconciled out of order (before 0.5.0)', () => {
  it('restores the newer value where an older verified update was applied over it, and nothing else', async () => {
    const { repairUpdateOrder } = await import('../src/repair.js')
    const { Git } = await import('../src/git.js')
    const { readFile, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const ui = async () => (await loadModel(fx.dir)).model.element('billing.invoice_ui')
    await land({ id: 'CHG-097', title: 'a', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { description: 'Older text.', technology: 'React' } }] })
    await land({ id: 'CHG-098', title: 'b', intent: 'i', operations: [{ op: 'update_element', id: 'ent-invoice-ui', set: { description: 'Newer text.' } }] })
    await verify('CHG-098')
    await recordEvidence(fx.dir, 'CHG-097', { id: 'ev-chg-097', kind: 'test', result: 'pass', source_ref: 'https://ci/97', code_revision: 'c0ffee1', observed_at: when() }, { actor: 'ci', date: when() })

    await reconcileBaseline(fx.dir, { actor: 'ci', date: when() }) // applies CHG-097, now only its technology
    expect((await ui()).description.text).toBe('Newer text.')
    // What a pre-0.5.0 reconcile committed instead: CHG-097 applied last, its description over CHG-098's.
    const file = join(fx.dir, 'model', 'model.c4')
    const c4 = await readFile(file, 'utf8')
    await writeFile(file, c4.replace('Newer text.', 'Older text.'), 'utf8')
    const git = new Git(fx.dir)
    await git.add(['model'])
    await git.commit('simulate old reconcile\n', { date: when() })
    expect((await ui()).description.text).toBe('Older text.')

    const dry = await repairUpdateOrder(fx.dir, { actor: 'tester', dryRun: true })
    expect(dry).toMatchObject({ changed: false, restored: [{ entityId: 'ent-invoice-ui', field: 'description', from: 'CHG-098', was: 'CHG-097' }] })
    const r = await repairUpdateOrder(fx.dir, { actor: 'tester', date: when() })
    expect(r.changed).toBe(true)
    const after = await ui()
    expect(after.description.text).toBe('Newer text.')
    expect(after.technology).toBe('React')
    expect((await repairUpdateOrder(fx.dir, { actor: 'tester' })).restored).toEqual([])
  })
})
