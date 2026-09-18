import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createUsageReport, estimateCost, validateRates } from "../scripts/moderation-usage.mjs";
import { comparePredictions, liveEvaluation, validateCorpus, validateProfile } from "../scripts/moderation-evaluate.mjs";

const rates = {
    currency: "USD",
    providers: [
        {
            apiHost: "provider.example",
            model: "model",
            inputPerMillion: 2,
            outputPerMillion: 4,
            cacheAccounting: "reported",
            cachedInputPerMillion: 0.2,
            cacheWriteInputPerMillion: 2.5,
            reasoningAccounting: "included-in-output"
        }
    ]
};
const attempt = {
    stage: "triage",
    apiHost: "provider.example",
    requestedModel: "model",
    status: "ok",
    elapsedMs: 20,
    usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 600, cacheWriteInputTokens: 200 }
};
const provider = { stage: "triage", apiHost: "provider.example", model: "model" };
const corpus = {
    version: 1,
    cases: [
        {
            id: "synthetic-allow",
            provenance: "synthetic",
            rationale: "Ordinary question.",
            expected: "allow",
            rules: ["No spam"],
            publication: { kind: "post", content: "A gardening question." }
        }
    ]
};

describe("offline moderation usage report", () => {
    it("ignores cached attempts, counts retry failures and preserves unknown costs without leaking fields", () => {
        const report = createUsageReport(rates);
        report.add({
            version: 1,
            source: "provider",
            action: "approved",
            provider,
            publication: { content: "private publication" },
            apiKey: "private-key",
            attempts: [{ ...attempt, status: "error", httpStatus: 429, usage: undefined }, attempt]
        });
        report.add({ version: 1, source: "cache", action: "approved", attempts: [attempt] });
        report.add({
            version: 1,
            source: "provider",
            action: "moderation_error",
            provider,
            attempts: [{ ...attempt, status: "error", errorKind: "timeout", usage: undefined }]
        });
        report.add({ version: 1, source: "rule", action: "queued_for_review" });
        report.add({ version: 1, source: "provider", action: "approved", provider: { ...provider, stage: "reviewer" } });
        const result = report.finish();
        expect(result).toMatchObject({
            auditedCacheHits: 1,
            providerDecisions: 3,
            deterministicDecisions: 1,
            legacyEntriesWithoutAttempts: 1,
            reached: { triage: 2 },
            providers: [
                {
                    requests: 3,
                    throttled: 1,
                    timeouts: 1,
                    pricedRequests: 1,
                    unknownCostRequests: 2,
                    estimatedTotalCostUsd: null,
                    reportedTokens: { inputTokens: { total: 1000, requests: 1 } }
                }
            ]
        });
        expect(JSON.stringify(result)).not.toContain("private");
        expect(result.providers[0].estimatedKnownCostUsd).toBeCloseTo(0.00142);
    });
    it("does not fabricate missing token decomposition, rates, or reasoning billing", () => {
        expect(estimateCost({ ...attempt, usage: { inputTokens: 1000, outputTokens: 10 } }, rates)).toBeUndefined();
        expect(estimateCost(attempt)).toBeUndefined();
        expect(estimateCost({ ...attempt, usage: { ...attempt.usage, cachedInputTokens: 1001 } }, rates)).toBeUndefined();
        expect(() => validateRates({ ...rates, providers: [{ ...rates.providers[0], outputPerMillion: -1 }] })).toThrow();
        expect(() => validateRates({ ...rates, providers: [{ ...rates.providers[0], reasoningAccounting: "guess" }] })).toThrow();
    });
    it("ignores malformed audit records while retaining valid legacy provider entries", () => {
        const report = createUsageReport();
        for (const entry of [
            { version: 1, source: "provider" },
            { version: 1, source: "provider", action: "approved" },
            { version: 1, source: "provider", action: "approved", provider: { stage: "triage" } },
            { version: 1, source: "provider", action: "bogus", provider },
            { version: 1, source: "cache" },
            { version: 1, mode: "shadow" }
        ])
            report.add(entry);
        report.add({ version: 1, source: "provider", action: "approved", provider });
        report.add({
            version: 1,
            source: "provider",
            action: "queued_for_review",
            provider: { apiHost: "legacy.example", model: "legacy" }
        });
        expect(report.finish()).toMatchObject({
            ignoredLines: 6,
            auditEntries: 2,
            providerDecisions: 2,
            legacyEntriesWithoutAttempts: 2,
            finishedAt: { triage: 1, unknown: 1 },
            providers: []
        });
    });
    it("keeps shadow usage separate from decision funnels and validates input lines", () => {
        const report = createUsageReport();
        report.add({ version: 1, mode: "shadow", attempts: [{ ...attempt, stage: "jev" }] });
        report.add({ publication: "unrelated record" });
        report.invalidLine();
        expect(report.finish()).toMatchObject({
            shadowEntries: 1,
            providerDecisions: 0,
            ignoredLines: 2,
            reached: { jev: 0 },
            providers: [{ mode: "shadow", stage: "jev", unknownCostRequests: 1 }]
        });
    });
});

