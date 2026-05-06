/**
 * v0.7.35.1 FEATURE_142 (B-R1) — compaction prompt eval fixtures.
 *
 * 10 synthetic conversation transcripts: 5 coding domain + 5 non-coding
 * domain (data-analysis / customer-support / SRE / docs / ML-experiments).
 *
 * Each fixture carries `keyFacts` — strings that MUST survive the
 * compaction summary. The eval scores a candidate prompt by what fraction
 * of its summary contains each key fact (substring match, case-sensitive
 * for identifiers, case-insensitive for prose).
 *
 * The transcripts are intentionally short (~6-10 messages) so the
 * compaction LLM call stays within sub-second latency on flagship models;
 * eval cost stays cheap (10 fixtures × 3 prompts × 3 models ≈ 90 cells,
 * each ~2K tokens).
 *
 * Domain mix is intentional: a neutral prompt that scores well on
 * coding fixtures but degrades on non-coding fixtures has not actually
 * neutralized — it's just rewording. The eval gates on cross-domain
 * recall consistency.
 */

import type { KodaXMessage } from '@kodax/ai';

export type FactMatchMode = 'substring' | 'substring-ci';

export interface KeyFact {
  /** The string that must appear in the summary (substring match). */
  readonly text: string;
  /** Case-sensitive substring (for identifiers) or case-insensitive (for prose). */
  readonly mode: FactMatchMode;
  /** Optional category tag for diagnostic reporting. */
  readonly tag?: 'identifier' | 'error' | 'config' | 'decision' | 'request' | 'state';
}

export type FixtureDomain = 'coding' | 'data-analysis' | 'customer-support' | 'sre' | 'docs' | 'ml-experiments';

export interface CompactionFixture {
  readonly id: string;
  readonly domain: FixtureDomain;
  readonly description: string;
  readonly transcript: readonly KodaXMessage[];
  /** Facts the summary must preserve. Failing any one drops recall score. */
  readonly keyFacts: readonly KeyFact[];
}

const u = (text: string): KodaXMessage => ({ role: 'user', content: text });
const a = (text: string): KodaXMessage => ({ role: 'assistant', content: text });

// ============================================================================
// CODING fixtures
// ============================================================================

const fixtureCodingDebug401: CompactionFixture = {
  id: 'coding-debug-401',
  domain: 'coding',
  description: 'Debug a 401 auth error in an Express + JWT API',
  transcript: [
    u('the /api/auth/login endpoint returns 401 even for valid users. fix it'),
    a('I will read the auth middleware to find where 401 is thrown.'),
    a('Found it: src/middleware/auth.ts:42 throws when req.headers.authorization is empty. The login route at src/routes/auth.ts:18 sends the JWT in the response body but does not set the Authorization header on subsequent requests because the client uses fetch without credentials.'),
    u('use httpOnly cookie instead of Authorization header'),
    a('Switching to httpOnly cookie strategy. Will set cookie on POST /api/auth/login at src/routes/auth.ts and update src/middleware/auth.ts to read req.cookies.session instead of req.headers.authorization. cookie-parser middleware needs to be added to src/app.ts.'),
    a('Edited src/app.ts to add cookieParser(). Edited src/middleware/auth.ts:42 to read from req.cookies.session. Edited src/routes/auth.ts:18 to set res.cookie("session", token, {httpOnly: true, secure: true, sameSite: "lax"}).'),
    u('does it work with the existing tests?'),
    a('tests/auth.test.ts assumes Authorization header — needs update too. Will modify the integration test to use the cookie instead.'),
  ],
  keyFacts: [
    { text: '/api/auth/login', mode: 'substring', tag: 'identifier' },
    { text: '401', mode: 'substring', tag: 'error' },
    { text: 'src/middleware/auth.ts', mode: 'substring', tag: 'identifier' },
    { text: 'src/routes/auth.ts', mode: 'substring', tag: 'identifier' },
    { text: 'src/app.ts', mode: 'substring', tag: 'identifier' },
    { text: 'tests/auth.test.ts', mode: 'substring', tag: 'identifier' },
    { text: 'httpOnly', mode: 'substring-ci', tag: 'decision' },
    { text: 'cookie', mode: 'substring-ci', tag: 'decision' },
    { text: 'cookie-parser', mode: 'substring-ci', tag: 'config' },
  ],
};

