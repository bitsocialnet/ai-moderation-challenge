#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createUsageReport, estimateCost } from "./moderation-usage.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const label = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const verdicts = ["allow", "review"];
export const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const probability = (value) => nonnegative(value) && value <= 1;
const evaluatedFactories = new WeakSet();
let evaluationActive = false;

const jevContrastExamples = {
    allow: "Boundary example: under a rule prohibiting sale offers, asking how to estimate an object's value is not itself an offer to sell. Apply the actual supplied policy; these illustrations introduce no additional rules.",
    review: "Boundary example: under that same rule, an explicit offer of an object for a stated price crosses the sale-offer rule even if the wording is polite. Mere shared vocabulary or missing context does not establish a violation."
};
export function validateJevRubric(rubric) {
    if (!["baseline", "contrastive"].includes(rubric)) throw new Error("Jev rubric must be baseline or contrastive");
    return rubric;
}

// Evaluation-only transform: production request construction and cache identity are untouched.
export function evaluationJevBody(body, rubric = "baseline") {
    validateJevRubric(rubric);
    if (rubric === "baseline") return body;
    const input = JSON.parse(body);
    const question = input?.questions?.decision;
    if (
        !object(input) ||
        Object.keys(input.questions ?? {}).length !== 1 ||
        question?.type !== "choice" ||
        typeof question.instructions !== "string" ||
        !object(question.criteria) ||
        Object.keys(question.criteria).length !== 2 ||
        verdicts.some((key) => typeof question.criteria[key] !== "string")
    )
        throw new Error("Unsupported Jev request for rubric experiment");
    question.criteria = Object.fromEntries(verdicts.map((key) => [key, `${question.criteria[key]} ${jevContrastExamples[key]}`]));
    return JSON.stringify(input);
}
export function validateObservation(item) {
    if (!object(item) || !label(item.id) || ![...verdicts, "error"].includes(item.verdict)) throw new Error("Invalid observation");
    for (const key of ["elapsedMs", "estimatedCostUsd"])
        if (item[key] !== undefined && item[key] !== null && !nonnegative(item[key])) throw new Error("Invalid observation metric");
    if (item.escalated !== undefined && item.escalated !== null && typeof item.escalated !== "boolean")
        throw new Error("Invalid escalation metric");
    if (
        item.jev !== undefined &&
        item.jev !== null &&
        (!object(item.jev) ||
            !probability(item.jev.reviewProbability) ||
            !probability(item.jev.confidence) ||
            !probability(item.jev.maxReviewProbability) ||
            typeof item.jev.wouldAutoAllow !== "boolean" ||
            (item.jev.wouldAutoAllow && item.jev.reviewProbability > item.jev.maxReviewProbability))
    )
        throw new Error("Invalid Jev evidence");
    return item;
}