describe("repeatable moderation evaluation", () => {
    it("validates the committed synthetic corpus without requests", async () => {
        const body = JSON.parse(await readFile(new URL("../evaluations/moderation-corpus.json", import.meta.url), "utf8"));
        expect(validateCorpus(body).cases).toHaveLength(12);
        expect(body.cases.every((item: { provenance: string }) => item.provenance === "synthetic")).toBe(true);
    });
    it("requires independent real-label provenance and disallows identifying publication fields", () => {
        expect(() => validateCorpus({ ...corpus, cases: [{ ...corpus.cases[0], provenance: "reviewed-real" }] })).toThrow();
        expect(() =>
            validateCorpus({
                ...corpus,
                cases: [{ ...corpus.cases[0], publication: { ...corpus.cases[0].publication, author: "private" } }]
            })
        ).toThrow();
    });
    it("rejects edit fixtures that bypass moderation or include ignored link/title fields", () => {
        for (const publication of [
            { kind: "commentEdit" },
            { kind: "commentEdit", link: "https://article.example/story" },
            { kind: "commentEdit", content: "Changed text", title: "Ignored" },
            { kind: "commentEdit", content: "Changed text", link: "https://article.example/story" },
            { kind: "commentEdit", content: "Changed text", linkHtmlTagName: "img" }
        ])
            expect(() => validateCorpus({ ...corpus, cases: [{ ...corpus.cases[0], publication }] })).toThrow(/Content-edit cases/);
        expect(
            validateCorpus({ ...corpus, cases: [{ ...corpus.cases[0], publication: { kind: "commentEdit", content: "Changed text" } }] })
                .cases
        ).toHaveLength(1);
    });
    it("reports missing and wrong labels separately and rejects unknown predictions", () => {
        expect(comparePredictions(corpus, [])).toMatchObject({ missing: 1, falseReviews: 0, correct: 0 });
        expect(comparePredictions(corpus, [{ id: "synthetic-allow", verdict: "review" }])).toMatchObject({
            missing: 0,
            falseReviews: 1,
            correct: 0
        });
        expect(() => comparePredictions(corpus, [{ id: "unknown", verdict: "allow" }])).toThrow();
    });
    it("requires environment credentials and explicit safe provider settings", () => {
        expect(() => validateProfile({ id: "x", options: { apiKey: "secret" } })).toThrow();
        expect(() => validateProfile({ id: "x", options: { apiUrl: "https://provider.example?key=secret" } })).toThrow();
        expect(() => validateProfile({ id: "x", options: {}, apiKeyEnv: "MISSING" }, {})).toThrow();
    });
    it("reuses established review labels for memory-cache duplicates without duplicating usage", async () => {
        const cases = [0, 1].map((index) => ({ ...corpus.cases[0], id: `repeat-${index}`, expected: "review" }));
        let calls = 0;
        const result = await liveEvaluation(
            { ...corpus, cases },
            { id: "repeat", options: {} },
            {
                maxRequests: 2,
                maxRequestBytes: 100,
                factory: () => ({
                    getChallenge: async ({ challengeSettings }) => {
                        if (calls++ === 0)
                            await writeFile(
                                challengeSettings.options.auditLogPath,
                                JSON.stringify({
                                    version: 1,
                                    source: "provider",
                                    action: "queued_for_review",
                                    provider,
                                    attempts: [attempt]
                                }) + "\n"
                            );
                        return { success: false };
                    }
                })
            }
        );
        expect(result.comparison).toMatchObject({ correct: 2, errors: 0 });
        expect(result.usage.providers[0].requests).toBe(1);
    });
    it("enforces live request budgets across cascades and removes temporary audit content", async () => {
        const original = globalThis.fetch;
        const fetch = vi.fn(async () => new Response("{}"));
        let path: string | undefined;
        const result = await liveEvaluation(
            corpus,
            { id: "test", options: {} },
            {
                maxRequests: 1,
                maxRequestBytes: 20,
                fetchImpl: fetch,
                factory: () => ({
                    getChallenge: async ({ challengeSettings }: { challengeSettings: { options: { auditLogPath: string } } }) => {
                        path = challengeSettings.options.auditLogPath;
                        await globalThis.fetch("https://provider.example", { body: "x", method: "POST" });
                        await expect(globalThis.fetch("https://provider.example", { body: "x", method: "POST" })).rejects.toThrow("budget");
                        await writeFile(
                            path,
                            JSON.stringify({
                                version: 1,
                                source: "provider",
                                action: "moderation_error",
                                provider,
                                publication: "PRIVATE_CORPUS_TEXT",
                                attempts: []
                            }) + "\n"
                        );
                        return { success: false, error: "PRIVATE_ERROR" };
                    }
                })
            }
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ requests: 1, budgetExceeded: true, comparison: { errors: 1 } });
        expect(JSON.stringify(result)).not.toContain("PRIVATE");
        expect(globalThis.fetch).toBe(original);
        await expect(readFile(path!)).rejects.toThrow();
    });
});