const fixtureCodingRefactor: CompactionFixture = {
  id: 'coding-refactor-multi-file',
  domain: 'coding',
  description: 'Cross-module refactor renaming a function across 4 files',
  transcript: [
    u('rename `parseConfig` to `loadConfig` everywhere; the new name reflects what it actually does (it reads from disk, not just parses)'),
    a('grep finds 4 files: src/config/loader.ts (the definition), src/server.ts (call), src/cli/main.ts (call), tests/config.test.ts (calls + spy).'),
    a('Renamed in src/config/loader.ts:12 (export). Updated import in src/server.ts:7. Updated import in src/cli/main.ts:9. Updated tests/config.test.ts:3 import + 5 call sites + the vi.spyOn line.'),
    u('also rename the file `loader.ts` to `loader.ts` … no wait, keep the file name. but rename the test file to match.'),
    a('Got it. Skipping file rename for src/config/loader.ts. Renaming tests/config.test.ts to tests/load-config.test.ts. Updated jest config? — actually project uses vitest, no path config needed.'),
    a('All references migrated. Running npm test now.'),
    u('any issues?'),
    a('1 test failure: tests/load-config.test.ts:42 — "loadConfig handles missing file" — the error message changed because loadConfig now wraps the FS error with "config load failed: ...". Will update the test expectation.'),
  ],
  keyFacts: [
    { text: 'parseConfig', mode: 'substring', tag: 'identifier' },
    { text: 'loadConfig', mode: 'substring', tag: 'identifier' },
    { text: 'src/config/loader.ts', mode: 'substring', tag: 'identifier' },
    { text: 'src/server.ts', mode: 'substring', tag: 'identifier' },
    { text: 'src/cli/main.ts', mode: 'substring', tag: 'identifier' },
    { text: 'tests/load-config.test.ts', mode: 'substring', tag: 'identifier' },
    { text: 'config load failed', mode: 'substring-ci', tag: 'error' },
    { text: 'vitest', mode: 'substring-ci', tag: 'config' },
  ],
};

const fixtureCodingBashDebug: CompactionFixture = {
  id: 'coding-bash-debug',
  domain: 'coding',
  description: 'Debug a flaky CI test using bash + log inspection',
  transcript: [
    u('CI keeps failing on tests/integration/queue.test.ts. local passes. find why'),
    a('Read .github/workflows/ci.yml — runs `npm test -- --runInBand --testTimeout=10000`. Will inspect the queue test file.'),
    a('tests/integration/queue.test.ts:67 spawns a child process that listens on port 6379 (Redis). The test assumes localhost:6379 is free. CI workflow does not start a Redis service, so the test should fail there too — but you say it does fail there. Let me re-read.'),
    a('Wait — local has Redis already running on 6379 (homebrew service). CI does not. The test says "skipped" locally only because the connect() throws ECONNREFUSED quickly. On CI, the spawn does not throw fast enough, hits the 10000ms timeout, fails.'),
    u('add redis-server service to ci workflow'),
    a('Edited .github/workflows/ci.yml — added a redis service container with image redis:7-alpine on port 6379. Tests should now consistently connect.'),
  ],
  keyFacts: [
    { text: 'tests/integration/queue.test.ts', mode: 'substring', tag: 'identifier' },
    { text: '.github/workflows/ci.yml', mode: 'substring', tag: 'identifier' },
    { text: '6379', mode: 'substring', tag: 'config' },
    { text: 'ECONNREFUSED', mode: 'substring', tag: 'error' },
    { text: 'redis:7-alpine', mode: 'substring-ci', tag: 'config' },
    { text: '10000', mode: 'substring', tag: 'config' },
    { text: 'redis service', mode: 'substring-ci', tag: 'decision' },
  ],
};

const fixtureCodingDeps: CompactionFixture = {
  id: 'coding-dep-upgrade',
  domain: 'coding',
  description: 'Resolve a CVE by upgrading a transitive dependency',
  transcript: [
    u('npm audit shows CVE-2024-45337 in `golang.org/x/crypto`. wait, that is the wrong ecosystem. let me restart: CVE-2024-21538 in `cross-spawn@7.0.3`. fix.'),
    a('cross-spawn@7.0.3 is pulled in transitively by 12 of our dependencies (per npm ls cross-spawn). The fix is in cross-spawn@7.0.5 (per the GitHub Security Advisory).'),
    a('Adding "cross-spawn": "^7.0.5" to package.json overrides field. Running npm install. Verifying with npm ls cross-spawn that all paths now resolve to 7.0.5.'),
    u('verify with npm audit before commit'),
    a('npm audit reports 0 vulnerabilities after the override. Committing as: "chore(deps): bump transitive cross-spawn to ^7.0.5 to address CVE-2024-21538".'),
  ],
  keyFacts: [
    { text: 'CVE-2024-21538', mode: 'substring', tag: 'identifier' },
    { text: 'cross-spawn', mode: 'substring', tag: 'identifier' },
    { text: '7.0.5', mode: 'substring', tag: 'config' },
    { text: '7.0.3', mode: 'substring', tag: 'config' },
    { text: 'overrides', mode: 'substring-ci', tag: 'decision' },
    { text: 'package.json', mode: 'substring', tag: 'identifier' },
  ],
};

