// Budgeted reads and element summaries: the budget is honoured, nothing is dropped without being
// counted, results are deterministic, detail falls off with distance, focus terms are kept longest,
// summaries are required when authoring and derived (never written) on read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budgetedExpand, budgetedSearch } from '../src/budget.js'
import { locate, type ContainerDetail, type LocateResult } from '../src/locate.js'
import { IdentityRegistry } from '../src/identity.js'
import { Ledger } from '../src/ledger.js'
import { generateDSL, loadModel } from '../src/model.js'
import { applyChangeSets } from '../src/projection.js'
import type { Snapshot } from '../src/queries.js'
import { ChangeSet } from '../src/schema.js'
import { firstSentence, summaryOf } from '../src/summary.js'
import { validateChangeSet } from '../src/validate.js'
import { migrateSummaries } from '../src/migrate.js'
import { promoteChangeSet } from '../src/promote.js'
import { recordChangeSet } from '../src/provenance.js'
import { makeRepo, type Fixture } from './fixture.js'

const LONG = 'It does one thing well. ' + 'Further detail about how it does that thing, with caveats, history and numbers. '.repeat(8)

/** A system of 6 containers x 6 components, long descriptions, edges across containers and to an outside system. */
function bigModel(): string {
  const L = ['specification {', '  element system', '  element container', '  element component', '  relationship uses', '}', 'model {']
  L.push(`  other = system 'Other' {`, `    metadata {`, `      stable_id 'ent-other'`, `    }`, `  }`)
  L.push(`  sys = system 'System' {`, `    description '${LONG}'`, `    metadata {`, `      stable_id 'ent-sys'`, `    }`)
  for (let c = 0; c < 6; c++) {
    L.push(`    c${c} = container 'Container ${c}' {`, `      description '${LONG}'`, `      metadata {`, `        stable_id 'ent-c${c}'`, `      }`)
    for (let k = 0; k < 6; k++) {
      L.push(`      k${k} = component '${k === 3 ? 'Tick hook' : 'Part'} ${c}.${k}' {`, `        description '${LONG}'`, `        metadata {`, `          stable_id 'ent-c${c}-k${k}'`, `        }`, `      }`)
    }
    L.push('    }')
  }
  L.push('  }')
  for (let c = 0; c < 6; c++) {
    for (let k = 0; k < 6; k++) {
      L.push(`  sys.c${c}.k${k} -[uses]-> sys.c${(c + 1) % 6}.k${(k + 1) % 6} 'calls ${c}.${k}' {`, `    metadata {`, `      stable_id 'rel-${c}-${k}'`, `    }`, `  }`)
    }
    L.push(`  sys.c${c}.k0 -[uses]-> other 'reports ${c}' {`, `    metadata {`, `      stable_id 'rel-out-${c}'`, `    }`, `  }`)
  }
  L.push('}')
  return L.join('\n') + '\n'
}

let dir: string
let s: Snapshot
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb4-reads-'))
  await mkdir(join(dir, 'model'))
  await writeFile(join(dir, 'model', 'model.c4'), bigModel(), 'utf8')
  const loaded = await loadModel(dir)
  s = { model: loaded.model, parsedData: loaded.parsedData, registry: IdentityRegistry.fromModel(loaded.model), ledger: await Ledger.load(dir, { tolerant: true }), head: null }
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const DESCENDANTS = 6 + 36
const EDGES = 36 + 6

describe('summaries', () => {
  it('derive the first sentence of the description, on one line, capped', () => {
    expect(firstSentence('Does a thing. Then more.')).toBe('Does a thing.')
    expect(firstSentence('Uses e.g. caches and i.e. queues. Next one.')).toBe('Uses e.g. caches and i.e. queues.')
    expect(firstSentence('First paragraph\nwraps here\n\nSecond paragraph.')).toBe('First paragraph wraps here')
    expect(firstSentence('x'.repeat(500))).toHaveLength(200)
    const el = s.model.element('sys')
    expect(summaryOf(el)).toEqual({ text: 'It does one thing well.', derived: true })
    expect(summaryOf(s.model.element('other'))).toBeNull()
  })

  it('reads never write: the model files are unchanged after reading summaries', async () => {
    budgetedExpand(s, { entity: 'ent-sys', depth: 2 })
    const again = await loadModel(dir)
    expect(again.parsedData.elements['sys'].summary).toBeUndefined()
  })
})

