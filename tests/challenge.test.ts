import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const stubApiKey = (name = "AI_MODERATION_OPENAI_API_KEY", value = "test-key") => {
    vi.stubEnv(name, value);
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
        expect(options).toContain("apiKeyEnv");
        expect(options).toContain("model");
        expect(options).toContain("branch");
        expect(options).toContain("prompt");
        expect(options).toContain("promptPath");
        expect(options).not.toContain("serverUrl");
    });

    it("sends direct Responses API requests with community rules and extracted link metadata", async () => {
        stubApiKey();
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

    it("supports OpenAI-compatible chat-completions endpoints", async () => {
        stubApiKey("CUSTOM_AI_KEY", "custom-key");
        const fetchMock = stubFetch(createChatModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/v1/chat/completions",
                apiFormat: "chat-completions",
                apiKeyEnv: "CUSTOM_AI_KEY",
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
        stubApiKey();
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

    it("publishes comments on allow verdict through the allow branch", async () => {
        stubApiKey();
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
        stubApiKey();
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
        stubApiKey();
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
        stubApiKey();
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
        stubApiKey();
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
        stubApiKey();
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

    it("expires failed API calls after the branch pair can reuse them", async () => {
        vi.useFakeTimers();
        stubApiKey();
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
        stubApiKey();
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
        stubApiKey();
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

    it("routes comments to review when the API key is missing", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("missing key comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({
            success: false,
            error: "AI moderation API key is not configured in AI_MODERATION_OPENAI_API_KEY"
        });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns safe failures for invalid options", async () => {
        stubApiKey();
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
        stubApiKey();
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
