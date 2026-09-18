import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({ loggerMock: Object.assign(vi.fn(), { error: vi.fn(), trace: vi.fn() }) }));
vi.mock("@pkcprotocol/pkc-logger", () => ({ default: () => loggerMock }));

const community = { address: "usage-test.bitsocial.net", rules: ["No spam"] } as unknown as LocalCommunity;
const request = (content: string) =>
    ({ comment: { content, parentCid: "parent-1", postCid: "post-1" } }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lunaResponse = () =>
    response({
        model: "gpt-5.6-luna",
        output_text: JSON.stringify({ verdict: "review", reason: "possible spam", matchedRuleIndexes: [0] }),
        usage: {
            input_tokens: 3000,
            output_tokens: 40,
            input_tokens_details: { cached_tokens: 2500, cache_write_tokens: 400 },
            output_tokens_details: { reasoning_tokens: 0 },
            private_prompt: "unknown-usage-field"
        }
    });
const grokResponse = () =>
    response({
        model: "grok-4.6",
        choices: [
            {
                message: {
                    content: JSON.stringify({ verdict: "allow", reason: "no clear violation", matchedRuleIndexes: [] }),
                    reasoning_content: "private-model-reasoning"
                }
            }
        ],
        usage: {
            prompt_tokens: 3100,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 2000 },
            completion_tokens_details: { reasoning_tokens: 94 },
            cost_in_usd_ticks: 10000
        },
        headers: { authorization: "private-response-header" }
    });
const stubFetch = (...responses: Response[]) => {
    const mock = vi.fn();
    for (const value of responses) mock.mockResolvedValueOnce(value);
    vi.stubGlobal("fetch", mock);
    return mock;
};
const settings = (auditLogPath: string, overrides: Record<string, unknown> = {}) =>
    ({
        options: {
            apiUrl: "https://api.x.ai/v1/chat/completions",
            apiFormat: "chat-completions",
            apiKey: "reviewer-private-key",
            model: "grok-4.6",
            reasoningEffort: "high",
            triageApiUrl: "https://api.openai.com/v1/responses",
            triageApiFormat: "responses",
            triageApiKey: "triage-private-key",
            triageModel: "gpt-5.6-luna",
            triageReasoningEffort: "none",
            prompt: "private-policy-sentinel",
            cachePath: "",
            auditLogPath,
            ...overrides
        }
    }) as CommunityChallengeSetting;
const challenge = async () => {
    const { default: factory } = await import("../src/index.js");
    return factory({} as CommunityChallengeSetting);
};
const readAudit = async (path: string) =>
    (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
const capturedLogs = () =>
    JSON.stringify([loggerMock.mock.calls, loggerMock.error.mock.calls, loggerMock.trace.mock.calls], (_key, value: unknown) =>
        value instanceof Error ? { message: value.message, stack: value.stack } : value
    );

let tempDir: string;
let auditLogPath: string;
beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "bitsocial-provider-usage-"));
    auditLogPath = join(tempDir, "audit.jsonl");
});
afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
});

