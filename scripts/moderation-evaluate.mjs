#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createUsageReport } from "./moderation-usage.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const label = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const verdicts = ["allow", "review"];
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
        rows
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
    { maxRequests, maxRequestBytes, factory, fetchImpl = globalThis.fetch, env = process.env }
) {
    validateCorpus(corpus);
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
    const root = await mkdtemp(join(tmpdir(), "bitsocial-moderation-eval-"));
    const originalFetch = globalThis.fetch;
    let requests = 0,
        requestBytes = 0,
        budgetExceeded = false;
    const usage = createUsageReport();
    const predictions = [];
    const observedOutcomes = new Map();
    try {
        globalThis.fetch = async (url, init) => {
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
                      ? observedOutcomes.get(inputKey)
                      : result.success
                        ? "allow"
                        : entries.length
                          ? "review"
                          : "error";
            observedOutcomes.set(inputKey, verdict);
            predictions.push({ id: item.id, verdict });
        }
    } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
    }
    return {
        version: 1,
        mode: "live",
        profile: profile.id,
        budgetExceeded,
        requests,
        requestBytes,
        corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
        comparison: comparePredictions(corpus, predictions),
        usage: usage.finish()
    };
}

export async function evaluationMain(args) {
    if (args.includes("--help")) {
        console.log(
            "node scripts/moderation-evaluate.mjs [--corpus evaluations/moderation-corpus.json] [--predictions predictions.json]\nLive (opt-in): --live --profile profile.json --max-requests N --max-request-bytes N\nDefault validates corpus offline. Live mode requires a fresh build and credential environment variables."
        );
        return;
    }
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (Object.hasOwn(flags, flag)) throw new Error("Duplicate flag");
        if (flag === "--live") flags[flag] = true;
        else if (["--corpus", "--predictions", "--profile", "--max-requests", "--max-request-bytes"].includes(flag) && args[i + 1])
            flags[flag] = args[++i];
        else throw new Error("Unknown flag or missing value");
    }
    if (!flags["--live"] && ["--profile", "--max-requests", "--max-request-bytes"].some((flag) => flags[flag]))
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
            factory
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
