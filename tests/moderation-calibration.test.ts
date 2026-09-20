import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultPolicy, evaluateHoldout, fitThreshold, freezeCorpus, selectForLabeling } from "../scripts/moderation-calibrate.mjs";
import { sha256, summarizePredictions } from "../scripts/moderation-evaluate.mjs";

const caseFor = (id: string, expected = "allow", provenance = "synthetic") => ({
    id,
    expected,
    provenance,
    ...(provenance === "reviewed-real"
        ? {
              independentlyReviewed: true,
              labelReview: {
                  method: "independent-human",
                  labelerId: "labeler-1",
                  reviewerId: "reviewer-2",
                  policyVersion: "policy-1",
                  reviewedAt: "2026-09-20",
                  sampling: "random-audit"
              }
          }
        : {}),
    rationale: "Test fixture only; these are not real reviewed labels.",
    rules: ["No spam."],
    publication: { kind: "post", content: `Synthetic example ${id}` }
});
const observation = (id: string, reviewProbability = 0.01, wouldAutoAllow = reviewProbability <= 0.05) => ({
    id,
    verdict: wouldAutoAllow ? "allow" : "review",
    elapsedMs: 20,
    estimatedCostUsd: null,
    escalated: !wouldAutoAllow,
    jev: { reviewProbability, confidence: 0.9, wouldAutoAllow, maxReviewProbability: 0.05 }
});
function experiment(provenance = "synthetic") {
    const corpus = {
        version: 1,
        cases: [
            caseFor("fit-allow", "allow", provenance),
            caseFor("fit-review", "review", provenance),
            caseFor("holdout-allow", "allow", provenance),
            caseFor("holdout-review", "review", provenance)
        ]
    };
    const assignments = corpus.cases.map((row) => ({ id: row.id, group: row.id, split: row.id.startsWith("fit") ? "fit" : "holdout" }));
    const frozen = freezeCorpus(corpus, assignments);
    const report = {
        mode: "offline-fixture",
        corpusSha256: sha256(corpus),
        profileSha256: "a".repeat(64),
        runtimeSha256: "b".repeat(64),
        jevModel: "jev-1.13.0",
        predictions: corpus.cases.map((row) => observation(row.id, row.expected === "review" ? 0.9 : 0.01))
    };
    return { corpus, assignments, frozen, report };
}

