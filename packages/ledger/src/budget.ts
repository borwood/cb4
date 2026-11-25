// Budgeted list reads (expand, search). The caller names a character budget and the server returns
// the most useful view of the model that fits inside it, instead of a fixed shape whose size depends
// on the data. Detail falls off with distance from the focus (a fisheye view, distance only):
// descriptions go first, then the edge lists inside relationship bundles, then summaries, then whole
// rows, always the farthest first. Nothing is dropped without being counted, and every cut names
// the call that brings it back.
import type { ElementModel, RelationshipModel } from '@likec4/core/model'
import {
  elementMedium, elementRow, relationshipRow, resolveElement, searchMatches,
  type ElementMedium, type ElementRow, type Overview, type RelationshipRow, type SearchOptions, type Snapshot,
} from './queries.js'
import { userTags } from './reserved.js'
import { rawDescription } from './summary.js'

export type ReadFormat = 'outline' | 'json'
export const DEFAULT_BUDGET = 40_000
export const MIN_BUDGET = 2_000
export const MAX_BUDGET = 200_000

/** How much of an entity a row shows: described = medium plus the full description. */
export type Level = 'described' | 'medium' | 'minimal'
const RANK: Record<Level, number> = { minimal: 0, medium: 1, described: 2 }
const LOWER: Record<Level, Level | null> = { described: 'medium', medium: 'minimal', minimal: null }

export function clampBudget(budget: number | undefined): number {
  return Math.max(MIN_BUDGET, Math.min(budget ?? DEFAULT_BUDGET, MAX_BUDGET))
}

/** A row at some level; `description` only at described. */
export type ViewRow = (ElementRow | ElementMedium) & { description?: string | null }

function rowAt(s: Snapshot, el: ElementModel, level: Level): ViewRow {
  if (level === 'minimal') return elementRow(s, el, true)
  const medium = elementMedium(s, el)
  return level === 'described' ? { ...medium, description: rawDescription(el) } : medium
}

// ---------------------------------------------------------------------------------------------
// Outline rendering of single rows (shared by expand, search, overview).

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
const quote = (t: string) => `'${oneLine(t)}'`

