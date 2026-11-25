# Changelog

What changes for you when you upgrade. Both packages, `cb4-mcp` (the MCP server and CLI) and
`cb4-ledger` (the library), are released together under one version. Before 0.3.0 they were
published as `@borwood/b4-after` and `@borwood/b4-after-ledger`.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow
[Semantic Versioning](https://semver.org/) and will break before 1.0; breaking changes are marked.

## [Unreleased]

## [0.5.0] - 2026-11-25

### Upgrading

- **Breaking:** `migrate` is no longer an MCP tool. Migrations are upgrade steps you run once, when
  a release says to, so they are on the command line now:
  `cb4 migrate summaries [repoDir] --actor <name> [--dry-run]`. Reads still count summaries
  derived from descriptions, but no longer say how to store them. If your `overview` reports
  derived summaries, run `npx cb4-mcp migrate summaries <repoDir> --actor <you> --dry-run`, then
  without `--dry-run`. It records one editorial change set and changes no status.
- After upgrading, run `reconcile` once. Pending markers held by change sets that a promoted
  change set supersedes are dropped (see Fixed). Then run
  `npx cb4-mcp migrate update-order <repoDir> --actor <you> --dry-run`. It lists values that an
  earlier version overwrote when an older update was verified after a newer one, and restores them
  when you run it again without `--dry-run`. The repair is derived from the ledger, and a value is
  only restored when the committed one came from an older update.
- If you installed the skills with `cb4 skill`, run it again. The guide now covers replacing a
  promoted plan with a correction that declares `supersedes`, closing out a feature with what was
  built, `description_append`, relationship coverage and chained promotion.

### Added

- `propose` and `validate` take `change_set_path` (a YAML or JSON file) instead of `change_set`,
  for change sets too large to pass inline. Relative paths resolve against the server's working
  directory. In `cb4-ledger`: `readChangeSetInput()`.
- `promote` takes `with_dependencies=true` to promote the unpromoted `depends_on` chain first, in
  dependency order, with one commit per step. `accept=true` accepts proposed change sets on the way
  (it also works without `with_dependencies`). The chain stops at the first refusal; steps already
  done stay, and the result says where it stopped (`stopped`). In `cb4-ledger`: `promoteChain()`.
- `update_element` takes `set.description_append` to add a paragraph to the intended description
  rather than replace it. `propose` records the full resulting text.
- `W_DESCRIPTION_DROPS_TEXT`: an `update_element` whose new description leaves out sentences of
  the intended description warns. The intended description is the committed one plus pending
  updates and unpromoted `depends_on` change sets, not just the committed one.
- `record_evidence` returns `uncovered` (targets no passing observation covers yet). It also returns
  a `hint` naming relationships whose endpoints are both covered when no record names the
  relationship itself. Covering both endpoints still does not cover the link.

### Fixed

- A promoted change set that declares `supersedes: [X]` now ends X's pending updates and removals.
  They are dropped unapplied when the replacement is promoted, or at the next reconcile, and X's
  `b4_pending` markers clear. Before this, `supersedes` was only recorded: X stayed pending
  forever, and evidence on X could still apply its old text. `promote` and `reconcile` report the
  dropped operations as `abandoned`, and `record_evidence` on X warns that it changes nothing.
  Additions X made stay.
- Target views no longer put a pending description on the card of an element that has a summary.
  LikeC4 cards show the summary, but a view's `description` override replaced it, so the full
  text landed on the card. A pending summary is now the card text instead: LikeC4 ignores `summary`
  inside `with { }`, so the summary override cb4 wrote before had no effect. Elements without a
  summary still show a pending description on the card, as their As-is card shows the description.
- `record_evidence` no longer requires `recorded_by`: it defaults to the actor (`actor=` or the
  server's `--actor`). The stored record still always names who recorded it.
- A deferred update verified after a newer update of the same entity no longer overwrites the newer
  values. It now sets only the fields (and metadata keys) the newer one left alone. Target views show
  the same values. Before this, verifying an older change set after a newer one put the older
  description back.

## [0.4.0] - 2026-11-21

### Upgrading

- **Breaking:** `overview`, `search` and `expand` answer in an indented outline by default (one
  line per entity, its summary and description on the lines below, a first line naming the read
  and `head`). Pass `format=json` for the same content as JSON. Errors stay JSON.
- **Breaking:** `locate` answers in an outline by default too, within a character budget
  (`budget=<chars>`, default 40,000). `format=json` gives the old shape plus `omitted` on every
  part the budget cut, `relatedElided` and per-level `elided` counts, `degraded`,
  `summariesDerived` and `budget`. Under budget pressure connected and related entities can come
  back as minimal rows (no `summary`) and a container as a row only. In `cb4-ledger`, `locate()`
  now returns `{ text, data }`, with the old result as `data`.
- **Breaking:** `detail=medium` now shows an element's `summary` instead of its full description,
  and is the default for `overview`, `search` and `expand`. The description is in `element` and in
  `locate`'s focus. Code reading `description` from medium rows should read `summary`.
- **Breaking:** proposing an `add_element` now requires a `summary`: one line, 200 characters at
  most, saying what the element is (`E_MISSING_SUMMARY`). Change sets already in the ledger are
  unaffected and still promote. A summary can be replaced but not removed.
- `expand` results as JSON changed shape: relationships come as single `relationships` plus
  `bundles` (several edges between the same two rows, counted), with `elided`, `degraded`,
  `hiddenRelationships`, `focus` and `budget` reporting what was cut. `relationships=direct` is
  still accepted and means the new default, `bundled`.

### Added

- Character budgets for `search`, `expand` and `locate` (`budget=<chars>`, default 40,000). The answer is the
  most useful view that fits: detail falls off with distance from the entity you asked about
  (descriptions first, then edge lists, then summaries, then whole rows), and everything left out
  is counted with the call that brings it back. A depth-2 `expand` of a large system that used to
  return 92,000 characters now fits in 40,000 with every entity listed, and the largest `locate`
  there went from 47,000 characters of JSON to a 34,000-character outline with nothing cut.
- `expand focus_terms=[...]`: entities whose id, fqn or title hold every word of a term are listed
  even below `depth`, shown with their full description, and kept longest under the budget.
- Relationship bundling in `expand`: relationships with an end in the subtree are counted between
  the rows shown (or an outside branch, named by title) instead of listed one by one, and meet at
  shallower containers when the budget is tight. Relationships deep inside the subtree are now
  included, bundled at the row that contains them.
- `search under=<id>` scopes a search to the descendants of an element.
- Element summaries, stored as LikeC4's native `summary` property: `add_element` and
  `update_element` take `summary`, target views show pending summaries, and `bootstrap mode=adopt`
  copies existing summaries or derives one from the description's first sentence. Elements without
  a stored summary show that first sentence on read, marked `summaryDerived` (`summary (derived)` in
  the outline); reads never write it back. `overview` counts elements by summary: stored, derived,
  none.
- Validation warns when a summary runs past one line or 200 characters (`W_LONG_SUMMARY`) and when
  an update changes the description but not the summary (`W_SUMMARY_STALE`).
- `migrate what=summaries` stores the summaries reads have been deriving, as one change set marked
  `editorial`, proposed, accepted and promoted in one call. Editorial change sets may only set
  summaries; they apply at once and never count toward an entity's status, qualification or
  implementation, so a planned element stays intended and a failing one stays failed.
  `dry_run=true` lists what would be stored. Run it once per repository after upgrading.

### Fixed

- `bootstrap mode=adopt` no longer copies an element's summary into its description when the
  element has a summary and no description.
- The `cb4-mcp` README's setup for other MCP clients ran `npx -y cb4`, which is not this package;
  it now runs `npx -y cb4-mcp`. Its library example imports from `cb4-mcp` too.

## [0.3.0] - 2026-10-30

### Upgrading

- The project is now **cb4**. The packages are `cb4-mcp` (MCP server and CLI, command `cb4`; npm
  refuses the bare name as too close to existing packages) and `cb4-ledger`, unscoped. `@borwood/b4-after` and `@borwood/b4-after-ledger` are deprecated and
  will not receive further versions. To move:
  - Point your MCP client at the new package: `claude mcp add cb4 -- npx -y cb4-mcp ./architecture --actor claude`
    (or `codex mcp add ...`), and remove the old entry.
  - Environment variables are `CB4_REPO` and `CB4_ACTOR` (were `B4_AFTER_REPO`, `B4_AFTER_ACTOR`).
  - Reinstall the skills, now `cb4-guide` and `cb4-adopt`: `npx -y cb4-mcp skill` (add `--codex` for
    Codex), and delete the old `b4-after-*` skill folders.
  - Library users import from `cb4-ledger`; the API is unchanged apart from the entries below.
- Nothing in a model repository changes. The `b4-*` tags and `b4_*` metadata that cb4 writes into
  the model keep their names, so existing repositories need no migration.

### Added

- `locate` tool: one grounding read for an agent handed an entity id. It returns the element in
  full, every entity it has a direct relationship with (medium detail, placed by the nearest shared
  container and the path below it), and each container up to the root with its peers split into
  those whose subtree connects to the entity's subtree (medium detail with the connecting
  relationships) and the rest (id, kind, title). A relationship id works too: the relationship in
  full with its source as the focus. Every list is capped (`max_peers`, `max_relationships`).
- One set of detail tiers across the reads. `minimal` is the row you already know (id, fqn, kind,
  title, children count, pending). `medium` adds description, technology, tags and status. `full`
  is what `element` returns. `overview`, `search` and `expand` take `detail=medium` to answer
  "what are these" without one `element` call per row; the default stays minimal. `help queries`
  defines the tiers once.
- `search` matches technology and description text, for elements and relationships, so "what
  talks to Kafka" finds a component whose description says so. Ranking is unchanged: exact id or
  title first, then prefix, then substring.
- `changes` takes a `source` filter: the ref of an issue, PR, CI run or deployment. It matches
  change-set `sources[].ref` and evidence `source_ref`, so "which change sets relate to this
  link" is one call. Each row says what matched (`matched: [{via: source, role, ref}]` or
  `{via: evidence, evidence, kind, result, ref}`). Matching is exact unless
  `source_match=contains`, for a PR number or issue key inside a URL that may be written in
  several forms.