export function summarizePredictions(cases, predictions) {
    const indexed = new Map(predictions.map((item) => [item.id, validateObservation(item)]));
    const rows = cases.map((item) => ({ expected: item.expected, prediction: indexed.get(item.id) }));
    const times = rows
        .map((row) => row.prediction?.elapsedMs)
        .filter(nonnegative)
        .sort((a, b) => a - b);
    const costs = rows.map((row) => row.prediction?.estimatedCostUsd);
    const count = (test) => rows.filter(test).length;
    const allows = count((row) => row.expected === "allow"),
        reviews = rows.length - allows;
    const falseAllows = count((row) => row.expected === "review" && row.prediction?.verdict === "allow");
    const falseAlarms = count((row) => row.expected === "allow" && row.prediction?.verdict === "review");
    const missing = count((row) => !row.prediction),
        errors = count((row) => row.prediction?.verdict === "error");
    return {
        cases: rows.length,
        expectedAllows: allows,
        expectedReviews: reviews,
        falseAllows,
        falseAlarms,
        falseAllowRate: reviews ? falseAllows / reviews : null,
        falseAlarmRate: allows ? falseAlarms / allows : null,
        missing,
        errors,
        abstentions: missing + errors,
        escalations: count((row) => row.prediction?.escalated === true),
        unknownEscalations: count((row) => typeof row.prediction?.escalated !== "boolean"),
        latencyMs: {
            measured: times.length,
            p50: times.length ? times[Math.ceil(times.length * 0.5) - 1] : null,
            p95: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null
        },
        costUsd: {
            knownSubtotal: costs.filter(nonnegative).reduce((sum, cost) => sum + cost, 0),
            unknownCases: costs.filter((cost) => !nonnegative(cost)).length,
            total: costs.length && costs.every(nonnegative) ? costs.reduce((sum, cost) => sum + cost, 0) : null
        }
    };
}
export function validateCorpus(corpus) {
    if (!object(corpus) || corpus.version !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length || corpus.cases.length > 1000)
        throw new Error("Invalid corpus");
    const ids = new Set();
    for (const item of corpus.cases) {
        if (
            !object(item) ||
            !label(item.id) ||
            ids.has(item.id) ||
            !verdicts.includes(item.expected) ||
            !["synthetic", "reviewed-real"].includes(item.provenance) ||
            (item.provenance === "reviewed-real" && item.independentlyReviewed !== true) ||
            !Array.isArray(item.rules) ||
            item.rules.some((rule) => typeof rule !== "string") ||
            !object(item.publication) ||
            !["post", "reply", "commentEdit"].includes(item.publication.kind) ||
            typeof item.rationale !== "string" ||
            !item.rationale.trim()
        )
            throw new Error("Invalid case or missing label provenance");
        if (
            item.publication.kind === "commentEdit" &&
            (typeof item.publication.content !== "string" ||
                ["title", "link", "linkHtmlTagName"].some((key) => Object.hasOwn(item.publication, key)))
        )
            throw new Error("Content-edit cases require string content and cannot include ignored title/link fields");
        const publicationFields = new Set(["kind", "content", "title", "link", "linkHtmlTagName", "timestamp"]);
        if (Object.keys(item.publication).some((key) => !publicationFields.has(key)))
            throw new Error("Unsupported or identifying publication field");
        for (const key of ["content", "title", "link", "linkHtmlTagName"])
            if (item.publication[key] !== undefined && typeof item.publication[key] !== "string")
                throw new Error("Invalid publication text");
        if (
            item.publication.timestamp !== undefined &&
            (!Number.isSafeInteger(item.publication.timestamp) || item.publication.timestamp < 0)
        )
            throw new Error("Invalid timestamp");
        if (
            item.articleMaxAgeHours !== undefined &&
            (typeof item.articleMaxAgeHours !== "number" ||
                !Number.isFinite(item.articleMaxAgeHours) ||
                item.articleMaxAgeHours <= 0 ||
                item.articleMaxAgeHours > 876000)
        )
            throw new Error("Invalid configured age");
        ids.add(item.id);
    }
    return corpus;
}
export function comparePredictions(corpus, predictions) {
    validateCorpus(corpus);
    if (!Array.isArray(predictions)) throw new Error("Predictions must be an array");
    const indexed = new Map();
    for (const prediction of predictions) {
        if (
            !object(prediction) ||
            !label(prediction.id) ||
            indexed.has(prediction.id) ||
            ![...verdicts, "error"].includes(prediction.verdict) ||
            !corpus.cases.some((item) => item.id === prediction.id)
        )
            throw new Error("Invalid or duplicate prediction");
        validateObservation(prediction);
        indexed.set(prediction.id, prediction.verdict);
    }
    const rows = corpus.cases.map((item) => ({
        id: item.id,
        provenance: item.provenance,
        expected: item.expected,
        actual: indexed.get(item.id) ?? "missing",
        correct: indexed.get(item.id) === item.expected
    }));
    return {
        cases: rows.length,
        correct: rows.filter((item) => item.correct).length,
        falseAllows: rows.filter((item) => item.expected === "review" && item.actual === "allow").length,
        falseReviews: rows.filter((item) => item.expected === "allow" && item.actual === "review").length,
        errors: rows.filter((item) => item.actual === "error").length,
        missing: rows.filter((item) => item.actual === "missing").length,
        rows,
        metricsByProvenance: Object.fromEntries(
            ["synthetic", "reviewed-real"].map((provenance) => [
                provenance,
                summarizePredictions(
                    corpus.cases.filter((item) => item.provenance === provenance),
                    predictions
                )
            ])
        )
    };
}
export function validateProfile(profile, env = process.env) {
    if (!object(profile) || !label(profile.id) || !object(profile.options)) throw new Error("Profile requires id and options");
    const options = { ...profile.options };
    if (options.jevMode === "shadow") throw new Error("Evaluation profiles cannot start unawaited shadow requests");
    const allowed = new Set([
        "apiUrl",
        "apiFormat",
        "model",
        "fallbackModel",
        "reasoningEffort",
        "triageApiUrl",
        "triageApiFormat",
        "triageModel",
        "triageReasoningEffort",
        "jevMode",
        "jevApiUrl",
        "jevModel",
        "jevMaxReviewProbability"
    ]);
    if (Object.keys(options).some((key) => !allowed.has(key)) || Object.values(options).some((value) => typeof value !== "string"))
        throw new Error("Profile accepts only documented string provider options; use environment references for secrets");
    for (const key of ["apiUrl", "triageApiUrl", "jevApiUrl"])
        if (options[key]) {
            const url = new URL(options[key]);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
                throw new Error("Profile URLs must use HTTPS without embedded credentials/query");
        }
    for (const key of ["apiKey", "triageApiKey", "jevApiKey"]) {
        const name = profile[`${key}Env`];
        if (name !== undefined) {
            if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(name) || !env[name])
                throw new Error("Missing or invalid credential environment reference");
            options[key] = env[name];
        }
    }
    return options;
}

