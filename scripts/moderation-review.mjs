#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { freezeCorpus } from "./moderation-calibrate.mjs";
import { validateCorpus } from "./moderation-evaluate.mjs";
import { createReviewQueue, selectReview, reviewHash, readReviewJson, writeReviewJson, reviewHtml } from "./jev/review-handoff.mjs";

export function prepareModerationReview(corpus, assignments, { commit, policySource, corpusId = "moderation-blind-v1" }) {
    freezeCorpus(corpus, assignments);
    if (corpus.cases.some((item) => item.provenance !== "synthetic"))
        throw new Error(
            "This handoff supports existing synthetic fixtures only; real moderation data needs a separately authorized sanitized source"
        );
    const prompts = ["DEFAULT_SYSTEM_PROMPT", "REPLY_MODERATION_POLICY_PROMPT"].map((name) => {
        const match = policySource.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])\\.join\\("\\\\n"\\);`));
        if (!match) throw new Error("Public policy source changed; review the rubric extraction");
        return match[1]
            .slice(1, -1)
            .trim()
            .split("\n")
            .map((line) => {
                const literal = line.trim().replace(/,$/, "");
                if (literal.startsWith('"')) return JSON.parse(literal);
                if (/^'[^'\\]*'$/.test(literal)) return literal.slice(1, -1);
                throw new Error("Public policy contains unsupported source syntax; review rubric extraction");
            })
            .join("\n");
    });
    const rubric = {
        version: "moderation-public-review-v1",
        sourceSha256: reviewHash(policySource),
        text:
            prompts.join("\n\n") +
            "\n\nHuman review: label allow or route to moderator review using this public policy and each supplied rule. If YOU cannot apply the policy with the provided information, select uncertain / needs context; this is an unlabeled human item, not a predicted moderation action. URL date paths provide UTC day bounds; use the final instant of that UTC day for older-than-window checks. Missing, invalid, or future dates do not prove an article too old. A configured age window does not override a stricter community rule. Do not open linked URLs. These are existing synthetic fixtures, not actual community traffic."
    };
    const byId = new Map(assignments.map((item) => [item.id, item]));
    return createReviewQueue({
        kind: "moderation",
        corpusId,
        rubric,
        items: corpus.cases.map((item, index) => ({
            source: { kind: "synthetic", repository: "ai-moderation-challenge", commit, path: "evaluations/moderation-corpus.json", index },
            group: `group-${reviewHash(byId.get(item.id).group).slice(0, 24)}`,
            split: byId.get(item.id).split,
            content: {
                rules: item.rules,
                publication: item.publication,
                ...(item.articleMaxAgeHours === undefined ? {} : { articleMaxAgeHours: item.articleMaxAgeHours })
            }
        }))
    });
}

export function importModerationReview(queue, bundle) {
    if (queue.kind !== "moderation") throw new Error("Expected moderation queue");
    const manifest = selectReview(queue, bundle);
    const labeled = manifest.items.filter((item) => item.state === "labeled");
    const corpus = labeled.length
        ? {
              version: 1,
              cases: labeled.map((item) => ({
                  id: item.id,
                  expected: item.label,
                  provenance: "synthetic",
                  rationale: "Human-reviewed synthetic fixture; not real moderation traffic.",
                  ...item.content,
                  humanReview: {
                      ...manifest.reviewer,
                      queueSha256: manifest.queueSha256,
                      contentSha256: item.contentSha256,
                      source: item.source
                  }
              }))
          }
        : null;
    if (corpus) validateCorpus(corpus);
    const assignments = labeled.map(({ id, group, split }) => ({ id, group, split }));
    const frozen = corpus && new Set(assignments.map((item) => item.split)).size === 2 ? freezeCorpus(corpus, assignments) : null;
    return { corpus, assignments, frozen, manifest };
}

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({
        args: argv,
        options: { help: { type: "boolean" }, queue: { type: "string" }, review: { type: "string" }, out: { type: "string" } }
    });
    if (values.help) {
        console.log(
            "Offline import: node scripts/moderation-review.mjs --queue moderation-queue.json --review bitsocial-human-review.json --out new-output-prefix\nWrites decided-only corpus, split assignments, optional frozen corpus, and complete pending/provenance manifest. Never overwrites files. Export API: prepareModerationReview + reviewHtml."
        );
        return;
    }
    if (!values.queue || !values.review || !values.out) throw new Error("Explicit queue, review bundle, and new output prefix required");
    const result = importModerationReview(await readReviewJson(values.queue), await readReviewJson(values.review));
    for (const [name, value] of Object.entries(result)) if (value !== null) await writeReviewJson(`${values.out}.${name}.json`, value);
    console.log(JSON.stringify({ outputPrefix: values.out, ...result.manifest.summary, accuracy: "unmeasured" }));
}
export { reviewHtml };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(() => {
        console.error(
            "Review import failed: check queue identity, reviewer fields, labels, and unused output paths. No accuracy result was produced."
        );
        process.exitCode = 1;
    });
