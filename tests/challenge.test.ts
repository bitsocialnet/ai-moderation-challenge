import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory from "../src/index.js";

type MockFetch = ReturnType<typeof vi.fn>;

const createModelResponse = (verdict: unknown, status = 200) =>
    new Response(
        JSON.stringify({
            output_text: JSON.stringify(verdict)
        }),
        {
            status,
            headers: { "content-type": "application/json" }
        }
    );

const createNestedResponsesModelResponse = (verdict: unknown) =>
    new Response(
        JSON.stringify({
            output: [
                {
                    content: [
                        {
                            type: "output_text",
                            text: JSON.stringify(verdict)
                        }
                    ]
                }
            ]
        }),
        {
            status: 200,
            headers: { "content-type": "application/json" }
        }
    );

const createChatModelResponse = (verdict: unknown) =>
    new Response(
        JSON.stringify({
            choices: [
                {
                    message: {
                        content: JSON.stringify(verdict)
                    }
                }
            ]
        }),
        {
            status: 200,
            headers: { "content-type": "application/json" }
        }
    );

const createRawResponse = (body: string, status = 200) =>
    new Response(body, {
        status,
        headers: { "content-type": "application/json" }
    });

const stubFetch = (...responses: Response[]) => {
    const fetchMock = vi.fn();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
};