export async function liveEvaluation(
    corpus,
    profile,
    {
        maxRequests,
        maxRequestBytes,
        factory,
        fetchImpl = globalThis.fetch,
        env = process.env,
        rates,
        runtimeSha256 = null,
        jevRubric = "baseline"
    }
) {
    validateCorpus(corpus);
    validateJevRubric(jevRubric);
    if (
        !Number.isInteger(maxRequests) ||
        maxRequests < 1 ||
        maxRequests > 1000 ||
        !Number.isInteger(maxRequestBytes) ||
        maxRequestBytes < 1 ||
        maxRequestBytes > 10_000_000
    )
        throw new Error("Explicit request/byte budgets required");
    const options = validateProfile(profile, env);
    const jevEndpoint = options.jevApiUrl ?? "https://api.typesafe.ai/v1/systemone";
    if (
        jevRubric === "contrastive" &&
        (options.jevMode !== "triage" || jevEndpoint.replace(/\/$/, "") !== "https://api.typesafe.ai/v1/systemone")
    )
        throw new Error("Contrastive trial requires Jev triage at the official TypeSafe endpoint");
    const jevQuestionHashes = new Set();
    const usage = createUsageReport(rates);
    // The runtime owns a module-global decision cache; factory() does not clear it.
    // The fetch wrapper is also process-global, so evaluations must not overlap.
    if (typeof factory !== "function" || evaluatedFactories.has(factory) || evaluationActive)
        throw new Error("Run each evaluation in a separate process with a fresh runtime factory");
    evaluatedFactories.add(factory);
    evaluationActive = true;
    let root;
    try {
        root = await mkdtemp(join(tmpdir(), "bitsocial-moderation-eval-"));
    } catch (error) {
        evaluationActive = false;
        throw error;
    }
    const originalFetch = globalThis.fetch;
    let requests = 0,
        requestBytes = 0,
        budgetExceeded = false;
    const predictions = [];
    const observedOutcomes = new Map();
    try {
        globalThis.fetch = async (url, init) => {
            if (jevRubric === "contrastive" && String(url).replace(/\/$/, "") === jevEndpoint.replace(/\/$/, "")) {
                const body = evaluationJevBody(init?.body, jevRubric);
                jevQuestionHashes.add(sha256(JSON.parse(body).questions));
                init = { ...init, body };
            }
            const bytes = Buffer.byteLength(typeof init?.body === "string" ? init.body : "");
            if (requests >= maxRequests || requestBytes + bytes > maxRequestBytes) {
                budgetExceeded = true;
                throw new Error("Evaluation request budget exhausted");
            }
            requests++;
            requestBytes += bytes;
            return fetchImpl(url, { ...init, redirect: "error" });
        };
        const challenge = factory({});
        for (const [index, item] of corpus.cases.entries()) {
            if (budgetExceeded) break;
            const { kind, ...publication } = item.publication;
            const auditLogPath = join(root, `${index}.jsonl`);
            // Match the normalized publication fields, not case IDs or source object key order.
            const inputKey = JSON.stringify([
                kind,
                publication.content,
                kind === "commentEdit" ? null : publication.title,
                kind === "commentEdit" ? null : publication.link,
                kind === "commentEdit" ? null : publication.linkHtmlTagName,
                publication.timestamp,
                item.rules,
                item.articleMaxAgeHours
            ]);
            const started = performance.now();
            const result = await challenge.getChallenge({
                challengeSettings: {
                    options: {
                        ...options,
                        branch: "allow",
                        cachePath: "",
                        auditLogPath,
                        ...(item.articleMaxAgeHours === undefined ? {} : { articleMaxAgeHours: String(item.articleMaxAgeHours) })
                    }
                },
                challengeIndex: 0,
                challengeRequestMessage:
                    kind === "commentEdit"
                        ? { commentEdit: { ...publication, commentCid: "synthetic-edited-comment" } }
                        : {
                              comment: {
                                  ...publication,
                                  ...(kind === "reply" ? { parentCid: "synthetic-parent", postCid: "synthetic-post" } : {})
                              }
                          },
                community: { address: "moderation-evaluation.example", title: "Moderation evaluation", rules: item.rules }
            });
            let entries = [];
            try {
                entries = (await readFile(auditLogPath, "utf8"))
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
            } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
            for (const entry of entries) usage.add(entry);
            const action = entries.at(-1)?.action;
            const verdict =
                action === "moderation_error" || budgetExceeded
                    ? "error"
                    : !entries.length && observedOutcomes.has(inputKey)
                      ? observedOutcomes.get(inputKey).verdict
                      : result.success
                        ? "allow"
                        : entries.length
                          ? "review"
                          : "error";
            const cached = !entries.length ? observedOutcomes.get(inputKey) : undefined;
            const attempts = entries.filter((entry) => entry.source === "provider").flatMap((entry) => entry.attempts ?? []);
            const decision = attempts.findLast(
                (attempt) => attempt.stage === "jev" && attempt.status === "ok" && attempt.jevDecision
            )?.jevDecision;
            const costs = attempts.map((attempt) => estimateCost(attempt, rates));
            const prediction = {
                id: item.id,
                verdict,
                elapsedMs: performance.now() - started,
                escalated:
                    cached?.escalated ??
                    (entries.length ? attempts.some((attempt) => attempt.stage === "triage" || attempt.stage === "reviewer") : null),
                memoryCacheHit: Boolean(cached),
                estimatedCostUsd:
                    cached || entries.at(-1)?.source === "rule"
                        ? 0
                        : attempts.length && costs.every(nonnegative)
                          ? costs.reduce((sum, cost) => sum + cost, 0)
                          : null,
                jev: decision
                    ? {
                          reviewProbability: decision.reviewProbability,
                          confidence: decision.confidence,
                          maxReviewProbability: decision.maxReviewProbability,
                          wouldAutoAllow: decision.wouldAutoAllow
                      }
                    : (cached?.jev ?? null)
            };
            observedOutcomes.set(inputKey, prediction);
            predictions.push(prediction);
        }
    } finally {
        globalThis.fetch = originalFetch;
        evaluationActive = false;
        await rm(root, { recursive: true, force: true });
    }
    return {
        version: 1,
        mode: "live",
        profile: profile.id,
        budgetExceeded,
        requests,
        requestBytes,
        corpusSha256: sha256(corpus),
        profileSha256: sha256(
            jevRubric === "baseline" ? profile.options : { options: profile.options, jevRubric, examples: jevContrastExamples }
        ),
        jevRubric,
        ...(jevRubric === "contrastive"
            ? {
                  rubricExperiment: {
                      version: 1,
                      examplesSha256: sha256(jevContrastExamples),
                      questionHashes: [...jevQuestionHashes],
                      note: "Evaluation-only authored contrasts; not human-calibrated. Runtime policy and thresholds are unchanged."
                  }
              }
            : {}),
        jevModel: /^jev-\d+\.\d+\.\d+$/.test(options.jevModel ?? "") ? options.jevModel : null,
        runtimeSha256,
        predictions,
        comparison: comparePredictions(corpus, predictions),
        usage: usage.finish()
    };
}

