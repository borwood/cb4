// locate: one read that grounds an agent around an entity, within a character budget. The focus
// in full, the entities it relates to, then each container up to the root with the peers of the
// member below it. Built from the shared detail templates in queries.ts; every list is capped and
// says when it was cut.
//
// Under the budget, detail falls off with distance from the focus. The cuts are one fixed sequence
// (outermost container descriptions first, the focus's own description last), and the answer is
// the shortest prefix of that sequence whose rendering fits, so results are deterministic and a
// smaller budget never shows more. Every cut is counted and names the call that brings it back.
import type { ElementModel, RelationshipModel } from '@likec4/core/model'
import {
  elementDetail, elementMedium, elementRow, relationshipDetail, relationshipRow, resolveElement,
  type ElementDetail, type ElementMedium, type ElementRow, type RelationshipDetail, type RelationshipRow, type Snapshot,
} from './queries.js'
import { clampBudget, outlineRelationship, outlineRow, type ReadFormat } from './budget.js'

export interface LocateOptions {
  entity: string
  /** Cap on peers listed per level (connected and other separately) and on related entities. Default 25, max 100. */
  maxPeers?: number
  /** Cap on relationship rows listed per connected entity. Default 10, max 50. */
  maxRelationships?: number
  /** Characters the rendered answer may use (default 40000, 2000..200000). */
  budget?: number
  format?: ReadFormat
  head?: string | null
}

/** What a part shows less of than it has, for the budget. Counts are of rows left out. */
export interface Omitted {
  description?: true
  /** User metadata; status and identity keys stay. */
  metadata?: true
  summary?: true
  /** Relationship rows (a connected or related entity's, or a container's own). */
  relationships?: number
  /** The focus's children. */
  children?: number
  /** The focus's nested relationships (through descendants). */
  nested?: number
  /** The focus's own incoming and outgoing relationships. */
  direct?: number
  /** A container shown as a row only: no description, metadata, relationships, views or change sets. */
  detail?: true
}

/** Medium detail (minimal under budget pressure) plus the relationships connecting the entity to the thing examined. */
export type ConnectedEntity = (ElementMedium | ElementRow) & {
  relationships: RelationshipRow[]
  relationshipsTruncated: boolean
  omitted?: Omitted
}

export type RelatedEntity = ConnectedEntity & {
  /** Nearest container shared with the focus (null when they share only the model root). Related entities are ordered by this, nearest first. */
  under: string | null
  /** Containers between `under` and this entity, outermost first, so it can be placed against the chain. */
  path: ElementRow[]
}

/**
 * Full detail without the lists the surrounding levels already show: children (the level below lists
 * them as focus and peers) and nested relationships (the connected peers at each level carry them).
 */
export type ContainerDetail = Omit<ElementDetail, 'children' | 'nestedIncoming' | 'nestedOutgoing' | 'nestedTruncated'> & { children: number; omitted?: Omitted }
/** A container cut down to its row for the budget. */
export type ContainerRow = ElementRow & { omitted: Omitted }

export interface LocateLevel {
  container: ContainerDetail | ContainerRow | null
  /** Peers of the entity below this container (or of the root, when container is null), connected to that entity's subtree. */
  connected: ConnectedEntity[]
  connectedTruncated: boolean
  other: ElementRow[]
  otherTruncated: boolean
  /** Peers within the caps left out for the budget. */
  elided?: { connected: number; other: number }
}

export type LocateFocus = ElementDetail & { omitted?: Omitted }

export interface LocateResult {
  /** Present when the id named a relationship: the relationship in full; `focus` is then its source element and the target is among `related`. */
  relationship?: RelationshipDetail
  focus: LocateFocus
  related: RelatedEntity[]
  relatedTruncated: boolean
  /** Related entities within the cap left out for the budget. */
  relatedElided?: number
  /** Nearest container first, ending with the level of the roots. */
  levels: LocateLevel[]
  /** Parts shown with less than they have, for the budget. */
  degraded: { descriptions: number; relationshipLists: number; summaries: number }
  /** Shown rows whose summary is derived from the description (not yet stored). */
  summariesDerived: number
  budget: { limit: number; used: number; over?: true }
}

