# Command Center / AI-Dashboard Product Roadmap

**Repository:** `rickydeleon49-ui/Ai-Dashboard`  
**Roadmap version:** 1.1  
**Updated:** September 18, 2026  
**Status:** Planning document; Phase 2 hardening is completed and merged. A fresh-start readiness correction is in independent review as the final prerequisite before Phase 2C.

## 1. Product vision

Command Center is a project and work-management system that can operate in two distinct ways:

1. **Personal desktop application** — a private, local-first workspace with optional local AI, local files, GitHub access, notes, prompts, and automations.
2. **Hosted multi-user SaaS** — an account-based, workspace-scoped collaboration platform where every record, secret, job, file, and integration is isolated by tenant.

The long-term product combines project planning, team collaboration, knowledge management, GitHub activity, operational monitoring, and reviewed AI assistance in one workspace.

The desktop product should remain useful without an account or continuous internet connection. The hosted product must never fall back to shared desktop storage or desktop-only authentication behavior.

## 2. Product principles

All roadmap work should follow these rules:

- **Tenant isolation is a data invariant.** Workspace scoping belongs in repositories and transactions, not only in pages or route handlers.
- **Local-first remains a first-class mode.** Desktop use must not require a hosted account unless the user explicitly enables synchronization.
- **AI proposes; people approve.** Destructive or externally visible AI actions require an explicit review step.
- **Background work is durable.** Scheduled and asynchronous jobs must tolerate restarts, retries, multiple workers, and duplicate delivery.
- **Failures are recoverable.** Imports, migrations, uploads, billing events, and integrations must be resumable or safely repeatable.
- **Security fails closed.** Missing configuration must disable the affected feature rather than weaken authentication or expose secrets.
- **Features ship in small releases.** Every release should be independently testable, reversible where practical, and narrowly scoped.
- **Documentation is part of the feature.** User behavior, deployment requirements, recovery procedures, and known limitations ship with the code.

## 3. Current product status

### Completed

#### Phase 2, Release A — Milestones, Tasks, and Dependencies

- Project milestones and tasks
- One-level subtask user experience
- Task dependencies
- Blocked-status presentation
- Cross-project **My Work** view
- Initial accounts-mode workspace scoping

#### Phase 2, Release B — Project Knowledge Base

- Per-project documents
- Title, content, category, and pinned state
- Create, read, update, and delete behavior
- Search across title, content, and category
- Desktop and accounts-mode repository implementations

#### Supporting release work