/** One element as outline lines at the given indent. */
export function outlineRow(row: ViewRow, indent: string): string[] {
  const m = row as Partial<ElementMedium> & ViewRow
  const parts = [`${indent}- ${row.id}: ${oneLine(row.title)} [${row.kind}] ${row.fqn}`]
  if (row.children) parts.push(`${row.children} ${row.children === 1 ? 'child' : 'children'}`)
  if (row.pending?.length) parts.push(`pending ${row.pending.join(',')}`)
  if (m.technology) parts.push(`tech ${oneLine(m.technology)}`)
  const tags = m.tags ? userTags(m.tags) : []
  if (tags.length) parts.push(`tags ${tags.join(',')}`)
  if (m.status) parts.push(`status ${Object.entries(m.status).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`).join(' ')}`)
  const lines = [parts.join(' · ')]
  if (m.summary) lines.push(`${indent}  ${m.summaryDerived ? 'summary (derived)' : 'summary'}: ${oneLine(m.summary)}`)
  if (m.description) {
    lines.push(`${indent}  description:`)
    for (const l of m.description.trim().split(/\r?\n/)) lines.push(`${indent}    ${l.trimEnd()}`)
  }
  return lines
}

export function outlineRelationship(r: RelationshipRow, indent: string): string {
  return `${indent}- ${r.id}: ${r.from} -> ${r.to}${r.title ? ' ' + quote(r.title) : ''}${r.kind ? ` [${r.kind}]` : ''}${r.pending?.length ? ` · pending ${r.pending.join(',')}` : ''}`
}

// ---------------------------------------------------------------------------------------------
// The degradation engine.

interface Node {
  el: ElementModel
  id: string
  depth: number
  parent: Node | null
  kids: Node[]
  /** Higher keeps detail longer. The focus is never degraded below its cap or elided. */
  priority: number
  /** Position in the listing; later rows give way first among equal priority. */
  order: number
  cap: Level
  /** Current level; null once elided. */
  level: Level | null
  matched?: boolean
  rows: Partial<Record<Level, { row: ViewRow; size: number }>>
}

type Candidate = { kind: 'node'; node: Node; to: Level | null; save: number } | { kind: 'bundle'; key: string; save: number }

/**
 * Greedy degradation: render, and while over budget apply the next cheapest-to-lose steps until
 * their estimated saving covers the excess, then render again. Steps come from `next`, in order.
 */
function fit<T>(budget: number, render: () => { text: string; data: T }, next: (excess: number) => boolean): { text: string; data: T; over: boolean } {
  for (;;) {
    const out = render()
    if (out.text.length <= budget) return { ...out, over: false }
    if (!next(out.text.length - budget)) return { ...out, over: true }
  }
}

function cached(s: Snapshot, n: Node, level: Level, size: (row: ViewRow, n: Node) => number) {
  let c = n.rows[level]
  if (!c) { const row = rowAt(s, n.el, level); c = n.rows[level] = { row, size: size(row, n) } }
  return c
}

/** Nodes in degradation order for one phase: lowest priority first, later rows first among equals. */
const byLoss = (a: Node, b: Node) => a.priority - b.priority || b.order - a.order

// ---------------------------------------------------------------------------------------------
// expand

export interface BudgetedExpandOptions {
  entity: string
  /** Levels of descendants to collect, 0..5 (default 1). */
  depth?: number
  /** Cap on collected descendants (default 200, max 500); the budget usually binds first. */
  maxNodes?: number
  /** 'none' leaves relationships out. Default: every relationship with an endpoint in the subtree, bundled at the edge of what is shown. */
  relationships?: 'bundled' | 'none'
  /** Highest level rows may reach: minimal, or medium (default; the focus and focus matches are then described). */
  detail?: 'minimal' | 'medium'
  /** Terms that raise matching descendants (any depth up to 5) to the top: listed, described, kept longest. */
  focusTerms?: string[]
  budget?: number
  format?: ReadFormat
  head?: string | null
}

interface Endpoint { id: string; fqn: string; title: string; outside: boolean }
export interface Bundle { from: string; to: string; count: number; edges?: RelationshipRow[]; next?: string }
export interface Elision { under: string; count: number; next: string }

export interface BudgetedExpand {
  entity: ViewRow & { parent: string | null }
  descendants: (ViewRow & { depth: number; parent: string })[]
  /** Single relationships, endpoints as recorded. */
  relationships: RelationshipRow[]
  /** Several relationships between the same two shown entities (or an outside branch), counted; edges listed while the budget allows. */
  bundles: Bundle[]
  /** Descendants left out for the budget, counted under the nearest entity shown. */
  elided: Elision[]
  /** Rows shown below their cap for the budget. */
  degraded: { withoutDescription: number; withoutSummary: number }
  /** Relationships with both ends inside one shown entity (as bundled), hidden with it. */
  hiddenRelationships: number
  /** Present when relationships were bundled at a shallower level than the rows shown, for the budget. */
  bundledAtDepth?: number
  /** max_nodes stopped collection before depth was reached. */
  truncated: boolean
  /** Shown rows whose summary is derived from the description (not yet stored). */
  summariesDerived: number
  focus?: { terms: string[]; matched: string[]; unmatched: string[] }
  budget: { limit: number; used: number; over?: true }
}

export function budgetedExpand(s: Snapshot, opts: BudgetedExpandOptions): { text: string; data: BudgetedExpand } | null {
  const root = resolveElement(s, opts.entity)
  if (!root) return null
  const format = opts.format ?? 'outline'
  const budget = clampBudget(opts.budget)
  const depth = Math.max(0, Math.min(opts.depth ?? 1, 5))
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 200, 500))
  const cap: Level = opts.detail === 'minimal' ? 'minimal' : 'medium'
  const terms = [...new Set((opts.focusTerms ?? []).flatMap(t => t.split(',')).map(t => t.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))]

  // Collect: descendants to `depth`, plus focus matches deeper down (to 5) with the containers above them.
  const byFqn = new Map<string, Node>()
  const nodes: Node[] = []
  const make = (el: ElementModel, d: number, parent: Node | null): Node => {
    const n: Node = { el, id: elementRow(s, el).id, depth: d, parent, kids: [], priority: 0, order: nodes.length, cap, level: cap, rows: {} }
    nodes.push(n); byFqn.set(el.id, n); parent?.kids.push(n)
    return n
  }
  const rootNode = make(root, 0, null)
  let truncated = false
  const matchedTerms = new Set<string>()
  const hits = new Map<string, number>()
  /** Number of focus terms naming the element: every word of a term in its stable id, fqn or title. */
  const matches = (el: ElementModel) => {
    let n = hits.get(el.id)
    if (n !== undefined) return n > 0
    const words = new Set(`${elementRow(s, el).id} ${el.id} ${el.title}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
    n = 0
    for (const t of terms) if (t.split(/[^a-z0-9]+/).filter(Boolean).every(w => words.has(w) || [...words].some(x => x.startsWith(w) && w.length >= 4))) { matchedTerms.add(t); n++ }
    hits.set(el.id, n)
    return n > 0
  }
  const rootLevel = [...root.ancestors()].length
  const within = (x: ElementModel) => [...x.ancestors()].length - rootLevel <= 5
  const walk = (el: ElementModel, parent: Node) => {
    for (const c of el.children()) {
      const d = parent.depth + 1
      if (d > 5) continue
      const hit = terms.length > 0 && matches(c)
      if (d > depth && !hit && !(terms.length > 0 && [...c.descendants()].some(x => within(x) && matches(x)))) continue
      if (nodes.length > maxNodes) { truncated = true; return }
      const n = make(c, d, parent)
      n.matched = hit
      walk(c, n)
    }
  }
  walk(root, rootNode)
  for (const n of nodes) {
    n.priority = n === rootNode ? Infinity : n.matched ? 1000 + 10 * (hits.get(n.el.id) ?? 0) - n.depth : 100 - n.depth
    if (n === rootNode || n.matched) n.cap = n.level = cap === 'medium' ? 'described' : 'minimal'
  }

  // Relationships with an endpoint in the subtree, bundled at the edge of what is shown.
  const inside = (el: ElementModel) => el === root || root.isAncestorOf(el)
  const chain = [root, ...root.ancestors()]
  const outsideRep = new Map<string, Endpoint>()
  const repOutside = (el: ElementModel): Endpoint => {
    let ep = outsideRep.get(el.id)
    if (ep) return ep
    const lca = chain.find(a => a.isAncestorOf(el)) ?? null
    let cur = el
    while (cur.parent && cur.parent !== lca) cur = cur.parent
    ep = { id: elementRow(s, cur).id, fqn: cur.id, title: cur.title, outside: true }
    outsideRep.set(el.id, ep)
    return ep
  }
  const repInside = (el: ElementModel): Node => {
    for (let cur: ElementModel | null = el; cur; cur = cur.parent) {
      const n = byFqn.get(cur.id)
      if (n && n.level !== null) return n
    }
    return rootNode
  }
  const edges: { r: RelationshipModel; row: RelationshipRow }[] = []
  if (opts.relationships !== 'none') {
    for (const r of s.model.relationships()) if (inside(r.source) || inside(r.target)) edges.push({ r, row: relationshipRow(s, r) })
  }
  const collapsed = new Set<string>()
  /** Set once every bundle has been collapsed, so bundles merged by later elisions start collapsed too. */
  let collapseAll = false
  let dropRelationships = false

  /** Deepest level relationship endpoints are shown at; lowering it bundles edges at coarser containers without hiding any row. */
  const maxDepth = Math.max(0, ...nodes.map(n => n.depth))
  let edgeDepth = maxDepth
  const endpoint = (el: ElementModel): { ep: Endpoint; node: Node | null } => {
    if (!inside(el)) return { ep: repOutside(el), node: null }
    let n = repInside(el)
    while (n.depth > edgeDepth && n.parent) n = n.parent
    return { ep: { id: n.id, fqn: n.el.id, title: n.el.title, outside: false }, node: n }
  }
  interface Group { key: string; from: Endpoint; to: Endpoint; members: { r: RelationshipModel; row: RelationshipRow }[]; priority: number; order: number; anchor: string }
  const group = () => {
    const groups = new Map<string, Group>()
    let hidden = 0
    for (const e of edges) {
      const a = endpoint(e.r.source), b = endpoint(e.r.target)
      if (a.ep.id === b.ep.id) { hidden++; continue }
      const key = `${a.ep.id}>${b.ep.id}`
      let g = groups.get(key)
      if (!g) {
        const near = [a.node, b.node].filter((x): x is Node => !!x).sort((x, y) => y.priority - x.priority || x.order - y.order)[0] ?? rootNode
        g = { key, from: a.ep, to: b.ep, members: [], priority: near.priority, order: near.order, anchor: near.id }
        groups.set(key, g)
      }
      g.members.push(e)
    }
    const list = [...groups.values()].sort((x, y) => (y.priority - x.priority) || x.order - y.order || x.key.localeCompare(y.key))
    return { list, hidden }
  }

  const rowSize = (row: ViewRow, n: Node) => format === 'outline'
    ? outlineRow(row, '  '.repeat(n.depth)).join('\n').length + 1
    : JSON.stringify(row).length + 30

  const shown = () => nodes.filter(n => n.level !== null)
  const elisions = (): Elision[] => {
    const out: Elision[] = []
    for (const n of shown()) {
      let count = 0
      const visit = (k: Node) => { for (const c of k.kids) { count++; visit(c) } }
      for (const k of n.kids) if (k.level === null) { count++; visit(k) }
      if (count) out.push({ under: n.id, count, next: `expand entity=${n.id}` })
    }
    return out
  }

  const render = (): { text: string; data: BudgetedExpand } => {
    const vis = shown()
    const { list, hidden } = dropRelationships ? { list: [], hidden: 0 } : group()
    const relationships: RelationshipRow[] = []
    const bundles: Bundle[] = []
    for (const g of list) {
      if (g.members.length === 1) { relationships.push(g.members[0]!.row); continue }
      const b: Bundle = { from: g.from.id, to: g.to.id, count: g.members.length }
      if (!collapseAll && !collapsed.has(g.key)) b.edges = g.members.map(m => m.row)
      else b.next = `element entity=${g.anchor}`
      bundles.push(b)
    }
    const elided = elisions()
    const degraded = {
      withoutDescription: vis.filter(n => RANK[n.cap] >= RANK.described && RANK[n.level!] < RANK.described && rawDescription(n.el)).length,
      withoutSummary: vis.filter(n => RANK[n.cap] >= RANK.medium && n.level === 'minimal').length,
    }
    const rows = new Map(vis.map(n => [n, cached(s, n, n.level!, rowSize).row]))
    const summariesDerived = [...rows.values()].filter(r => (r as ElementMedium).summaryDerived).length
    const data: BudgetedExpand = {
      entity: { ...rows.get(rootNode)!, parent: root.parent ? elementRow(s, root.parent).id : null },
      descendants: vis.filter(n => n !== rootNode).map(n => ({ ...rows.get(n)!, depth: n.depth, parent: n.parent!.id })),
      relationships, bundles, elided, degraded,
      hiddenRelationships: hidden + (dropRelationships ? edges.length : 0),
      ...(edgeDepth < maxDepth && !dropRelationships && edges.length ? { bundledAtDepth: edgeDepth } : {}),
      truncated, summariesDerived,
      ...(terms.length ? { focus: { terms, matched: nodes.filter(n => n.matched).map(n => n.id), unmatched: terms.filter(t => !matchedTerms.has(t)) } } : {}),
      budget: { limit: budget, used: 0 },
    }
    const outsideTitles = new Map<string, string>()
    for (const g of list) for (const ep of [g.from, g.to]) if (ep.outside) outsideTitles.set(ep.id, ep.title)
    const text = format === 'json'
      ? JSON.stringify(data)
      : outlineExpand(data, { rows: vis.map(n => ({ row: rows.get(n)!, depth: n.depth, id: n.id })), head: opts.head ?? null, depth, outsideTitles, dropped: dropRelationships ? edges.length : 0 })
    return { text, data }
  }

  // Degradation steps, phase by phase: descriptions, bundle edge lists, summaries, rows, relationships.
  const next = (excess: number): boolean => {
    const steps: Candidate[] = []
    const est = (n: Node, to: Level | null) => cached(s, n, n.level!, rowSize).size - (to ? cached(s, n, to, rowSize).size : 0)
    // Two tiers: rows the focus terms matched keep their detail until everything else has given way.
    const focused = (n: Node) => !!n.matched
    const phase = (from: Level, tier: boolean) => shown().filter(n => n.level === from && LOWER[from] && n !== rootNode && focused(n) === tier).sort(byLoss)
    const lower = (from: Level, tier: boolean) => { for (const n of phase(from, tier)) steps.push({ kind: 'node', node: n, to: LOWER[from], save: est(n, LOWER[from]) }) }
    const elide = (tier: boolean) => {
      // Only current leaves: eliding them can make their parents leaves, picked up next round.
      const leaves = shown().filter(n => n !== rootNode && focused(n) === tier && n.kids.every(k => k.level === null)).sort(byLoss)
      for (const n of leaves) steps.push({ kind: 'node', node: n, to: null, save: est(n, null) })
    }
    const edgesLeft = !dropRelationships && edges.length > 0
    lower('described', false)
    if (!steps.length && edgesLeft && !collapseAll) {
      const { list } = group()
      for (const g of [...list].reverse()) if (g.members.length > 1 && !collapsed.has(g.key)) {
        steps.push({ kind: 'bundle', key: g.key, save: g.members.reduce((t, m) => t + JSON.stringify(m.row).length, 0) })
      }
      if (!steps.length) collapseAll = true
    }
    // Coarser edges first down to the focus's children, then summaries, then down to the focus itself.
    if (!steps.length && edgesLeft && edgeDepth > 1) { edgeDepth--; return true }
    if (!steps.length) lower('medium', false)
    if (!steps.length && edgesLeft && edgeDepth > 0) { edgeDepth--; return true }
    if (!steps.length) elide(false)
    if (!steps.length) lower('described', true)
    if (!steps.length) lower('medium', true)
    if (!steps.length) elide(true)
    if (!steps.length && edgesLeft) { dropRelationships = true; return true }
    if (!steps.length && rootNode.level !== 'minimal' && rootNode.level !== null) {
      const to = LOWER[rootNode.level]!
      steps.push({ kind: 'node', node: rootNode, to, save: est(rootNode, to) })
    }
    if (!steps.length) return false
    let saved = 0
    for (const st of steps) {
      if (st.kind === 'bundle') collapsed.add(st.key)
      else st.node.level = st.to
      saved += Math.max(st.save, 1)
      if (saved >= excess) break
    }
    return true
  }

  const out = fit(budget, render, next)
  out.data.budget.used = out.text.length
  if (out.over) out.data.budget.over = true
  if (format === 'json') return { text: JSON.stringify(out.data), data: out.data }
  return { text: out.text, data: out.data }
}