/** The child of `container` (or the root) whose subtree holds `el`. */
function branchOf(el: ElementModel, container: ElementModel | null): ElementModel {
  let cur = el
  while (cur.parent && cur.parent !== container) cur = cur.parent
  return cur
}

/** An entity listed with the relationships that connect it; its view is cut by the budget steps. */
interface Entry { el: ElementModel; rels: RelationshipModel[]; rows: boolean; medium: boolean; shown: boolean }
interface Level { container: ElementModel | null; desc: boolean; rels: boolean; full: boolean; connected: Entry[]; connectedTruncated: boolean; other: { el: ElementModel; shown: boolean }[]; otherTruncated: boolean }

export function locate(s: Snapshot, opts: LocateOptions): { text: string; data: LocateResult } | null {
  const maxPeers = Math.max(1, Math.min(opts.maxPeers ?? 25, 100))
  const maxRelationships = Math.max(1, Math.min(opts.maxRelationships ?? 10, 50))
  const budget = clampBudget(opts.budget)
  const format = opts.format ?? 'outline'

  let relationship: RelationshipDetail | undefined
  let el = resolveElement(s, opts.entity)
  if (!el) {
    const rec = s.registry.resolve(opts.entity)
    const rel = rec?.type === 'relationship' ? s.model.findRelationship(rec.relationId, 'model') : null
    if (!rel) return null
    relationship = relationshipDetail(s, rel)
    el = rel.source
  }
  const focusEl = el
  const chain = [el, ...el.ancestors()] // focus first, root last

  // Related: the other end of every direct relationship, placed against the chain, nearest shared
  // container first (inside the focus, then siblings, then further out), ids breaking ties.
  const byOther = new Map<ElementModel, RelationshipModel[]>()
  for (const r of [...el.incoming('direct'), ...el.outgoing('direct')]) {
    const other = r.source === el ? r.target : r.source
    byOther.set(other, [...(byOther.get(other) ?? []), r])
  }
  const placed = [...byOther.entries()].map(([other, rels]) => {
    const depth = chain.findIndex(a => a === other || a.isAncestorOf(other))
    return { other, rels, shared: depth < 0 ? null : chain[depth]!, depth: depth < 0 ? chain.length : depth, id: elementRow(s, other).id }
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))
  const entry = (other: ElementModel, rels: RelationshipModel[]): Entry => ({ el: other, rels, rows: true, medium: true, shown: true })
  const related = placed.slice(0, maxPeers).map(p => ({ ...entry(p.other, p.rels), shared: p.shared }))

  // Levels: for each container in the chain (and finally the roots), split the peers of the member below it.
  const levels: Level[] = []
  for (let i = 0; i < chain.length; i++) {
    const member = chain[i]!
    const parent = chain[i + 1] ?? null
    const peers = [...(parent ? parent.children() : s.model.roots())].filter(p => p !== member)
    const connectedRels = new Map<ElementModel, RelationshipModel[]>()
    for (const r of [...member.allIncoming, ...member.allOutgoing]) {
      const inside = member.isAncestorOf(r.source) || r.source === member
      const other = inside ? r.target : r.source
      if (other === member || member.isAncestorOf(other)) continue // internal to the subtree
      if (parent && !parent.isAncestorOf(other)) continue // leaves this container: counted at a higher level
      const peer = branchOf(other, parent)
      connectedRels.set(peer, [...(connectedRels.get(peer) ?? []), r])
    }
    const connectedPeers = peers.filter(p => connectedRels.has(p))
    const other = peers.filter(p => !connectedRels.has(p))
    levels.push({
      container: parent, desc: true, rels: true, full: true,
      connected: connectedPeers.slice(0, maxPeers).map(p => entry(p, connectedRels.get(p)!)),
      connectedTruncated: connectedPeers.length > maxPeers,
      other: other.slice(0, maxPeers).map(p => ({ el: p, shown: true })),
      otherTruncated: other.length > maxPeers,
    })
  }
  const focus = { desc: true, metadata: true, direct: true, nested: true, children: true }

  // The cuts, in order: container descriptions and user metadata; relationship lists (to counts);
  // summaries; containers to rows; peers, then related entities, then the focus's children (to
  // counts); last the focus's own relationships, metadata and description. Within a phase outer
  // levels go before inner ones and later rows before earlier ones.
  const steps: (() => void)[] = []
  const outward = [...levels].reverse()
  const back = <T>(xs: T[]) => [...xs].reverse()
  for (const l of outward) if (l.container) steps.push(() => { l.desc = false })
  for (const l of outward) {
    for (const e of back(l.connected)) steps.push(() => { e.rows = false })
    if (l.container) steps.push(() => { l.rels = false })
  }
  for (const e of back(related)) steps.push(() => { e.rows = false })
  steps.push(() => { focus.nested = false })
  for (const l of outward) for (const e of back(l.connected)) steps.push(() => { e.medium = false })
  for (const e of back(related)) steps.push(() => { e.medium = false })
  for (const l of outward) if (l.container) steps.push(() => { l.full = false })
  for (const l of outward) {
    for (const o of back(l.other)) steps.push(() => { o.shown = false })
    for (const e of back(l.connected)) steps.push(() => { e.shown = false })
  }
  for (const e of back(related)) steps.push(() => { e.shown = false })
  steps.push(() => { focus.children = false })
  steps.push(() => { focus.direct = false })
  steps.push(() => { focus.metadata = false })
  steps.push(() => { focus.desc = false })

  const reset = () => {
    for (const l of levels) {
      l.desc = l.rels = l.full = true
      for (const e of l.connected) e.rows = e.medium = e.shown = true
      for (const o of l.other) o.shown = true
    }
    for (const e of related) e.rows = e.medium = e.shown = true
    focus.desc = focus.metadata = focus.direct = focus.nested = focus.children = true
  }

  /** Metadata without user keys (status and identity keys stay); true in the second slot when any were removed. */
  const STATUS_KEYS = new Set(['b4_status', 'b4_change', 'b4_pending', 'b4_moved_from', 'stable_id'])
  const statusOnly = (md: Record<string, string | string[]>): [Record<string, string | string[]>, boolean] => {
    const kept = Object.fromEntries(Object.entries(md).filter(([k]) => STATUS_KEYS.has(k)))
    return [kept, Object.keys(kept).length < Object.keys(md).length]
  }

  const fullFocus = elementDetail(s, focusEl.id)!
  const containerFull = new Map<ElementModel, ContainerDetail>()
  const containerOf = (c: ElementModel): ContainerDetail => {
    let d = containerFull.get(c)
    if (!d) {
      const { children, nestedIncoming, nestedOutgoing, nestedTruncated, ...rest } = elementDetail(s, c.id)!
      void nestedIncoming; void nestedOutgoing; void nestedTruncated
      d = { ...rest, children: children.length }
      containerFull.set(c, d)
    }
    return d
  }

  const build = (): LocateResult => {
    const degraded = { descriptions: 0, relationshipLists: 0, summaries: 0 }
    const connectedRow = (e: Entry): ConnectedEntity => {
      const base = e.medium ? elementMedium(s, e.el) : elementRow(s, e.el, true)
      const omitted: Omitted = {}
      if (!e.medium) { omitted.summary = true; degraded.summaries++ }
      const listed = e.rels.slice(0, maxRelationships)
      if (!e.rows) { omitted.relationships = listed.length; degraded.relationshipLists++ }
      return {
        ...base,
        relationships: e.rows ? listed.map(r => relationshipRow(s, r)) : [],
        relationshipsTruncated: e.rels.length > maxRelationships,
        ...(Object.keys(omitted).length ? { omitted } : {}),
      }
    }
    const f: LocateFocus = { ...fullFocus }
    const fo: Omitted = {}
    if (!focus.desc && f.description) { fo.description = true; f.description = null; degraded.descriptions++ }
    if (!focus.metadata) { const [md, cut] = statusOnly(f.metadata); if (cut) { f.metadata = md; fo.metadata = true } }
    if (!focus.direct && f.incoming.length + f.outgoing.length) { fo.direct = f.incoming.length + f.outgoing.length; f.incoming = []; f.outgoing = [] }
    if (!focus.nested && f.nestedIncoming.length + f.nestedOutgoing.length) { fo.nested = f.nestedIncoming.length + f.nestedOutgoing.length; f.nestedIncoming = []; f.nestedOutgoing = []; degraded.relationshipLists++ }
    if (!focus.children && f.children.length) { fo.children = f.children.length; f.children = [] }
    if (Object.keys(fo).length) f.omitted = fo

    const relatedShown = related.filter(e => e.shown)
    const data: LocateResult = {
      ...(relationship ? { relationship } : {}),
      focus: f,
      related: relatedShown.map(e => {
        const path: ElementRow[] = []
        for (let cur = e.el.parent; cur && cur !== e.shared; cur = cur.parent) path.unshift(elementRow(s, cur, true))
        return { ...connectedRow(e), under: e.shared ? elementRow(s, e.shared).id : null, path }
      }),
      relatedTruncated: byOther.size > maxPeers,
      ...(relatedShown.length < related.length ? { relatedElided: related.length - relatedShown.length } : {}),
      levels: levels.map(l => {
        let container: LocateLevel['container'] = null
        if (l.container && !l.full) container = { ...elementRow(s, l.container, true), omitted: { detail: true } }
        else if (l.container) {
          const c: ContainerDetail = { ...containerOf(l.container) }
          const co: Omitted = {}
          if (!l.desc && c.description) { co.description = true; c.description = null; degraded.descriptions++ }
          if (!l.desc) { const [md, cut] = statusOnly(c.metadata); if (cut) { c.metadata = md; co.metadata = true } }
          if (!l.rels && c.incoming.length + c.outgoing.length) { co.relationships = c.incoming.length + c.outgoing.length; c.incoming = []; c.outgoing = []; degraded.relationshipLists++ }
          if (Object.keys(co).length) c.omitted = co
          container = c
        }
        const conn = l.connected.filter(e => e.shown)
        const other = l.other.filter(o => o.shown)
        const elided = { connected: l.connected.length - conn.length, other: l.other.length - other.length }
        return {
          container,
          connected: conn.map(connectedRow), connectedTruncated: l.connectedTruncated,
          other: other.map(o => elementRow(s, o.el, true)), otherTruncated: l.otherTruncated,
          ...(elided.connected || elided.other ? { elided } : {}),
        }
      }),
      degraded,
      summariesDerived: 0,
      budget: { limit: budget, used: 0 },
    }
    const rows = [data.focus, ...data.related, ...data.levels.flatMap(l => [...(l.container ? [l.container] : []), ...l.connected])] as { summaryDerived?: true }[]
    data.summariesDerived = rows.filter(r => r.summaryDerived).length
    return data
  }
  const render = (data: LocateResult) => format === 'json' ? JSON.stringify(data) : outlineLocate(data, opts.head ?? null)
  const at = (k: number) => {
    reset()
    for (let i = 0; i < k; i++) steps[i]!()
    const data = build()
    return { data, text: render(data) }
  }

  // Shortest prefix of the cuts that fits: binary search, then confirm.
  let out = at(0)
  if (out.text.length > budget) {
    let lo = 1, hi = steps.length
    const last = at(hi)
    if (last.text.length > budget) out = { ...last, data: { ...last.data, budget: { ...last.data.budget, over: true } } }
    else {
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (at(mid).text.length <= budget) hi = mid
        else lo = mid + 1
      }
      out = at(lo)
    }
  }
  out.data.budget.used = out.text.length
  if (format === 'json') { out.data.budget.used = JSON.stringify(out.data).length; return { text: JSON.stringify(out.data), data: out.data } }
  return { text: render(out.data), data: out.data }
}

