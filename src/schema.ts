import { z } from "zod";

export const DEFAULT_SERVER_URL = "https://spamblocker.bitsocial.net/api/v1";
export const DEFAULT_ERROR = "Rejected by Bitsocial AI moderation.";

export const BranchSchema = z.enum(["allow", "review"]);

export const AiModerationEvaluateResponseSchema = z.object({
    verdict: BranchSchema,
    reason: z.string().optional(),
    matchedRuleIndexes: z.array(z.number().int().nonnegative()).optional(),
    model: z.string().optional(),
    policyVersion: z.string().optional(),
    cacheHit: z.boolean().optional()
});

export type Branch = z.infer<typeof BranchSchema>;
export type AiModerationEvaluateResponse = z.infer<typeof AiModerationEvaluateResponseSchema>;

export type ParsedOptions = {
    serverUrl: string;
    branch: Branch;
    error: string;
};

type OptionName = keyof ParsedOptions;

type OptionInput = {
    option: OptionName;
    default: string;
};

const normalizeServerUrl = (url: string) => url.replace(/\/+$/, "");

const isHttpUrl = (value: string) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
};

export const createOptionsSchema = (optionInputs: ReadonlyArray<OptionInput>) => {
    const optionDefaults = optionInputs.reduce(
        (acc, input) => {
            acc[input.option] = input.default;
            return acc;
        },
        {} as Record<OptionName, string>
    );

    const getOptionDefault = (option: OptionName) => optionDefaults[option];

    const resolveOptionString = (value: unknown, option: OptionName) => {
        if (typeof value === "string") {
            const trimmed = value.trim();
            return trimmed ? trimmed : getOptionDefault(option);
        }
        if (value === undefined || value === null) {
            return getOptionDefault(option);
        }
        return value;
    };

    const schema: z.ZodType<ParsedOptions> = z.preprocess(
        (value) => (value && typeof value === "object" ? value : {}),
        z.object({
            serverUrl: z.preprocess(
                (value) => {
                    const resolved = resolveOptionString(value, "serverUrl");
                    return typeof resolved === "string" ? normalizeServerUrl(resolved) : resolved;
                },
                z.url().refine(isHttpUrl, {
                    message: "Server URL must use http or https"
                })
            ),
            branch: z.preprocess((value) => {
                const resolved = resolveOptionString(value, "branch");
                return typeof resolved === "string" ? resolved.trim().toLowerCase() : resolved;
            }, BranchSchema),
            error: z.preprocess((value) => resolveOptionString(value, "error"), z.string())
        })
    );

    return schema;
};