describe("frozen moderation calibration", () => {
    it("freezes the committed synthetic corpus with explicit groups, without content in the manifest", async () => {
        const corpus = JSON.parse(await readFile(new URL("../evaluations/moderation-corpus.json", import.meta.url), "utf8"));
        const assignments = JSON.parse(await readFile(new URL("../evaluations/moderation-split.json", import.meta.url), "utf8"));
        const frozen = freezeCorpus(corpus, assignments);
        expect(frozen.cases).toHaveLength(12);
        expect(JSON.stringify(frozen)).not.toContain("basil");
        expect(new Set(frozen.cases.filter((row) => row.id.startsWith("recency")).map((row) => row.split)).size).toBe(1);
    });
    it("rejects group leakage, reordered duplicate publication fields, incomplete assignments, and changed labels", () => {
        const { corpus, assignments, frozen, report } = experiment();
        expect(() => freezeCorpus(corpus, assignments.slice(1))).toThrow();
        expect(() =>
            freezeCorpus(
                corpus,
                assignments.map((row) => ({ ...row, group: "shared" }))
            )
        ).toThrow(/cross/);
        const duplicated = structuredClone(corpus);
        duplicated.cases[2].publication = { content: corpus.cases[0].publication.content, kind: "post" };
        expect(() => freezeCorpus(duplicated, assignments)).toThrow(/cross/);
        corpus.cases[0].expected = "review";
        expect(() => fitThreshold(corpus, frozen, report)).toThrow(/Frozen corpus changed/);
    });
    it("requires explicit distinct labeler/reviewer provenance for calibration of reviewed-real rows", () => {
        const { corpus, assignments } = experiment("reviewed-real");
        corpus.cases[0].labelReview!.reviewerId = "labeler-1";
        expect(() => freezeCorpus(corpus, assignments)).toThrow(/independent label/);
    });
    it("fits without consulting holdout and refuses a mutated locked candidate or fit observations", () => {
        const { corpus, frozen, report } = experiment();
        const fit = fitThreshold(corpus, frozen, report);
        expect(fit.candidateThreshold).toBe(0.01);
        report.predictions[3] = observation("holdout-review", 0.001);
        expect(fitThreshold(corpus, frozen, report)).toEqual(fit);
        expect(evaluateHoldout(corpus, frozen, report, fit).status).toBe("failed");
        expect(() => evaluateHoldout(corpus, frozen, report, { ...fit, candidateThreshold: 0.05 })).toThrow(/changed/);
        report.predictions[0] = observation("fit-allow", 0.02);
        expect(() => evaluateHoldout(corpus, frozen, report, fit)).toThrow(/changed/);
    });
    it("rejects unknown/duplicate observations, unsafe thresholds and experiments with different runtime/profile", () => {
        const { corpus, frozen, report } = experiment();
        const fit = fitThreshold(corpus, frozen, report);
        expect(() => fitThreshold(corpus, frozen, { ...report, predictions: [...report.predictions, report.predictions[0]] })).toThrow();
        expect(() => fitThreshold(corpus, frozen, { ...report, predictions: [observation("unknown")] })).toThrow();
        expect(() => fitThreshold(corpus, frozen, report, { ...defaultPolicy, thresholds: [0.06] })).toThrow();
        expect(() => evaluateHoldout(corpus, frozen, { ...report, profileSha256: "c".repeat(64) }, fit)).toThrow(/changed/);
        expect(() => evaluateHoldout(corpus, frozen, { ...report, runtimeSha256: "c".repeat(64) }, fit)).toThrow(/changed/);
        report.predictions[0].jev.maxReviewProbability = 0.025;
        expect(() => fitThreshold(corpus, frozen, report)).toThrow(/relax/);
    });
    it("never converts low probability alone into an allow and reports missing scores separately", () => {
        const { corpus, frozen, report } = experiment();
        report.predictions[0] = observation("fit-allow", 0.001, false);
        expect(fitThreshold(corpus, frozen, report).status).toBe("no_candidate");
        report.predictions = report.predictions.slice(1);
        expect(fitThreshold(corpus, frozen, report).candidates[0].gate).toMatchObject({ unscored: 1, autoAllows: 0 });
    });
    it("keeps synthetic or tiny reviewed samples insufficient even when every prediction agrees", () => {
        for (const provenance of ["synthetic", "reviewed-real"]) {
            const { corpus, frozen, report } = experiment(provenance);
            const fit = fitThreshold(corpus, frozen, report);
            const holdout = evaluateHoldout(corpus, frozen, report, fit);
            expect(holdout.status).toBe("insufficient_data");
            expect(holdout.advisoryOnly).toBe(true);
            expect(holdout.support.reasons).toContain("fixture_observations");
            expect(holdout.support.reasons).toContain("too_few_independent_violation_labels");
        }
    });
    it("uses the conservative zero-failure bound and excludes correlated or uncertainty-selected labels", () => {
        const cases = ["fit", "holdout"].flatMap((split) => [
            ...Array.from({ length: 299 }, (_, i) => caseFor(`${split}-review-${i}`, "review", "reviewed-real")),
            ...Array.from({ length: 30 }, (_, i) => caseFor(`${split}-allow-${i}`, "allow", "reviewed-real"))
        ]);
        const corpus = { version: 1, cases };
        const assignments = cases.map((row) => ({ id: row.id, group: row.id, split: row.id.startsWith("fit") ? "fit" : "holdout" }));
        const frozen = freezeCorpus(corpus, assignments);
        const report = {
            mode: "live",
            corpusSha256: sha256(corpus),
            profileSha256: "a".repeat(64),
            runtimeSha256: "b".repeat(64),
            jevModel: "jev-1.13.0",
            predictions: cases.map((row) => observation(row.id, row.expected === "review" ? 0.9 : 0.01))
        };
        // Stubs deliberately exercise the math. These fixtures are not actual human labels or live API measurements.
        const fit = fitThreshold(corpus, frozen, report);
        const holdout = evaluateHoldout(corpus, frozen, report, fit);
        expect(holdout.status).toBe("supported_for_review");
        expect(holdout.support.falseAllowUpperBound).toBeCloseTo(1 - 0.05 ** (1 / 299));
        cases.find((row) => row.id === "holdout-review-0")!.labelReview!.sampling = "uncertainty";
        const reducedFrozen = freezeCorpus(corpus, assignments),
            reducedReport = { ...report, corpusSha256: sha256(corpus) };
        expect(evaluateHoldout(corpus, reducedFrozen, reducedReport, fitThreshold(corpus, reducedFrozen, reducedReport)).status).toBe(
            "insufficient_data"
        );
        const grouped = assignments.map((row) => ({ ...row, group: row.split }));
        const groupedFrozen = freezeCorpus(corpus, grouped);
        expect(fitThreshold(corpus, groupedFrozen, reducedReport).candidates[0].support.independentViolationGroups).toBe(0);
    });
});

