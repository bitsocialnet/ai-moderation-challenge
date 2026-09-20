#!/usr/bin/env node
// Offline, advisory tooling. No model requests, production settings, or private-traffic ingestion.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, validateCorpus, validateObservation, summarizePredictions } from "./moderation-evaluate.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const ceiling = 0.05;
export const defaultPolicy = Object.freeze({
    thresholds: [0, 0.01, 0.025, 0.05],
    maxFalseAllowRate: 0.01,
    confidence: 0.95,
    minAllowedGroups: 30
});

function reviewProvenance(item) {
    if (item.provenance === "synthetic") return null;
    const review = item.labelReview;
    if (
        !object(review) ||
        review.method !== "independent-human" ||
        !label(review.labelerId) ||
        !label(review.reviewerId) ||
        review.labelerId === review.reviewerId ||
        !label(review.policyVersion) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewedAt) ||
        !Number.isFinite(Date.parse(review.reviewedAt)) ||
        !["random-audit", "uncertainty", "curated"].includes(review.sampling)
    )
        throw new Error("Calibration requires explicit independent label review and sampling provenance");
    return {
        method: review.method,
        labelerId: review.labelerId,
        reviewerId: review.reviewerId,
        policyVersion: review.policyVersion,
        reviewedAt: review.reviewedAt,
        sampling: review.sampling
    };
}

