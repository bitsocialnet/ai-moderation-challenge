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

To add real examples, independently label and sanitize them before creating a separate corpus. Use `provenance: "reviewed-real"` and `independentlyReviewed: true`; this is an explicit attestation, not automated proof. Remove author IDs, signatures, CIDs, private URLs, and secrets from text as well as metadata. The schema rejects unsupported identifying publication fields, but cannot automatically prove arbitrary text is sanitized. Record the policy basis in `rationale`. Keep real and synthetic results separate when discussing quality, and inspect false approvals before changing thresholds.

## Recency regression evidence

The previous runtime transmitted date strings and instructed the model to subtract them; it did not perform age arithmetic. The earlier synthetic evaluation found inconsistent decisions around a 48-hour window. The new regression also demonstrates that the former runtime accepted an expired article whenever a provider answered allow. With `articleMaxAgeHours` configured, that case now reviews without a provider request. Boundary/future/missing dates still reach the normal cascade to check other rules. The tests run without network or credentials; they verify runtime behavior, not model accuracy.