function outlineExpand(d: BudgetedExpand, ctx: { rows: { row: ViewRow; depth: number; id: string }[]; head: string | null; depth: number; outsideTitles: Map<string, string>; dropped: number }): string {
  const L: string[] = []
  const nRels = d.relationships.length + d.bundles.reduce((t, b) => t + b.count, 0)
  L.push(`# expand ${d.entity.id} depth=${ctx.depth} · ${ctx.rows.length} entities shown, ${nRels} relationships${d.entity.parent ? ` · parent ${d.entity.parent}` : ''}${ctx.head ? ` · head ${ctx.head}` : ''}`)
  const elidedUnder = new Map(d.elided.map(e => [e.under, e]))
  // Rows in listing order; an elision note follows the last row of the subtree it belongs to.
  const pending: { depth: number; e: Elision }[] = []
  const flush = (depth: number) => {
    while (pending.length && pending[pending.length - 1]!.depth >= depth) {
      const { depth: dd, e } = pending.pop()!
      L.push(`${'  '.repeat(dd + 1)}- … ${e.count} more (budget): ${e.next}`)
    }
  }
  for (const r of ctx.rows) {
    flush(r.depth)
    L.push(...outlineRow(r.row, '  '.repeat(r.depth)))
    const e = elidedUnder.get(r.id)
    if (e) pending.push({ depth: r.depth, e })
  }
  flush(0)
  if (nRels || ctx.dropped) {
    L.push('relationships:')
    for (const r of d.relationships) L.push(outlineRelationship(r, ''))
    const name = (id: string) => ctx.outsideTitles.has(id) ? `${id} ${quote(ctx.outsideTitles.get(id)!)}` : id
    for (const b of d.bundles) {
      L.push(`- ${name(b.from)} -> ${name(b.to)}: ${b.count} relationships${b.next ? ` (budget): ${b.next}` : ''}`)
      for (const r of b.edges ?? []) L.push(outlineRelationship(r, '  '))
    }
    if (ctx.dropped) L.push(`- ${ctx.dropped} relationships left out (budget): expand entity=${d.entity.id} relationships=none, then element on the ids that matter`)
  }
  L.push(...footer(d))
  return L.join('\n') + '\n'
}