describe('budgetedExpand', () => {
  it('fits the budget and accounts for every descendant and relationship', () => {
    for (const budget of [2_000, 4_000, 8_000, 16_000, 40_000]) {
      for (const format of ['outline', 'json'] as const) {
        const r = budgetedExpand(s, { entity: 'ent-sys', depth: 2, budget, format })!
        expect(r.text.length).toBeLessThanOrEqual(budget)
        const d = r.data
        expect(d.descendants.length + d.elided.reduce((t, e) => t + e.count, 0)).toBe(DESCENDANTS)
        expect(d.relationships.length + d.bundles.reduce((t, b) => t + b.count, 0) + d.hiddenRelationships).toBe(EDGES)
        for (const e of d.elided) expect(e.next).toBe(`expand entity=${e.under}`)
      }
    }
  })

  it('is deterministic and monotone: a smaller budget never shows more', () => {
    const a = budgetedExpand(s, { entity: 'ent-sys', depth: 2, budget: 6_000 })!
    expect(budgetedExpand(s, { entity: 'ent-sys', depth: 2, budget: 6_000 })!.text).toBe(a.text)
    let prev = Infinity
    for (const budget of [40_000, 20_000, 10_000, 5_000, 2_500]) {
      const n = budgetedExpand(s, { entity: 'ent-sys', depth: 2, budget, format: 'json' })!.data.descendants.length
      expect(n).toBeLessThanOrEqual(prev)
      prev = n
    }
  })

  it('drops detail farthest first: components lose their summaries before containers', () => {
    const r = budgetedExpand(s, { entity: 'ent-sys', depth: 2, budget: 9_000, format: 'json' })!.data
    const at = (depth: number) => r.descendants.filter(d => d.depth === depth)
    const hasSummary = (d: any) => 'summary' in d
    expect(at(1).every(hasSummary)).toBe(true)
    expect(at(2).some(d => !hasSummary(d))).toBe(true)
    // The focus keeps its description.
    expect(r.entity.description).toContain('It does one thing well.')
  })

  it('bundles relationships at the edge of what is shown and names the outside', () => {
    const r = budgetedExpand(s, { entity: 'ent-sys', depth: 1, budget: 40_000, format: 'json' })!.data
    // Components are not shown at depth 1: their edges meet at the containers.
    const out = r.relationships.filter(x => x.to === 'ent-other').length + r.bundles.filter(b => b.to === 'ent-other').reduce((t, b) => t + b.count, 0)
    expect(out).toBe(6)
    expect(r.bundles.every(b => b.from.startsWith('ent-c') || b.from === 'ent-sys')).toBe(true)
    const text = budgetedExpand(s, { entity: 'ent-sys', depth: 1 })!.text
    expect(text).toMatch(/-> ent-other|ent-c\d+ -> ent-c\d+: \d+ relationships/)
  })

  it('keeps focus matches longest, described, even below depth', () => {
    const r = budgetedExpand(s, { entity: 'ent-sys', depth: 1, focusTerms: ['tick hook'], budget: 8_000, format: 'json' })!.data
    const hooks = r.descendants.filter(d => d.title.startsWith('Tick hook'))
    expect(hooks).toHaveLength(6)
    expect(hooks.every(h => (h as any).description?.startsWith('It does one thing well.'))).toBe(true)
    expect(r.focus).toMatchObject({ terms: ['tick hook'], unmatched: [] })
    expect(r.focus!.matched).toHaveLength(6)
  })
})

