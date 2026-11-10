import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, processOnce, pruneModLog } from "../scripts/publish-audit-log-to-community.mjs";

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

afterEach(() => {
    vi.restoreAllMocks();
});

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

// Stands in for the PKC RPC client when publishing audit entries; every post is accepted with a fresh CID.
const fakePublisherPkc = () => {
    const publishedCacheKeys: string[] = [];
    const pkc = {
        createComment: vi.fn(async (options: { content: string }) => {
            publishedCacheKeys.push(/Cache key: (\S+)/.exec(options.content)?.[1] ?? "");
            const cid = `cid-${publishedCacheKeys.length}`;
            const publication = Object.assign(new EventEmitter(), {
                publishChallengeAnswers: vi.fn(),
                publish: async () => {
                    setImmediate(() => publication.emit("challengeverification", { challengeSuccess: true, commentUpdate: { cid } }));
                }
            });
            return publication;
        })
    };
    return { pkc, publishedCacheKeys };
};

const auditLine = (cacheKey: string) =>
    `${JSON.stringify({ cacheKey, verdict: { verdict: "allow" }, community: { address: "source.example" }, publication: { kind: "post" } })}\n`;

describe("mod-log publisher audit cursor", () => {
    let tempDir: string | undefined;

    afterEach(async () => {
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
        tempDir = undefined;
    });

    const setup = async (auditLogContent: string, state: Record<string, unknown>, extra: string[] = []) => {
        tempDir = await mkdtemp(join(tmpdir(), "bitsocial-mod-log-cursor-"));
        const auditLog = join(tempDir, "audit.jsonl");
        const statePath = join(tempDir, "state.json");
        await writeFile(auditLog, auditLogContent);
        await writeFile(statePath, JSON.stringify(state));
        return {
            auditLog,
            statePath,
            args: parseArgs(["--community", "modlog.example", "--audit-log", auditLog, "--state", statePath, ...extra]),
            readState: async () => JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
        };
    };

    it("ignores a stored offset that was recorded for a different audit log", async () => {
        const content = auditLine("entry-one") + auditLine("entry-two");
        const state = { offset: 10, auditLog: "/previous/audit.jsonl", community: "modlog.example" };
        const { args, auditLog, readState } = await setup(content, state);
        const { pkc, publishedCacheKeys } = fakePublisherPkc();

        await expect(processOnce({ args, pkc, signer: {}, state })).resolves.toBe(0);

        expect(publishedCacheKeys).toEqual([]);
        expect(await readState()).toEqual(expect.objectContaining({ offset: Buffer.byteLength(content), auditLog }));
    });

    it("republishes a different audit log from the start with --from-start", async () => {
        const content = auditLine("entry-one") + auditLine("entry-two");
        const state = { offset: 10, auditLog: "/previous/audit.jsonl", community: "modlog.example" };
        const { args, auditLog, readState } = await setup(content, state, ["--from-start"]);
        const { pkc, publishedCacheKeys } = fakePublisherPkc();

        await expect(processOnce({ args, pkc, signer: {}, state })).resolves.toBe(2);

        expect(publishedCacheKeys).toEqual(["entry-one", "entry-two"]);
        expect(await readState()).toEqual(expect.objectContaining({ offset: Buffer.byteLength(content), auditLog }));
    });

    it.each([
        ["a relative stored path", "stored"],
        ["a relative --audit-log path", "argument"]
    ] as const)("keeps the stored offset when %s names the same audit log", async (_label, relativeSide) => {
        const content = auditLine("entry-one") + auditLine("entry-two");
        const state: Record<string, unknown> = { offset: Buffer.byteLength(auditLine("entry-one")), community: "modlog.example" };
        const { args, auditLog, readState } = await setup(content, state);
        state.auditLog = relativeSide === "stored" ? relative(process.cwd(), auditLog) : auditLog;
        if (relativeSide === "argument") args.auditLog = relative(process.cwd(), auditLog);
        const { pkc, publishedCacheKeys } = fakePublisherPkc();

        await expect(processOnce({ args, pkc, signer: {}, state })).resolves.toBe(1);

        expect(publishedCacheKeys).toEqual(["entry-two"]);
        expect(await readState()).toEqual(expect.objectContaining({ offset: Buffer.byteLength(content), auditLog }));
    });

    it("keeps the stored cursor when --audit-log names a file that does not exist", async () => {
        const content = auditLine("entry-one") + auditLine("entry-two");
        const offset = Buffer.byteLength(auditLine("entry-one"));
        const { args, auditLog, readState } = await setup(content, {});
        const storedState = { offset, auditLog, community: "modlog.example" };
        await writeFile(args.state, JSON.stringify(storedState));
        const { pkc, publishedCacheKeys } = fakePublisherPkc();

        const missingLogArgs = { ...args, auditLog: join(dirname(auditLog), "missing.jsonl") };
        await expect(processOnce({ args: missingLogArgs, pkc, signer: {}, state: { ...storedState } })).resolves.toBe(0);
        expect(await readState()).toEqual(storedState);

        await expect(processOnce({ args, pkc, signer: {}, state: await readState() })).resolves.toBe(1);
        expect(publishedCacheKeys).toEqual(["entry-two"]);
    });

    it("skips audit lines that are not JSON objects instead of blocking every later entry", async () => {
        const content = auditLine("entry-one") + "{truncated\n" + "42\n" + auditLine("entry-two");
        const state = {};
        const { args, readState } = await setup(content, state, ["--from-start"]);
        const { pkc, publishedCacheKeys } = fakePublisherPkc();
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(processOnce({ args, pkc, signer: {}, state })).resolves.toBe(2);

        expect(publishedCacheKeys).toEqual(["entry-one", "entry-two"]);
        expect(consoleError).toHaveBeenCalledTimes(2);
        expect(await readState()).toEqual(expect.objectContaining({ offset: Buffer.byteLength(content) }));
    });

    it("binds the first recorded offset to the audit log it was read from", async () => {
        const content = auditLine("entry-one");
        const state = {};
        const { args, auditLog, readState } = await setup(content, state);
        const { pkc } = fakePublisherPkc();

        await processOnce({ args, pkc, signer: {}, state });

        expect(await readState()).toEqual(expect.objectContaining({ offset: Buffer.byteLength(content), auditLog }));
    });
});