function footer(d: Pick<BudgetedExpand, 'degraded' | 'hiddenRelationships' | 'bundledAtDepth' | 'truncated' | 'summariesDerived' | 'focus'>): string[] {
  const L: string[] = []
  if (d.focus) {
    const m = d.focus.matched
    L.push(`focus: ${m.length ? `${m.length} matched (${m.slice(0, 20).join(', ')}${m.length > 20 ? ', …' : ''})` : 'no matches'}${d.focus.unmatched.length ? `; no match for ${d.focus.unmatched.map(t => quote(t)).join(', ')}` : ''}`)
  }
  const g = d.degraded
  if (g.withoutDescription || g.withoutSummary) {
    L.push(`degraded (budget): ${[g.withoutDescription ? `${g.withoutDescription} without description` : '', g.withoutSummary ? `${g.withoutSummary} without summary` : ''].filter(Boolean).join(', ')}; element entity=<id> shows any in full`)
  }
  if (d.bundledAtDepth !== undefined) L.push(`bundled (budget): relationships counted between containers at depth ${d.bundledAtDepth}; expand a child for its own edges`)
  if (d.hiddenRelationships) L.push(`hidden: ${d.hiddenRelationships} relationships with both ends inside one entity shown; expand or element it to see them`)
  if (d.truncated) L.push('truncated: max_nodes reached before depth; raise max_nodes or expand a child')
  if (d.summariesDerived) L.push(`summaries: ${d.summariesDerived} derived from the first sentence of the description (not stored)`)
  return L
}

