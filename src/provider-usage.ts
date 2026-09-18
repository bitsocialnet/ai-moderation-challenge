export type ProviderUsage = {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const ownValue = (record: Record<string, unknown> | undefined, key: string): unknown =>
    record && Object.hasOwn(record, key) ? record[key] : undefined;

const tokenCount = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const getProviderUsage = (data: unknown): ProviderUsage | undefined => {
    try {
        const usage = asRecord(ownValue(asRecord(data), "usage"));
        if (!usage) return undefined;

        // Select one API shape so malformed or mixed telemetry cannot combine unrelated counts.
        const isResponses = ["input_tokens", "output_tokens", "input_tokens_details", "output_tokens_details"].some((key) =>
            Object.hasOwn(usage, key)
        );
        const inputDetails = asRecord(ownValue(usage, isResponses ? "input_tokens_details" : "prompt_tokens_details"));
        const outputDetails = asRecord(ownValue(usage, isResponses ? "output_tokens_details" : "completion_tokens_details"));
        const inputTokens = tokenCount(ownValue(usage, isResponses ? "input_tokens" : "prompt_tokens"));
        const outputTokens = tokenCount(ownValue(usage, isResponses ? "output_tokens" : "completion_tokens"));
        let cachedInputTokens = tokenCount(ownValue(inputDetails, "cached_tokens"));
        let cacheWriteInputTokens = isResponses ? tokenCount(ownValue(inputDetails, "cache_write_tokens")) : undefined;
        const reasoningTokens = tokenCount(ownValue(outputDetails, "reasoning_tokens"));

        if (
            inputTokens !== undefined &&
            ((cachedInputTokens !== undefined && cachedInputTokens > inputTokens) ||
                (cacheWriteInputTokens !== undefined && cacheWriteInputTokens > inputTokens) ||
                (cachedInputTokens !== undefined &&
                    cacheWriteInputTokens !== undefined &&
                    cachedInputTokens > inputTokens - cacheWriteInputTokens))
        ) {
            cachedInputTokens = undefined;
            cacheWriteInputTokens = undefined;
        }

        const normalized: ProviderUsage = {};
        if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
        if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
        if (cachedInputTokens !== undefined) normalized.cachedInputTokens = cachedInputTokens;
        if (cacheWriteInputTokens !== undefined) normalized.cacheWriteInputTokens = cacheWriteInputTokens;
        // Providers differ in whether output already includes reasoning. Preserve the reported count.
        if (reasoningTokens !== undefined) normalized.reasoningTokens = reasoningTokens;
        return Object.keys(normalized).length ? normalized : undefined;
    } catch {
        // Optional accounting must never turn an otherwise valid verdict into an unavailable result.
        return undefined;
    }
};
