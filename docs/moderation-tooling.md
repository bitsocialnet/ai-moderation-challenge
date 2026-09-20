# Moderation operator tooling

These tools run from a repository checkout with Node.js 22+. They use the standard library and make no network calls unless evaluation is explicitly run with `--live`. The challenge's Jev model, single decision, approval threshold, provider deadlines, and fallback policy are unchanged.

## Usage report

```bash
node scripts/moderation-usage.mjs --audit /private/moderation-audit.jsonl > usage-summary.json
node scripts/moderation-usage.mjs --audit /private/moderation-audit.jsonl --rates /private/rates.json > cost-summary.json
```

The audit file itself contains private publication data. The report reads it locally and emits aggregate telemetry only: no publication text, addresses, reasons, policy, credentials, or raw errors. Host and model identifiers remain visible because tariffs depend on them. Malformed/unrelated JSONL records are counted as ignored; cache records never count embedded attempts as new usage. `reached` counts decisions reaching each stage, while per-provider request totals include retries. `finishedAt` excludes moderation errors. Source `rule` identifies deterministic recency checks. Memory-cache reuse is not logged, so these are audited records rather than an exact census of incoming publications.

Optional rate-file schema, with **illustrative values, not provider prices**:

```json
{
    "currency": "USD",
    "providers": [
        {
            "apiHost": "provider.example",
            "model": "model-version",
            "inputPerMillion": 2,
            "outputPerMillion": 4,
            "cacheAccounting": "reported",
            "cachedInputPerMillion": 0.2,
            "cacheWriteInputPerMillion": 2.5,
            "reasoningAccounting": "included-in-output"
        }
    ]
}
```

Select `cacheAccounting: "none"` only for providers without cache billing distinctions; cached/cache-write rates are then omitted. `reported` requires both cache counts in each attempt, including explicitly reported zeros. Missing counts do not silently become zero. Select `reasoningAccounting: "separate"` and supply `reasoningPerMillion` only when that provider bills reasoning separately from its reported output tokens. The script never adds reasoning tokens to output without this explicit instruction. Input totals include cached and cache-write counts; the report subtracts those from ordinary input before applying their rates.

A provider row has `estimatedTotalCostUsd: null` if any of its requests lacks the necessary tariff or usage. `estimatedKnownCostUsd` is only the calculable subtotal. A zero-token failure with missing usage is unknown, not free. Rates, currency conversions, minimum charges, and vendor invoices are not fetched automatically. Mean/max timing concerns provider calls, not the full publication path.

## Moderation evaluation

The committed `evaluations/moderation-corpus.json` contains 12 small synthetic cases: ordinary discussion, clear spam, prompt injection, reply/topic rules, and recency boundaries. Labels are explicit judgments for those examples, not an external accuracy benchmark. Date cases deliberately configure a 48-hour window so they also exercise runtime enforcement.

Default offline validation:

```bash
node scripts/moderation-evaluate.mjs
```

Offline comparison accepts a JSON array containing only case IDs and predictions:

```json
[{ "id": "ordinary-question", "verdict": "allow" }]
```

```bash
node scripts/moderation-evaluate.mjs --predictions /private/predictions.json
```

Missing predictions, errors, false approvals, and false reviews are reported separately and produce a nonzero exit status. Unknown/duplicate IDs are rejected. The tool does not manufacture predictions or claim that corpus validation measures model quality.

For intentional live evaluation:

```bash
corepack yarn build
node scripts/moderation-evaluate.mjs \
    --live \
    --profile evaluations/jev-cascade.example.json \
    --max-requests 36 \
    --max-request-bytes 300000 \
    > evaluation-summary.json
```

Provide the environment variables named in the profile through your private secret-loading mechanism; never put credential values into profiles, fixtures, shell history, or reports. Review the example's exact endpoints and model access first. Copy the profile to a private file and change `id` and `jevMode` to `off` for a Luna/Grok baseline. Comparisons use the same labeled corpus, built runtime, default public moderation policy, and per-case rules. Custom production prompt files are intentionally not loaded by this runner. Profile options are limited to provider settings; shadow mode is disallowed because it would launch unawaited requests. No community is contacted and no publication is submitted.

