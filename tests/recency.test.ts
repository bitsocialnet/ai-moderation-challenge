import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory from "../src/index.js";
import { getArticleRecency } from "../src/recency.js";

vi.mock("@pkcprotocol/pkc-logger", () => ({ default: () => Object.assign(vi.fn(), { error: vi.fn(), trace: vi.fn() }) }));
const challenge = ChallengeFileFactory({} as CommunityChallengeSetting);
let sequence = 0;
const dirs: string[] = [];
const community = {
    address: "recency.example",
    rules: ["Linked articles must be no more than 48 hours old."]
} as unknown as LocalCommunity;
const request = (date = "2026/09/15", extra = {}) =>
    ({
        comment: {
            title: `Article ${++sequence}`,
            link: `https://news.example/${date}/story`,
            timestamp: Date.parse("2026-09-18T12:00:00Z") / 1000,
            ...extra
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
const settings = (options = {}) =>
    ({
        options: {
            apiUrl: "https://provider.example/responses",
            model: "model-test",
            prompt: "Review clear violations.",
            cachePath: "",
            auditLogPath: "",
            ...options
        }
    }) as CommunityChallengeSetting;
const evaluate = (options = {}, publication = request(), pendingApproval = false) =>
    challenge.getChallenge({
        challengeSettings: { ...settings(options), pendingApproval },
        challengeIndex: 0,
        challengeRequestMessage: publication,
        community
    });
const stub = (verdict = "allow") => {
    const mock = vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    output_text: JSON.stringify({
                        verdict,
                        reason: verdict === "review" ? "clear spam violation" : "",
                        matchedRuleIndexes: verdict === "review" ? [0] : []
                    })
                })
            )
    );
    vi.stubGlobal("fetch", mock);
    return mock;
};
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("deterministic configured article recency", () => {
    it("reviews known expired article before any model can allow it", async () => {
        const fetch = stub();
        const result = await evaluate({ articleMaxAgeHours: "48" });
        expect(result).toEqual({ success: false, error: "the linked article appears older than the configured 48-hour window" });
        expect(fetch).not.toHaveBeenCalled();
    });
    it("uses the review branch pending-approval behavior without guessing a rule index", async () => {
        const fetch = stub();
        const result = await evaluate({ articleMaxAgeHours: "48", branch: "review" }, request(), true);
        expect(result).toMatchObject({ success: true, commentUpdate: { reason: expect.stringContaining("48-hour window") } });
        expect(JSON.stringify(result)).not.toContain("Rule #");
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(["2026/09/16", "2026/09/17", "2026/09/19", "story", "2026/02/30"])(
        "keeps %s permitted for recency but checks other rules",
        async (date) => {
            const fetch = stub("review");
            expect(await evaluate({ articleMaxAgeHours: "48" }, request(date))).toEqual({ success: false, error: "clear spam violation" });
            expect(fetch).toHaveBeenCalledTimes(1);
            const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
            const payload = JSON.parse(body.input[1].content);
            expect(payload.publication.articleRecency.maxAgeSeconds).toBe(48 * 3600);
            expect(payload.instructions).toContain("Do not independently re-enforce that configured window");
            expect(payload.instructions).toContain("including any stricter explicit article-age limit");
        }
    );
    it("does not invent a window from prose and separates configured cache identity", async () => {
        const fetch = stub();
        const publication = request();
        expect(await evaluate({}, publication)).toEqual({ success: true });
        expect(await evaluate({ articleMaxAgeHours: "48" }, publication)).toMatchObject({ success: false });
        expect(await evaluate({ articleMaxAgeHours: "240" }, publication)).toEqual({ success: true });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("preserves a stricter 48-hour community rule when the configured guard allows 240 hours", async () => {
        const fetch = stub("review");
        expect(await evaluate({ articleMaxAgeHours: "240" })).toMatchObject({ success: false });
        const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
        const payload = JSON.parse(body.input[1].content);
        expect(payload.community.rules).toContain("Linked articles must be no more than 48 hours old.");
        expect(payload.publication.articleRecency).toMatchObject({ maxAgeSeconds: 240 * 3600 });
        expect(payload.publication.articleRecency.minimumAgeSeconds).toBeGreaterThan(48 * 3600);
        expect(payload.instructions).toContain("Continue enforcing all community rules, including any stricter explicit article-age limit");
        expect(payload.instructions).not.toContain("Do not review for article age alone");
    });
    it("leaves replies and media outside the top-level article setting", async () => {
        const fetch = stub();
        expect(await evaluate({ articleMaxAgeHours: "48" }, request("2026/09/15", { parentCid: "parent" }))).toEqual({ success: true });
        expect(await evaluate({ articleMaxAgeHours: "48" }, request("2026/09/15", { linkHtmlTagName: "img" }))).toEqual({ success: true });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it("preserves reject-on-review and reject-on-unavailable for content edits", async () => {
        stub("review");
        const edit = (content: string) =>
            ({
                commentEdit: { commentCid: "edited-comment", content, timestamp: Date.parse("2026-09-18T12:00:00Z") / 1000 }
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        expect(await evaluate({ articleMaxAgeHours: "48", branch: "review" }, edit("first content"), true)).toMatchObject({
            success: false
        });
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
        expect(await evaluate({ articleMaxAgeHours: "48", branch: "review" }, edit("second content"), true)).toMatchObject({
            success: false
        });
    });
    it("records deterministic decisions without pretending to bill a provider", async () => {
        stub();
        const directory = await mkdtemp(join(tmpdir(), "recency-audit-"));
        dirs.push(directory);
        const auditLogPath = join(directory, "audit.jsonl");
        await evaluate({ articleMaxAgeHours: "48", auditLogPath });
        const entry = JSON.parse((await readFile(auditLogPath, "utf8")).trim());
        expect(entry).toMatchObject({
            source: "rule",
            rule: "article-recency",
            action: "queued_for_review",
            verdict: { matchedRuleIndexes: [] },
            articleRecency: { status: "outside-window" }
        });
        expect(entry).not.toHaveProperty("provider");
        expect(entry).not.toHaveProperty("attempts");
    });
    it.each(["0", "-1", "Infinity", "48h", "99999999"])("rejects invalid configured age %s", (articleMaxAgeHours) => {
        expect(() => challenge.validateChallengeSettings!({ challengeSettings: settings({ articleMaxAgeHours }) })).toThrow();
    });
    it("does not treat a missing timestamp as old", async () => {
        const fetch = stub();
        expect(await evaluate({ articleMaxAgeHours: "48" }, request("2026/09/15", { timestamp: undefined }))).toEqual({ success: true });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe("article age arithmetic", () => {
    const options = {
        kind: "post",
        hasLink: true,
        maxAgeHours: 48,
        dateHint: { earliestPossibleAt: "2026-09-15T00:00:00.000Z", latestPossibleAt: "2026-09-15T23:59:59.999Z" }
    };
    it("uses the latest possible article instant; exactly 48 hours is not older", () => {
        const submittedAtSeconds = Date.parse("2026-09-17T23:59:59.999Z") / 1000;
        expect(getArticleRecency({ ...options, submittedAtSeconds })).toMatchObject({
            minimumAgeSeconds: 172800,
            maximumAgeSeconds: 259199.999,
            status: "uncertain"
        });
        expect(getArticleRecency({ ...options, submittedAtSeconds: submittedAtSeconds + 0.001 })?.status).toBe("outside-window");
    });
    it("keeps future-day evidence uncertain", () => {
        expect(getArticleRecency({ ...options, submittedAtSeconds: Date.parse("2026-09-14T12:00:00Z") / 1000 })?.status).toBe("uncertain");
    });
});
