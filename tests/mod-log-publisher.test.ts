import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, pruneModLog, publishWithChallengeAnswer } from "../scripts/publish-audit-log-to-community.mjs";

type Outcome = "accepted" | "comment-gone" | "no-comment-to-edit" | "not-moderator" | "transport-error";

// Reasons pkc-js 0.0.85 puts in challengeverification for these moderation rejections. A moderation of a purged or
// unknown comment fails the parent-existence check, which runs before the moderator check.
const rejectionReasons: Partial<Record<Outcome, string>> = {
    "comment-gone": "The parent of this publication does not exist within the community's records",
    "no-comment-to-edit": "CommentModerationPubsubMessagePublication is attempting to moderate a comment that does not exist",
    "not-moderator": "CommentModerationPubsubMessagePublication signer is not a mod at this community"
};

// Stands in for the PKC RPC client: each moderation publishes and answers with the next scripted outcome.
const fakePkc = (outcomes: Outcome[] = []) => {
    const moderations: Array<{ commentCid: string; commentModeration: Record<string, unknown> }> = [];
    const pkc = {
        createCommentModeration: vi.fn(async (options: { commentCid: string; commentModeration: Record<string, unknown> }) => {
            moderations.push({ commentCid: options.commentCid, commentModeration: options.commentModeration });
            const outcome = outcomes.shift() ?? "accepted";
            const publication = Object.assign(new EventEmitter(), {
                publishChallengeAnswers: vi.fn(),
                publish: async () => {
                    if (outcome === "transport-error") throw new Error("rpc connection closed");
                    const reason = rejectionReasons[outcome];
                    setImmediate(() =>
                        publication.emit("challengeverification", reason ? { challengeSuccess: false, reason } : { challengeSuccess: true })
                    );
                }
            });
            return publication;
        })
    };
    return { pkc, moderations };
};

const args = (extra: string[] = []) => parseArgs(["--community", "modlog.example", ...extra]);
const posts = (...cids: string[]) => cids.map((cid, index) => ({ cid, publishedAt: 1_000 + index }));

