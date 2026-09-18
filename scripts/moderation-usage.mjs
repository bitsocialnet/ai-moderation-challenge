#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const rate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identifier = (value) => (typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? value : "unknown");
const stages = new Set(["jev", "triage", "reviewer"]);
const tokenFields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens"];

export function validateRates(value) {
    if (!record(value) || value.currency !== "USD" || !Array.isArray(value.providers))
        throw new Error("Rates require USD currency and providers array");
    const seen = new Set();
    for (const item of value.providers) {
        if (
            !record(item) ||
            identifier(item.apiHost) !== item.apiHost ||
            identifier(item.model) !== item.model ||
            !rate(item.inputPerMillion) ||
            !rate(item.outputPerMillion) ||
            !["none", "reported"].includes(item.cacheAccounting) ||
            !["included-in-output", "separate"].includes(item.reasoningAccounting) ||
            (item.cacheAccounting === "reported" && (!rate(item.cachedInputPerMillion) || !rate(item.cacheWriteInputPerMillion))) ||
            (item.reasoningAccounting === "separate" && !rate(item.reasoningPerMillion))
        )
            throw new Error("Invalid provider rates or explicit accounting assumptions");
        const key = JSON.stringify([item.apiHost, item.model]);
        if (seen.has(key)) throw new Error("Duplicate provider rates");
        seen.add(key);
    }
    return value;
}

// Unknown cache/reasoning accounting stays unknown. These are estimates from reported
// tokens, not billing reconciliation; failed requests may have unreported charges.
export function estimateCost(attempt, rates) {
    const tariff = rates?.providers.find(
        (item) => item.apiHost === attempt.apiHost && item.model === (attempt.model ?? attempt.requestedModel)
    );
    const usage = attempt.usage;
    if (!tariff || !record(usage) || !count(usage.inputTokens) || !count(usage.outputTokens)) return undefined;
    let cost = usage.inputTokens * tariff.inputPerMillion + usage.outputTokens * tariff.outputPerMillion;
    if (tariff.cacheAccounting === "reported") {
        if (
            !count(usage.cachedInputTokens) ||
            !count(usage.cacheWriteInputTokens) ||
            usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens
        )
            return undefined;
        cost += usage.cachedInputTokens * (tariff.cachedInputPerMillion - tariff.inputPerMillion);
        cost += usage.cacheWriteInputTokens * (tariff.cacheWriteInputPerMillion - tariff.inputPerMillion);
    } else if ((usage.cachedInputTokens ?? 0) !== 0 || (usage.cacheWriteInputTokens ?? 0) !== 0) return undefined;
    if (tariff.reasoningAccounting === "separate") {
        if (!count(usage.reasoningTokens)) return undefined;
        cost += usage.reasoningTokens * tariff.reasoningPerMillion;
    }
    return cost / 1_000_000;
}