// ---------------------------------------------------------------------------------------------
// Outline

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function describe(L: string[], text: string | null | undefined, indent: string) {
  if (!text) return
  L.push(`${indent}description:`)
  for (const l of text.trim().split(/\r?\n/)) L.push(`${indent}  ${l.trimEnd()}`)
}

/** Parent, views, change sets, user metadata and own relationships of a detailed element. */
function detailLines(L: string[], d: Omit<ElementDetail, 'children' | 'nestedIncoming' | 'nestedOutgoing' | 'nestedTruncated'>, indent: string, omitted: Omitted | undefined, relLabel: string) {
  const cs = d.changeSets
  const facts = [
    d.parent ? `parent ${d.parent}` : 'root',
    d.views.length ? `views ${d.views.join(', ')}` : '',
    cs.total ? `change sets ${cs.total} (${[`${cs.promoted} promoted`, cs.open.length ? `open ${cs.open.join(', ')}${cs.openTruncated ? ', …' : ''}` : ''].filter(Boolean).join('; ')})` : '',
  ].filter(Boolean)
  L.push(`${indent}${facts.join(' · ')}`)
  const md = Object.entries(d.metadata).filter(([k]) => k !== 'stable_id')
  if (omitted?.metadata) L.push(`${indent}metadata: user keys left out (budget): element entity=${d.id}${md.length ? ` · ${md.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : oneLine(v)}`).join(', ')}` : ''}`)
  else if (md.length) L.push(`${indent}metadata: ${md.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : oneLine(v)}`).join(', ')}`)
  if (d.outgoing.length) { L.push(`${indent}outgoing:`); for (const r of d.outgoing) L.push(outlineRelationship(r, indent + '  ')) }
  if (d.incoming.length) { L.push(`${indent}incoming:`); for (const r of d.incoming) L.push(outlineRelationship(r, indent + '  ')) }
  const cut = omitted?.relationships ?? omitted?.direct
  if (cut) L.push(`${indent}${relLabel}: ${plural(cut, 'relationship')} (budget): element entity=${d.id}`)
}

