import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { evaluationJevBody, liveEvaluation } from "../../moderation-evaluate.mjs";

const fixture = JSON.parse(await readFile(new URL("../../../evaluations/moderation-corpus.json", import.meta.url)));
const corpus = { ...fixture, cases: [fixture.cases[0]] };
const endpoint = "https://api.typesafe.ai/v1/systemone";
const profile = { id: "trial", options: { jevMode: "triage", jevApiUrl: endpoint, jevModel: "jev-1.13.0" } };
const request = {
    model: "jev-1.13.0",
    state: { trustedPolicy: "AUTHORITATIVE_POLICY", publication: { content: "UNTRUSTED_TEXT" } },
    questions: {
        decision: { type: "choice", instructions: "Apply the policy", criteria: { allow: "No clear violation", review: "Clear violation" } }
    }
};
const body = JSON.stringify(request);

test("default is byte-identical; contrastive changes only criteria and rejects unknown request shapes", () => {
    assert.equal(evaluationJevBody(body), body);
    const trial = JSON.parse(evaluationJevBody(body, "contrastive"));
    assert.deepEqual(trial.state, request.state);
    assert.equal(trial.questions.decision.instructions, request.questions.decision.instructions);
    assert.deepEqual(Object.keys(trial.questions.decision.criteria), ["allow", "review"]);
    assert.notDeepEqual(trial.questions.decision.criteria, request.questions.decision.criteria);
    assert.throws(() => evaluationJevBody(body, null), /rubric/);
    assert.throws(() => evaluationJevBody("{}", "contrastive"), /Unsupported/);
});

test("trial transforms only Jev, counts full transformed bytes and reports hashes without policy or text", async () => {
    const sent = [];
    const fallback = JSON.stringify({ messages: [{ content: "fallback input" }] });
    const result = await liveEvaluation(corpus, profile, {
        jevRubric: "contrastive",
        maxRequests: 2,
        maxRequestBytes: 10000,
        fetchImpl: async (url, init) => {
            sent.push({ url, init });
            return new Response("{}");
        },
        factory: () => ({
            getChallenge: async () => {
                await globalThis.fetch(endpoint, { method: "POST", body });
                await globalThis.fetch("https://provider.example/fallback", { method: "POST", body: fallback });
                return { success: false };
            }
        })
    });
    assert.equal(sent[0].init.body, evaluationJevBody(body, "contrastive"));
    assert.equal(sent[1].init.body, fallback);
    assert.equal(result.requestBytes, Buffer.byteLength(sent[0].init.body) + Buffer.byteLength(fallback));
    assert.equal(result.rubricExperiment.questionHashes.length, 1);
    assert.ok(!JSON.stringify(result).includes("UNTRUSTED_TEXT"));
    assert.ok(!JSON.stringify(result).includes("AUTHORITATIVE_POLICY"));
});

test("the expanded prompt cannot bypass byte budgets and invalid trials make no calls", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    const options = {
        jevRubric: "contrastive",
        maxRequests: 1,
        maxRequestBytes: Buffer.byteLength(body),
        fetchImpl: async () => {
            calls++;
            return new Response("{}");
        },
        factory: () => ({
            getChallenge: async () => {
                await assert.rejects(() => globalThis.fetch(endpoint, { method: "POST", body }), /budget/);
                return { success: false };
            }
        })
    };
    const result = await liveEvaluation(corpus, profile, options);
    assert.equal(result.budgetExceeded, true);
    assert.equal(calls, 0);
    assert.equal(globalThis.fetch, original);
    await assert.rejects(() => liveEvaluation(corpus, profile, { ...options, jevRubric: "invalid" }), /rubric/);
    await assert.rejects(() => liveEvaluation(corpus, { ...profile, options: { jevMode: "off" } }, options), /triage/);
    await assert.rejects(
        () => liveEvaluation(corpus, { ...profile, options: { ...profile.options, jevApiUrl: "https://other.example" } }, options),
        /official/
    );
    assert.equal(calls, 0);
});

test("cached factory reuse and concurrent evaluations fail before another provider call", async () => {
    let calls = 0;
    let release;
    const waiting = new Promise((resolve) => {
        release = resolve;
    });
    let entered;
    const ready = new Promise((resolve) => {
        entered = resolve;
    });
    const factory = () => ({
        getChallenge: async () => {
            entered();
            await waiting;
            await globalThis.fetch(endpoint, { method: "POST", body });
            return { success: false };
        }
    });
    const options = {
        factory,
        maxRequests: 1,
        maxRequestBytes: 10000,
        fetchImpl: async () => {
            calls++;
            return new Response("{}");
        }
    };
    const first = liveEvaluation(corpus, profile, options);
    await ready;
    try {
        await assert.rejects(() => liveEvaluation(corpus, profile, { ...options, factory: () => ({}) }), /separate process/);
    } finally {
        release();
    }
    await first;
    await assert.rejects(() => liveEvaluation(corpus, profile, { ...options, jevRubric: "contrastive" }), /separate process/);
    assert.equal(calls, 1);
});

test("invalid tariffs do not acquire the process guard or poison a later evaluation", async () => {
    const factory = () => ({ getChallenge: async () => ({ success: false }) });
    const options = { factory, maxRequests: 1, maxRequestBytes: 1000 };
    await assert.rejects(() => liveEvaluation(corpus, profile, { ...options, rates: {} }), /Rates/);
    const result = await liveEvaluation(corpus, profile, options);
    assert.equal(result.requests, 0);
});