const fixtureCodingMerge: CompactionFixture = {
  id: 'coding-merge-conflict',
  domain: 'coding',
  description: 'Resolve a merge conflict in a TS interface',
  transcript: [
    u('main has a conflict on src/types/user.ts. resolve it preserving both intents (mine: add `phoneNumber: string` field; theirs: add `email: string` to required fields)'),
    a('Read both sides. Mine added phoneNumber as optional. Theirs moved email from optional to required. Both can coexist — final shape: required email + name + id; optional phoneNumber + avatarUrl.'),
    a('Edited src/types/user.ts to merge both changes. Also updated src/db/migrations/2024-01-15-user-phone.sql to make sure the DB column is nullable, matching the TS optional field.'),
    u('run the type-check'),
    a('npm run typecheck — 2 errors in src/api/users.controller.ts:88 because the existing code passes user without email field in 3 test fixtures. Need to either fix the fixtures or revert the email-required change. User intent says required, so fixing fixtures: tests/fixtures/users.json updated 3 entries.'),
  ],
  keyFacts: [
    { text: 'src/types/user.ts', mode: 'substring', tag: 'identifier' },
    { text: 'phoneNumber', mode: 'substring', tag: 'identifier' },
    { text: 'email', mode: 'substring', tag: 'identifier' },
    { text: 'src/db/migrations/2024-01-15-user-phone.sql', mode: 'substring', tag: 'identifier' },
    { text: 'src/api/users.controller.ts', mode: 'substring', tag: 'identifier' },
    { text: 'tests/fixtures/users.json', mode: 'substring', tag: 'identifier' },
    { text: 'required', mode: 'substring-ci', tag: 'decision' },
  ],
};

// ============================================================================
// NON-CODING fixtures
// ============================================================================

const fixtureDataAnalysis: CompactionFixture = {
  id: 'data-analysis-cohort',
  domain: 'data-analysis',
  description: 'Cohort analysis on user retention with SQL + pandas',
  transcript: [
    u('compute 30-day retention for users who signed up in 2024-Q1, segmented by acquisition_channel'),
    a('Read schema. Tables: users (signup_date, acquisition_channel), events (user_id, event_date, event_name). Pulling: signups in 2024-Q1, then events where event_name="active" within 30 days of signup_date.'),
    a('Query result: 14,221 signups in Q1. 30-day retention by channel: organic 42.3% (n=5,103), paid_search 28.7% (n=4,488), referral 51.9% (n=2,890), social 19.4% (n=1,740).'),
    u('the social number looks low. is it sample size or real?'),
    a('Bootstrap 95% CI on the 19.4% social cohort: [16.8%, 22.1%]. Statistically significantly below organic and paid_search. Real, not sampling noise.'),
    u('share with the growth team — flag the social channel issue'),
    a('Wrote analysis to notebooks/q1-retention-by-channel.ipynb. Sent slack message to #growth with the breakdown + flag on social channel underperformance.'),
  ],
  keyFacts: [
    { text: '2024-Q1', mode: 'substring', tag: 'config' },
    { text: 'acquisition_channel', mode: 'substring', tag: 'identifier' },
    { text: 'signup_date', mode: 'substring', tag: 'identifier' },
    { text: '14,221', mode: 'substring', tag: 'state' },
    { text: '19.4%', mode: 'substring', tag: 'state' },
    { text: '42.3%', mode: 'substring', tag: 'state' },
    { text: 'notebooks/q1-retention-by-channel.ipynb', mode: 'substring', tag: 'identifier' },
    { text: 'social', mode: 'substring-ci', tag: 'decision' },
    { text: '#growth', mode: 'substring', tag: 'identifier' },
  ],
};

