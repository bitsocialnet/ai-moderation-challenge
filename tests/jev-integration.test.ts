import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory from "../src/index.js";

vi.mock("@pkcprotocol/pkc-logger", () => ({ default: () => Object.assign(vi.fn(), { error: vi.fn(), trace: vi.fn() }) }));

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const LUNA_URL = "https://api.openai.com/v1/responses";
const GROK_URL = "https://api.x.ai/v1/chat/completions";
const PRIVATE_PROMPT = "Synthetic private policy: review clear spam violations.";
const community = { address: "jev-tests.example", title: "Jev tests", rules: ["No spam"] } as unknown as LocalCommunity;
const tempDirs: string[] = [];
let requestCounter = 0;

const request = (kind: "comment" | "commentEdit" = "comment") =>
    ({
        challengeRequestId: new Uint8Array([4, 5, 6]),
        [kind]: {
            ...(kind === "commentEdit"
                ? { commentCid: "edited-comment" }
                : { title: "A discussion", link: "https://media.example/item.png" }),
            content: `Unique synthetic publication ${++requestCounter}`,
            author: { address: "private-author-address", publicKey: "private-author-key" },
            signature: { publicKey: "private-signature-key", signature: "private-signature-value" },
            timestamp: 1_789_730_000
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const settings = (options: Record<string, unknown> = {}): CommunityChallengeSetting =>
    ({
        options: {
            apiUrl: GROK_URL,
            apiFormat: "chat-completions",
            apiKey: "synthetic-grok-key",
            model: "grok-4.6",
            triageApiUrl: LUNA_URL,
            triageApiKey: "synthetic-luna-key",
            triageModel: "gpt-5.6-luna",
            triageReasoningEffort: "none",
            jevApiKey: "synthetic-jev-key",
            prompt: PRIVATE_PROMPT,
            cachePath: "",
            auditLogPath: "",
            ...options
        }
    }) as CommunityChallengeSetting;

const challenge = ChallengeFileFactory({} as CommunityChallengeSetting);
const evaluate = (options: Record<string, unknown>, publication = request(), pendingApproval = false) =>
    challenge.getChallenge({
        challengeSettings: { ...settings(options), pendingApproval },
        challengeRequestMessage: publication,
        challengeIndex: options.branch === "review" ? 2 : 1,
        community
    });

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jev = (reviewProbability = 0.01, model = "jev-1.13.0") =>
    json({
        model,
        answers: {
            decision: {
                type: "choice",
                choice: reviewProbability > 0.5 ? "review" : "allow",
                confidence: 1 - Math.min(reviewProbability, 1 - reviewProbability),
                probabilities: { allow: 1 - reviewProbability, review: reviewProbability }
            }
        },
        usage: { input_tokens: 100, output_tokens: 12 }
    });
const luna = (verdict: "allow" | "review" = "allow") =>
    json({
        model: "gpt-5.6-luna",
        output_text: JSON.stringify({
            verdict,
            reason: verdict === "review" ? "Clear spam violation" : "",
            matchedRuleIndexes: verdict === "review" ? [0] : []
        }),
        usage: { input_tokens: 200, output_tokens: 20, input_tokens_details: { cached_tokens: 180 } }
    });
const grok = (verdict: "allow" | "review" = "allow") =>
    json({
        model: "grok-4.6",
        choices: [
            {
                message: {
                    content: JSON.stringify({
                        verdict,
                        reason: verdict === "review" ? "Clear spam violation" : "",
                        matchedRuleIndexes: verdict === "review" ? [0] : []
                    })
                }
            }
        ],
        usage: { prompt_tokens: 300, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } }
    });
const stubFetch = (...responses: Response[]) => {
    const mock = vi.fn();
    for (const response of responses) mock.mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", mock);
    return mock;
};
const auditPath = async () => {
    const dir = await mkdtemp(join(tmpdir(), "bitsocial-jev-integration-"));
    tempDirs.push(dir);
    return join(dir, "audit.jsonl");
};
const readAudit = async (path: string) =>
    (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Jev moderation integration", () => {
    it("keeps the existing Luna-to-Grok cascade when Jev is off by default", async () => {
        const fetchMock = stubFetch(luna("review"), grok());

        await expect(evaluate({})).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([LUNA_URL, GROK_URL]);
    });

    it("lets an eligible Jev allow skip Luna and Grok and records the measured attempt", async () => {
        const path = await auditPath();
        const publication = request();
        const fetchMock = stubFetch(jev(0.05));

        await expect(evaluate({ jevMode: "triage", auditLogPath: path }, publication)).resolves.toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(JEV_URL);
        expect(init.headers).toMatchObject({ authorization: "Bearer synthetic-jev-key" });
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ model: "jev-1.13.0", state: { trustedPolicy: PRIVATE_PROMPT, community: { rules: ["No spam"] } } });
        expect(body.state.trustedUserInstructions).toEqual(expect.any(String));
        expect(body.state.publication.content).toBe(publication.comment?.content);
        expect(body.questions.decision.type).toBe("choice");
        for (const privateValue of [
            "private-author-address",
            "private-author-key",
            "private-signature-key",
            "private-signature-value",
            "synthetic-jev-key"
        ]) {
            expect(init.body).not.toContain(privateValue);
        }
        for (const field of ["authorAddress", "authorPublicKey", "signaturePublicKey", "signatureHash", "challengeRequestIdHash"]) {
            expect(body.state.publication).not.toHaveProperty(field);
        }
        const [entry] = await readAudit(path);
        expect(entry).toMatchObject({
            action: "approved",
            provider: { stage: "jev", apiFormat: "typesafe", model: "jev-1.13.0" },
            attempts: [
                {
                    stage: "jev",
                    status: "ok",
                    httpStatus: 200,
                    model: "jev-1.13.0",
                    elapsedMs: expect.any(Number),
                    usage: { inputTokens: 100, outputTokens: 12 },
                    jevDecision: { reviewProbability: 0.05, confidence: 0.95, maxReviewProbability: 0.05, wouldAutoAllow: true }
                }
            ]
        });
        expect(JSON.stringify(entry)).not.toContain("synthetic-jev-key");
        expect(JSON.stringify(entry)).not.toContain(PRIVATE_PROMPT);
    });

    it("escalates an unexpected pinned model while allowing an explicitly configured alias", async () => {
        const path = await auditPath();
        const fetchMock = stubFetch(jev(0.01, "jev-next-version"), luna(), jev(0.01, "jev-next-version"));
        await expect(evaluate({ jevMode: "triage", auditLogPath: path })).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL]);
        const [entry] = await readAudit(path);
        expect(entry.attempts[0]).toMatchObject({ stage: "jev", status: "error", errorKind: "invalid-response" });
        expect(entry.attempts[0]).not.toHaveProperty("jevDecision");
        await expect(evaluate({ jevMode: "triage", jevModel: "jev-latest" })).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL, JEV_URL]);
    });

    it.each(["jev-latest", "jev-preview"])("rejects echoed text in the returned model for alias %s", async (alias) => {
        const path = await auditPath();
        const cachePath = `${path}.cache.json`;
        const privateEcho = "jev-1.13.0\nprivate echoed policy";
        const fetchMock = stubFetch(jev(0.01, privateEcho), luna());
        await expect(evaluate({ jevMode: "triage", jevModel: alias, auditLogPath: path, cachePath })).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL]);
        const audit = await readFile(path, "utf8");
        const cache = await readFile(cachePath, "utf8");
        expect(audit).not.toContain("private echoed policy");
        expect(cache).not.toContain("private echoed policy");
        expect(JSON.parse(audit).attempts[0]).toMatchObject({ status: "error", errorKind: "invalid-response" });
    });

    it.each([0.051, 0.2, 0.5, 0.9])("lets Luna decide when Jev review probability is %s", async (probability) => {
        const fetchMock = stubFetch(jev(probability), luna());

        await expect(evaluate({ jevMode: "triage" })).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL]);
    });

    it("applies the configured threshold to approval rather than trusting the choice alone", async () => {
        const fetchMock = stubFetch(jev(0.2), luna("review"), grok("review"), jev(0.2));
        const publication = request();

        await expect(evaluate({ jevMode: "triage" }, publication)).resolves.toMatchObject({ success: false });
        await expect(evaluate({ jevMode: "triage", jevMaxReviewProbability: "0.2" }, publication)).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL, GROK_URL, JEV_URL]);
    });

    it("sends a Jev review through Luna and Grok before queuing, with usage for every stage", async () => {
        const path = await auditPath();
        const fetchMock = stubFetch(jev(0.9), luna("review"), grok("review"));
        const publication = request();

        const result = await evaluate({ jevMode: "triage", auditLogPath: path, branch: "review" }, publication, true);

        expect(result).toMatchObject({ success: true, commentUpdate: { reason: expect.stringContaining("spam") } });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL, GROK_URL]);
        const [entry] = await readAudit(path);
        expect(entry).toMatchObject({
            action: "queued_for_review",
            provider: { stage: "reviewer", model: "grok-4.6" },
            attempts: [
                { stage: "jev", status: "ok", httpStatus: 200, usage: { inputTokens: 100, outputTokens: 12 } },
                { stage: "triage", status: "ok", httpStatus: 200, usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 180 } },
                { stage: "reviewer", status: "ok", httpStatus: 200, usage: { inputTokens: 300, outputTokens: 30, reasoningTokens: 10 } }
            ]
        });
    });

    it.each(["malformed", "http", "network"])("falls back to Luna after a Jev %s failure", async (failure) => {
        const path = await auditPath();
        const fetchMock = vi.fn();
        if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("network unavailable"));
        else
            fetchMock.mockResolvedValueOnce(
                failure === "http" ? json({ error: "synthetic-jev-key" }, 503) : json({ model: "jev-1.13.0", answers: {} })
            );
        fetchMock.mockResolvedValueOnce(luna());
        vi.stubGlobal("fetch", fetchMock);

        await expect(evaluate({ jevMode: "triage", auditLogPath: path })).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL]);
        const [entry] = await readAudit(path);
        expect(entry.attempts[0]).toMatchObject({
            stage: "jev",
            status: "error",
            errorKind: failure === "malformed" ? "invalid-response" : failure
        });
        expect(entry.attempts[1]).toMatchObject({ stage: "triage", status: "ok" });
        expect(JSON.stringify(entry)).not.toContain("synthetic-jev-key");
    });

    it("does not approve an unavailable cascade and preserves manual review for new comments", async () => {
        const fetchMock = stubFetch(json({}, 503), json({}, 503), json({}, 503));
        const publication = request();

        await expect(evaluate({ jevMode: "triage" }, publication)).resolves.toMatchObject({ success: false });
        await expect(evaluate({ jevMode: "triage", branch: "review" }, publication, true)).resolves.toMatchObject({
            success: true,
            commentUpdate: { reason: expect.stringContaining("temporarily unavailable") }
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it.each(["review", "unavailable"])("keeps content edits rejected for both branches when the cascade is %s", async (result) => {
        const fetchMock = stubFetch(json({}, 503), luna("review"), result === "review" ? grok("review") : json({}, 503));
        const publication = request("commentEdit");

        await expect(evaluate({ jevMode: "triage" }, publication)).resolves.toMatchObject({ success: false });
        await expect(evaluate({ jevMode: "triage", branch: "review" }, publication, true)).resolves.toMatchObject({ success: false });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does not await shadow decisions or let their disagreement change moderation", async () => {
        const path = await auditPath();
        const publication = request();
        let resolveShadow!: (value: Response) => void;
        const pendingShadow = new Promise<Response>((resolve) => {
            resolveShadow = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockReturnValueOnce(pendingShadow)
            .mockResolvedValueOnce(luna("review"))
            .mockResolvedValueOnce(grok("review"));
        vi.stubGlobal("fetch", fetchMock);
        let settled = false;
        const resultPromise = evaluate({ jevMode: "shadow", auditLogPath: path }, publication).then((value) => {
            settled = true;
            return value;
        });
        try {
            await vi.waitFor(() => expect(settled).toBe(true));
            await expect(resultPromise).resolves.toMatchObject({ success: false, error: expect.stringContaining("spam") });
            const [entry] = await readAudit(path);
            expect(entry.attempts.map((attempt: { stage: string }) => attempt.stage)).toEqual(["triage", "reviewer"]);
            await expect(readFile(`${path}.jev-shadow.jsonl`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            resolveShadow(jev());
        }
        await vi.waitFor(async () => {
            const [entry] = await readAudit(`${path}.jev-shadow.jsonl`);
            expect(entry).toMatchObject({
                baselineVerdict: "review",
                decision: { verdict: "allow" },
                wouldAutoAllow: true,
                attempts: [{ stage: "jev", status: "ok" }]
            });
        });
        const shadowText = await readFile(`${path}.jev-shadow.jsonl`, "utf8");
        for (const privateValue of [
            PRIVATE_PROMPT,
            publication.comment!.content!,
            "synthetic-jev-key",
            "synthetic-luna-key",
            "private-author-address",
            "private-signature-value"
        ]) {
            expect(shadowText).not.toContain(privateValue);
        }
        await expect(evaluate({ jevMode: "shadow", auditLogPath: path, branch: "review" }, publication, true)).resolves.toMatchObject({
            success: true
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("records a shadow failure separately while preserving the successful main verdict", async () => {
        const path = await auditPath();
        stubFetch(json({ error: "synthetic-jev-key" }, 503), luna());

        await expect(evaluate({ jevMode: "shadow", auditLogPath: path })).resolves.toEqual({ success: true });
        await vi.waitFor(async () => {
            const [entry] = await readAudit(`${path}.jev-shadow.jsonl`);
            expect(entry).toMatchObject({
                baselineVerdict: "allow",
                wouldAutoAllow: false,
                attempts: [{ stage: "jev", status: "error", httpStatus: 503 }]
            });
            expect(entry).not.toHaveProperty("decision");
        });
        expect(await readFile(`${path}.jev-shadow.jsonl`, "utf8")).not.toContain("synthetic-jev-key");
    });

    it("normalizes the Jev endpoint for requests and cache identity", async () => {
        const fetchMock = stubFetch(jev());
        const publication = request();
        await expect(evaluate({ jevMode: "triage", jevApiUrl: `${JEV_URL}///` }, publication)).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls[0]?.[0]).toBe(JEV_URL);
        await expect(evaluate({ jevMode: "triage", jevApiUrl: JEV_URL }, publication)).resolves.toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("shares the Jev verdict between branches and isolates caches by mode, model and threshold", async () => {
        const fetchMock = stubFetch(jev(), jev(), jev(0.01, "jev-other-version"), luna());
        const publication = request();

        await expect(evaluate({ jevMode: "triage" }, publication)).resolves.toEqual({ success: true });
        await expect(evaluate({ jevMode: "triage", branch: "review" }, publication)).resolves.toMatchObject({ success: false });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(evaluate({ jevMode: "triage", jevMaxReviewProbability: "0.04" }, publication)).resolves.toEqual({ success: true });
        await expect(evaluate({ jevMode: "triage", jevModel: "jev-other-version" }, publication)).resolves.toEqual({ success: true });
        await expect(evaluate({ jevMode: "off" }, publication)).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, JEV_URL, JEV_URL, LUNA_URL]);
    });

    it.each(["headers", "body"])("abandons stalled Jev %s after 2 seconds and continues with Luna", async (phase) => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockImplementationOnce((_url: string, init: RequestInit) => {
                const stall = () =>
                    new Promise<never>((_resolve, reject) => {
                        init.signal?.addEventListener("abort", () => reject(new Error("request aborted")));
                    });
                return phase === "headers" ? stall() : Promise.resolve({ ok: true, status: 200, text: stall } as Response);
            })
            .mockResolvedValueOnce(luna());
        vi.stubGlobal("fetch", fetchMock);
        const result = evaluate({ jevMode: "triage" });

        await vi.advanceTimersByTimeAsync(1_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toEqual({ success: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([JEV_URL, LUNA_URL]);
    });
});

describe("Jev configuration boundaries", () => {
    const validate = (options: Record<string, unknown>, publicOptions?: string[]) =>
        challenge.validateChallengeSettings!({ challengeSettings: { ...settings(options), ...(publicOptions ? { publicOptions } : {}) } });

    it.each([0, "0", 0.05, "0.05", 0.499])("accepts an explicit approval threshold of %s", (threshold) => {
        expect(() => validate({ jevMode: "triage", jevMaxReviewProbability: threshold })).not.toThrow();
    });

    it.each([-0.01, 0.5, 1, "not-a-number", Infinity, NaN])("rejects an invalid approval threshold of %s", (threshold) => {
        expect(() => validate({ jevMode: "triage", jevMaxReviewProbability: threshold })).toThrow(/Invalid challenge options/);
    });

    it("requires a private key when enabled, HTTPS and an audit destination for shadow mode", () => {
        expect(() => validate({ jevMode: "off", jevApiKey: "" })).not.toThrow();
        expect(() => validate({ jevMode: "triage", jevApiKey: "" })).toThrow(/Jev API key is required/);
        expect(() => validate({ jevMode: "shadow", jevApiKey: "", auditLogPath: "synthetic-audit.jsonl" })).toThrow(
            /Jev API key is required/
        );
        expect(() => validate({ jevMode: "triage", jevApiUrl: "http://provider.example/v1/systemone" })).toThrow(
            /Jev API URL must use https/
        );
        expect(() => validate({ jevMode: "shadow" })).toThrow(/Shadow mode requires an audit log path/);
        expect(() => validate({ jevMode: "active" })).toThrow(/Invalid challenge options/);
    });

    it("rejects publishing the Jev key and makes invalid runtime options fail closed before fetching", async () => {
        const fetchMock = stubFetch();
        expect(() => validate({ jevMode: "triage" }, ["jevApiKey"])).toThrow(/jevApiKey must not be listed in publicOptions/);
        await expect(evaluate({ jevMode: "triage", jevApiKey: "" })).resolves.toMatchObject({
            success: false,
            error: expect.stringContaining("Jev API key is required")
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
