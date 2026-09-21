import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareModerationReview, importModerationReview } from "../../moderation-review.mjs";
import { blankReview } from "../review-handoff.mjs";
import { validateCorpus } from "../../moderation-evaluate.mjs";
const corpus = JSON.parse(await readFile(new URL("../../../evaluations/moderation-corpus.json", import.meta.url)));
const assignments = JSON.parse(await readFile(new URL("../../../evaluations/moderation-split.json", import.meta.url)));
const policySource = await readFile(new URL("../../../src/index.ts", import.meta.url), "utf8");
const options = { commit: "a".repeat(40), policySource };

test("existing 12 synthetic cases export blind with exact public policy, no label/rationale IDs", () => {
    const queue = prepareModerationReview(corpus, assignments, options);
    assert.equal(queue.items.length, 12);
    const serialized = JSON.stringify(queue);
    assert.equal(serialized.includes("clear-commercial-spam"), false);
    assert.equal(serialized.includes("recency-expired"), false);
    assert.equal(serialized.includes('"expected"'), false);
    assert.equal(serialized.includes('"rationale"'), false);
    assert.match(queue.rubric.text, /Apply top-level post and thread-starting rules more narrowly to replies/);
    assert.match(queue.rubric.text, /missing or uncertain/);
});
test("human answers import into native corpus without upgrading synthetic provenance", () => {
    const queue = prepareModerationReview(corpus, assignments, options);
    const review = { ...blankReview(queue), reviewerId: "test-human", reviewedAt: "2026-09-21", independentOfModelOutput: true };
    review.labels.forEach((row, index) => {
        row.label = index === 0 ? "uncertain" : index === 1 ? "" : "allow";
    });
    const result = importModerationReview(queue, { schemaVersion: 1, reviews: [review] });
    assert.deepEqual(result.manifest.summary, { total: 12, labeled: 10, pending: 2 });
    validateCorpus(result.corpus);
    assert.equal(
        result.corpus.cases.every((row) => row.provenance === "synthetic"),
        true
    );
    assert.equal(result.frozen.cases.length, 10);
    for (const row of result.assignments) assert.equal(row.split, queue.items.find((item) => item.id === row.id).split);
});
test("no invented corpus when every answer is pending", () => {
    const queue = prepareModerationReview(corpus, assignments, options);
    const review = { ...blankReview(queue), reviewerId: "test-human", reviewedAt: "2026-09-21", independentOfModelOutput: true };
    const result = importModerationReview(queue, { schemaVersion: 1, reviews: [review] });
    assert.equal(result.corpus, null);
    assert.equal(result.frozen, null);
    assert.equal(result.manifest.summary.pending, 12);
});