const fixtureCustomerSupport: CompactionFixture = {
  id: 'customer-support-refund',
  domain: 'customer-support',
  description: 'Process a refund + escalate billing issue',
  transcript: [
    u('ticket #48217: customer charged twice for order ORD-2025-19834 ($89.99 each). they want a refund and a guarantee it will not happen again'),
    a('Looked up customer record (cust_id: 7129abf8). Order ORD-2025-19834 dated 2025-04-12. Stripe shows two charges: ch_3PqA12 and ch_3PqA1Y, both $89.99, ~3 seconds apart.'),
    a('Likely a double-click bug on the Pay button. Refunding ch_3PqA1Y (the second charge) — keeping ch_3PqA12 as the legitimate one. Filed escalation to engineering as ENG-3812 to add idempotency key on POST /checkout.'),
    u('what should I tell the customer about the timeline?'),
    a('Refund clears Stripe in 5-10 business days, will land back on their card by 2025-04-25 latest. Engineering ticket ENG-3812 is on the next sprint, no commitment on customer-side ETA. Recommended response: "refund issued today, expect it within 5-10 business days; engineering investigating to prevent recurrence."'),
    u('apply that refund and send the response'),
    a('Refunded ch_3PqA1Y for $89.99. Sent message to customer through Zendesk with the templated response. Ticket #48217 status: "awaiting customer confirmation".'),
  ],
  keyFacts: [
    { text: '#48217', mode: 'substring', tag: 'identifier' },
    { text: 'ORD-2025-19834', mode: 'substring', tag: 'identifier' },
    { text: '$89.99', mode: 'substring', tag: 'state' },
    { text: 'cust_id: 7129abf8', mode: 'substring', tag: 'identifier' },
    { text: 'ch_3PqA1Y', mode: 'substring', tag: 'identifier' },
    { text: 'ch_3PqA12', mode: 'substring', tag: 'identifier' },
    { text: 'ENG-3812', mode: 'substring', tag: 'identifier' },
    { text: 'idempotency key', mode: 'substring-ci', tag: 'decision' },
    { text: '5-10 business days', mode: 'substring-ci', tag: 'state' },
  ],
};

const fixtureSRE: CompactionFixture = {
  id: 'sre-incident-triage',
  domain: 'sre',
  description: 'Triage a P1 latency spike on the API gateway',
  transcript: [
    u('PagerDuty: P1 — api-gateway p99 latency jumped from 80ms to 2.3s starting 2025-05-06 14:32 UTC. investigate'),
    a('Pulled metrics from grafana.internal/d/api-latency. Spike is on the /v2/orders endpoint specifically. Other endpoints normal.'),
    a('Looked at recent deploys. release-2025-05-06.1 went out at 14:28 UTC — 4 minutes before the spike. Diff: PR #4421 added a new authorization check that calls the user-service.'),
    a('Checked user-service: its p99 latency also climbed at 14:28 from 12ms to 1.8s. The new auth check on every /v2/orders request is hitting user-service N times per gateway request, where it used to be 0.'),
    u('roll back release-2025-05-06.1?'),
    a('Yes — initiating rollback to release-2025-05-05.7. ETA 4 minutes for the rollout. Will monitor api-gateway p99 returning to baseline.'),
    a('Rollback complete at 14:51 UTC. p99 back to 78ms within 90 seconds. Filed incident report INC-2025-0506-A; root cause: PR #4421 made user-service call synchronous and per-request without caching.'),
  ],
  keyFacts: [
    { text: 'api-gateway', mode: 'substring-ci', tag: 'identifier' },
    { text: '/v2/orders', mode: 'substring', tag: 'identifier' },
    { text: 'release-2025-05-06.1', mode: 'substring', tag: 'identifier' },
    { text: 'release-2025-05-05.7', mode: 'substring', tag: 'identifier' },
    { text: 'PR #4421', mode: 'substring', tag: 'identifier' },
    { text: 'user-service', mode: 'substring', tag: 'identifier' },
    { text: 'INC-2025-0506-A', mode: 'substring', tag: 'identifier' },
    { text: '2.3s', mode: 'substring', tag: 'state' },
    { text: '80ms', mode: 'substring', tag: 'state' },
    { text: 'rollback', mode: 'substring-ci', tag: 'decision' },
  ],
};

