import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { getPublicKeyFromPrivateKey } from "../src/pkc-js-signer.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory from "../src/index.js";
import * as cborg from "cborg";

type MockResponseOptions = {
    ok?: boolean;
    status?: number;
    jsonThrows?: boolean;
};

const createResponse = (body: unknown, options: MockResponseOptions = {}) => {
    const { ok = true, status = 200, jsonThrows = false } = options;
    return {
        ok,
        status,
        json: jsonThrows ? vi.fn().mockRejectedValue(new Error("bad json")) : vi.fn().mockResolvedValue(body)
    };
};

const stubFetch = (...responses: Array<ReturnType<typeof createResponse>>) => {
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
            link: "https://example.com/image.png"
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

const testPrivateKey = Buffer.alloc(32, 7).toString("base64");
let community: LocalCommunity;

beforeAll(async () => {
    const publicKey = await getPublicKeyFromPrivateKey(testPrivateKey);
    community = {
        address: "test.bitsocial.net",
        title: "Test community",
        description: "A community for tests",
        rules: ["No spam", "No sexualized minors"],
        features: { safeForWork: true },
        signer: {
            privateKey: testPrivateKey,
            publicKey,
            type: "ed25519"
        }
    } as unknown as LocalCommunity;
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("Bitsocial AI moderation challenge package", () => {
    it("exposes metadata and option inputs", () => {
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        expect(challengeFile.type).toBe("text/plain");
        expect(challengeFile.description).toMatch(/AI/i);
        expect(challengeFile.optionInputs.some((input) => input.option === "serverUrl")).toBe(true);
        expect(challengeFile.optionInputs.some((input) => input.option === "branch")).toBe(true);
    });

    it("sends signed CBOR evaluate requests with community rules", async () => {
        const fetchMock = stubFetch(createResponse({ verdict: "allow" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("signed cbor payload");

        const result = await challengeFile.getChallenge({
            challengeSettings: { options: { serverUrl: "https://moderation.example/api" } } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("https://moderation.example/api/ai-moderation/evaluate", expect.any(Object));

        const bodyBuffer = fetchMock.mock.calls[0]?.[1]?.body as Buffer;
        const payload = cborg.decode(bodyBuffer);

        expect(payload).toEqual(
            expect.objectContaining({
                challengeRequest: request,
                communityContext: {
                    address: "test.bitsocial.net",
                    title: "Test community",
                    description: "A community for tests",
                    rules: ["No spam", "No sexualized minors"],
                    features: { safeForWork: true }
                },
                timestamp: expect.any(Number),
                signature: expect.objectContaining({
                    publicKey: expect.any(Uint8Array),
                    type: "ed25519",
                    signedPropertyNames: ["challengeRequest", "communityContext", "timestamp"],
                    signature: expect.any(Uint8Array)
                })
            })
        );
    });

    it("publishes comments on allow verdict through the allow branch", async () => {
        stubFetch(createResponse({ verdict: "allow" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/allow-comment", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: createCommentRequest("allowed comment"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("routes review comments through the review branch and reuses the cached verdict", async () => {
        const fetchMock = stubFetch(createResponse({ verdict: "review", reason: "Rule 1" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("cached review comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/review-comment-cache", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/review-comment-cache", branch: "review" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "Rule 1" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows content edits on allow verdict", async () => {
        stubFetch(createResponse({ verdict: "allow" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/allow-edit", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: createContentEditRequest("clean edit"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("rejects content edits on review verdict for both branches", async () => {
        const fetchMock = stubFetch(createResponse({ verdict: "review", reason: "Edit breaks rules" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("bad edit");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/review-edit", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/review-edit", branch: "review" }
            } as CommunityChallengeSetting,
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
        const fetchMock = stubFetch(createResponse({ verdict: "review" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: { options: { branch: "allow" } } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: { options: { branch: "review" } } as CommunityChallengeSetting,
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
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/comment-outage", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/comment-outage", branch: "review" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "network down" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects content edits on API outages", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("edit during outage");

        const result = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/edit-outage", branch: "allow" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Rejected by Bitsocial AI moderation." });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats invalid API responses as moderation outages", async () => {
        stubFetch(createResponse({ verdict: "reject" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: {
                options: { serverUrl: "https://moderation.example/invalid-response", branch: "review" }
            } as CommunityChallengeSetting,
            challengeRequestMessage: createCommentRequest("invalid response comment"),
            challengeIndex: 2,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("returns safe failures for invalid options", async () => {
        const fetchMock = stubFetch(createResponse({ verdict: "allow" }));
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
});