describe("sanitized observations and labeling selection", () => {
    it("separates false allows, false alarms, errors/missing, escalation, measured latency, and unknown cost", () => {
        const cases = [caseFor("false-allow", "review"), caseFor("false-alarm"), caseFor("failure"), caseFor("missing")];
        const summary = summarizePredictions(cases, [
            { id: "false-allow", verdict: "allow", elapsedMs: 10, estimatedCostUsd: 0.01, escalated: false },
            { id: "false-alarm", verdict: "review", elapsedMs: 30, estimatedCostUsd: 0, escalated: true },
            { id: "failure", verdict: "error" }
        ]);
        expect(summary).toMatchObject({
            falseAllows: 1,
            falseAlarms: 1,
            errors: 1,
            missing: 1,
            abstentions: 2,
            escalations: 1,
            latencyMs: { measured: 2, p50: 10, p95: 30 },
            costUsd: { knownSubtotal: 0.01, total: null, unknownCases: 2 }
        });
    });
    it("samples random audits before uncertainty without duplicates, while excluding frozen IDs", () => {
        const pool = Array.from({ length: 30 }, (_, i) => ({ id: `candidate-${i}`, reviewProbability: i / 100 }));
        const options = { seed: "seed-1", uncertaintyCount: 3, randomCount: 5 };
        const selected = selectForLabeling(pool, options, ["candidate-5"]);
        expect(selected).toEqual(selectForLabeling([...pool].reverse(), options, ["candidate-5"]));
        expect(selected.selected).toHaveLength(8);
        expect(new Set(selected.selected.map((row) => row.id)).size).toBe(8);
        expect(selected.selected.some((row) => row.id === "candidate-5")).toBe(false);
        const randomOnly = selectForLabeling(pool, { ...options, uncertaintyCount: 0 }, ["candidate-5"]);
        expect(selected.selected.filter((row) => row.sampling === "random-audit")).toEqual(randomOnly.selected);
        const remaining = pool.filter(
            (row) => !selected.selected.some((item) => item.sampling === "random-audit" && item.id === row.id) && row.id !== "candidate-5"
        );
        const nearest = remaining
            .sort((a, b) => Math.abs(a.reviewProbability - 0.05) - Math.abs(b.reviewProbability - 0.05) || a.id.localeCompare(b.id))
            .slice(0, 3);
        expect(selected.selected.filter((row) => row.sampling === "uncertainty").map((row) => row.id)).toEqual(
            nearest.map((row) => row.id)
        );
        expect(() => selectForLabeling([{ ...pool[0], content: "private publication" }], options)).toThrow(/opaque IDs/);
        expect(() => selectForLabeling([pool[0], pool[0]], options)).toThrow();
        expect(selectForLabeling([], options).selected).toEqual([]);
    });
});