const fixtureDocs: CompactionFixture = {
  id: 'docs-style-revision',
  domain: 'docs',
  description: 'Revise a public-facing migration guide',
  transcript: [
    u('rewrite the v3 migration guide. current draft is too verbose. target: 2-page max, focus on breaking changes and the upgrade path. file: docs/migrate-v3.md'),
    a('Read docs/migrate-v3.md (current 7 pages). Breaking changes per CHANGELOG.md: (1) `setup()` removed, replaced with `init()` taking config object; (2) sync API removed — all calls now async; (3) error type renamed `ConfigError` → `InitError` with new fields.'),
    a('Drafted the rewrite. Structure: "What changed" (1 page) → "How to migrate" (1 page with code-equivalent before/after for each breaking change). Cut the philosophy section. Cut the FAQ. Cut the "Why we did this" sidebar.'),
    u('keep the FAQ section — users need it. drop the philosophy and the why sidebar.'),
    a('Adjusted: kept FAQ (4 Q&As), dropped philosophy + why sidebar. Now 2 pages even with FAQ. Saved to docs/migrate-v3.md. Cross-referenced from docs/index.md and docs/CHANGELOG.md.'),
  ],
  keyFacts: [
    { text: 'docs/migrate-v3.md', mode: 'substring', tag: 'identifier' },
    { text: 'docs/index.md', mode: 'substring', tag: 'identifier' },
    { text: 'CHANGELOG.md', mode: 'substring', tag: 'identifier' },
    { text: 'setup()', mode: 'substring', tag: 'identifier' },
    { text: 'init()', mode: 'substring', tag: 'identifier' },
    { text: 'ConfigError', mode: 'substring', tag: 'identifier' },
    { text: 'InitError', mode: 'substring', tag: 'identifier' },
    { text: 'FAQ', mode: 'substring-ci', tag: 'decision' },
    { text: '2-page', mode: 'substring-ci', tag: 'request' },
  ],
};

const fixtureMLExperiments: CompactionFixture = {
  id: 'ml-experiments-tuning',
  domain: 'ml-experiments',
  description: 'Hyperparameter sweep for a recommendation model',
  transcript: [
    u('run a sweep on lr ∈ {1e-4, 3e-4, 1e-3} × dropout ∈ {0.1, 0.2, 0.3} for the rec_v3 model. 5-fold CV, optimize NDCG@10. dataset: amazon-reviews-2024-q4.parquet'),
    a('Started sweep on cluster: 9 configs × 5 folds = 45 jobs. Tracking via wandb run group "rec-v3-sweep-20250506". ETA ~2.5 hours per fold (parallel × 5 folds).'),
    a('Sweep complete. Best config: lr=3e-4, dropout=0.2, NDCG@10=0.412 ± 0.008. Worst: lr=1e-3 dropout=0.1 (NDCG@10=0.358). Best beats current production (lr=1e-4, dropout=0.2, NDCG@10=0.394) by 1.8 absolute points.'),
    u('promote the best config to staging'),
    a('Updated configs/rec_v3_staging.yaml with lr=3e-4, dropout=0.2. Started deploy via Argo workflow rec-deploy-2025-05-06. Will monitor staging NDCG@10 over the next 48h before recommending production rollout.'),
  ],
  keyFacts: [
    { text: 'rec_v3', mode: 'substring', tag: 'identifier' },
    { text: 'amazon-reviews-2024-q4.parquet', mode: 'substring', tag: 'identifier' },
    { text: 'NDCG@10', mode: 'substring', tag: 'identifier' },
    { text: '3e-4', mode: 'substring', tag: 'config' },
    { text: '0.2', mode: 'substring', tag: 'config' },
    { text: '0.412', mode: 'substring', tag: 'state' },
    { text: '0.394', mode: 'substring', tag: 'state' },
    { text: 'configs/rec_v3_staging.yaml', mode: 'substring', tag: 'identifier' },
    { text: 'wandb', mode: 'substring-ci', tag: 'identifier' },
    { text: 'rec-v3-sweep-20250506', mode: 'substring', tag: 'identifier' },
  ],
};

export const COMPACTION_FIXTURES: readonly CompactionFixture[] = Object.freeze([
  fixtureCodingDebug401,
  fixtureCodingRefactor,
  fixtureCodingBashDebug,
  fixtureCodingDeps,
  fixtureCodingMerge,
  fixtureDataAnalysis,
  fixtureCustomerSupport,
  fixtureSRE,
  fixtureDocs,
  fixtureMLExperiments,
]);