### Changed

- **Breaking**: on a container, `element` used to list its descendants' relationships under
  `incoming`/`outgoing` with nothing to say so, so an edge from a child read as the container's
  own. Those lists now hold the element's own edges only. Edges that cross its boundary through a
  descendant are under `nestedIncoming`/`nestedOutgoing`, each with `via: {id, fqn}` of the
  descendant, capped at 50 with `nestedTruncated`. Relationships internal to the subtree are in
  neither; `expand` shows those.
- **Breaking**: `element` no longer lists every change set id that ever touched the entity. That
  list grew with history times connectivity, so a hub element in a long-lived repository could
  carry hundreds of ids on the call agents make most. `changeSets` is now a summary: `total`,
  `promoted`, `byDisposition`, and `open` (proposed or accepted, not promoted, capped at 20
  with `openTruncated`). For the history use `story entity=<id>`, which is paged, or
  `changes entity=<id>`.

## [0.2.1] - 2026-10-28

### Added

- Metadata values may be lists of strings as well as strings, matching LikeC4
  (`metadata: { owners: ['alice', 'bob'] }`).
- `search` matches metadata values and takes a `metadata: { key: value }` filter, so "every
  element owned by the payments team" is one call. Relationships are searched the same way.

### Changed

- In `update_element` and `update_relationship`, a `null` metadata value deletes that key. Other
  keys are still patched in place.
