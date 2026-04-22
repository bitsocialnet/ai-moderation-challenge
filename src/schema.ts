import { z } from "zod";

export const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_API_KEY_ENV = "AI_MODERATION_OPENAI_API_KEY";
export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_PROMPT_VERSION = "bitsocial-ai-moderation-v1";
export const DEFAULT_ERROR = "Rejected by Bitsocial AI moderation.";

export const BranchSchema = z.enum(["allow", "review"]);
export const ApiFormatSchema = z.enum(["responses", "chat-completions"]);

export const ModelVerdictSchema = z
    .object({
        verdict: BranchSchema,
        reason: z.string().optional(),
        matchedRuleIndexes: z.array(z.number().int().nonnegative()).optional()
    })
    .strict();

export type Branch = z.infer<typeof BranchSchema>;
export type ApiFormat = z.infer<typeof ApiFormatSchema>;
export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;

export type ParsedOptions = {
    apiUrl: string;
    apiFormat: ApiFormat;
    apiKeyEnv: string;
    model: string;
    branch: Branch;
    prompt?: string;
    promptPath?: string;
    promptVersion: string;
    error: string;
};

type OptionName = keyof ParsedOptions;

type OptionInput = {
    option: OptionName;
    default: string;
};

const normalizeUrl = (url: string) => url.replace(/\/+$/, "");

const isHttpUrl = (value: string) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
};

const isEnvVarName = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);

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

    const resolveOptionalOptionString = (value: unknown, option: OptionName) => {
        const resolved = resolveOptionString(value, option);
        if (typeof resolved !== "string") return resolved;
        const trimmed = resolved.trim();
        return trimmed ? trimmed : undefined;
    };

    const schema: z.ZodType<ParsedOptions> = z.preprocess(
        (value) => (value && typeof value === "object" ? value : {}),
        z
            .object({
                apiUrl: z.preprocess(
                    (value) => {
                        const resolved = resolveOptionString(value, "apiUrl");
                        return typeof resolved === "string" ? normalizeUrl(resolved) : resolved;
                    },
                    z.url().refine(isHttpUrl, {
                        message: "API URL must use http or https"
                    })
                ),
                apiFormat: z.preprocess((value) => {
                    const resolved = resolveOptionString(value, "apiFormat");
                    return typeof resolved === "string" ? resolved.trim().toLowerCase() : resolved;
                }, ApiFormatSchema),
                apiKeyEnv: z.preprocess(
                    (value) => resolveOptionString(value, "apiKeyEnv"),
                    z.string().min(1).refine(isEnvVarName, {
                        message: "API key environment variable must be a valid environment variable name"
                    })
                ),
                model: z.preprocess((value) => resolveOptionString(value, "model"), z.string().min(1)),
                branch: z.preprocess((value) => {
                    const resolved = resolveOptionString(value, "branch");
                    return typeof resolved === "string" ? resolved.trim().toLowerCase() : resolved;
                }, BranchSchema),
                prompt: z.preprocess((value) => resolveOptionalOptionString(value, "prompt"), z.string().optional()),
                promptPath: z.preprocess((value) => resolveOptionalOptionString(value, "promptPath"), z.string().optional()),
                promptVersion: z.preprocess((value) => resolveOptionString(value, "promptVersion"), z.string().min(1)),
                error: z.preprocess((value) => resolveOptionString(value, "error"), z.string())
            })
            .refine((options) => !(options.prompt && options.promptPath), {
                message: "Use prompt or promptPath, not both"
            })
    );

    return schema;
};