export async function evaluationMain(args) {
    if (args.includes("--help")) {
        console.log(
            "node scripts/moderation-evaluate.mjs [--corpus evaluations/moderation-corpus.json] [--predictions predictions.json]\nLive (opt-in): --live --profile profile.json --max-requests N --max-request-bytes N [--rates rates.json] [--jev-rubric baseline|contrastive]\nDefault validates corpus offline. Live mode requires a fresh build and credential environment variables."
        );
        return;
    }
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (Object.hasOwn(flags, flag)) throw new Error("Duplicate flag");
        if (flag === "--live") flags[flag] = true;
        else if (
            ["--corpus", "--predictions", "--profile", "--max-requests", "--max-request-bytes", "--rates", "--jev-rubric"].includes(flag) &&
            args[i + 1]
        )
            flags[flag] = args[++i];
        else throw new Error("Unknown flag or missing value");
    }
    validateJevRubric(flags["--jev-rubric"] ?? "baseline");
    if (!flags["--live"] && ["--profile", "--max-requests", "--max-request-bytes", "--rates", "--jev-rubric"].some((flag) => flags[flag]))
        throw new Error("Live settings require --live");
    if (flags["--live"] && flags["--predictions"]) throw new Error("Choose live or saved predictions");
    const corpus = validateCorpus(
        JSON.parse(await readFile(flags["--corpus"] ?? new URL("../evaluations/moderation-corpus.json", import.meta.url), "utf8"))
    );
    let result;
    if (flags["--live"]) {
        if (!flags["--profile"]) throw new Error("Live profile is required");
        const profile = JSON.parse(await readFile(flags["--profile"], "utf8"));
        const { default: factory } = await import("../dist/index.js");
        result = await liveEvaluation(corpus, profile, {
            maxRequests: Number(flags["--max-requests"]),
            maxRequestBytes: Number(flags["--max-request-bytes"]),
            factory,
            jevRubric: flags["--jev-rubric"] ?? "baseline",
            rates: flags["--rates"] ? JSON.parse(await readFile(flags["--rates"], "utf8")) : undefined,
            runtimeSha256: createHash("sha256")
                .update(await readFile(new URL("../dist/index.js", import.meta.url)))
                .digest("hex")
        });
    } else if (flags["--predictions"])
        result = {
            mode: "offline-comparison",
            comparison: comparePredictions(corpus, JSON.parse(await readFile(flags["--predictions"], "utf8")))
        };
    else
        result = {
            mode: "offline-validation",
            cases: corpus.cases.length,
            syntheticCases: corpus.cases.filter((item) => item.provenance === "synthetic").length,
            reviewedRealCases: corpus.cases.filter((item) => item.provenance === "reviewed-real").length,
            message: "Corpus shape validated; no model accuracy or API performance result is claimed."
        };
    console.log(JSON.stringify(result, null, 2));
    if (
        result.comparison &&
        (result.comparison.errors || result.comparison.missing || result.comparison.falseAllows || result.comparison.falseReviews)
    )
        process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    evaluationMain(process.argv.slice(2)).catch(() => {
        console.error("Evaluation failed. Check corpus, profile, budgets, environment, and build; private data is not printed.");
        process.exitCode = 1;
    });
}
