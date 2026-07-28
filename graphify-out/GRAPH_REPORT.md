# Graph Report - .  (2026-07-25)

## Corpus Check
- 33 files · ~237,634 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1628 nodes · 2693 edges · 97 communities (88 shown, 9 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 284 edges (avg confidence: 0.53)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- In-Page Selector Tool
- Selector Generation Engine
- Workflow Sidebar & Editors
- Run & Schedule Store
- Backend Dependencies
- Backend Server Orchestration
- Proxies Repository & Crypto
- Public REST API Architecture (docs)
- Workflow Panel
- DB Client (SQLite/Postgres)
- Public API Reference (docs)
- Browser Manager & Stealth
- Code Check & Healing Stats
- Frontend Dependencies
- Execution Pipeline & Healing
- Workflow Code Generation
- Execution Results Panel
- API Discovery & Replay
- Change Diff Engine
- Element Inspector
- Self-Healing Service
- Action Definitions & Pagination
- Public API v1 Tests
- Change Monitor Tests
- Express App Wiring
- Frontend API Client
- Public API v1 Helpers & Routes
- Workflow Routes & Dataset
- API Worker Async Queue
- CSV Export Tests
- DB Schema & Migrations
- JWT Auth Middleware
- Scraper Service (Live Control)
- Workflow State (useWorkflow)
- Dataset API Tests
- Dataset & Monitor UI
- Variable Picker
- Runs History UI
- AI Naming Routes
- Public API v1 Runs Routes
- DB Smoke Test
- Runner Service (Child Processes)
- Webhook Dispatcher
- HTML Inspector Panel
- Frontend App Shell
- API Key Auth & Service
- API Rate Limiting
- API Discovery AI Enrichment
- Extract List AI
- Healing Integration Tests
- Workflow Utils
- Proxies Menu UI
- CAPTCHA & Consent Scripts
- Workflows Repository
- Runs Routes & Export
- LLM Service
- Error Classifier
- Network Capture (CDP)
- Webhooks Routes
- Healing Verify
- Scheduler Service
- Workflow Test Harness
- Custom Actions Repository
- Proxy Pools Routes
- Auth Routes (Login/Register)
- CAPTCHA Solver Service
- Workflow Variables UI
- API Keys Repository
- Custom Actions Routes
- Proxies Routes
- Repair Service (LLM)
- XLSX Export Tests
- Excel (XLSX) Export
- Field Transforms Runtime
- DB Migration Runner
- API Keys Routes
- API Serialization
- Custom Actions Menu
- Dashboard
- API Sources Panel
- Schedule Editor
- Change Monitor Service
- Dependency Resolver
- Condition Builder
- Healing Apply Helpers
- Workflow Executor
- Force Same-Tab Navigation
- Proxy Resolver
- CI Pipeline & App Shell
- User Actions Tracker
- Change Monitoring Migration
- Minimal Stealth Test
- Minimal CDP Test
- API Discovery & Code Export (docs)

## God Nodes (most connected - your core abstractions)
1. `onClick()` - 21 edges
2. `getSelectorsForElement()` - 19 edges
3. `BrowserManager` - 15 edges
4. `getStableClasses()` - 15 edges
5. `genAction()` - 14 edges
6. `generateCode()` - 14 edges
7. `cssEscape()` - 13 edges
8. `ExtractListFieldsEditor()` - 13 edges
9. `executeAndPersist()` - 13 edges
10. `Prioritized Roadmap (P0-P3)` - 13 edges

## Surprising Connections (you probably didn't know these)
- `useWorkflow()` --indirect_call--> `count()`  [INFERRED]
  frontend/src/workflow/useWorkflow.js → backend/browser/networkCapture.js
- `API Discovery` --semantically_similar_to--> `Self-healing data extraction`  [INFERRED] [semantically similar]
  docs/API_DISCOVERY.md → README.md
- `ExtractListFieldsEditor()` --indirect_call--> `requestId()`  [INFERRED]
  frontend/src/components/ExtractListFieldsEditor.jsx → backend/middleware/apiKeyAuth.js
- `HtmlInspectorPanel()` --indirect_call--> `q()`  [INFERRED]
  frontend/src/components/HtmlInspectorPanel.jsx → backend/workflow/workflowCodegen.js
- `useWorkflow()` --indirect_call--> `clone()`  [INFERRED]
  frontend/src/workflow/useWorkflow.js → backend/workflow/workflowUtils.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Webhook delivery system (events + signing)** — docs_api_reference_webhooks, docs_api_reference_run_completed_event, docs_api_reference_run_failed_event, docs_api_reference_run_changed_event, docs_api_reference_webhook_signature_verification [EXTRACTED 1.00]
- **Extracted data's life beyond a single run** — docs_platform_analysis_dataset_view, docs_platform_analysis_excel_export, docs_platform_analysis_change_monitoring [EXTRACTED 1.00]
- **Differentiators neither competitor ships** — docs_platform_analysis_self_healing, docs_platform_analysis_api_discovery, docs_platform_analysis_code_export [EXTRACTED 1.00]
- **API Discovery capture→analyze→verify→propose→call pipeline** — docs_api_discovery_passive_capture, docs_api_discovery_heuristics_decide_ai_enriches, docs_api_discovery_two_probe_replay, docs_api_discovery_authorization_tiers, docs_api_discovery_extract_api_step [EXTRACTED 0.85]
- **Stateless-backend scaling foundations** — docs_scaling_and_db_migration_stateless_backend, docs_scaling_and_db_migration_dual_backend_client, docs_scaling_and_db_migration_atomic_schedule_claim, docs_scaling_and_db_migration_user_id_scoping [EXTRACTED 0.80]

## Communities (97 total, 9 thin omitted)

### Community 0 - "In-Page Selector Tool"
Cohesion: 0.06
Nodes (79): applyHard(), applyHoverHighlight(), _applyListFieldMarkers(), applySoft(), buildElementInfo(), buildLabelAnchoredSelector(), buildRelativeSelector(), buildSimpleSelector() (+71 more)

### Community 1 - "Selector Generation Engine"
Cohesion: 0.09
Nodes (64): anchorsForElement(), applyBasisDedup(), attrNameSimilarity(), buildContext(), buildCssPath(), buildExactGroupSelector(), buildGroupSelectors(), buildNodeInfo() (+56 more)

### Community 2 - "Workflow Sidebar & Editors"
Cohesion: 0.06
Nodes (52): BRANCH_KEYS, CAN_RESELECT(), CAT_COLORS, CompactWorkflowSidebar(), composeScopedSelector(), CWSCtx, flattenSteps(), getMeta() (+44 more)

### Community 3 - "Run & Schedule Store"
Cohesion: 0.05
Nodes (15): bumpScheduleAfterRun(), claimDueSchedule(), computeNextRun(), crypto, db, ensureVersion(), getMonitorById(), getScheduleById() (+7 more)

### Community 4 - "Backend Dependencies"
Cohesion: 0.05
Nodes (42): author, dependencies, bcryptjs, better-sqlite3, body-parser, dotenv, exceljs, express (+34 more)

### Community 5 - "Backend Server Orchestration"
Cohesion: 0.05
Nodes (39): apiDiscovery, apiDiscoveryAI, apiReplay, apiWorker, app, browserManager, { buildFlowTree }, { buildInjectedCaptchaScript } (+31 more)

### Community 6 - "Proxies Repository & Crypto"
Cohesion: 0.08
Nodes (30): create(), cryptoUtil, db, getForUser(), getSharedById(), listAvailableForUser(), listForUser(), listShared() (+22 more)

### Community 7 - "Public REST API Architecture (docs)"
Cohesion: 0.05
Nodes (42): API-key authentication, executionPipeline (shared execution service), Public REST API architecture (v1), Thin front door over existing services, Trigger-and-fetch async design, API Discovery, Authorization tiers (open/session/bearer/signed), EXTRACT_API step (Call Data API) (+34 more)

### Community 8 - "Workflow Panel"
Cohesion: 0.07
Nodes (28): react, ActionCard(), analyseSourceExpr(), buildControlSummary(), collectCapturedOutputs(), ColumnSelect(), ControlBlock(), detectInputMismatch() (+20 more)

### Community 9 - "DB Client (SQLite/Postgres)"
Cohesion: 0.05
Nodes (14): fs, path, db, db, db, express, router, usageRepo (+6 more)

### Community 10 - "Public API Reference (docs)"
Cohesion: 0.08
Nodes (40): API Key Authentication, apiWorker (async execution), Cursor Pagination, Consistent Error Shape, Execution Pipeline (shared with API), Idempotency Keys, needs_review Run Status, Public REST API (v1) (+32 more)

### Community 11 - "Browser Manager & Stealth"
Cohesion: 0.10
Nodes (20): BrowserManager, {
    DEVICE_PROFILES,
    pickRandomProfile,
    getLaunchArgs,
    getUserAgentMetadata,
    getNavigatorOverrideScript,
    workerConstructorPatchFn,
    PROXY_WEBRTC_GUARD_SCRIPT
}, { executablePath }, puppeteer, { resolveChromePath }, StealthPlugin, existsFile(), findUnder() (+12 more)

### Community 12 - "Code Check & Healing Stats"
Cohesion: 0.07
Nodes (27): vm, classifyStep(), COLLECTION_TYPES, emptyFieldsOf(), isCollectionType(), isSuspicious(), THRESHOLDS, assessFieldSamples() (+19 more)

### Community 13 - "Frontend Dependencies"
Cohesion: 0.06
Nodes (32): axios, @dnd-kit/core, @dnd-kit/sortable, author, dependencies, axios, @dnd-kit/core, @dnd-kit/sortable (+24 more)

### Community 14 - "Execution Pipeline & Healing"
Cohesion: 0.10
Nodes (28): aggregateStats(), baselineFor(), changeMonitor, { checkCompiles }, CHILD_KEYS, cloneFields(), delay(), detectBrokenSteps() (+20 more)

### Community 15 - "Workflow Code Generation"
Cohesion: 0.15
Nodes (28): { buildCodegenCaptchaHelper }, { buildCodegenConsentHelper }, { buildCodegenStealthHelper, getProxyLaunchArgs, PROXY_WEBRTC_GUARD_SCRIPT }, collectReadmeInfo(), EXTRACTION_TYPES, genAction(), genControl(), generateReadme() (+20 more)

### Community 16 - "Execution Results Panel"
Cohesion: 0.11
Nodes (18): DataPreview(), ExecutionPanel(), FLOW_BRANCH_KEYS, FLOW_LOOP_TYPES, FlowNode(), formatCell(), friendlyType(), getCount() (+10 more)

### Community 17 - "API Discovery & Replay"
Cohesion: 0.15
Nodes (25): analyze(), buildCurl(), buildFetchSnippet(), classifyAuth(), curateHeaders(), describeParams(), digits(), findPrimaryCollection() (+17 more)

### Community 18 - "Change Diff Engine"
Cohesion: 0.13
Nodes (21): changedFields(), diffResults(), displayKey(), indexRows(), isRecord(), listFor(), { rowKey }, summarizeDiff() (+13 more)

### Community 19 - "Element Inspector"
Cohesion: 0.11
Nodes (9): ACTION_ICON_PATHS, ActionConfigurator(), buildDefaultAdvanced(), buildDefaultParams(), CATEGORIES, MultiInspector(), SingleInspector(), strategyLabel() (+1 more)

### Community 20 - "Self-Healing Service"
Cohesion: 0.20
Nodes (21): buildListExplanation(), buildListParams(), candidateFallbacks(), cleanRelative(), firstContainerHtml(), healList(), healSingle(), healStep() (+13 more)

### Community 21 - "Action Definitions & Pagination"
Cohesion: 0.15
Nodes (13): actionDefinitions, EXTRACT_WAIT_ADV, ACTION_TYPES, generatePaginationSteps(), SuggestionCard(), TYPE_INFO, STEPS, CONTROL_TYPES (+5 more)

### Community 22 - "Public API v1 Tests"
Cohesion: 0.11
Nodes (20): fetch, api(), apiKeysRepo, apiWorker, app, assert, crypto, db (+12 more)

### Community 23 - "Change Monitor Tests"
Cohesion: 0.12
Nodes (18): app, changeMonitor, crypto, db, fs, http, main(), ok() (+10 more)

### Community 24 - "Express App Wiring"
Cohesion: 0.11
Nodes (17): aiRoutes, apiKeysRoutes, app, authRoutes, cors, customActionsRoutes, db, DIST_DIR (+9 more)

### Community 25 - "Frontend API Client"
Cohesion: 0.17
Nodes (14): aiApi, api, apiKeysApi, authApi, getToken(), proxiesApi, proxyPoolsApi, setToken() (+6 more)

### Community 26 - "Public API v1 Helpers & Routes"
Cohesion: 0.17
Nodes (14): isUniqueViolation(), pageEnvelope(), parseCursor(), parseId(), parseLimit(), safeJson(), express, { parseId, parseLimit, parseCursor, pageEnvelope, isUniqueViolation, safeJson } (+6 more)

### Community 27 - "Workflow Routes & Dataset"
Cohesion: 0.12
Nodes (10): collectKeyFields(), dataset, express, loadDataset(), { requireAuth }, { resultsToCsv }, { resultsToXlsx }, router (+2 more)

### Community 28 - "API Worker Async Queue"
Cohesion: 0.15
Nodes (13): applyInputs(), CONCURRENCY, controllers, executeOne(), executionPipeline, { resolveCustomActions, resolveSubflows }, runStore, safeJson() (+5 more)

### Community 29 - "CSV Export Tests"
Cohesion: 0.18
Nodes (13): assert, fs, PARITY_FIXTURES, path, { resultsToCsv, toCSV, csvCell }, vm, csvCell(), isRecord() (+5 more)

### Community 30 - "DB Schema & Migrations"
Cohesion: 0.24
Nodes (10): schema, { pk, fk }, up(), { pk, fk }, up(), { pk, fk }, up(), fk() (+2 more)

### Community 31 - "JWT Auth Middleware"
Cohesion: 0.14
Nodes (12): crypto, fs, jwt, JWT_SECRET, path, requireAuth(), verifyToken(), express (+4 more)

### Community 32 - "Scraper Service (Live Control)"
Cohesion: 0.15
Nodes (10): express, router, scraperServiceFactory, browserManager, heldModifiers(), MODIFIER_KEYS, performAction(), reconcileModifiers() (+2 more)

### Community 33 - "Workflow State (useWorkflow)"
Cohesion: 0.25
Nodes (15): buildCustomActionStep(), buildDefaultAdvanced(), buildDefaultParams(), StepList(), WorkflowPanel(), attachedGroupLeader(), attachedGroupSize(), BRANCH_KEYS (+7 more)

### Community 34 - "Dataset API Tests"
Cohesion: 0.16
Nodes (14): app, db, fs, http, main(), ok(), os, path (+6 more)

### Community 35 - "Dataset & Monitor UI"
Cohesion: 0.23
Nodes (12): schedulesApi, workflowsApi, cell(), cellTitle(), DatasetPanel(), relTime(), ChangeRow(), formatDate() (+4 more)

### Community 36 - "Variable Picker"
Cohesion: 0.23
Nodes (13): buildCapturedNode(), buildCustomNode(), buildIterVarNode(), buildTree(), COMPATIBLE, expectedKindLabel(), filterNode(), filterTree() (+5 more)

### Community 37 - "Runs History UI"
Cohesion: 0.17
Nodes (5): formatDate(), formatDuration(), REPAIR_KIND_LABELS, RunsHistory(), Summary()

### Community 38 - "AI Naming Routes"
Cohesion: 0.20
Nodes (12): buildPrompt(), clip(), describeSample(), express, isValidName(), llm, { requireAuth }, router (+4 more)

### Community 39 - "Public API v1 Runs Routes"
Cohesion: 0.15
Nodes (11): apiWorker, express, { parseId, parseLimit, parseCursor, pageEnvelope, safeJson }, { resultsToCsv }, { resultsToXlsx }, router, RUN_STATUSES, runStore (+3 more)

### Community 40 - "DB Smoke Test"
Cohesion: 0.18
Nodes (12): assert(), customActions, db, fs, main(), os, path, { resolveCustomActions, resolveSubflows } (+4 more)

### Community 41 - "Runner Service (Child Processes)"
Cohesion: 0.19
Nodes (11): acquireRunSlot(), EventEmitter, fs, { generateCode }, MAX_CONCURRENT_RUNS, os, path, releaseRunSlot() (+3 more)

### Community 42 - "Webhook Dispatcher"
Cohesion: 0.23
Nodes (12): crypto, delay(), deliver(), dispatchChangeEvent(), dispatchRunEvent(), eventForStatus(), pushEvent(), RETRY_DELAYS_MS (+4 more)

### Community 43 - "HTML Inspector Panel"
Cohesion: 0.27
Nodes (9): buildTree(), cssPath(), flatten(), HtmlInspectorPanel(), nextId(), nodeMatches(), VOID_TAGS, xPath() (+1 more)

### Community 44 - "Frontend App Shell"
Cohesion: 0.27
Nodes (9): AppShell(), buildApiStepFromSource(), collectNavigateUrls(), deepResolveVars(), insertIndexAfter(), resolveVars(), stickyInsertIndex(), treeHasStepType() (+1 more)

### Community 45 - "API Key Auth & Service"
Cohesion: 0.24
Nodes (10): apiKeysRepo, crypto, { hashKey, looksLikeApiKey }, requestId(), requireApiKey(), crypto, generateKey(), hashKey() (+2 more)

### Community 46 - "API Rate Limiting"
Cohesion: 0.23
Nodes (10): sendApiError(), apiRateLimit(), buckets, limitPerMinute(), { sendApiError }, sweeper, { apiRateLimit }, express (+2 more)

### Community 47 - "API Discovery AI Enrichment"
Cohesion: 0.23
Nodes (8): buildUserPrompt(), enrich(), llm, llmJson, sanitize(), SYSTEM_PROMPT, titleCase(), toSnake()

### Community 48 - "Extract List AI"
Cohesion: 0.30
Nodes (11): buildUserPrompt(), cleanSelector(), guessAttributeFromContext(), llm, normaliseListName(), parseLlmJson(), proposeFields(), sanitiseName() (+3 more)

### Community 49 - "Healing Integration Tests"
Cohesion: 0.17
Nodes (9): assert, changedHtml, DISAPPEARED, FIELD_REPAIR, fs, healing, llm, path (+1 more)

### Community 50 - "Workflow Utils"
Cohesion: 0.32
Nodes (11): buildFlowTree(), CHILD_KEYS, clone(), collectCustomActionIds(), collectSubflowIds(), findStepById(), patchStepParams(), removeListField() (+3 more)

### Community 51 - "Proxies Menu UI"
Cohesion: 0.27
Nodes (8): decodeSpec(), emptyPoolDraft(), emptyProxyDraft(), encodeSpec(), headerFor(), PoolList(), ProxiesMenu(), strategyLabel()

### Community 52 - "CAPTCHA & Consent Scripts"
Cohesion: 0.18
Nodes (9): buildCodegenCaptchaHelper(), buildInjectedCaptchaScript(), { PROVIDER_CLIENT_SRC }, buildCodegenConsentHelper(), buildInjectedConsentScript(), getProxyLaunchArgs(), generateCode(), pruneRedundantLeadingNavigations() (+1 more)

### Community 54 - "Runs Routes & Export"
Cohesion: 0.22
Nodes (10): express, { requireAuth }, { resultsToCsv }, { resultsToXlsx }, router, runStore, safeJson(), serialize() (+2 more)

### Community 55 - "LLM Service"
Cohesion: 0.29
Nodes (9): llm, chat(), chatOnce(), DEFAULT_MODELS, getConfig(), getModels(), isConfigured(), isFallbackCode() (+1 more)

### Community 56 - "Error Classifier"
Cohesion: 0.22
Nodes (9): CAPTCHA_PATTERNS, classifyError(), CONN_PATTERNS, HTTP_PATTERNS, LLM_PATTERNS, matches(), SELECTOR_PATTERNS, summarise() (+1 more)

### Community 57 - "Network Capture (CDP)"
Cohesion: 0.29
Nodes (7): attach(), CAPTURED_TYPES, captures, count(), detach(), evictIfNeeded(), rememberExtra()

### Community 58 - "Webhooks Routes"
Cohesion: 0.20
Nodes (8): crypto, express, { parseId }, router, { sendApiError }, { serializeWebhook }, VALID_EVENTS, webhooksRepo

### Community 59 - "Healing Verify"
Cohesion: 0.24
Nodes (6): getBrowser(), inPageCount(), puppeteer, { resolveChromePath }, verifyContainerSelector(), withSnapshot()

### Community 60 - "Scheduler Service"
Cohesion: 0.27
Nodes (8): executionPipeline, inflight, { resolveCustomActions, resolveSubflows }, runOne(), runStore, safeJson(), start(), tick()

### Community 61 - "Workflow Test Harness"
Cohesion: 0.27
Nodes (8): applyStealthToPage(), evalOnElement(), evalOnElements(), puppeteer, resolveElement(), resolveElements(), run(), StealthPlugin

### Community 63 - "Proxy Pools Routes"
Cohesion: 0.25
Nodes (7): requireAdmin(), express, pools, { requireAuth, requireAdmin }, router, STRATEGIES, validate()

### Community 64 - "Auth Routes (Login/Register)"
Cohesion: 0.22
Nodes (7): signToken(), bcrypt, db, express, router, { signToken, requireAuth }, users

### Community 65 - "CAPTCHA Solver Service"
Cohesion: 0.39
Nodes (8): __captchaSolveToken, getConfig(), getProviderName(), isConfigured(), isSupportedType(), normalizeProvider(), solveToken(), SUPPORTED_TYPES

### Community 66 - "Workflow Variables UI"
Cohesion: 0.28
Nodes (5): CustomVarRow(), EMPTY_DRAFT, sanitiseName(), TYPES, WorkflowVariables()

### Community 68 - "Custom Actions Routes"
Cohesion: 0.25
Nodes (5): customActions, express, INPUT_TYPES, { requireAuth }, router

### Community 69 - "Proxies Routes"
Cohesion: 0.29
Nodes (6): express, PROTOCOLS, proxies, { requireAuth, requireAdmin }, router, validate()

### Community 70 - "Repair Service (LLM)"
Cohesion: 0.43
Nodes (7): buildUserPrompt(), llm, parseLlmJson(), proposePatch(), SYSTEM_PROMPT, truncate(), validatePatch()

### Community 71 - "XLSX Export Tests"
Cohesion: 0.36
Nodes (7): assert, ExcelJS, grid(), main(), readBack(), { resultsToXlsx }, test()

### Community 72 - "Excel (XLSX) Export"
Cohesion: 0.39
Nodes (7): autoWidth(), cell(), ExcelJS, fillSheet(), resultsToXlsx(), { unionHeaders, recordValue, isRecord, SCALAR_COLUMN }, uniqueSheetName()

### Community 73 - "Field Transforms Runtime"
Cohesion: 0.36
Nodes (7): __ftCleanValue(), __ftEffectiveColumns(), __ftHasPipeline(), __ftMaterializeRow(), __ftNamedGroups(), __ftSplitValue(), RUNTIME_SRC

### Community 74 - "DB Migration Runner"
Cohesion: 0.38
Nodes (6): ensureMigrationsTable(), fs, loadMigrations(), MIGRATIONS_DIR, path, run()

### Community 75 - "API Keys Routes"
Cohesion: 0.29
Nodes (5): apiKeysRepo, express, { generateKey }, { requireAuth }, router

### Community 76 - "API Serialization"
Cohesion: 0.43
Nodes (6): replayOrConflict(), safeJson(), serializeRun(), serializeWebhook(), serializeWorkflow(), serializeWorkflowSummary()

### Community 77 - "Custom Actions Menu"
Cohesion: 0.33
Nodes (4): customActionsApi, CustomActionsMenu(), emptyDraft(), INPUT_TYPES

### Community 78 - "Dashboard"
Cohesion: 0.38
Nodes (5): runsApi, Dashboard(), prettyUrl(), relTime(), STATUS_META

### Community 79 - "API Sources Panel"
Cohesion: 0.33
Nodes (3): AUTH_INFO, SourceCard(), verificationBadge()

### Community 80 - "Schedule Editor"
Cohesion: 0.57
Nodes (6): formatDate(), pad(), PRESETS, prettyMin(), ScheduleEditor(), tzLabel()

### Community 81 - "Change Monitor Service"
Cohesion: 0.33
Nodes (4): changeDiff, dataset, runStore, webhookDispatcher

### Community 82 - "Dependency Resolver"
Cohesion: 0.40
Nodes (5): { collectCustomActionIds, collectSubflowIds }, customActionsRepo, resolveSubflows(), safeJson(), workflowsRepo

### Community 83 - "Condition Builder"
Cohesion: 0.53
Nodes (4): ConditionBuilder(), OPERATORS, rightLiteral(), WPCtx

### Community 84 - "Healing Apply Helpers"
Cohesion: 0.50
Nodes (5): applyPatch(), buildHistorySamples(), compilesOk(), healAndApply(), truncate()

### Community 85 - "Workflow Executor"
Cohesion: 0.60
Nodes (4): executeWorkflow(), pipeline, safeJson(), serializeRun()

### Community 87 - "Proxy Resolver"
Cohesion: 0.50
Nodes (3): proxiesRepo, proxyPoolsRepo, resolveWorkflowProxy()

### Community 88 - "CI Pipeline & App Shell"
Cohesion: 0.50
Nodes (4): Frontend app shell (React/Vite root), Backend tests job, Frontend build job, CI Pipeline (GitHub Actions)

## Knowledge Gaps
- **471 isolated node(s):** `express`, `cors`, `path`, `fs`, `authRoutes` (+466 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `requestId()` connect `API Key Auth & Service` to `Workflow Sidebar & Editors`, `API Rate Limiting`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Why does `ExtractListFieldsEditor()` connect `Workflow Sidebar & Editors` to `Workflow Panel`, `API Key Auth & Service`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `react` connect `Workflow Panel` to `Workflow State (useWorkflow)`, `Frontend Dependencies`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **What connects `express`, `cors`, `path` to the rest of the system?**
  _471 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `In-Page Selector Tool` be split into smaller, more focused modules?**
  _Cohesion score 0.06229797237731413 - nodes in this community are weakly interconnected._
- **Should `Selector Generation Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.09324009324009325 - nodes in this community are weakly interconnected._
- **Should `Workflow Sidebar & Editors` be split into smaller, more focused modules?**
  _Cohesion score 0.057539682539682536 - nodes in this community are weakly interconnected._