- `b4-after-guide` skill and `help plan`: a slice that refines a planned entity should carry an
  `update_element` on it, so verifying the slice also proves the planned entity; referencing it
  from a relationship or as a parent does not. Reinstall the skill to pick this up:
  `npx -y @borwood/b4-after skill b4-after-guide`.

### Fixed

- An update could overwrite an entity's `stable_id` through `set.metadata`. It is now rejected as
  reserved (`E_RESERVED_METADATA`).

## [0.2.0] - 2026-10-27

### Upgrading

- Run the `reconcile` tool once on each existing model repository. It rewrites `model/model.c4`
  with the new status tags and metadata and generates `model/views.c4`. Until then the model has no
  status information and the As-is and Target views do not exist.
- Any `.c4` file you placed under `model/` by hand is removed on the next promotion or
  reconciliation. `model/` is fully generated now; keep hand-written views elsewhere.
- Change sets that still carry `implementation:` keep working. The field is ignored with a warning
  and can be deleted from your files whenever convenient.
- Agents using the adoption skill should reinstall it: `npx -y @borwood/b4-after skill`. The same
  command now also installs the new `b4-after-guide` skill.

### Changed (breaking)

- **The promoted model no longer claims a change is built.** Promoting an unverified change set
  used to apply every operation as fact. Now additions and moves are applied and tagged
  `b4-intended` or `b4-pending-move`; updates and removals of entities that already exist are held
  back and the target is tagged `b4-pending-update` or `b4-retiring` until evidence verifies them.
  Every element and relationship carries `b4_change` (the change set it comes from), `b4_status`
  (its verification) and, when something is held back, `b4_pending`. Anyone reading `model/`,
  with or without b4-after, can tell what exists from what is planned.
- Tags starting `b4-` and metadata keys starting `b4_` are reserved. Change sets that set them are
  rejected (`E_RESERVED_TAG`, `E_RESERVED_METADATA`).