export function freezeCorpus(corpus, assignments) {
    validateCorpus(corpus);
    if (!Array.isArray(assignments) || assignments.length !== corpus.cases.length) throw new Error("Assign every case exactly once");
    const indexed = new Map();
    for (const row of assignments) {
        if (!object(row) || !label(row.id) || !label(row.group) || !["fit", "holdout"].includes(row.split) || indexed.has(row.id))
            throw new Error("Invalid split assignment");
        indexed.set(row.id, row);
    }
    const groups = new Map(),
        inputs = new Map();
    const cases = corpus.cases
        .map((item) => {
            const assignment = indexed.get(item.id);
            if (!assignment) throw new Error("Missing split assignment");
            const p = item.publication;
            const inputSha256 = sha256([
                p.kind,
                p.content ?? null,
                p.title ?? null,
                p.link ?? null,
                p.linkHtmlTagName ?? null,
                p.timestamp ?? null,
                item.rules,
                item.articleMaxAgeHours ?? null
            ]);
            for (const [map, key] of [
                [groups, assignment.group],
                [inputs, inputSha256]
            ]) {
                if (map.has(key) && map.get(key) !== assignment.split) throw new Error("Related or duplicate cases cross fit/holdout");
                map.set(key, assignment.split);
            }
            return {
                id: item.id,
                group: assignment.group,
                split: assignment.split,
                inputSha256,
                expected: item.expected,
                provenance: item.provenance,
                labelReview: reviewProvenance(item)
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(cases.map((row) => row.split)).size !== 2) throw new Error("Both fit and holdout are required");
    const frozen = { version: 1, corpusSha256: sha256(corpus), cases };
    return { ...frozen, freezeSha256: sha256(frozen) };
}

function validateFrozen(corpus, frozen) {
    if (!object(frozen) || !Array.isArray(frozen.cases)) throw new Error("Invalid frozen corpus");
    const regenerated = freezeCorpus(corpus, frozen.cases);
    if (sha256(regenerated) !== sha256(frozen)) throw new Error("Frozen corpus changed; create a new experiment before using holdout");
    return frozen;
}

function observations(corpus, frozen, report) {
    validateFrozen(corpus, frozen);
    if (
        !object(report) ||
        !["live", "offline-fixture"].includes(report.mode) ||
        report.corpusSha256 !== frozen.corpusSha256 ||
        !digest(report.profileSha256) ||
        !digest(report.runtimeSha256) ||
        !/^jev-\d+\.\d+\.\d+$/.test(report.jevModel ?? "") ||
        !Array.isArray(report.predictions)
    )
        throw new Error("Report must identify the frozen corpus, provider profile, and built runtime");
    const indexed = new Map();
    for (const item of report.predictions) {
        validateObservation(item);
        if (indexed.has(item.id) || !frozen.cases.some((row) => row.id === item.id)) throw new Error("Duplicate or unknown observation");
        // Only retain fields needed for reproducible metrics, never arbitrary report content.
        indexed.set(item.id, {
            id: item.id,
            verdict: item.verdict,
            elapsedMs: item.elapsedMs ?? null,
            estimatedCostUsd: item.estimatedCostUsd ?? null,
            escalated: item.escalated ?? null,
            jev: item.jev
                ? {
                      reviewProbability: item.jev.reviewProbability,
                      confidence: item.jev.confidence,
                      maxReviewProbability: item.jev.maxReviewProbability,
                      wouldAutoAllow: item.jev.wouldAutoAllow
                  }
                : null
        });
    }
    return indexed;
}

function policy(value) {
    if (
        !object(value) ||
        Object.keys(value).some((key) => !Object.hasOwn(defaultPolicy, key)) ||
        !Array.isArray(value.thresholds) ||
        !value.thresholds.length ||
        value.thresholds.length > 50 ||
        value.thresholds.some((n) => !probability(n) || n > ceiling) ||
        new Set(value.thresholds).size !== value.thresholds.length ||
        !probability(value.maxFalseAllowRate) ||
        value.maxFalseAllowRate === 0 ||
        value.maxFalseAllowRate >= 1 ||
        !probability(value.confidence) ||
        value.confidence < 0.9 ||
        value.confidence >= 1 ||
        !Number.isInteger(value.minAllowedGroups) ||
        value.minAllowedGroups < 1
    )
        throw new Error("Invalid conservative calibration policy");
    return {
        thresholds: [...value.thresholds].sort((a, b) => a - b),
        maxFalseAllowRate: value.maxFalseAllowRate,
        confidence: value.confidence,
        minAllowedGroups: value.minAllowedGroups
    };
}

function gated(rows, indexed, threshold) {
    return rows.map((row) => {
        const observation = indexed.get(row.id),
            evidence = observation?.jev;
        if (evidence && threshold > evidence.maxReviewProbability) throw new Error("Candidate would relax the observed gate");
        // The current audit preserves original eligibility, not the raw choice. Never infer choice from probability.
        const scored = Boolean(evidence);
        const autoAllow = scored && evidence.wouldAutoAllow && evidence.reviewProbability <= threshold;
        return { ...row, scored, autoAllow, observation };
    });
}

function gateMetrics(rows) {
    const scored = rows.filter((row) => row.scored);
    const expectedReviews = scored.filter((row) => row.expected === "review").length;
    const expectedAllows = scored.length - expectedReviews;
    const falseAllows = scored.filter((row) => row.expected === "review" && row.autoAllow).length;
    const falseAlarms = scored.filter((row) => row.expected === "allow" && !row.autoAllow).length;
    return {
        cases: rows.length,
        scored: scored.length,
        unscored: rows.length - scored.length,
        autoAllows: scored.filter((row) => row.autoAllow).length,
        escalations: scored.filter((row) => !row.autoAllow).length,
        falseAllows,
        falseAlarms,
        falseAllowRate: expectedReviews ? falseAllows / expectedReviews : null,
        falseAlarmRate: expectedAllows ? falseAlarms / expectedAllows : null
    };
}

function support(rows, selectedPolicy, mode) {
    // Correlated variants and duplicated inputs are useful stress tests, not independent statistical trials.
    const groupSizes = new Map(),
        inputSizes = new Map();
    for (const row of rows) {
        groupSizes.set(row.group, (groupSizes.get(row.group) ?? 0) + 1);
        inputSizes.set(row.inputSha256, (inputSizes.get(row.inputSha256) ?? 0) + 1);
    }
    const eligible = rows.filter(
        (row) =>
            row.provenance === "reviewed-real" &&
            row.labelReview.sampling === "random-audit" &&
            groupSizes.get(row.group) === 1 &&
            inputSizes.get(row.inputSha256) === 1
    );
    const reviews = eligible.filter((row) => row.expected === "review" && row.scored);
    const allows = eligible.filter((row) => row.expected === "allow" && row.scored);
    const falseAllows = reviews.filter((row) => row.autoAllow).length;
    // Exact one-sided binomial upper bound for zero observed false allows. Nonzero failures fail the gate.
    const upper = reviews.length && falseAllows === 0 ? -Math.expm1(Math.log(1 - selectedPolicy.confidence) / reviews.length) : null;
    const reasons = [];
    if (mode !== "live") reasons.push("fixture_observations");
    if (falseAllows) reasons.push("observed_false_allow");
    if (eligible.some((row) => !row.scored)) reasons.push("missing_jev_evidence");
    if (upper === null || upper > selectedPolicy.maxFalseAllowRate) reasons.push("too_few_independent_violation_labels");
    if (allows.length < selectedPolicy.minAllowedGroups) reasons.push("too_few_independent_allow_labels");
    return {
        status: falseAllows ? "failed" : reasons.length ? "insufficient_data" : "supported",
        reasons,
        independentViolationGroups: reviews.length,
        independentAllowGroups: allows.length,
        excludedCases: rows.length - eligible.length,
        falseAllows,
        falseAllowUpperBound: upper,
        confidence: selectedPolicy.confidence,
        maxFalseAllowRate: selectedPolicy.maxFalseAllowRate
    };
}

function partitionReport(rows, indexed, threshold, selectedPolicy, mode) {
    const routed = gated(rows, indexed, threshold);
    return {
        gate: gateMetrics(routed),
        byProvenance: Object.fromEntries(
            ["synthetic", "reviewed-real"].map((provenance) => {
                const subset = routed.filter((row) => row.provenance === provenance);
                return [provenance, { gate: gateMetrics(subset), observedCascade: summarizePredictions(subset, [...indexed.values()]) }];
            })
        ),
        support: support(routed, selectedPolicy, mode)
    };
}

export function fitThreshold(corpus, frozen, report, requestedPolicy = defaultPolicy) {
    const indexed = observations(corpus, frozen, report),
        selectedPolicy = policy(requestedPolicy);
    const fit = frozen.cases.filter((row) => row.split === "fit");
    const candidates = selectedPolicy.thresholds.map((threshold) => ({
        threshold,
        ...partitionReport(fit, indexed, threshold, selectedPolicy, report.mode)
    }));
    const feasible = candidates.filter((row) => row.gate.falseAllows === 0 && row.gate.autoAllows > 0);
    // Maximize observed auto-allow coverage with the smaller threshold breaking ties. Holdout is never consulted here.
    feasible.sort((a, b) => b.gate.autoAllows - a.gate.autoAllows || a.threshold - b.threshold);
    return {
        version: 1,
        mode: "fit",
        advisoryOnly: true,
        freezeSha256: frozen.freezeSha256,
        profileSha256: report.profileSha256,
        runtimeSha256: report.runtimeSha256,
        jevModel: report.jevModel,
        observationMode: report.mode,
        fitObservationsSha256: sha256(fit.map((row) => indexed.get(row.id) ?? null)),
        policy: selectedPolicy,
        candidateThreshold: feasible[0]?.threshold ?? null,
        candidates,
        status: feasible.length ? "candidate_requires_holdout" : "no_candidate"
    };
}

export function evaluateHoldout(corpus, frozen, report, lockedFit) {
    if (!object(lockedFit)) throw new Error("A previously locked fit report is required");
    const regenerated = fitThreshold(corpus, frozen, report, lockedFit.policy);
    if (sha256(regenerated) !== sha256(lockedFit)) throw new Error("Fit evidence or candidate changed; holdout cannot retune a candidate");
    const indexed = observations(corpus, frozen, report);
    if (lockedFit.candidateThreshold === null) return { version: 1, mode: "holdout", advisoryOnly: true, status: "no_candidate" };
    const threshold = lockedFit.candidateThreshold;
    const result = partitionReport(
        frozen.cases.filter((row) => row.split === "holdout"),
        indexed,
        threshold,
        lockedFit.policy,
        report.mode
    );
    const fitSupport = lockedFit.candidates.find((row) => row.threshold === threshold).support;
    const status =
        result.gate.falseAllows || result.support.status === "failed"
            ? "failed"
            : fitSupport.status === "supported" && result.support.status === "supported"
              ? "supported_for_review"
              : "insufficient_data";
    return {
        version: 1,
        mode: "holdout",
        advisoryOnly: true,
        status,
        threshold,
        freezeSha256: frozen.freezeSha256,
        fitSha256: sha256(lockedFit),
        holdoutObservationsSha256: sha256(frozen.cases.filter((row) => row.split === "holdout").map((row) => indexed.get(row.id) ?? null)),
        fitSupport,
        ...result,
        limitation:
            "Observed cascade latency/cost belongs to the original gate; counterfactual fallback behavior is not measured. Statistical support assumes honest independent labels and representative random sampling. No production threshold is changed."
    };
}

export function selectForLabeling(candidates, { seed, uncertaintyCount, randomCount, threshold = ceiling }, excludedIds = []) {
    if (
        !label(seed) ||
        !probability(threshold) ||
        threshold > ceiling ||
        !Array.isArray(candidates) ||
        candidates.length > 10000 ||
        ![uncertaintyCount, randomCount].every((n) => Number.isInteger(n) && n >= 0 && n <= 1000) ||
        !Array.isArray(excludedIds) ||
        excludedIds.some((id) => !label(id))
    )
        throw new Error("Invalid labeling selection");
    const seen = new Set(),
        excluded = new Set(excludedIds);
    const available = [];
    for (const row of candidates) {
        if (
            !object(row) ||
            !label(row.id) ||
            seen.has(row.id) ||
            !probability(row.reviewProbability) ||
            Object.keys(row).some((key) => !["id", "reviewProbability"].includes(key))
        )
            throw new Error("Label candidates accept opaque IDs and probability only; sanitize separately");
        seen.add(row.id);
        if (!excluded.has(row.id)) available.push(row);
    }
    // Sample random audits first from the whole eligible pool. Uncertainty must not bias that sample.
    const random = [...available].sort((a, b) => sha256([seed, a.id]).localeCompare(sha256([seed, b.id]))).slice(0, randomCount);
    const randomIds = new Set(random.map((row) => row.id));
    const uncertain = available
        .filter((row) => !randomIds.has(row.id))
        .sort((a, b) => Math.abs(a.reviewProbability - threshold) - Math.abs(b.reviewProbability - threshold) || a.id.localeCompare(b.id))
        .slice(0, uncertaintyCount);
    return {
        version: 1,
        mode: "label-selection",
        seed,
        threshold,
        eligible: available.length,
        requested: { random: randomCount, uncertainty: uncertaintyCount },
        selected: [
            ...random.map((row) => ({ id: row.id, sampling: "random-audit" })),
            ...uncertain.map((row) => ({ id: row.id, sampling: "uncertainty" }))
        ],
        limitation:
            "Selection is not a label. Review independently under the frozen policy; do not recycle held-out cases for tuning. Random sampling is only representative of the supplied pool."
    };
}

export async function calibrationMain(args) {
    if (args.includes("--help")) {
        console.log(
            "Offline moderation calibration (JSON on stdout; no network):\nfreeze --corpus FILE --assignments FILE\nfit --corpus FILE --frozen FILE --report FILE [--policy FILE]\nholdout --corpus FILE --frozen FILE --report FILE --fit FILE\nselect-labels --candidates FILE --seed LABEL --uncertainty N --random N [--frozen FILE]\nAll outputs are advisory. Freeze before calls/inspection; reserve holdout for one locked candidate."
        );
        return;
    }
    const [mode, ...rest] = args;
    const allowed = {
        freeze: ["corpus", "assignments"],
        fit: ["corpus", "frozen", "report", "policy"],
        holdout: ["corpus", "frozen", "report", "fit"],
        "select-labels": ["candidates", "seed", "uncertainty", "random", "frozen"]
    };
    if (!Object.hasOwn(allowed, mode)) throw new Error("Unknown mode");
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i].slice(2);
        if (!rest[i].startsWith("--") || !allowed[mode].includes(key) || !rest[i + 1] || Object.hasOwn(flags, key))
            throw new Error("Invalid flags");
        flags[key] = rest[i + 1];
    }
    const read = async (name) => {
        if (!flags[name]) throw new Error("Missing input file");
        return JSON.parse(await readFile(flags[name], "utf8"));
    };
    let result;
    if (mode === "select-labels") {
        const frozen = flags.frozen ? await read("frozen") : null;
        if (frozen && (!Array.isArray(frozen.cases) || frozen.cases.some((row) => !label(row.id)))) throw new Error("Invalid exclusions");
        result = selectForLabeling(
            await read("candidates"),
            { seed: flags.seed, uncertaintyCount: Number(flags.uncertainty), randomCount: Number(flags.random) },
            frozen?.cases.map((row) => row.id) ?? []
        );
    } else {
        const corpus = await read("corpus");
        if (mode === "freeze") result = freezeCorpus(corpus, await read("assignments"));
        else if (mode === "fit")
            result = fitThreshold(corpus, await read("frozen"), await read("report"), flags.policy ? await read("policy") : defaultPolicy);
        else result = evaluateHoldout(corpus, await read("frozen"), await read("report"), await read("fit"));
    }
    console.log(JSON.stringify(result, null, 2));
    if (["failed", "insufficient_data", "no_candidate"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    calibrationMain(process.argv.slice(2)).catch(() => {
        console.error(
            "Calibration failed. Check frozen inputs, sanitized observations, provenance, and flags; private data is not printed."
        );
        process.exitCode = 1;
    });
}