The request budget covers **all** provider calls, including fallback/retry attempts; the UTF-8 byte budget covers complete serialized outgoing bodies, not tokens or dollar spend. Neither is a precise monetary cap. Requests are sequential, provider deadlines remain in force, and redirects are refused. When either budget is exhausted, further network calls are blocked and unprocessed cases are marked missing. Run each profile in a separate process and rebuild after source changes; the challenge intentionally reuses identical in-process decisions.

Live mode temporarily writes the normal audit into a private operating-system temp directory to distinguish review from provider failure and extract actual attempt telemetry. It removes that directory even on ordinary failure. A hard process kill can leave a temporary directory; its synthetic/sanitized publication data remains private and no prompt or key is recorded by the runtime. Reports include a corpus hash, case IDs, label provenance, outcomes, and aggregate usage (including host/model identifiers, as in the usage report); raw request/response content and provider errors are not emitted.

Live reports also include reusable `predictions`: final verdict, measured per-case wall-clock latency, whether triage/reviewer was reached, and the actual Jev gate evidence when available. `comparison.metricsByProvenance` keeps synthetic and reviewed-real metrics separate. False-allow and false-alarm rates use expected-review and expected-allow denominators respectively. Errors/missing predictions are abstentions, not correct reviews; escalation is a provider-routing event and can end in allow, review, or error. Unknown escalation stays unknown. Latency includes challenge execution and local audit readback; p50/p95 use nearest ranks. In-process cache hits have their own measured latency and zero incremental cost, while retaining the original decision evidence.

Add `--rates /private/rates.json` using the usage-report schema to estimate costs. No tariffs are assumed: missing rates/usage produce `null` totals, with known subtotals separately visible. Raw publication data and provider errors never appear in reusable predictions. A built-runtime hash and provider-profile hash bind observations to that experiment; only a pinned `jev-X.Y.Z` model is accepted by calibration.

To add real examples, independently label and sanitize them before creating a separate corpus. Use `provenance: "reviewed-real"` and `independentlyReviewed: true`; this is an explicit attestation, not automated proof. Remove author IDs, signatures, CIDs, private URLs, and secrets from text as well as metadata. The schema rejects unsupported identifying publication fields, but cannot automatically prove arbitrary text is sanitized. Record the policy basis in `rationale`. Keep real and synthetic results separate when discussing quality, and inspect false approvals before changing thresholds.

## Frozen calibration and labeling