describe('locate', () => {
  const shownRows = (d: LocateResult) => d.related.length + d.levels.reduce((t, l) => t + l.connected.length + l.other.length, 0)
  const BUDGETS = [2_000, 3_000, 4_000, 6_000, 8_000, 12_000, 16_000, 40_000]

  it('fits the budget and counts every related entity and peer it leaves out', () => {
    const full = locate(s, { entity: 'ent-c0-k0', format: 'json', budget: 200_000 })!.data
    // k0 calls c1.k1, is called by c5.k5, reports to other; its container's peers are not connected to it.
    expect(full.related.map(r => r.id)).toEqual(['ent-c1-k1', 'ent-c5-k5', 'ent-other'])
    expect(full.levels.map(l => [l.container?.id ?? null, l.connected.map(c => c.id), l.other.length])).toEqual([
      ['ent-c0', [], 5],
      ['ent-sys', ['ent-c1', 'ent-c5'], 3],
      [null, ['ent-other'], 0],
    ])
    for (const budget of BUDGETS) {
      for (const format of ['outline', 'json'] as const) {
        const r = locate(s, { entity: 'ent-c0-k0', budget, format })!
        expect(r.text.length).toBeLessThanOrEqual(budget)
        const d = r.data
        expect(d.related.length + (d.relatedElided ?? 0)).toBe(3)
        d.levels.forEach((l, i) => {
          expect(l.connected.length + (l.elided?.connected ?? 0)).toBe(full.levels[i]!.connected.length)
          expect(l.other.length + (l.elided?.other ?? 0)).toBe(full.levels[i]!.other.length)
        })
      }
    }
  })

  it('is deterministic and monotone, and cuts farthest first', () => {
    const a = locate(s, { entity: 'ent-c0-k0', budget: 5_000 })!
    expect(locate(s, { entity: 'ent-c0-k0', budget: 5_000 })!.text).toBe(a.text)
    let prev = Infinity
    for (const budget of [...BUDGETS].reverse()) {
      const d = locate(s, { entity: 'ent-c0-k0', budget, format: 'json' })!.data
      expect(shownRows(d)).toBeLessThanOrEqual(prev)
      prev = shownRows(d)
      // The outer container loses its description before the inner one; the focus keeps its own longest.
      const described = (i: number) => !!(d.levels[i]!.container as ContainerDetail).description
      if (!described(0)) expect(described(1)).toBe(false)
      if (budget >= 4_000) expect(d.focus.description).toContain('It does one thing well.')
    }
  })

  it('names the cut and the call that brings it back', () => {
    const t = locate(s, { entity: 'ent-c0-k0', budget: 3_000 })!.text
    expect(t.split('\n')[0]).toMatch(/^# locate ent-c0-k0 · 3 related entities/)
    expect(t).toMatch(/\(budget\)/)
    expect(t).toMatch(/expand entity=ent-c0 depth=1|element entity=ent-\S+/)
    const r = locate(s, { entity: 'rel-0-0', budget: 40_000 })!.text
    expect(r.split('\n')[0]).toMatch(/^# locate rel-0-0 \(source ent-c0-k0\)/)
    expect(r).toContain('- rel-0-0: ent-c0-k0 -> ent-c1-k1')
  })
})

describe('budgetedSearch', () => {
  it('scopes with under, honours the budget and counts what it leaves out', () => {
    const all = budgetedSearch(s, { query: 'part', limit: 50, format: 'json' })!.data
    expect(all.elements).toHaveLength(30)
    const under = budgetedSearch(s, { query: 'part', under: 'ent-c2', limit: 50, format: 'json' })!.data
    expect(under.elements.map(e => e.id).every(id => id.startsWith('ent-c2-'))).toBe(true)
    expect(under.elements).toHaveLength(5)
    const tight = budgetedSearch(s, { query: 'part', limit: 50, budget: 2_000 })!
    expect(tight.text.length).toBeLessThanOrEqual(2_000)
    expect(tight.data.elements.length + tight.data.elided.elements).toBe(30)
    expect(budgetedSearch(s, { query: 'x', under: 'ent-nope' })).toBeNull()
  })
})

describe('summary rules when authoring', () => {
  let fx: Fixture
  let registry: IdentityRegistry
  beforeAll(async () => { fx = await makeRepo(); registry = IdentityRegistry.fromModel((await loadModel(fx.dir)).model) })
  afterAll(async () => { await fx.cleanup() })
  const base = { id: 'CHG-100', title: 't', intent: 'i' }
  const add = { op: 'add_element', id: 'ent-x', parent: null, name: 'x', kind: 'system' }
  const codes = (cs: unknown, authoring = true) => validateChangeSet(cs, { registry, authoring }).issues.map(i => i.code)

  it('requires a summary on new elements, keeps it one line, and never deletes it', () => {
    expect(codes({ ...base, operations: [add] })).toEqual(['E_MISSING_SUMMARY'])
    expect(codes({ ...base, operations: [{ ...add, summary: '  ' }] })).toEqual(['E_MISSING_SUMMARY'])
    expect(codes({ ...base, operations: [{ ...add, summary: 'One line.' }] })).toEqual([])
    expect(codes({ ...base, operations: [{ ...add, summary: 'x'.repeat(201) }] })).toEqual(['W_LONG_SUMMARY'])
    expect(codes({ ...base, operations: [{ ...add, summary: 'two\nlines' }] })).toEqual(['W_LONG_SUMMARY'])
    expect(codes({ ...base, operations: [{ op: 'update_element', id: 'ent-billing', set: { summary: null } }] })).toEqual(['E_SUMMARY_REQUIRED'])
    expect(codes({ ...base, operations: [{ op: 'update_element', id: 'ent-billing', set: { description: 'New words.' } }] })).toEqual(['W_SUMMARY_STALE'])
    expect(codes({ ...base, operations: [{ op: 'update_element', id: 'ent-billing', set: { description: 'New words.', summary: 'New.' } }] })).toEqual([])
    // Relationships have no summary in LikeC4.
    expect(codes({ ...base, operations: [{ op: 'add_relationship', id: 'rel-x', from: 'ent-customer', to: 'ent-billing', summary: 's' }] })).toContain('E_SCHEMA')
  })

  it('does not apply to recorded change sets re-checked for projection or promotion', () => {
    expect(codes({ ...base, operations: [add] }, false)).toEqual([])
  })

  it('a stored summary survives projection and DSL generation and reads back as stored', async () => {
    const loaded = await loadModel(fx.dir)
    const cs = ChangeSet.parse({ ...base, operations: [{ ...add, summary: 'Short line.', description: 'Long text. More.' }] })
    const p = await applyChangeSets(loaded.parsedData, [cs], { baseline: { source: 'worktree', revision: null }, highlight: false })
    expect(summaryOf(p.model.element('x'))).toEqual({ text: 'Short line.', derived: false })
    const dsl = await generateDSL(p.data)
    expect(dsl).toMatch(/summary '\s*Short line\.\s*'/)
    expect(dsl).toMatch(/description '\s*Long text\. More\.\s*'/)
  })
})

describe('migrateSummaries', () => {
  let fx: Fixture
  beforeAll(async () => { fx = await makeRepo() })
  afterAll(async () => { await fx.cleanup() })

  /** Status tags and metadata per element, and descriptions, as committed. */
  const statuses = async () => {
    const data = (await loadModel(fx.dir)).parsedData
    return Object.fromEntries(Object.entries<any>(data.elements).map(([fqn, el]) => [fqn, {
      tags: (el.tags ?? []).filter((t: string) => t.startsWith('b4-')).sort(),
      meta: Object.fromEntries(Object.entries(el.metadata ?? {}).filter(([k]) => k.startsWith('b4_'))),
      description: el.description ?? null,
    }]))
  }

  it('stores derived summaries as one editorial change set and leaves every status as it was', async () => {
    // A planned element recorded before the summary rule: intended, described, no summary.
    await recordChangeSet(fx.dir, ChangeSet.parse({
      id: 'CHG-500', title: 'Plan a cache', intent: 'i', disposition: 'accepted',
      operations: [{ op: 'add_element', id: 'ent-cache', parent: 'ent-billing', name: 'cache', kind: 'datastore', title: 'Cache', description: 'Holds hot invoices. Evicts after an hour.' }],
    }), { actor: 'test' })
    await promoteChangeSet(fx.dir, 'CHG-500', { actor: 'test' })
    const before = await statuses()
    expect(before['billing.cache']!.tags).toEqual(['b4-intended'])

    const dry = await migrateSummaries(fx.dir, { actor: 'test', dryRun: true })
    expect(dry.changeId).toBeNull()
    expect(dry.operations).toEqual([
      { op: 'update_element', id: 'ent-customer', set: { summary: 'Pays invoices' } },
      { op: 'update_element', id: 'ent-cache', set: { summary: 'Holds hot invoices.' } },
    ])
    expect(dry.skipped.noDescription).toContain('ent-billing')
    expect(dry.head).toBe(await fx.git.headSha())

    const r = await migrateSummaries(fx.dir, { actor: 'test' })
    expect(r.changeId).toBe('CHG-501')
    const loaded = await loadModel(fx.dir)
    expect(summaryOf(loaded.model.element('billing.cache'))).toEqual({ text: 'Holds hot invoices.', derived: false })
    expect(summaryOf(loaded.model.element('customer'))).toEqual({ text: 'Pays invoices', derived: false })
    // Wording only: the planned cache is still intended, nothing else moved, descriptions untouched.
    expect(await statuses()).toEqual(before)
    const ledger = await Ledger.load(fx.dir)
    expect(ledger.get('CHG-501')!.changeSet).toMatchObject({ editorial: true, disposition: 'accepted' })
    expect(ledger.get('CHG-501')!.changeSet.promotion).toBeDefined()
    expect(ledger.get('CHG-501')!.implementation).toBe('implemented')

    // Idempotent: nothing left to store.
    const again = await migrateSummaries(fx.dir, { actor: 'test' })
    expect(again).toMatchObject({ changeId: null, operations: [] })
  })

  it('an editorial change set may only set summaries', async () => {
    const registry = IdentityRegistry.fromModel((await loadModel(fx.dir)).model)
    const v = validateChangeSet({ id: 'CHG-900', title: 't', intent: 'i', editorial: true, operations: [
      { op: 'update_element', id: 'ent-billing', set: { summary: 'Fine.' } },
      { op: 'update_element', id: 'ent-billing', set: { summary: 'Fine.', technology: 'Go' } },
      { op: 'remove_element', id: 'ent-customer' },
    ] }, { registry })
    expect(v.issues.filter(i => i.code === 'E_EDITORIAL_SCOPE').map(i => i.path)).toEqual(['/operations/1', '/operations/2'])
  })
})