// ---------------------------------------------------------------------------------------------
// search

export interface BudgetedSearchOptions extends SearchOptions {
  budget?: number
  format?: ReadFormat
  head?: string | null
}

export interface BudgetedSearch {
  query: string
  under?: string
  elements: ViewRow[]
  relationships: RelationshipRow[]
  /** Matches beyond `limit`. */
  more: { elements: number; relationships: number }
  /** Matches within `limit` left out for the budget. */
  elided: { elements: number; relationships: number }
  degraded: { withoutSummary: number }
  summariesDerived: number
  budget: { limit: number; used: number; over?: true }
}

export function budgetedSearch(s: Snapshot, opts: BudgetedSearchOptions): { text: string; data: BudgetedSearch } | null {
  const m = searchMatches(s, opts)
  if (!m) return null
  const format = opts.format ?? 'outline'
  const budget = clampBudget(opts.budget)
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50))
  const cap: Level = opts.detail === 'minimal' ? 'minimal' : 'medium'
  const nodes: Node[] = m.elements.slice(0, limit).map((el, i) => ({ el, id: elementRow(s, el).id, depth: 0, parent: null, kids: [], priority: -i, order: i, cap, level: cap, rows: {} }))
  const rels = m.relationships.slice(0, limit).map(r => relationshipRow(s, r))
  let relsShown = rels.length
  const rowSize = (row: ViewRow) => format === 'outline' ? outlineRow(row, '').join('\n').length + 1 : JSON.stringify(row).length + 1

  const render = () => {
    const vis = nodes.filter(n => n.level !== null)
    const elements = vis.map(n => cached(s, n, n.level!, rowSize).row)
    const data: BudgetedSearch = {
      query: opts.query, ...(opts.under ? { under: opts.under } : {}),
      elements, relationships: rels.slice(0, relsShown),
      more: { elements: Math.max(0, m.total - limit), relationships: Math.max(0, m.relationships.length - limit) },
      elided: { elements: nodes.length - vis.length, relationships: rels.length - relsShown },
      degraded: { withoutSummary: vis.filter(n => n.cap !== 'minimal' && n.level === 'minimal').length },
      summariesDerived: elements.filter(r => (r as ElementMedium).summaryDerived).length,
      budget: { limit: budget, used: 0 },
    }
    return { text: format === 'json' ? JSON.stringify(data) : outlineSearch(data, opts, limit), data }
  }
  const next = (excess: number): boolean => {
    let saved = 0
    const steps = nodes.filter(n => n.level === 'medium').sort(byLoss)
    for (const n of steps) {
      saved += cached(s, n, 'medium', rowSize).size - cached(s, n, 'minimal', rowSize).size
      n.level = 'minimal'
      if (saved >= excess) return true
    }
    if (steps.length) return true
    if (relsShown > 0) { relsShown--; return true }
    const last = nodes.filter(n => n.level !== null).sort(byLoss)[0]
    if (!last || nodes.filter(n => n.level !== null).length <= 1) return false
    last.level = null
    return true
  }
  const out = fit(budget, render, next)
  out.data.budget.used = out.text.length
  if (out.over) out.data.budget.over = true
  return { text: format === 'json' ? JSON.stringify(out.data) : out.text, data: out.data }
}