describe("mod-log publisher pruning", () => {
    it("archives the posts beyond the newest --keep-posts, oldest first", async () => {
        const { pkc, moderations } = fakePkc();
        const state = { posts: posts("a", "b", "c", "d"), archived: [] as Array<{ cid: string; archivedAt: number }> };
        const save = vi.fn();

        await pruneModLog({ args: args(["--keep-posts", "2"]), pkc, signer: {}, state, now: 5_000, save });

        expect(moderations).toEqual([
            { commentCid: "a", commentModeration: expect.objectContaining({ archived: true }) },
            { commentCid: "b", commentModeration: expect.objectContaining({ archived: true }) }
        ]);
        expect(state.posts.map((post) => post.cid)).toEqual(["c", "d"]);
        expect(state.archived).toEqual([
            { cid: "a", archivedAt: 5_000 },
            { cid: "b", archivedAt: 5_000 }
        ]);
        expect(save).toHaveBeenCalledTimes(2);
    });

    it("purges archived posts only after the retention period", async () => {
        const { pkc, moderations } = fakePkc();
        const state = {
            posts: [],
            archived: [
                { cid: "old", archivedAt: 1_000 },
                { cid: "recent", archivedAt: 4_500 }
            ]
        };

        await pruneModLog({
            args: args(["--keep-posts", "100", "--archive-purge-seconds", "3600"]),
            pkc,
            signer: {},
            state,
            now: 5_000,
            save: vi.fn()
        });

        expect(moderations).toEqual([{ commentCid: "old", commentModeration: expect.objectContaining({ purged: true }) }]);
        expect(state.archived).toEqual([{ cid: "recent", archivedAt: 4_500 }]);
    });

    it("drops a post the community no longer has and keeps one whose moderation could not be delivered", async () => {
        const { pkc } = fakePkc(["comment-gone", "transport-error"]);
        const state = { posts: posts("gone", "retry", "kept"), archived: [] as Array<{ cid: string; archivedAt: number }> };
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(pruneModLog({ args: args(["--keep-posts", "1"]), pkc, signer: {}, state, now: 5_000, save: vi.fn() })).rejects.toThrow(
            "rpc connection closed"
        );

        expect(state.posts.map((post) => post.cid)).toEqual(["retry", "kept"]);
        expect(state.archived).toEqual([]);
    });

    it.each(["comment-gone", "no-comment-to-edit"] as const)(
        "drops an archived post whose purge is rejected because the community no longer has it (%s)",
        async (outcome) => {
            const { pkc, moderations } = fakePkc([outcome]);
            const state = { posts: [], archived: [{ cid: "already-purged", archivedAt: 0 }] };
            const save = vi.fn();
            vi.spyOn(console, "error").mockImplementation(() => {});

            await expect(
                pruneModLog({ args: args(["--keep-posts", "10"]), pkc, signer: {}, state, now: 5_000_000, save })
            ).resolves.toBeUndefined();

            expect(moderations).toEqual([{ commentCid: "already-purged", commentModeration: expect.objectContaining({ purged: true }) }]);
            expect(state.archived).toEqual([]);
            expect(save).toHaveBeenCalledTimes(1);
        }
    );

    it("keeps tracking posts when the community rejects a moderation the signer may make later", async () => {
        const { pkc, moderations } = fakePkc(["not-moderator"]);
        const state = { posts: posts("a", "b", "c"), archived: [{ cid: "old", archivedAt: 0 }] };
        const save = vi.fn();
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(pruneModLog({ args: args(["--keep-posts", "1"]), pkc, signer: {}, state, now: 5_000_000, save })).rejects.toThrow(
            "signer is not a mod"
        );

        expect(moderations).toHaveLength(1);
        expect(state.posts.map((post) => post.cid)).toEqual(["a", "b", "c"]);
        expect(state.archived).toEqual([{ cid: "old", archivedAt: 0 }]);
        expect(save).not.toHaveBeenCalled();
    });

    it("keeps an archived post tracked when its purge is rejected for a reason other than the post being gone", async () => {
        const { pkc } = fakePkc(["not-moderator"]);
        const state = { posts: [], archived: [{ cid: "old", archivedAt: 0 }] };

        await expect(
            pruneModLog({ args: args(["--keep-posts", "10"]), pkc, signer: {}, state, now: 5_000_000, save: vi.fn() })
        ).rejects.toThrow("signer is not a mod");

        expect(state.archived).toEqual([{ cid: "old", archivedAt: 0 }]);
    });

    it("leaves the mod log alone without --keep-posts", async () => {
        const { pkc, moderations } = fakePkc();
        const state = { posts: posts("a", "b"), archived: [{ cid: "c", archivedAt: 0 }] };

        await pruneModLog({ args: args(), pkc, signer: {}, state, now: 5_000_000, save: vi.fn() });

        expect(moderations).toEqual([]);
    });

    it("rejects invalid pruning options", () => {
        expect(() => args(["--keep-posts", "-1"])).toThrow("--keep-posts must be a non-negative integer");
        expect(() => args(["--keep-posts", "2.5"])).toThrow("--keep-posts must be a non-negative integer");
        expect(() => args(["--archive-purge-seconds", "-5"])).toThrow("--archive-purge-seconds must be zero or positive");
    });
});

const passwordChallenge = { challenge: "What is the password?", type: "text/plain" };

