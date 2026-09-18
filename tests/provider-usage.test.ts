import { describe, expect, it } from "vitest";
import { getProviderUsage } from "../src/provider-usage.js";

describe("provider usage normalization", () => {
    it("retains Responses token and cache accounting without retaining response content", () => {
        const data = {
            id: "response-id",
            output_text: '{"verdict":"allow"}',
            usage: {
                input_tokens: 3000,
                output_tokens: 48,
                input_tokens_details: { cached_tokens: 2500, cache_write_tokens: 400 },
                output_tokens_details: { reasoning_tokens: 20 },
                total_tokens: 3048,
                prompt: "private prompt",
                authorization: "private authorization"
            }
        };

        expect(getProviderUsage(data)).toEqual({
            inputTokens: 3000,
            outputTokens: 48,
            cachedInputTokens: 2500,
            cacheWriteInputTokens: 400,
            reasoningTokens: 20
        });
    });

    it("retains Jev counts without inventing cache or reasoning metrics", () => {
        expect(
            getProviderUsage({
                model: "jev-1.13.0",
                choice: "allow",
                probabilities: { allow: 0.99, review: 0.01 },
                usage: { input_tokens: 2827, output_tokens: 31 }
            })
        ).toEqual({ inputTokens: 2827, outputTokens: 31 });
    });

    it("keeps chat reasoning separate even when it exceeds the reported completion count", () => {
        expect(
            getProviderUsage({
                choices: [{ message: { content: '{"verdict":"review"}', reasoning_content: "private reasoning" } }],
                usage: {
                    prompt_tokens: 3000,
                    completion_tokens: 40,
                    prompt_tokens_details: { cached_tokens: 2800 },
                    completion_tokens_details: { reasoning_tokens: 94 },
                    cost_in_usd_ticks: 10000
                }
            })
        ).toEqual({ inputTokens: 3000, outputTokens: 40, cachedInputTokens: 2800, reasoningTokens: 94 });
    });

    it("preserves explicit zero counts and absent totals independently", () => {
        expect(
            getProviderUsage({
                usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }
            })
        ).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
        expect(getProviderUsage({ usage: { output_tokens_details: { reasoning_tokens: 0 } } })).toEqual({ reasoningTokens: 0 });
        expect(getProviderUsage({ usage: { input_tokens_details: { cached_tokens: 10 } } })).toEqual({ cachedInputTokens: 10 });
    });

    it.each([undefined, null, "12", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []])(
        "omits invalid counts (%j) while preserving valid independent metrics",
        (invalid) => {
            expect(
                getProviderUsage({
                    usage: {
                        input_tokens: 100,
                        output_tokens: invalid,
                        input_tokens_details: { cached_tokens: invalid, cache_write_tokens: invalid },
                        output_tokens_details: { reasoning_tokens: invalid }
                    }
                })
            ).toEqual({ inputTokens: 100 });
        }
    );

    it.each([
        { cached_tokens: 101, cache_write_tokens: 0 },
        { cached_tokens: 0, cache_write_tokens: 101 },
        { cached_tokens: 70, cache_write_tokens: 31 }
    ])("omits inconsistent cache decomposition (%j)", (inputDetails) => {
        expect(getProviderUsage({ usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: inputDetails } })).toEqual({
            inputTokens: 100,
            outputTokens: 10
        });
    });

    it("allows consistent cache counts at the safe integer boundary", () => {
        expect(
            getProviderUsage({
                usage: {
                    input_tokens: Number.MAX_SAFE_INTEGER,
                    input_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER - 1, cache_write_tokens: 1 }
                }
            })
        ).toEqual({ inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: Number.MAX_SAFE_INTEGER - 1, cacheWriteInputTokens: 1 });
    });

    it.each([undefined, null, [], "response", {}, { usage: null }, { usage: [] }, { usage: {} }, { usage: { total_tokens: 100 } }])(
        "returns no usage when recognized metrics are absent (%j)",
        (data) => {
            expect(getProviderUsage(data)).toBeUndefined();
        }
    );

    it("does not search nested payloads or read unknown fields", () => {
        const data = {
            output: [{ usage: { input_tokens: 123 } }],
            usage: {
                output_tokens: 10,
                get prompt() {
                    throw new Error("private payload must not be read");
                }
            }
        };
        expect(getProviderUsage(data)).toEqual({ outputTokens: 10 });
        expect(getProviderUsage({ output: [{ usage: { input_tokens: 123 } }] })).toBeUndefined();
        expect(getProviderUsage(Object.create({ usage: { input_tokens: 123 } }))).toBeUndefined();
    });

    it("does not combine Responses and chat usage fields", () => {
        expect(
            getProviderUsage({
                usage: { input_tokens: "invalid", output_tokens: 10, prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 1000 } }
            })
        ).toEqual({ outputTokens: 10 });
    });

    it("returns no usage if malformed telemetry throws", () => {
        expect(
            getProviderUsage({
                get usage() {
                    throw new Error("malformed telemetry");
                }
            })
        ).toBeUndefined();
    });
});