function connectedLines(L: string[], e: ConnectedEntity, indent: string, idsOnly: boolean) {
  L.push(...outlineRow(e as ElementMedium, indent))
  const sub = indent + '  '
  if (e.omitted?.relationships) L.push(`${sub}${plural(e.omitted.relationships, 'relationship')} (budget)${e.relationshipsTruncated ? ', more beyond max_relationships' : ''}`)
  else if (idsOnly) L.push(`${sub}via ${e.relationships.map(r => r.id).join(', ')}${e.relationshipsTruncated ? ', … (max_relationships)' : ''}`)
  else {
    for (const r of e.relationships) L.push(outlineRelationship(r, sub))
    if (e.relationshipsTruncated) L.push(`${sub}- … more beyond max_relationships`)
  }
}

function outlineLocate(d: LocateResult, head: string | null): string {
  const L: string[] = []
  const f = d.focus
  L.push(`# locate ${d.relationship?.id ?? f.id}${d.relationship ? ` (source ${f.id})` : ''} · ${plural(d.related.length + (d.relatedElided ?? 0), 'related entity', 'related entities')}${d.relatedElided ? ` (${d.relatedElided} left out)` : ''}, ${plural(d.levels.length, 'level')}${head ? ` · head ${head}` : ''}`)
  if (d.relationship) {
    const r = d.relationship
    L.push('relationship:')
    L.push([outlineRelationship(r, ''), r.technology ? `tech ${oneLine(r.technology)}` : '', r.tags.length ? `tags ${r.tags.join(',')}` : '', r.views.length ? `views ${r.views.join(', ')}` : ''].filter(Boolean).join(' · '))
    describe(L, r.description, '  ')
  }

  L.push('focus:')
  L.push(...outlineRow({ ...f, children: f.children.length + (f.omitted?.children ?? 0) }, ''))
  if (f.omitted?.description) L.push(`  description left out (budget): element entity=${f.id}`)
  detailLines(L, f, '  ', f.omitted, 'own relationships')
  const nested = [...f.nestedOutgoing.map(r => ['out', r] as const), ...f.nestedIncoming.map(r => ['in', r] as const)]
  if (nested.length) {
    L.push(`  through descendants:${f.nestedTruncated ? ' (first 50 each way; element lists the same)' : ''}`)
    for (const [, r] of nested) L.push(outlineRelationship(r, '    '))
  }
  if (f.omitted?.nested) L.push(`  through descendants: ${plural(f.omitted.nested, 'relationship')} (budget): element entity=${f.id}`)
  if (f.children.length) { L.push('  children:'); for (const c of f.children) L.push(...outlineRow(c, '    ')) }
  if (f.omitted?.children) L.push(`  children: ${f.omitted.children} (budget): expand entity=${f.id}`)

  if (d.related.length || d.relatedElided || d.relatedTruncated) {
    L.push('related (direct relationships, nearest first):')
    for (const e of d.related) {
      L.push(...outlineRow(e as ElementMedium, '').map((l, i) => i === 0 ? `${l} · under ${e.under ?? 'model root'}${e.path.length ? ` · path ${e.path.map(p => p.id).join(' > ')}` : ''}` : l))
      const sub = '  '
      if (e.omitted?.relationships) L.push(`${sub}${plural(e.omitted.relationships, 'relationship')} (budget)`)
      else L.push(`${sub}via ${e.relationships.map(r => r.id).join(', ')}${e.relationshipsTruncated ? ', … (max_relationships)' : ''}`)
    }
    if (d.relatedElided) L.push(`- … ${d.relatedElided} more (budget): element entity=${f.id}`)
    if (d.relatedTruncated) L.push(`- … more beyond max_peers`)
  }

  let member = f.id
  for (const l of d.levels) {
    const c = l.container
    if (c) {
      L.push(`within ${c.id}:`)
      L.push(...outlineRow(c as ElementMedium, ''))
      if ('omitted' in c && c.omitted?.detail) L.push(`  detail left out (budget): element entity=${c.id}`)
      else {
        const cd = c as ContainerDetail
        if (cd.omitted?.description) L.push(`  description left out (budget): element entity=${cd.id}`)
        detailLines(L, cd, '  ', cd.omitted, 'own relationships')
      }
    } else L.push('within the model root:')
    if (l.connected.length) {
      L.push(`  peers of ${member} connected to it:`)
      for (const e of l.connected) connectedLines(L, e, '  ', false)
    }
    if (l.elided?.connected) L.push(`  - … ${l.elided.connected} more connected (budget): ${c ? `expand entity=${c.id} depth=1` : 'overview'}`)
    if (l.connectedTruncated) L.push(`  - … more connected beyond max_peers`)
    if (l.other.length || l.elided?.other || l.otherTruncated) {
      L.push(`  other peers of ${member}:`)
      for (const o of l.other) L.push(...outlineRow(o, '  '))
      if (l.elided?.other) L.push(`  - … ${l.elided.other} more (budget): ${c ? `expand entity=${c.id} depth=1` : 'overview'}`)
      if (l.otherTruncated) L.push(`  - … more beyond max_peers`)
    }
    if (c) member = c.id
  }

  const g = d.degraded
  if (g.descriptions || g.relationshipLists || g.summaries) {
    L.push(`degraded (budget): ${[g.descriptions ? plural(g.descriptions, 'description') : '', g.relationshipLists ? `${plural(g.relationshipLists, 'relationship list')} counted` : '', g.summaries ? `${plural(g.summaries, 'row')} without summary` : ''].filter(Boolean).join(', ')}; element entity=<id> shows any in full`)
  }
  if (d.summariesDerived) L.push(`summaries: ${d.summariesDerived} derived from the first sentence of the description (not stored yet; migrate what=summaries stores them)`)
  if (d.budget.over) L.push('over budget: even the smallest view does not fit; raise budget')
  return L.join('\n') + '\n'
}