function outlineSearch(d: BudgetedSearch, opts: BudgetedSearchOptions, limit: number): string {
  const L: string[] = []
  const filters = [opts.under ? `under ${opts.under}` : '', opts.kinds?.length ? `kinds ${opts.kinds.join(',')}` : '', opts.tags?.length ? `tags ${opts.tags.join(',')}` : '', opts.metadata && Object.keys(opts.metadata).length ? `metadata ${Object.entries(opts.metadata).map(([k, v]) => `${k}=${v}`).join(',')}` : ''].filter(Boolean)
  L.push(`# search ${quote(opts.query)}${filters.length ? ' · ' + filters.join(' · ') : ''} · ${d.elements.length} elements, ${d.relationships.length} relationships${opts.head ? ` · head ${opts.head}` : ''}`)
  for (const r of d.elements) L.push(...outlineRow(r, ''))
  if (d.relationships.length) { L.push('relationships:'); for (const r of d.relationships) L.push(outlineRelationship(r, '')) }
  if (d.elided.elements || d.elided.relationships) L.push(`elided (budget): ${d.elided.elements} elements, ${d.elided.relationships} relationships; raise budget or narrow the query`)
  if (d.more.elements || d.more.relationships) L.push(`more: ${d.more.elements} elements, ${d.more.relationships} relationships beyond limit=${limit}; raise limit (<=50) or narrow with under, kinds, tags, metadata`)
  if (d.degraded.withoutSummary) L.push(`degraded (budget): ${d.degraded.withoutSummary} without summary; element entity=<id> shows any in full`)
  if (d.summariesDerived) L.push(`summaries: ${d.summariesDerived} derived from the first sentence of the description (not stored)`)
  return L.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------
// overview (bounded already: at most 20 roots, 10 open change sets)

export function outlineOverview(o: Overview, head: string | null): string {
  const m = o.model
  const L = [`# overview · ${m.elements} elements, ${m.relationships} relationships, ${m.views} views${head ? ` · head ${head}` : ''}`]
  L.push(`kinds: ${Object.entries(m.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`)
  if (m.relationshipKinds.length) L.push(`relationship kinds: ${m.relationshipKinds.join(', ')}`)
  if (m.tags.length) L.push(`tags: ${m.tags.join(', ')}`)
  L.push(`roots${o.rootsTruncated ? ` (first ${o.roots.length})` : ''}:`)
  for (const r of o.roots) L.push(...outlineRow(r, ''))
  const lg = o.ledger
  L.push(`ledger: ${lg.changeSets} change sets (${Object.entries(lg.byDisposition).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ${lg.promoted} promoted`)
  if (lg.open.length) L.push(`open: ${lg.open.join(', ')}${lg.openTruncated ? ', … (changes disposition=proposed|accepted promoted=false)' : ''}`)
  if (o.identity.withoutStableId) L.push(`identity: ${o.identity.withoutStableId} elements without a stable id (help ids)`)
  const sm = o.summaries
  if (sm.derived || sm.none) L.push(`summaries: ${sm.stored} stored, ${sm.derived} derived from the description on read, ${sm.none} with neither`)
  return L.join('\n') + '\n'
}