// Stands in for a PKC publication whose community answers publish() with a CHALLENGE carrying `challenges`, or with a
// verification straight away when `challenges` is undefined. A CHALLENGE is followed by the given verification once
// the publisher answers it.
const fakePublication = ({
    challenges,
    verification = { challengeSuccess: true }
}: {
    challenges?: unknown;
    verification?: { challengeSuccess: boolean; reason?: string; challengeErrors?: Record<string, string> };
}) => {
    const publication: EventEmitter & { publish: () => Promise<void>; publishChallengeAnswers: ReturnType<typeof vi.fn> } = Object.assign(
        new EventEmitter(),
        {
            publishChallengeAnswers: vi.fn(async () => {
                setImmediate(() => publication.emit("challengeverification", verification));
            }),
            publish: async () => {
                setImmediate(() =>
                    challenges === undefined
                        ? publication.emit("challengeverification", verification)
                        : publication.emit("challenge", { challenges })
                );
            }
        }
    );
    return publication;
};

const publishOptions = { challengeAnswer: "secret", timeoutMs: 1_000, label: "audit entry abc" };

describe("mod-log publisher challenge answers", () => {
    it("answers a CHALLENGE that lists its challenges as an array (pkc-js before 0.0.152) with an array", async () => {
        const publication = fakePublication({ challenges: [passwordChallenge] });

        await expect(publishWithChallengeAnswer(publication, publishOptions)).resolves.toEqual({ challengeSuccess: true });

        expect(publication.publishChallengeAnswers).toHaveBeenCalledExactlyOnceWith({ challengeAnswers: ["secret"] });
    });

    it("answers a CHALLENGE keyed by challenge index (pkc-js 0.0.152) under its lowest index", async () => {
        const publication = fakePublication({ challenges: { "10": passwordChallenge, "2": passwordChallenge } });

        await expect(publishWithChallengeAnswer(publication, publishOptions)).resolves.toEqual({ challengeSuccess: true });

        expect(publication.publishChallengeAnswers).toHaveBeenCalledExactlyOnceWith({ challengeAnswers: { "2": "secret" } });
    });

    it("resolves without answering when the community verifies the publication without a CHALLENGE", async () => {
        const publication = fakePublication({});

        await expect(publishWithChallengeAnswer(publication, publishOptions)).resolves.toEqual({ challengeSuccess: true });

        expect(publication.publishChallengeAnswers).not.toHaveBeenCalled();
    });

    it("rejects with the community's verdict when the answer is wrong", async () => {
        const publication = fakePublication({
            challenges: { "0": passwordChallenge },
            verification: { challengeSuccess: false, challengeErrors: { "0": "Wrong answer." } }
        });

        await expect(publishWithChallengeAnswer(publication, publishOptions)).rejects.toThrow(
            "Mod log community rejected audit entry abc: unknown reason"
        );
    });

    it("rejects a CHALLENGE when no challenge answer is configured", async () => {
        const publication = fakePublication({ challenges: { "0": passwordChallenge } });

        await expect(publishWithChallengeAnswer(publication, { ...publishOptions, challengeAnswer: undefined })).rejects.toThrow(
            "Mod log community requested a challenge answer, but no challenge answer was configured"
        );
        expect(publication.publishChallengeAnswers).not.toHaveBeenCalled();
    });

    it("publishes moderations without a pre-answer and answers their CHALLENGE", async () => {
        const createOptions: Array<Record<string, unknown>> = [];
        const publication = fakePublication({ challenges: { "1": passwordChallenge } });
        const pkc = {
            createCommentModeration: vi.fn(async (options: Record<string, unknown>) => {
                createOptions.push(options);
                return publication;
            })
        };

        await pruneModLog({
            args: args(["--keep-posts", "0"]),
            pkc,
            signer: {},
            state: { posts: posts("a"), archived: [] },
            challengeAnswer: "secret",
            now: 5_000,
            save: vi.fn()
        });

        expect(createOptions).toHaveLength(1);
        expect(createOptions[0]).not.toHaveProperty("challengeRequest");
        expect(publication.publishChallengeAnswers).toHaveBeenCalledExactlyOnceWith({ challengeAnswers: { "1": "secret" } });
    });
});