- Reduced GitHub Actions usage
- Corrected failed-save UI state
- Corrected a task-board lint issue
- Added direct blocked-task completion protection
- Completed a full-route visual and browser audit
- Added the missing application favicon
- Added this roadmap document and corrected the Turbopack dev-mode bootstrap regression (PR #29)

#### Phase 2 hardening release — the gate before new feature implementation

Completed and merged as PR #30, the hardening baseline for everything after it. Delivered:

- Recursive task-blocking correctness
- Concurrency-safe dependency cycle prevention
- Transactional enforcement of one-level subtasks
- Workspace membership validation for task assignees
- Accounts-mode file-route isolation
- Upload rollback and orphan prevention
- Production magic-link protection
- Secure Electron request authentication
- Separation of accounts mode from shared SQLite state
- Resumable ownership claiming
- Safe workspace ownership and account deletion
- Enforced CI checks

An independent audit and the full verification matrix (typecheck, lint, unit, PostgreSQL, desktop-shell, end-to-end, build) passed before merge.

### In review — Release 2C.1: Workspace member directory

Implemented, in review on `phase2c/member-directory` (per §17 step 14). Delivered:
- Server-enforced soft removal (`status = 'removed'`), preserving task history and member attribution.
- Re-invitation and reactivation flow with composite row locks (`SELECT ... FOR UPDATE`), protecting original join dates.
- Reinstatement invariants: suspended members cannot be re-invited or self-rejoin via invitation; only admins/owners can reinstate.
- Database trigger protection preventing removal, demotion, or suspension of the last active owner across concurrent transactions.
- Member Directory API: `GET /api/workspaces/:id/members`, `PATCH /api/workspaces/:id/members/:userId`, `DELETE /api/workspaces/:id/members/:userId`.
- Full authorization matrix covering Owner, Admin, Member, Viewer, Suspended, Removed, Outsider, and Unauthenticated callers.
- Scoped admin capabilities: admins cannot modify/remove owners or other admins and cannot grant elevated roles.
- Member directory UI in Settings (accounts mode only) with debounced search, admin/owner status filters, role management, suspend/reinstate, and accessible removal confirmation dialog.
- Desktop single-user SQLite mode left untouched.

## 4. Release sequence at a glance

| Order | Release | Primary outcome | Depends on |
|---:|---|---|---|
| 1 | Phase 2 Hardening | Safe foundation for tasks, accounts, files, and deployment | Current `main` — **completed, PR #30** |
| — | Fresh-start readiness correction | First request against a new install never 500s | Hardening release — **merged to main** |
| 2 | Phase 2C — Team Collaboration | Members can coordinate work together | Release 2C.3 implemented, in review on `phase2c/checklists` |
| 3 | Phase 2D — Planning and Templates | Teams can plan time and repeat workflows | Stable task model |
| 4 | Phase 2E — Knowledge 2.0 | Knowledge becomes structured, searchable, and connected | Safe files and activity history |
| 5 | Phase 2F — Durable Automation | Reliable recurring and asynchronous work | Tenant-safe execution model |
| 6 | Phase 2G — Integrations, Monitoring, and Reviewed AI | External data and AI become operational tools | Durable jobs and secret isolation |
| 7 | Phase 3 — Hosted SaaS Parity | Every supported domain is genuinely tenant-safe | Phase 2 platform foundations |
| 8 | Phase 4 — Commercial SaaS | The product can onboard, bill, support, and retain customers | Hosted parity |
| 9 | Phase 5 — Scale and Enterprise Readiness | Larger organizations can govern and operate safely | Commercial baseline |

## 5. Phase 2 hardening — Release gate

**Status: completed and merged as PR #30.** Kept below as the record of what this gate required and delivered.

### Goal

Make the completed Phase 2 foundation safe under multi-user concurrency and safe to run in desktop, password-hosted, and accounts-hosted modes.

### Required outcomes

- Task dependency graphs remain acyclic under concurrent requests.
- Blocked state is correct across the complete reachable dependency graph.
- Completed tasks cannot silently conceal unfinished transitive blockers.
- Subtasks cannot form cycles or exceed the supported depth.
- Assignees must be active members of the task workspace.
- Accounts-mode requests cannot reach shared desktop file data.
- Failed uploads leave neither metadata nor blobs behind.
- Production sign-in tokens never enter application logs.
- Electron access uses a per-launch cryptographic credential rather than a broad environment-variable bypass.
- Accounts mode does not run or display shared SQLite scheduler and notification state.
- Ownership claims resume safely after partial failure.
- Account deletion cannot unexpectedly cascade-delete a shared workspace.
- Required CI checks cannot be bypassed when merging to `main`.

### Exit criteria

- All confirmed high-severity findings are resolved or explicitly accepted with documented compensating controls.
- SQLite and PostgreSQL implementations pass the same task-invariant test suite.
- Concurrency tests reproduce the former dependency race and prove the fix.
- Accounts-mode authorization tests cover owner, admin, member, outsider, unauthenticated user, and unknown resources.
- Desktop-shell, end-to-end, type-check, lint, unit, PostgreSQL, build, and migration checks pass.
- An independent read-only audit finds no release-blocking regression.

## 6. Phase 2C — Team Collaboration

### Product outcome

A workspace becomes a place where multiple people can assign, discuss, review, and track work without relying on another chat application.

### Release 2C.1 — Workspace member directory (implemented, in review on phase2c/member-directory)

#### Features

- Paginated workspace-member endpoint
- Member search by name and email
- Role display: owner, admin, member, and any future read-only role
- Active, invited, suspended, and removed membership states
- Safe user summary objects that do not expose private account fields
- Permission-aware member-management interface

#### Acceptance criteria

- A user can see only members of the active workspace.
- Removed and suspended users cannot be assigned new work.
- Non-admin members cannot change roles or membership state.
- Every member query is workspace-scoped at repository level.
- Responses never expose authentication providers, password data, tokens, or unrelated workspace membership.

### Release 2C.2 — Assignment experience (implemented, in review on phase2c/assignment)

#### Features

- Member-backed task assignee picker
- Unassigned filter
- **Assigned to me** and **Assigned by me** filters where applicable
- Multi-select assignment during bulk editing
- Clear presentation for removed or suspended historical assignees

#### Acceptance criteria

- The server independently validates every assignment.
- An outsider's user ID cannot be assigned through a direct API request.
- Removing a member does not corrupt task history.
- Assignment changes generate activity events.

### Release 2C.3 — Task checklists (implemented, in review on phase2c/checklists)

#### Features

- Ordered checklist items within a task
- Add, edit, reorder, complete, reopen, and delete actions
- Checklist progress on task cards and task details
- Optional conversion of a checklist item into a task
- Activity entries for meaningful checklist changes

#### Scope boundaries

- Checklist items do not have their own dependencies or assignees in this release.
- Converting an item must use the normal task invariants.

### Release 2C.4 — Comments, mentions, and activity history

#### Features

- Task comments
- Editing and soft deletion with visible history markers
- Workspace-member mentions
- Immutable activity events for assignments, status, dependencies, dates, milestones, and comments
- Per-task activity timeline
- Project-level recent activity view

#### Security requirements

- Comment and mention targets must belong to the workspace.
- Rendered user content must be sanitized.
- Edited and deleted content follows the product's retention policy.
- Activity records must not capture secrets, file contents, or authentication data.

### Release 2C.5 — Bulk editing

#### Features

- Multi-select tasks in project and My Work views
- Bulk status, priority, milestone, due date, label, and assignment changes
- Confirmation for destructive bulk operations
- Partial-failure reporting with retryable item details

#### Acceptance criteria

- Bulk operations reapply every single-task authorization and invariant.
- A partial failure never reports the entire operation as successful.
- Large selections use bounded batches and do not hold unbounded transactions.

### Release 2C.6 — Collaboration notifications

#### Features

- In-app notifications for assignment, mention, comment, and due-date events
- Per-category notification preferences
- Read, unread, archive, and mark-all-read actions
- Workspace-specific notification counts

#### Dependency

Email and scheduled notification delivery should wait for the durable job system in Phase 2F.

### Phase 2C exit criteria

- All collaboration records are tenant-scoped.
- Assignment, membership, and role transitions have authorization tests.
- Comments and activity have stored-XSS tests.
- Desktop behavior is defined for a single local user.
- Accounts mode passes multi-workspace isolation tests.
- Accessibility checks cover picker, checklist, comment, and bulk-action interactions.

## 7. Phase 2D — Planning and Templates

### Product outcome

Users can understand when work is happening, see scheduling conflicts, and create repeatable project structures.

### Release 2D.1 — Calendar

#### Features

- Month and week views
- Task due dates and milestone dates
- Workspace, project, assignee, and status filters
- Drag-to-reschedule with explicit save and error recovery
- Time-zone-aware display
- Unscheduled-work panel

### Release 2D.2 — Timeline

#### Features

- Project timeline with task and milestone date ranges
- Dependency lines
- Critical blocked-path highlighting
- Zoom levels and date-range navigation
- Read-only initial release, followed by safe drag editing

### Release 2D.3 — Reusable templates

#### Features

- Project templates
- Milestone and task templates
- Checklist and knowledge-document templates
- Relative dates such as "seven days after project start"
- Template preview before creation
- Personal templates for desktop and workspace templates for SaaS

#### Template safety

- Validate the resulting dependency graph before creation.
- Create the complete template atomically where the database permits.
- A failed template application must be safely retryable.
- Templates must not copy secrets, private integration identifiers, or inaccessible assignees.

### Phase 2D exit criteria

- Date calculations are tested across time zones and daylight-saving transitions.
- Calendar and timeline remain usable with large projects.
- Template application preserves all task invariants.
- Templates cannot reference another workspace's records.

## 8. Phase 2E — Knowledge 2.0

### Product outcome

Project knowledge becomes a structured workspace reference system rather than a flat collection of notes.

### Release 2E.1 — Safe Markdown

#### Features

- Markdown editing and preview
- Headings, lists, tables, links, code blocks, and task lists
- Consistent desktop and hosted rendering
- Plain-text extraction for search

#### Security requirements

- Raw HTML disabled by default.
- Links use an approved protocol allowlist.
- Rendered content is sanitized against stored XSS.
- Electron opens external links through a controlled boundary.

### Release 2E.2 — Folders and organization

#### Features

- Nested folders with a documented maximum depth
- Move and reorder documents
- Breadcrumb navigation
- Folder-level search filters
- Pinned and recently viewed documents

#### Invariants

- Folder cycles are impossible.
- Moves cannot cross workspaces.
- Deleting a folder requires an explicit policy for children.

### Release 2E.3 — Version history

#### Features

- Automatic immutable revisions
- Author and timestamp attribution
- Revision comparison
- Restore as a new revision
- Retention limits appropriate to the plan

### Release 2E.4 — Workspace-wide search

#### Features

- Search across all accessible project knowledge
- Filters for project, folder, category, author, and date
- Ranked snippets with highlighted matches
- Permission-safe indexing and result filtering

### Release 2E.5 — Connected knowledge

#### Features

- Link documents to projects, milestones, and tasks
- Backlinks from tasks and milestones
- Related-document suggestions
- Optional conversion between a comment or AI draft and a knowledge document

### Release 2E.6 — Attachments

#### Features

- Attach tenant-safe files to knowledge documents
- Upload progress, cancellation, preview, download, and deletion
- File-size and type policies
- Malware-scanning integration point for hosted deployments
- Storage quotas and retention behavior

#### Dependency

This release begins only after file storage is workspace-scoped and failed-write cleanup is verified.

### Phase 2E exit criteria

- Markdown security tests cover scripts, unsafe URLs, and malicious embedded content.
- Folder and document moves preserve tenant boundaries.
- Revision restoration never destroys the existing history.
- Search never leaks inaccessible documents through results, counts, snippets, or timing-sensitive shortcuts.
- Attachment deletion and retention are documented and tested.

## 9. Phase 2F — Durable Automation Platform

### Product outcome

Scheduled and asynchronous work continues reliably through restarts, transient failures, duplicate requests, and multiple hosted workers.

### Release 2F.1 — Job foundation

#### Features

- PostgreSQL-backed durable job records
- Scheduled, queued, running, succeeded, failed, cancelled, and dead-letter states
- Transactional job claiming
- Worker leases and abandoned-job recovery
- Bounded retries with exponential backoff and jitter
- Idempotency keys
- Per-job execution history
- Cancellation and manual retry
- Workspace-aware concurrency and rate limits

### Release 2F.2 — Worker operations

#### Features

- Separate web and worker process definitions
- Health and readiness endpoints
- Queue-depth, latency, retry, and failure metrics
- Structured logs without secrets
- Admin troubleshooting view
- Graceful shutdown and deploy behavior

### Release 2F.3 — Recurring tasks

#### Features

- Daily, weekly, monthly, and selected-day schedules
- Time-zone selection
- Clear behavior for missed occurrences
- Pause, resume, edit, and end recurrence
- Duplicate-occurrence prevention
- History linking generated tasks to their recurrence definition

### Release 2F.4 — Scheduled delivery

#### Features

- Email notifications
- Due-date reminders
- Digest notifications
- Scheduled GitHub synchronization
- Scheduled AI-summary generation

### Phase 2F exit criteria

- Killing a worker during execution does not lose a job.
- Duplicate delivery does not duplicate the business action.
- Two workers cannot both own the same execution lease.
- Retry behavior is bounded and observable.
- Jobs stop when a workspace loses entitlement or an integration is disconnected.
- Railway or another hosted platform runs the web and worker processes independently.

## 10. Phase 2G — Integrations, Monitoring, and Reviewed AI

### Product outcome

Command Center connects planning work to real development and operational signals while keeping people in control of AI actions.

### Release 2G.1 — GitHub project client

#### Features

- Repository selection per project
- Issues, pull requests, releases, workflows, and deployment summaries
- Link GitHub items to tasks and milestones
- Create a local task from an issue or pull request
- Controlled one-way synchronization before bidirectional synchronization
- Webhook ingestion with signature verification and duplicate-event handling

### Release 2G.2 — Deployment and uptime monitoring

#### Features

- Deployment records by project and environment
- Health-check endpoints and expected response rules
- Uptime history and incident timeline
- Failure and recovery notifications
- Manual maintenance windows
- Provider adapters beginning with the chosen hosting platform

#### Safety requirements

- SSRF-resistant destination validation
- Private-network and metadata-endpoint blocking
- DNS rebinding defenses
- Strict timeouts, response-size limits, and redirect policies

### Release 2G.3 — Reviewed AI summaries

#### Features

- Project, milestone, and workspace summaries
- Blocker and overdue-work summaries
- Release-note drafts
- Suggested task updates
- Source citations linking every important statement to workspace records
- Draft, reviewed, approved, rejected, and applied states

### Release 2G.4 — AI action center

#### Features

- Central review queue for AI-proposed changes
- Field-level change previews
- Approve, edit, reject, and bulk-review actions
- Expiring approvals
- Immutable audit trail of proposer, reviewer, and applied result
- Provider and cost controls by workspace

### Phase 2G exit criteria

- GitHub credentials are encrypted and isolated per workspace.
- Webhooks are verified and idempotent.
- Monitoring cannot access internal or metadata networks.
- AI cannot bypass normal repository authorization or task invariants.
- Every externally visible or destructive AI action requires approval.
- Usage and cost limits are enforced server-side.

## 11. Phase 3 — Hosted SaaS Parity

### Product outcome

Every feature shown in accounts mode is backed by tenant-isolated data, secrets, jobs, storage, authorization, and billing rules.

### Release 3A — Tenant-safe files and uploads

- PostgreSQL file metadata scoped to workspace and project
- Workspace-specific storage prefixes or buckets
- Signed, short-lived upload and download operations where applicable
- Quotas and usage accounting
- Retention and deletion jobs
- Malware-scanning hook
- Export support

### Release 3B — Tenant-safe notes

- Workspace and personal notes
- Explicit visibility model
- Search and tagging
- Version history where appropriate
- Conversion between notes, tasks, and knowledge documents

### Release 3C — Tenant-safe prompts and AI workspace

- Personal and workspace prompt libraries
- Role-based prompt sharing
- Workspace-specific provider configuration
- Usage limits and cost attribution
- Conversation retention controls
- Export and deletion behavior
- Protection from cross-workspace retrieval context

### Release 3D — Tenant-safe automations

- Workspace-owned automation definitions
- Durable hosted execution
- Workspace-specific secrets and connections
- Role-based create, edit, run, and disable permissions
- Idempotent execution and complete run history
- Per-plan quotas

### Release 3E — Tenant-safe GitHub integration

- Prefer GitHub App installations for hosted accounts
- Workspace installation ownership
- Repository allowlists
- Minimum required permissions
- Installation suspension and revocation handling
- Webhook lifecycle and replay protection
- Audit trail for synchronized or created records

### Release 3F — SaaS data lifecycle

- Workspace export
- Account export
- Account deletion with safe ownership transfer
- Workspace deletion with delay and recovery window
- Backup and restore procedures
- Retention policies
- Privacy documentation
- Tenant-safe support tooling

### Phase 3 exit criteria

- Unsupported desktop domains are no longer exposed as if they worked in accounts mode.
- Automated isolation tests cover every repository and API domain.
- Secrets, files, jobs, exports, search, and logs are tenant-safe.
- Backup restoration is tested, not merely documented.
- Account and workspace deletion preserve or transfer ownership according to policy.
- Hosted mode can run without initializing desktop SQLite services.

## 12. Phase 4 — Commercial SaaS

### Product outcome

The hosted product can onboard customers, enforce plans, collect payment, manage usage, and support users safely.

### Release 4A — Onboarding and invitations

- New-workspace onboarding
- Email invitations
- Invitation expiration and revocation
- Join, decline, and existing-account flows
- Initial project and template selection
- Product tour and setup checklist

### Release 4B — Plans and entitlements

- Free, paid, and internal/admin plans
- Central entitlement service
- Feature flags tied to server-side entitlements
- Seat, storage, AI, automation, and integration limits
- Grace periods and downgrade behavior
- Clear upgrade and limit-reached experiences

### Release 4C — Billing

- Checkout and customer portal
- Subscription lifecycle
- Verified webhook signatures
- Idempotent event processing
- Out-of-order event handling
- Invoice and payment status
- Failed-payment recovery
- Cancellation and reactivation

### Release 4D — Product operations

- Internal support console with least-privilege access
- Safe workspace lookup
- Redacted diagnostics
- Time-limited support access with audit logs
- Feature rollout controls
- Incident banners and service status communication

### Release 4E — Customer-facing trust

- Terms and privacy pages
- Data retention and deletion documentation
- Security overview
- Subprocessor list
- Status page
- Support and incident-response process

### Phase 4 exit criteria

- Entitlements cannot be bypassed through direct API calls.
- Billing webhooks are verified, idempotent, and tested out of order.
- Downgrades preserve data and clearly restrict future actions.
- Support access is audited and cannot reveal secrets.
- Restore, incident, and customer-notification procedures have been exercised.

## 13. Phase 5 — Scale and Enterprise Readiness

### Product outcome

Larger organizations can adopt the product with stronger identity, governance, reliability, and administrative controls.

### Candidate releases

- SAML or OIDC single sign-on
- Domain verification
- SCIM provisioning
- Custom roles and granular permissions
- Workspace groups and teams
- Enterprise audit-log export
- Data-region strategy
- Legal hold and configurable retention
- Advanced rate limiting and abuse protection
- Read replicas and search infrastructure when justified by measured load
- Multi-region recovery strategy
- Service-level objectives and public reliability reporting

These features should not be built prematurely. Each should be justified by customer demand, compliance requirements, or measured scale.

## 14. Cross-cutting engineering tracks

These are continuous responsibilities, not standalone phases.

### Security

- Threat-model every new external integration.
- Test cross-workspace access for every accounts-mode domain.
- Prevent token and secret exposure in logs, responses, exports, builds, and crash reports.
- Review CSRF, XSS, SSRF, redirects, path handling, uploads, and Electron IPC boundaries.
- Keep dependency advisories triaged with documented risk decisions.

### Data and migrations

- Use additive migrations before destructive cleanup.
- Include upgrade tests using representative existing databases.
- Define rollback or forward-recovery procedures.
- Back up before irreversible production migrations.
- Avoid application deployments that require an unsafe all-at-once schema transition.

### Testing

- Shared contract tests for SQLite and PostgreSQL repositories
- Accounts-mode role and isolation matrix
- Real PostgreSQL concurrency tests
- Browser end-to-end coverage for critical workflows
- Electron-shell security and offline tests
- Billing, webhook, job, and migration fault-injection tests
- Accessibility and responsive-layout checks

### Observability

- Structured redacted logs
- Request and job correlation identifiers
- Error monitoring
- Queue, database, storage, authentication, billing, and AI-usage metrics
- Actionable alerts with runbooks
- Privacy-aware product analytics

### Documentation

- Desktop installation and update guide
- Hosted deployment guide
- Environment-variable reference without secret values
- Backup and restore runbook
- Worker and scheduler operations
- Authentication-mode behavior
- Feature availability by mode
- Incident and release procedures

### Performance and scale

- Pagination for all potentially unbounded lists
- Indexed tenant-scoped queries
- Bounded uploads and AI context construction
- Background processing for expensive operations
- Load testing driven by realistic usage profiles
- Capacity thresholds that trigger architectural changes

## 15. Deployment model

### Electron desktop

The desktop application packages the user interface and runs its local service on loopback. SQLite and local file storage remain the default. Internet-dependent integrations should degrade cleanly when offline.

The desktop build does not require Railway.

### Hosted SaaS

Railway is a reasonable initial hosting platform, but it is not a permanent product requirement. The hosted architecture should remain portable.

A production deployment will generally require:

- Web application service
- PostgreSQL database
- Durable worker service once Phase 2F begins
- Persistent object storage for tenant files
- Transactional email provider
- Error monitoring and metrics
- Backup storage and tested restoration
- Optional Redis only when a measured requirement justifies it

Local container or ephemeral filesystem storage must not be treated as durable SaaS file storage.

## 16. Feature availability strategy

Every feature should have an explicit availability status for each mode:

| Status | Meaning |
|---|---|
| Supported | Fully implemented, tested, and documented for that mode |
| Preview | Available with a visible limitation and migration path |
| Hidden | Not rendered and not reachable through the API |
| Desktop only | Uses local resources and is intentionally unavailable in SaaS |
| Hosted only | Depends on accounts, team membership, or hosted infrastructure |

The product must not display desktop-backed features in accounts mode unless they have true tenant isolation.

## 17. Release process

Every small release should follow this sequence:

1. Write the user outcome and non-goals.
2. Document data ownership and authorization rules.
3. Define database and API contracts.
4. Define failure, retry, and migration behavior.
5. Implement repository and service invariants.
6. Add API and UI behavior.
7. Run the complete relevant verification matrix.
8. Perform a read-only security and release audit.
9. Resolve release blockers.
10. Merge only through required CI checks.
11. Deploy to a non-production environment.
12. Run smoke tests and verify rollback readiness.
13. Roll out gradually and monitor.
14. Update the roadmap and documentation with what actually shipped.

## 18. Prioritization rules

When deciding whether to move or split a release, use this order:

1. Security and tenant isolation
2. Data integrity and recoverability
3. Reliability of existing features
4. Foundations needed by multiple future features
5. High-frequency user workflows
6. Integrations and automation
7. Convenience and visual refinement

No roadmap date should override a failed security, migration, backup, or data-isolation gate.

## 19. Immediate next actions

### Before Phase 2C starts

- Complete independent review of the fresh-start readiness correction on `fix/fresh-start-readiness` and merge it to `main`.
- Define the exact role and membership lifecycle for Phase 2C.
- Draft collaboration user flows and wireframes.
- Decide comment retention and deletion behavior.
- Decide whether task activity is immutable or supports administrative redaction.
- Define desktop behavior for collaboration features that normally involve multiple users.

### Once the fresh-start readiness correction is merged

1. Confirm branch protection and required checks still pass on the updated `main`.
2. Create a fresh Phase 2C branch from that `main`.
3. Begin with the workspace-member endpoint and authorization contract (Release 2C.1, §6).

## 20. Decisions still required

- Is desktop collaboration strictly single-user, or will local network/team synchronization eventually exist?
- Which workspace roles are required beyond owner, admin, and member?
- Should comments be editable forever, editable for a limited period, or immutable with corrections?
- What are the document and activity retention policies?
- Which file-storage provider will be used for hosted accounts?
- Which transactional email provider will be used?
- Will hosted GitHub access use a GitHub App exclusively?
- Which AI providers and billing model will be supported in SaaS?
- What usage limits belong to the free and paid plans?
- Is Railway the initial production host, or only a staging environment?

These decisions should be made before the release that depends on them, not all at once.

## 21. Definition of roadmap completion

The roadmap is complete when Command Center can:

- Run privately as a dependable desktop application.
- Operate as a genuinely tenant-isolated hosted SaaS.
- Support teams through planning, collaboration, knowledge, and integrations.
- Execute recurring and asynchronous work durably.
- Use AI through transparent, reviewable, and cost-controlled workflows.
- Onboard, bill, support, export, and delete customer data safely.
- Recover from deploy, worker, database, storage, and integration failures using tested procedures.

The roadmap is directional rather than permanent. Each completed release should produce evidence that determines whether the next release remains the best investment.