const createCommentRequest = (content: string) =>
    ({
        comment: {
            content,
            title: "hello",
            link: "https://cdn.example.com/media/image.png?sig=1",
            linkHtmlTagName: "img",
            nsfw: true,
            flairs: [{ text: "meta" }, "announcement"]
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createReplyRequest = (content: string) =>
    ({
        comment: {
            content,
            parentCid: "parent-1",
            postCid: "post-1"
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createContentEditRequest = (content: string) =>
    ({
        commentEdit: {
            commentCid: "comment-1",
            content
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createDeleteEditRequest = () =>
    ({
        commentEdit: {
            commentCid: "comment-1",
            deleted: true
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createVoteRequest = () =>
    ({
        vote: {
            commentCid: "comment-1",
            vote: 1
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const community = {
    address: "test.bitsocial.net",
    title: "Test community",
    description: "A community for tests",
    rules: ["No spam", "No sexualized minors"],
    features: { safeForWork: true }
} as unknown as LocalCommunity;

const settings = (options: Record<string, unknown> = {}) =>
    ({
        options: {
            apiUrl: "https://provider.example/v1/responses",
            apiKey: "test-key",
            cachePath: "",
            ...options
        }
    }) as CommunityChallengeSetting;

const getFetchCall = (fetchMock: MockFetch, index = 0) => fetchMock.mock.calls[index] as [string, RequestInit];

const getRequestBody = (fetchMock: MockFetch, index = 0) =>
    JSON.parse(getFetchCall(fetchMock, index)[1].body as string) as Record<string, unknown>;

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("Bitsocial AI moderation challenge package", () => {
    it("exposes metadata and direct provider option inputs", () => {
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const options = challengeFile.optionInputs.map((input) => input.option);

        expect(challengeFile.type).toBe("text/plain");
        expect(challengeFile.description).toMatch(/AI/i);
        expect(options).toContain("apiUrl");
        expect(options).toContain("apiFormat");
        expect(options).toContain("apiKey");
        expect(options).toContain("model");
        expect(options).toContain("branch");
        expect(options).toContain("prompt");
        expect(options).toContain("promptPath");
        expect(options).toContain("cachePath");
        expect(options).not.toContain("apiKeyEnv");
        expect(options).not.toContain("promptVersion");
        expect(options).not.toContain("serverUrl");
    });

    it("sends direct Responses API requests with community rules and extracted link metadata", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ model: "gpt-test", prompt: "custom prompt" }),
            challengeRequestMessage: createCommentRequest("responses payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = getFetchCall(fetchMock);
        expect(url).toBe("https://provider.example/v1/responses");
        expect(init.headers).toMatchObject({
            authorization: "Bearer test-key",
            "content-type": "application/json"
        });

        const body = getRequestBody(fetchMock);
        expect(body).toMatchObject({
            model: "gpt-test",
            store: false,
            text: {
                format: {
                    type: "json_schema",
                    name: "bitsocial_ai_moderation_verdict",
                    strict: true
                }
            }
        });

        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0]).toEqual({ role: "system", content: "custom prompt" });
        const userPayload = JSON.parse(input[1].content) as Record<string, unknown>;
        expect(userPayload).toEqual({
            community: {
                address: "test.bitsocial.net",
                title: "Test community",
                description: "A community for tests",
                rules: ["No spam", "No sexualized minors"],
                features: { safeForWork: true }
            },
            publication: {
                kind: "post",
                content: "responses payload",
                title: "hello",
                link: {
                    url: "https://cdn.example.com/media/image.png?sig=1",
                    domain: "cdn.example.com",
                    path: "/media/image.png",
                    htmlTagName: "img"
                },
                flags: {
                    nsfw: true
                },
                flairs: ["meta", "announcement"]
            }
        });
        expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain("https://cdn.example.com/media/image.png?sig=1");
    });

    it("uses gpt-5.4-nano as the default model", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings(),
            challengeRequestMessage: createReplyRequest("default model payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(getRequestBody(fetchMock)).toMatchObject({
            model: "gpt-5.4-nano"
        });
    });

    it("sends a permissive default prompt for contextual offensive-term discussion", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const content = "Did Trotsky invent the word racist? A 19th century source used the term NEGROPHOBIA.";

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/contextual-term" }),
            challengeRequestMessage: createCommentRequest(content),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        const trackedDefaultPrompt = (
            await readFile(new URL("../prompts/bitsocial-ai-moderation-prompt.md", import.meta.url), "utf8")
        ).trim();
        expect(input[0].content).toBe(trackedDefaultPrompt);
        expect(input[0].content).toContain("Return review only when the content:");
        expect(input[0].content).toContain("Return allow when:");
        expect(input[0].content).toContain("used historically");
        expect(input[0].content).toContain("repeated offensive-word spam");
        expect(input[0].content).toContain("pornographic-site promotion");
        expect(input[0].content).toContain("referral/affiliate link spam");
        expect(input[0].content).toContain("Do not enforce general platform-safety preferences");

        const userPayload = JSON.parse(input[1].content) as Record<string, Record<string, unknown>>;
        expect(userPayload.publication.content).toBe(content);
    });

    it("accepts nested Responses API output text", async () => {
        const fetchMock = stubFetch(createNestedResponsesModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/nested-responses-output" }),
            challengeRequestMessage: createCommentRequest("nested responses payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends a clearly rule-breaking post to the review branch for moderator queueing", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "No spam", matchedRuleIndexes: [0] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("Buy cheap pills at spam.example now.");
        const spamCommunity = {
            ...community,
            rules: ["No spam", "No sexualized minors"]
        } as unknown as LocalCommunity;

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/spam-review", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community: spamCommunity
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/spam-review", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community: spamCommunity
        });

        expect(allowResult).toEqual({ success: false, error: "No spam" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        const userPayload = JSON.parse(input[1].content) as Record<string, Record<string, unknown>>;
        expect(userPayload.community.rules).toEqual(["No spam", "No sexualized minors"]);
        expect(userPayload.publication.content).toBe("Buy cheap pills at spam.example now.");
    });

    it("supports OpenAI-compatible chat-completions endpoints", async () => {
        const fetchMock = stubFetch(createChatModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/v1/chat/completions",
                apiFormat: "chat-completions",
                apiKey: "custom-key",
                model: "custom-model"
            }),
            challengeRequestMessage: createReplyRequest("chat payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        const [url, init] = getFetchCall(fetchMock);
        expect(url).toBe("https://provider.example/v1/chat/completions");
        expect(init.headers).toMatchObject({ authorization: "Bearer custom-key" });
        expect(getRequestBody(fetchMock)).toMatchObject({
            model: "custom-model",
            messages: [
                { role: "system", content: expect.stringContaining("automated first-pass moderation") },
                {
                    role: "user",
                    content: expect.stringContaining("chat payload")
                }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "bitsocial_ai_moderation_verdict",
                    strict: true
                }
            }
        });
    });

    it("can read the private system prompt from a node-local file", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-"));
        const promptPath = join(tempDir, "prompt.md");
        await writeFile(promptPath, "file prompt", "utf8");
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const result = await challengeFile.getChallenge({
                challengeSettings: settings({ promptPath }),
                challengeRequestMessage: createCommentRequest("prompt file payload"),
                challengeIndex: 1,
                community
            });

            expect(result).toEqual({ success: true });
            const body = getRequestBody(fetchMock);
            const input = body.input as Array<{ role: string; content: string }>;
            expect(input[0]).toEqual({ role: "system", content: "file prompt" });
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("persists successful verdicts in a JSON cache keyed by prompt hash", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-cache-"));
        const cachePath = join(tempDir, "verdicts.json");
        const prompt = "json cache private prompt";
        const request = createCommentRequest("json cached comment");
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const firstResult = await challengeFile.getChallenge({
                challengeSettings: settings({ cachePath, prompt }),
                challengeRequestMessage: request,
                challengeIndex: 1,
                community
            });

            expect(firstResult).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const cacheFileText = await readFile(cachePath, "utf8");
            const cacheFile = JSON.parse(cacheFileText) as { version: number; entries: Record<string, unknown> };
            const cacheKeys = Object.keys(cacheFile.entries);
            expect(cacheFile.version).toBe(1);
            expect(cacheKeys).toHaveLength(1);
            expect(cacheKeys[0]).toMatch(/^[a-f0-9]{64}$/);
            expect(cacheFileText).not.toContain(prompt);
            expect(cacheFileText).not.toContain("test-key");

            vi.resetModules();
            const freshFetchMock = vi.fn().mockRejectedValue(new Error("should not call provider"));
            vi.stubGlobal("fetch", freshFetchMock);
            const { default: FreshChallengeFileFactory } = await import("../src/index.js");
            const freshChallengeFile = FreshChallengeFileFactory({} as CommunityChallengeSetting);

            const secondResult = await freshChallengeFile.getChallenge({
                challengeSettings: settings({ cachePath, prompt }),
                challengeRequestMessage: request,
                challengeIndex: 1,
                community
            });

            expect(secondResult).toEqual({ success: true });
            expect(freshFetchMock).not.toHaveBeenCalled();
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("publishes comments on allow verdict through the allow branch", async () => {
        stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/allow-comment", branch: "allow" }),
            challengeRequestMessage: createCommentRequest("allowed comment"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("routes review comments through the review branch and reuses the cached verdict", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "Rule 1", matchedRuleIndexes: [0] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("cached review comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-comment-cache", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-comment-cache", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "Rule 1" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows content edits on allow verdict", async () => {
        stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/allow-edit", branch: "allow" }),
            challengeRequestMessage: createContentEditRequest("clean edit"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("rejects content edits on review verdict for both branches", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "Edit breaks rules", matchedRuleIndexes: [1] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("bad edit");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-edit", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-edit", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "Edit breaks rules" });
        expect(reviewResult).toEqual({ success: false, error: "Edit breaks rules" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["delete-only edits", createDeleteEditRequest()],
        ["votes", createVoteRequest()]
    ])("bypasses %s without calling the API", async (_label, request) => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: true });
        expect(reviewResult).toEqual({ success: false, error: "AI moderation review branch skipped." });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails open to the review branch for comment API outages", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("outage comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/comment-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/comment-outage", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "network down" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes comments to review when the provider returns an error response", async () => {
        const fetchMock = stubFetch(createRawResponse(JSON.stringify({ error: "rate limited" }), 429));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("provider error comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/provider-error", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/provider-error", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({
            success: false,
            error: 'AI moderation API error (429): {"error":"rate limited"}'
        });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("expires failed API calls after the branch pair can reuse them", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("retry after outage");

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const immediateResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: false, error: "network down" });
        expect(immediateResult).toEqual({ success: false, error: "network down" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        const retryResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(retryResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects content edits on API outages", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("edit during outage");

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/edit-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Rejected by Bitsocial AI moderation." });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats invalid API responses as moderation outages", async () => {
        stubFetch(createRawResponse("not-json"));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/invalid-response", branch: "review" }),
            challengeRequestMessage: createCommentRequest("invalid response comment"),
            challengeIndex: 2,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it.each([
        ["missing output text", {}],
        ["non-JSON output text", { output_text: "not-json" }],
        ["invalid verdict JSON", { output_text: JSON.stringify({ verdict: "maybe", reason: "", matchedRuleIndexes: [] }) }]
    ])("treats %s as a moderation outage", async (_label, body) => {
        const fetchMock = stubFetch(createRawResponse(JSON.stringify(body)));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const slug = _label.replaceAll(" ", "-");

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: `https://provider.example/malformed-model-output-${slug}`, branch: "review" }),
            challengeRequestMessage: createCommentRequest(`malformed model output ${_label}`),
            challengeIndex: 2,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes comments to review when the API key is missing", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("missing key comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", apiKey: "", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", apiKey: "", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({
            success: false,
            error: "AI moderation API key is not configured in challenge options"
        });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns safe failures for invalid options", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: { options: { branch: "maybe" } } as CommunityChallengeSetting,
            challengeRequestMessage: createCommentRequest("invalid options"),
            challengeIndex: 1,
            community
        });

        expect(result).toHaveProperty("success", false);
        expect((result as { error?: string }).error).toMatch(/Invalid challenge options/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects ambiguous prompt configuration", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ prompt: "inline", promptPath: "/tmp/prompt.md" }),
            challengeRequestMessage: createCommentRequest("ambiguous prompt"),
            challengeIndex: 1,
            community
        });

        expect(result).toHaveProperty("success", false);
        expect((result as { error?: string }).error).toMatch(/Use prompt or promptPath/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