`scripts/moderation-calibrate.mjs` is offline and advisory. It reuses evaluator reports; it neither calls a provider nor changes the challenge's `0.05` threshold. Its candidate thresholds can only tighten the observed gate, preserving the audit's original `wouldAutoAllow` decision. It does not guess the model's choice from probability alone. This follows TypeSafe's [domain-specific threshold guidance](https://docs.typesafe.ai/confidence) and [moderation consistency example](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook): confidence is a property of the answer distribution, not independently verified correctness.

Before collecting model observations or inspecting holdout results, assign every case to `fit` or `holdout` and an opaque group ID. Related variants must share a group and stay in one partition. The committed `evaluations/moderation-split.json` is a functional example: all six related recency variants stay together. It is not a representative domain split. Exact duplicate inputs cannot cross partitions even with different group IDs. Keep the corpus, assignment, frozen manifest, provider profile, and runtime fixed during an experiment.

```bash
node scripts/moderation-calibrate.mjs freeze \
    --corpus evaluations/moderation-corpus.json \
    --assignments evaluations/moderation-split.json > frozen.json
# Run the intentional live evaluation above, saving its output as evaluation.json.
node scripts/moderation-calibrate.mjs fit \
    --corpus evaluations/moderation-corpus.json --frozen frozen.json \
    --report evaluation.json > fit.json
node scripts/moderation-calibrate.mjs holdout \
    --corpus evaluations/moderation-corpus.json --frozen frozen.json \
    --report evaluation.json --fit fit.json > holdout.json
```

Fit chooses the candidate with most observed automatic allows and zero observed false allows; the smaller threshold wins ties. It never uses holdout scores. Holdout evaluates that one candidate, verifies the fit evidence has not changed, and refuses a modified candidate. A failed holdout requires a new experiment with fresh held-out examples; do not try multiple thresholds against the same holdout. Hashes detect changed inputs, not dishonest labels, prior holdout inspection, or deliberate reuse. Protect experiment artifacts from casual overwrite and record the final report before beginning another experiment.

Calibration of reviewed-real examples additionally requires this `labelReview` attestation on each corpus case; IDs must be opaque labels, not personal names:

```json
{
    "method": "independent-human",
    "labelerId": "labeler-1",
    "reviewerId": "reviewer-2",
    "policyVersion": "policy-1",
    "reviewedAt": "2026-09-20",
    "sampling": "random-audit"
}
```

The labeler and reviewer IDs must differ. Use `sampling: "uncertainty"` or `"curated"` for targeted examples; those improve coverage of difficult cases but do not estimate prevalence. Only independently reviewed, randomly audited real examples with unique inputs and a single case per group count toward statistical support. These assertions require honest provenance and a representative supplied pool; the tool cannot establish independence itself. It does not import raw private traffic or independently review labels.

Default support requires zero false allows, at least 30 independently reviewed allowed examples, and a one-sided 95% binomial upper bound on false-allow rate of at most 1%, in **both** partitions. With zero failures that needs at least 299 independent violating examples per partition. Missing Jev evidence, small samples, synthetic-only labels, or reports marked `mode: "offline-fixture"` produce `insufficient_data`; any held-out false allow produces `failed`. Even `supported_for_review` is only evidence for a human-reviewed proposal. Model/policy drift and sampling bias remain limitations. No setting is written or deployed.

An explicit optional `--policy` JSON can set `thresholds`, `maxFalseAllowRate`, `confidence`, and `minAllowedGroups`; all fields are required. Thresholds are bounded to `0..0.05`, confidence to `0.9..1` (excluding 1). Defaults are exported as `defaultPolicy` for reproducible inspection. Keep this policy fixed before fitting.

Each partition reports gate metrics separately from the original observed cascade. For the gate, a false alarm means an allowed example would be escalated; it does not claim a wrong final rejection. Cases without a Jev score are unscored, including deterministic recency decisions. Counterfactual fallback answers, latency, and cost at a different threshold are **not measured** by replay. Observed latency/cost always describes the original run. `failed`, `insufficient_data`, and `no_candidate` exit nonzero while still emitting their report.

For active labeling, supply only an array of opaque IDs and `reviewProbability` values. The helper rejects publication fields. A frozen manifest excludes its cases from selection:

```bash
node scripts/moderation-calibrate.mjs select-labels \
    --candidates sanitized-candidates.json --seed audit-round-1 \
    --uncertainty 20 --random 20 --frozen frozen.json > label-selection.json
```

The seeded random audit samples the full eligible pool first, then uncertainty selection takes remaining cases nearest the current `0.05` boundary. The two sets cannot overlap. Zero counts and empty pools are explicit empty selections. Fix the seed before inspecting labels. Selection creates no labels: independently review selected examples against the policy, sanitize separately, and reserve new holdout groups before a later experiment. Do not combine uncertainty-selected examples with random-audit denominators.

## Recency regression evidence

The previous runtime transmitted date strings and instructed the model to subtract them; it did not perform age arithmetic. The earlier synthetic evaluation found inconsistent decisions around a 48-hour window. The new regression also demonstrates that the former runtime accepted an expired article whenever a provider answered allow. With `articleMaxAgeHours` configured, that case now reviews without a provider request. Boundary/future/missing dates still reach the normal cascade to check other rules. The tests run without network or credentials; they verify runtime behavior, not model accuracy.
