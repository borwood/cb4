export * from './schema.js'
export { Git, GitError, parseTrailers, toUtcIso, type Commit } from './git.js'
export { IdentityRegistry, STABLE_ID_KEY, type EntityRecord, type ElementRecord, type RelationshipRecord, type IdentityProblem } from './identity.js'
export { loadModel, modelFromParsedData, generateDSL, sanitizeForGeneration, MODEL_DIR, type LoadedModel, type LoadModelOptions, type ParsedModelData } from './model.js'
export {
  workspaceFiles, readWorkspace, writeWorkspace, sameWorkspace, loadWorkspaceFiles, generateAndCheck, summarizeErrors, MODEL_FILE, VIEWS_FILE,
  type WorkspaceFiles,
} from './workspace.js'
export { generateViews } from './views.js'
export {
  RESERVED_TAG_PREFIX, RESERVED_METADATA_PREFIX, STATUS_FLAGS, TAG, TAG_COLOR, META, DEPRECATED_CHANGE_SET_FIELDS, LIKEC4_RESERVED_WORDS,
  isReservedTag, isReservedMetadataKey, isLikeC4ReservedWord, flagsOfTags, userTags, type StatusFlag,
} from './reserved.js'
export {
  finalizeBaseline, annotateStatuses, deriveEntityStatus, ensureReservedTags, planPromotion, markDeferred, markMoves, readPending, intendedIds, isIntended, pendingUpdates, promotedOrder, withoutSuperseded, supersessions,
  type EntityStatus, type StatusSummary, type StatusCount, type HistoryOptions, type AppliedOperation, type AbandonedOperation, type FinalizeResult, type PromotionPlan,
} from './status.js'
export { reconcileBaseline, ReconcileRefused, type ReconcileOptions, type ReconcileResult } from './reconcile.js'
export { applyOperation, patchProps, WorkingIds, emptyDiff, type OperationDiff, type ApplyOperationOptions, type PropertyPatch } from './operations.js'
export {
  Ledger, LedgerError, CHANGES_DIR, changeSetPath, parseChangeSet, readChangeSetInput, serializeChangeSet, participantsOf, compareRecorded,
  type ChangeRecord, type Participation, type ParticipationRole, type LedgerSnapshot, type LedgerProblem, type LoadLedgerOptions,
} from './ledger.js'
export { locate, type LocateOptions, type LocateResult, type LocateLevel, type ConnectedEntity, type RelatedEntity, type ContainerDetail, type ContainerRow, type LocateFocus, type Omitted } from './locate.js'
export { storyOf, type StoryQuery, type StoryResult, type StoryEntry, type StoryInclude, type StoryDeps } from './story.js'
export { validateChangeSet, type ValidationIssue, type ValidationResult, type ValidationContext } from './validate.js'
export { commitMessageFor, provenanceOf, recordChangeSet, TRAILER, type CommitMessageOptions, type RecordOptions, type RecordResult, type ProvenanceTrailers } from './provenance.js'
export {
  projectModel, applyChangeSets, orderByDependencies, ProjectionError, CANDIDATE_TAG, CANDIDATE_COLOR,
  type Projection, type ProjectOptions, type ApplyOptions, type ProjectionDiff, type ProjectionIssue,
} from './projection.js'
export { renderProjection, materializeProjection, projectionToDSL, type RenderOptions, type RenderResult, type RenderFormat, type Renderable, type MaterializedWorkspace, type MaterializeOptions } from './render.js'
export {
  proposeChangeSet, validateInContext, setDisposition, ProposalRejected, DISPOSITION_TRANSITIONS,
  type ProposeOptions, type ProposeResult, type DispositionOptions, type ContextualValidation,
} from './propose.js'
export { promoteChangeSet, promoteChain, PromotionRefused, type PromoteOptions, type PromoteResult, type PromotionPolicy, type PromoteChainOptions, type PromoteChainResult, type ChainStep } from './promote.js'
export {
  EvidenceRecord, EvidenceFile, EvidenceKind, EvidenceResult, EvidenceError, KIND_CLASS, EVIDENCE_DIR,
  evidencePath, parseEvidenceFile, serializeEvidenceFile, deriveVerification, deriveImplementation, targetVerification, targetsOf, recordEvidence, relationshipsWithCoveredEndpoints,
  type EvidenceRecordInput, type Verification, type VerificationStatus, type VerificationPolicy, type TargetVerification, type RecordEvidenceOptions, type RecordEvidenceResult,
} from './evidence.js'
export { intendedDescriptions, droppedSentences, expandDescriptionAppends, type DescriptionLookup } from './intended.js'
export { repairUpdateOrder, findOutOfOrderValues, type RestoredValue, type RepairUpdateOrderOptions, type RepairUpdateOrderResult } from './repair.js'
export { qualifyBaseline, QUALIFICATION_TAGS, type QualifiedBaseline, type EntityQualification, type QualificationStatus, type QualifyOptions } from './qualify.js'
export { formatStory, formatEntry, formatQualification } from './format.js'
export { releaseTimeline, releasedBaseline, promotionCommitOf, type ReleaseEvent, type ReleasedBaseline, type ReleasedBaselineOptions, type TimelineOptions } from './releases.js'
export { initModelRepo, adoptExistingModel, slug, DEFAULT_KINDS, DEFAULT_RELATIONSHIP_KINDS, type InitOptions, type InitResult, type AdoptOptions, type AdoptResult } from './bootstrap.js'
export {
  overview, search, expand, elementDetail, resolveElement, elementRow, relationshipRow,
  type Snapshot, type Overview, type SearchOptions, type SearchResult, type ExpandOptions, type ExpandResult, type ElementDetail, type ElementRow, type RelationshipRow,
} from './queries.js'
export { searchMatches, matchScore, elementMedium, type Detail, type ElementMedium } from './queries.js'
export {
  budgetedExpand, budgetedSearch, outlineOverview, outlineRow, outlineRelationship, clampBudget, DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET,
  type ReadFormat, type Level, type ViewRow, type BudgetedExpand, type BudgetedExpandOptions, type BudgetedSearch, type BudgetedSearchOptions, type Bundle, type Elision,
} from './budget.js'
export { summaryOf, firstSentence, rawSummary, rawDescription, clip, SUMMARY_MAX, type SummaryValue } from './summary.js'
export { migrateSummaries, type MigrateSummariesOptions, type MigrateSummariesResult } from './migrate.js'