- Element names that are LikeC4 keywords (`head`, `title`, `kind`, `link`, `style`, `view`, ...)
  are rejected at validation (`E_RESERVED_WORD`) instead of breaking promotion. Rename the element;
  stable ids are unaffected.
- `implementation` is no longer a change-set field. It is derived from evidence: `not_started`,
  `in_progress` once any observation exists, `implemented` once verified (inferred change sets
  count as implemented). The `changes` and `change` tools and the commit trailer report the
  derived value.
- Library: `validateChangeSet` is unchanged, but `proposeChangeSet` now validates with
  dependencies projected (see below) and returns `validation.projected`. `roundTripCheck` was
  removed; use `generateAndCheck`. `generateDSL` no longer emits views; `generateViews` and
  `workspaceFiles` produce them. `PromoteResult` gained `deferred`, `reconciled` and `warnings`.
  `Snapshot` requires `parsedData`. `ChangeSet` no longer has `implementation`; `ChangeRecord`
  still does, derived.

### Added

- `reconcile` tool: applies held-back updates and removals once their change set is verified for
  that entity, refreshes every status, regenerates the views, and commits only when something
  changed. It also runs automatically after `record_evidence`. Idempotent.
- `render` tool: the committed model for people, as LikeC4's single-file interactive site
  (default), PNG, or DSL. `project` and `qualify` accept `render=html` too.
- Generated views in `model/views.c4`: folders As-is and Target, each with a landscape, an
  everything view, one view per element with children, and one per tag. As-is leaves out intended
  entities; Target shows them, with pending titles, descriptions and technologies as overrides.
- `validate` and `propose` see entities introduced by change sets you depend on that are not yet
  promoted. Declare them in `depends_on` and a whole set of related change sets can be proposed and
  reviewed together; the response lists `projected_dependencies`. Promotion still goes in
  dependency order.
- Operations on an entity that is itself still intended apply at once, so a plan promoted before
  building can be revised, re-parented or dropped by a follow-up change set without waiting on
  evidence.
- `search`, `expand` and `element` rows carry `pending: [...]` whenever an entity is not exactly as
  drawn. `element` and `change` expose the derived verification per entity.
- `W_RETIRING_TARGET` warns when a change set builds on an element whose removal is promoted but
  not yet verified.
- `b4-after-guide` skill and `help plan`: the mental model, the change-set lifecycle, what evidence
  means and derives, how in-progress work looks in the model, how to plan a project in layers
  before building it, and how to derive shorter task-specific skills for a workspace.
- `b4-after skill <name>` installs a single skill; with no name it installs all shipped skills.
- Library: `reconcileBaseline`, `finalizeBaseline`, `annotateStatuses`, `deriveEntityStatus`,
  `planPromotion`, `validateInContext`, `targetVerification`, `deriveImplementation`,
  `generateViews`, `workspaceFiles`, `materializeProjection`, `LIKEC4_RESERVED_WORDS`, and the
  reserved vocabulary (`TAG`, `META`, `flagsOfTags`).

### Fixed

- Removing an element and adding another with the same name in one change set was rejected as a
  duplicate name.
- A move onto a name that already exists at the destination was accepted and failed at promotion;
  it is now rejected at validation.
- Promotion refusals caused by LikeC4 parse errors embedded the parser's full expected-token list,
  hundreds of kilobytes in one tool result. They are truncated to the first few errors.
- Regenerating a model was not stable when the specification declared tags out of order.

## [0.1.0] - 2026-10-26

First public release, renamed from the `like-b4` prototype.

- Change sets as records with stable identity and git provenance; validation against the baseline
  and ledger; proposals, dispositions and governed promotion into a LikeC4 model.
- Candidate projections with highlighted diffs, rendered as DSL or PNG.
- Evidence records with derived, environment-qualified verification; the qualified baseline;
  release timelines and released baselines from deployment evidence.
- Bounded stories per entity or subtree, as of a revision or date, with lineage pointers.
- Adoption: `bootstrap mode=init` and `mode=adopt`, inferred change sets, the `b4-after-adopt` skill.
- MCP server with seventeen bounded, compact tools; a relative model-repository path anchors to the
  main worktree so linked worktrees and subagents share one ledger.

[Unreleased]: https://github.com/borwood/cb4/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/borwood/cb4/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/borwood/cb4/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/borwood/cb4/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/borwood/cb4/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/borwood/cb4/compare/0db645a...v0.2.0
[0.1.0]: https://github.com/borwood/cb4/commits/0db645a