export function createUsageReport(rates) {
    if (rates) validateRates(rates);
    const report = {
        version: 1,
        currency: "USD",
        auditEntries: 0,
        ignoredLines: 0,
        providerDecisions: 0,
        auditedCacheHits: 0,
        deterministicDecisions: 0,
        legacyEntriesWithoutAttempts: 0,
        shadowEntries: 0,
        finishedAt: { jev: 0, triage: 0, reviewer: 0, unknown: 0 },
        reached: { jev: 0, triage: 0, reviewer: 0 },
        actions: { approved: 0, queued_for_review: 0, moderation_error: 0 },
        providers: [],
        limitations: [
            "Memory-cache reuse is not logged by the runtime; auditedCacheHits counts disk-cache audit records only.",
            "Latency measures provider attempts, not end-to-end publication latency.",
            "Missing telemetry/rates remain unknown; known cost is a subtotal, not the total bill.",
            "Shadow requests are separately counted; do not combine duplicate or overlapping audit files."
        ]
    };
    const providers = new Map();
    const add = (entry) => {
        if (!record(entry) || entry.version !== 1 || (!["provider", "cache", "rule"].includes(entry.source) && entry.mode !== "shadow")) {
            report.ignoredLines++;
            return;
        }
        report.auditEntries++;
        if (entry.mode === "shadow") report.shadowEntries++;
        else {
            if (Object.hasOwn(report.actions, entry.action)) report.actions[entry.action]++;
            if (entry.source === "cache") {
                report.auditedCacheHits++;
                return;
            }
            if (entry.source === "rule") {
                report.deterministicDecisions++;
                return;
            }
            report.providerDecisions++;
            if (entry.action !== "moderation_error")
                report.finishedAt[stages.has(entry.provider?.stage) ? entry.provider.stage : "unknown"]++;
        }
        if (!Array.isArray(entry.attempts)) {
            report.legacyEntriesWithoutAttempts++;
            return;
        }
        const reached = new Set();
        for (const attempt of entry.attempts) {
            if (!record(attempt) || !stages.has(attempt.stage)) continue;
            reached.add(attempt.stage);
            const apiHost = identifier(attempt.apiHost);
            const model = identifier(attempt.model ?? attempt.requestedModel);
            const mode = entry.mode === "shadow" ? "shadow" : "decision";
            const key = JSON.stringify([mode, attempt.stage, apiHost, model]);
            if (!providers.has(key))
                providers.set(key, {
                    mode,
                    stage: attempt.stage,
                    apiHost,
                    model,
                    requests: 0,
                    errors: 0,
                    throttled: 0,
                    timeouts: 0,
                    timedRequests: 0,
                    totalProviderMs: 0,
                    maxAttemptMs: null,
                    meanAttemptMs: null,
                    reportedTokens: Object.fromEntries(tokenFields.map((field) => [field, { total: 0, requests: 0 }])),
                    estimatedKnownCostUsd: 0,
                    pricedRequests: 0,
                    unknownCostRequests: 0,
                    estimatedTotalCostUsd: null
                });
            const row = providers.get(key);
            row.requests++;
            if (attempt.status !== "ok") row.errors++;
            if (attempt.httpStatus === 429) row.throttled++;
            if (attempt.errorKind === "timeout") row.timeouts++;
            if (rate(attempt.elapsedMs)) {
                row.timedRequests++;
                row.totalProviderMs += attempt.elapsedMs;
                row.maxAttemptMs = Math.max(row.maxAttemptMs ?? 0, attempt.elapsedMs);
            }
            for (const field of tokenFields)
                if (count(attempt.usage?.[field])) {
                    row.reportedTokens[field].total += attempt.usage[field];
                    row.reportedTokens[field].requests++;
                }
            const estimated = estimateCost(attempt, rates);
            if (estimated === undefined) row.unknownCostRequests++;
            else {
                row.estimatedKnownCostUsd += estimated;
                row.pricedRequests++;
            }
        }
        if (entry.mode !== "shadow") for (const stage of reached) report.reached[stage]++;
    };
    const finish = () => {
        report.providers = [...providers.values()].sort((a, b) =>
            JSON.stringify([a.mode, a.stage, a.apiHost, a.model]).localeCompare(JSON.stringify([b.mode, b.stage, b.apiHost, b.model]))
        );
        for (const row of report.providers) {
            row.meanAttemptMs = row.timedRequests ? row.totalProviderMs / row.timedRequests : null;
            row.estimatedTotalCostUsd = row.unknownCostRequests === 0 ? row.estimatedKnownCostUsd : null;
        }
        return report;
    };
    return { add, finish, invalidLine: () => report.ignoredLines++ };
}

export async function usageMain(args) {
    if (args.includes("--help")) {
        console.log(
            "node scripts/moderation-usage.mjs --audit /private/audit.jsonl [--rates rates.json]\nReads locally; prints only aggregate telemetry. No network calls."
        );
        return;
    }
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
        if (!["--audit", "--rates"].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i]))
            throw new Error("Expected --audit PATH [--rates PATH]");
        options[args[i]] = args[i + 1];
    }
    if (!options["--audit"]) throw new Error("--audit is required");
    const report = createUsageReport(options["--rates"] ? JSON.parse(await readFile(options["--rates"], "utf8")) : undefined);
    for await (const line of createInterface({ input: createReadStream(options["--audit"]), crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            report.invalidLine();
            continue;
        }
        report.add(entry);
    }
    console.log(JSON.stringify(report.finish(), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    usageMain(process.argv.slice(2)).catch(() => {
        console.error("Usage report failed. Check input paths, JSON, and rate schema; private data is not printed.");
        process.exitCode = 1;
    });
}