describe("private audit provider usage", () => {
    it("records sanitized Luna and Grok attempts with separate reasoning counts", async () => {
        const fetchMock = stubFetch(lunaResponse(), grokResponse());
        const result = await (
            await challenge()
        ).getChallenge({
            challengeSettings: settings(auditLogPath),
            challengeRequestMessage: request("ordinary reply"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const entries = await readAudit(auditLogPath);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ source: "provider", action: "approved", provider: { stage: "reviewer", model: "grok-4.6" } });
        expect(entries[0]!.attempts).toEqual([
            {
                stage: "triage",
                apiHost: "api.openai.com",
                apiFormat: "responses",
                requestedModel: "gpt-5.6-luna",
                model: "gpt-5.6-luna",
                startedAt: expect.any(String),
                elapsedMs: expect.any(Number),
                status: "ok",
                httpStatus: 200,
                verdict: "review",
                usage: { inputTokens: 3000, outputTokens: 40, cachedInputTokens: 2500, cacheWriteInputTokens: 400, reasoningTokens: 0 }
            },
            {
                stage: "reviewer",
                apiHost: "api.x.ai",
                apiFormat: "chat-completions",
                requestedModel: "grok-4.6",
                model: "grok-4.6",
                startedAt: expect.any(String),
                elapsedMs: expect.any(Number),
                status: "ok",
                httpStatus: 200,
                verdict: "allow",
                usage: { inputTokens: 3100, outputTokens: 30, cachedInputTokens: 2000, reasoningTokens: 94 }
            }
        ]);
        for (const attempt of entries[0]!.attempts as Array<Record<string, unknown>>) {
            expect(Number.isSafeInteger(attempt.elapsedMs)).toBe(true);
            expect(attempt.elapsedMs).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(Date.parse(attempt.startedAt as string))).toBe(true);
        }
        const audit = JSON.stringify(entries);
        for (const secret of [
            "triage-private-key",
            "reviewer-private-key",
            "private-policy-sentinel",
            "unknown-usage-field",
            "private-model-reasoning",
            "private-response-header",
            "cost_in_usd_ticks"
        ])
            expect(audit).not.toContain(secret);
    });

    it("records all three attempts for Luna escalation and reviewer 429 fallback", async () => {
        const fetchMock = stubFetch(lunaResponse(), response({ error: { message: "private-rate-limit-body" } }, 429), grokResponse());
        const result = await (
            await challenge()
        ).getChallenge({
            challengeSettings: settings(auditLogPath, { fallbackModel: "grok-fallback" }),
            challengeRequestMessage: request("fallback reply"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [entry] = await readAudit(auditLogPath);
        expect(entry).toMatchObject({ provider: { model: "grok-fallback", fallbackFromModel: "grok-4.6" } });
        expect(entry!.attempts).toEqual([
            expect.objectContaining({
                stage: "triage",
                requestedModel: "gpt-5.6-luna",
                status: "ok",
                httpStatus: 200,
                usage: { inputTokens: 3000, outputTokens: 40, cachedInputTokens: 2500, cacheWriteInputTokens: 400, reasoningTokens: 0 }
            }),
            {
                stage: "reviewer",
                apiHost: "api.x.ai",
                apiFormat: "chat-completions",
                requestedModel: "grok-4.6",
                startedAt: expect.any(String),
                elapsedMs: expect.any(Number),
                status: "error",
                httpStatus: 429,
                errorKind: "http"
            },
            expect.objectContaining({
                stage: "reviewer",
                requestedModel: "grok-fallback",
                status: "ok",
                httpStatus: 200,
                usage: { inputTokens: 3100, outputTokens: 30, cachedInputTokens: 2000, reasoningTokens: 94 }
            })
        ]);
        expect(JSON.stringify(entry) + capturedLogs()).not.toContain("private-rate-limit-body");
        expect(JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)).toMatchObject({ model: "grok-fallback" });
    });

    it("retains returned usage when a successful HTTP response has an invalid verdict", async () => {
        stubFetch(
            response({
                model: "grok-4.6",
                choices: [{ message: { content: '{"verdict":"invalid"}' } }],
                usage: { prompt_tokens: 500, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 94 } }
            })
        );
        const result = await (
            await challenge()
        ).getChallenge({
            challengeSettings: settings(auditLogPath, { triageModel: "" }),
            challengeRequestMessage: request("invalid response reply"),
            challengeIndex: 1,
            community
        });

        expect(result.success).toBe(false);
        const [entry] = await readAudit(auditLogPath);
        expect(entry).toMatchObject({ source: "provider", action: "moderation_error" });
        expect(entry!.attempts).toEqual([
            {
                stage: "reviewer",
                apiHost: "api.x.ai",
                apiFormat: "chat-completions",
                requestedModel: "grok-4.6",
                model: "grok-4.6",
                startedAt: expect.any(String),
                elapsedMs: expect.any(Number),
                status: "error",
                httpStatus: 200,
                errorKind: "invalid-response",
                usage: { inputTokens: 500, outputTokens: 10, reasoningTokens: 94 }
            }
        ]);
    });

    it("does not replay provider attempt charges when loading a persisted verdict", async () => {
        const fetchMock = stubFetch(lunaResponse(), grokResponse());
        const challengeSettings = settings(auditLogPath, { cachePath: join(tempDir, "cache.json") });
        const args = { challengeSettings, challengeRequestMessage: request("cached reply"), challengeIndex: 1, community };
        expect(await (await challenge()).getChallenge(args)).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        vi.resetModules();
        const cachedFetch = vi.fn().mockRejectedValue(new Error("unexpected provider call for cached verdict"));
        vi.stubGlobal("fetch", cachedFetch);
        expect(await (await challenge()).getChallenge(args)).toEqual({ success: true });
        expect(cachedFetch).not.toHaveBeenCalled();

        const entries = await readAudit(auditLogPath);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
            source: "provider",
            attempts: [expect.objectContaining({ usage: expect.any(Object) }), expect.objectContaining({ usage: expect.any(Object) })]
        });
        expect(entries[1]).toMatchObject({ source: "cache", action: "approved", provider: { model: "grok-4.6" } });
        expect(entries[1]).not.toHaveProperty("attempts");
        expect(entries[1]).not.toHaveProperty("usage");
        expect(await readFile(join(tempDir, "cache.json"), "utf8")).not.toContain("inputTokens");
    });

    it("excludes secrets echoed by HTTP errors from the audit, result and logger", async () => {
        const secrets = ["reviewer-private-key", "triage-private-key", "private-policy-sentinel", "private-provider-error-body"];
        stubFetch(
            response(
                {
                    error: { message: secrets.join(" ") },
                    usage: { prompt_tokens: 100, completion_tokens: 10 },
                    headers: { authorization: secrets[0] }
                },
                503
            )
        );
        const result = await (
            await challenge()
        ).getChallenge({
            challengeSettings: settings(auditLogPath, { triageModel: "" }),
            challengeRequestMessage: request("provider error reply"),
            challengeIndex: 1,
            community
        });

        expect(result.success).toBe(false);
        const [entry] = await readAudit(auditLogPath);
        expect(entry).toMatchObject({ action: "moderation_error", error: "AI moderation API error (503)" });
        expect(entry!.attempts).toEqual([
            {
                stage: "reviewer",
                apiHost: "api.x.ai",
                apiFormat: "chat-completions",
                requestedModel: "grok-4.6",
                startedAt: expect.any(String),
                elapsedMs: expect.any(Number),
                status: "error",
                httpStatus: 503,
                errorKind: "http"
            }
        ]);
        const captured = JSON.stringify({ entry, result }) + capturedLogs();
        for (const secret of secrets) expect(captured).not.toContain(secret);
        expect(loggerMock.error).toHaveBeenCalled();
    });
});
