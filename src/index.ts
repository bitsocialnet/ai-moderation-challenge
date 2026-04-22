import { readFile } from "node:fs/promises";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgs
} from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import Logger from "@pkcprotocol/pkc-logger";
import {
    DEFAULT_API_KEY_ENV,
    DEFAULT_API_URL,
    DEFAULT_ERROR,
    DEFAULT_MODEL,
    DEFAULT_PROMPT_VERSION,
    ModelVerdictSchema,
    createOptionsSchema,
    type ModelVerdict,
    type ParsedOptions
} from "./schema.js";

const log = Logger("bitsocial:community:challenge:ai-moderation");
const LEGACY_RUNTIME_COMMUNITY_KEY = String.fromCharCode(115, 117, 98, 112, 108, 101, 98, 98, 105, 116);
const MAX_CACHE_ENTRIES = 1000;
const FAILED_CACHE_TTL_MS = 30_000;

const DEFAULT_SYSTEM_PROMPT = [
    "You are the automated first-pass moderation filter for a Bitsocial community.",
    "Return review only when the submitted text obviously breaks the supplied community rules or is clearly abusive/spam.",
    "Return allow when the case is ambiguous, harmless, off-topic but not clearly rule-breaking, or needs human judgment.",
    "You are given link URL metadata only. Do not infer hidden media contents and do not request or fetch URLs.",
    "Use matchedRuleIndexes as zero-based indexes into the supplied community rules. Use an empty array when no rule matched.",
    "Return only JSON matching the requested schema."
].join("\n");

const MODEL_RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "reason", "matchedRuleIndexes"],
    properties: {
        verdict: {
            type: "string",
            enum: ["allow", "review"]
        },
        reason: {
            type: "string"
        },
        matchedRuleIndexes: {
            type: "array",
            items: {
                type: "integer",
                minimum: 0
            }
        }
    }
} as const;

const optionInputs = [
    {
        option: "apiUrl",
        label: "API URL",
        default: DEFAULT_API_URL,
        description: "OpenAI-compatible API endpoint URL",
        placeholder: "https://api.openai.com/v1/responses"
    },
    {
        option: "apiFormat",
        label: "API format",
        default: "responses",
        description: "Request format: responses or chat-completions",
        placeholder: "responses"
    },
    {
        option: "apiKeyEnv",
        label: "API key env",
        default: DEFAULT_API_KEY_ENV,
        description: "Environment variable containing the provider API key",
        placeholder: DEFAULT_API_KEY_ENV
    },
    {
        option: "model",
        label: "Model",
        default: DEFAULT_MODEL,
        description: "OpenAI-compatible moderation model",
        placeholder: DEFAULT_MODEL
    },
    {
        option: "branch",
        label: "Branch",
        default: "allow",
        description: "AI moderation branch to evaluate: allow or review",
        placeholder: "allow"
    },
    {
        option: "prompt",
        label: "Prompt",
        default: "",
        description: "Private system prompt text; leave empty to use the built-in prompt",
        placeholder: ""
    },
    {
        option: "promptPath",
        label: "Prompt path",
        default: "",
        description: "Path to a private system prompt file on the community node",
        placeholder: "/root/bitsocial-ai-moderation-prompt.md"
    },
    {
        option: "promptVersion",
        label: "Prompt version",
        default: DEFAULT_PROMPT_VERSION,
        description: "Version string used to separate cached verdicts after prompt changes",
        placeholder: DEFAULT_PROMPT_VERSION
    },
    {
        option: "error",
        label: "Error",
        default: DEFAULT_ERROR,
        description: "Error shown when content is rejected by AI moderation",
        placeholder: DEFAULT_ERROR
    }
] as const satisfies NonNullable<ChallengeFileInput["optionInputs"]>;

const OptionsSchema = createOptionsSchema(optionInputs);

const type: ChallengeInput["type"] = "text/plain";
const description: ChallengeFileInput["description"] = "Moderate Bitsocial publications with AI.";

type RuntimeCommunity = {
    address?: string;
    title?: string;
    description?: string;
    rules?: unknown;
    features?: unknown;
};

type CommunityContext = {
    address?: string;
    title?: string;
    description?: string;
    rules: string[];
    features?: Record<string, unknown>;
};

type ModeratedKind = "comment" | "content-edit";

type LinkTarget = {
    url: string;
    domain?: string;
    path?: string;
    htmlTagName?: string;
};

type PublicationTarget = {
    kind: "post" | "reply" | "commentEdit";
    content?: string;
    title?: string;
    link?: LinkTarget;
    flags: {
        nsfw?: boolean;
        spoiler?: boolean;
        deleted?: boolean;
    };
    flairs: string[];
    commentCid?: string;
    parentCid?: string;
    postCid?: string;
};

type ModerationTarget = {
    kind: ModeratedKind;
    target: PublicationTarget;
};

const evaluateCache = new Map<string, Promise<ModelVerdict>>();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isRuntimeCommunity = (value: unknown): value is RuntimeCommunity =>
    isRecord(value) && ("address" in value || "rules" in value || "title" in value || "description" in value);

const getRuntimeCommunity = (args: GetChallengeArgs): RuntimeCommunity | undefined => {
    if (isRuntimeCommunity(args.community)) {
        return args.community;
    }

    const legacyRuntimeCommunity = (args as Record<string, unknown>)[LEGACY_RUNTIME_COMMUNITY_KEY];
    if (isRuntimeCommunity(legacyRuntimeCommunity)) {
        return legacyRuntimeCommunity;
    }

    return undefined;
};

const parseOptions = (settings: GetChallengeArgs["challengeSettings"]) => {
    const parsed = OptionsSchema.safeParse(settings?.options);
    if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join("; ");
        return { success: false as const, error: `Invalid challenge options: ${message}` };
    }
    return { success: true as const, data: parsed.data };
};

const stableValue = (value: unknown): unknown => {
    if (value instanceof Uint8Array) {
        return { type: "Uint8Array", value: Array.from(value) };
    }
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }
    if (isRecord(value)) {
        return Object.keys(value)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = stableValue(value[key]);
                return acc;
            }, {});
    }
    return value;
};

const stableStringify = (value: unknown) => JSON.stringify(stableValue(value));

const addCachedPromise = (key: string, promise: Promise<ModelVerdict>) => {
    if (evaluateCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = evaluateCache.keys().next().value;
        if (typeof firstKey === "string") {
            evaluateCache.delete(firstKey);
        }
    }
    evaluateCache.set(key, promise);
};

const getCommunityContext = (community: RuntimeCommunity | undefined): CommunityContext => {
    const context: CommunityContext = {
        rules: Array.isArray(community?.rules) ? community.rules.filter((rule): rule is string => typeof rule === "string") : []
    };

    if (typeof community?.address === "string") context.address = community.address;
    if (typeof community?.title === "string") context.title = community.title;
    if (typeof community?.description === "string") context.description = community.description;
    if (isRecord(community?.features)) context.features = community.features;

    return context;
};

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const booleanValue = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const flairText = (flairs: unknown): string[] => {
    if (!Array.isArray(flairs)) return [];
    return flairs
        .map((flair) => {
            if (typeof flair === "string") return flair;
            if (isRecord(flair) && typeof flair.text === "string") return flair.text;
            return undefined;
        })
        .filter((flair): flair is string => Boolean(flair));
};

const linkTarget = ({ link, htmlTagName }: { link: unknown; htmlTagName?: unknown }): LinkTarget | undefined => {
    if (typeof link !== "string" || link.length === 0) return undefined;
    try {
        const url = new URL(link);
        return {
            url: link,
            domain: url.hostname,
            path: url.pathname,
            ...(typeof htmlTagName === "string" ? { htmlTagName } : {})
        };
    } catch {
        return {
            url: link,
            ...(typeof htmlTagName === "string" ? { htmlTagName } : {})
        };
    }
};

const getModerationTarget = (challengeRequestMessage: GetChallengeArgs["challengeRequestMessage"]): ModerationTarget | undefined => {
    const request = challengeRequestMessage as unknown as Record<string, unknown>;

    if (isRecord(request.comment)) {
        const { comment } = request;
        return {
            kind: "comment",
            target: {
                kind: typeof comment.parentCid === "string" ? "reply" : "post",
                content: stringValue(comment.content),
                title: stringValue(comment.title),
                link: linkTarget({ link: comment.link, htmlTagName: comment.linkHtmlTagName }),
                flags: {
                    nsfw: booleanValue(comment.nsfw),
                    spoiler: booleanValue(comment.spoiler)
                },
                flairs: flairText(comment.flairs),
                parentCid: stringValue(comment.parentCid),
                postCid: stringValue(comment.postCid)
            }
        };
    }

    if (isRecord(request.commentEdit) && typeof request.commentEdit.content === "string") {
        const { commentEdit } = request;
        return {
            kind: "content-edit",
            target: {
                kind: "commentEdit",
                content: stringValue(commentEdit.content),
                flags: {
                    nsfw: booleanValue(commentEdit.nsfw),
                    spoiler: booleanValue(commentEdit.spoiler),
                    deleted: booleanValue(commentEdit.deleted)
                },
                flairs: flairText(commentEdit.flairs),
                commentCid: stringValue(commentEdit.commentCid)
            }
        };
    }

    return undefined;
};

const getBypassResult = (options: ParsedOptions): ChallengeResultInput => {
    if (options.branch === "allow") {
        return { success: true };
    }
    return { success: false, error: "AI moderation review branch skipped." };
};

const getFallbackResult = (kind: ModeratedKind, options: ParsedOptions, error: unknown): ChallengeResultInput => {
    const message = error instanceof Error ? error.message : "Unknown AI moderation error";
    log.error("AI moderation failed: %s", message);

    if (kind === "comment" && options.branch === "review") {
        return { success: true };
    }

    return { success: false, error: kind === "content-edit" ? options.error : message };
};

const getBranchResult = (
    kind: ModeratedKind,
    options: ParsedOptions,
    verdict: "allow" | "review",
    reason: string | undefined
): ChallengeResultInput => {
    if (kind === "content-edit" && verdict === "review") {
        return { success: false, error: reason || options.error };
    }

    if (options.branch === verdict) {
        return { success: true };
    }

    return { success: false, error: reason || "AI moderation branch did not match." };
};

const getApiKey = (options: ParsedOptions) => {
    const apiKey = process.env[options.apiKeyEnv];
    if (!apiKey) {
        throw new Error(`AI moderation API key is not configured in ${options.apiKeyEnv}`);
    }
    return apiKey;
};

const loadSystemPrompt = async (options: ParsedOptions) => {
    if (options.prompt) return options.prompt;
    if (options.promptPath) return readFile(options.promptPath, "utf8");
    return DEFAULT_SYSTEM_PROMPT;
};

const createResponsesRequestBody = ({
    model,
    systemPrompt,
    communityContext,
    target
}: {
    model: string;
    systemPrompt: string;
    communityContext: CommunityContext;
    target: PublicationTarget;
}) => ({
    model,
    store: false,
    input: [
        {
            role: "system",
            content: systemPrompt
        },
        {
            role: "user",
            content: JSON.stringify({
                community: communityContext,
                publication: target
            })
        }
    ],
    text: {
        format: {
            type: "json_schema",
            name: "bitsocial_ai_moderation_verdict",
            strict: true,
            schema: MODEL_RESPONSE_SCHEMA
        }
    }
});

const createChatCompletionsRequestBody = ({
    model,
    systemPrompt,
    communityContext,
    target
}: {
    model: string;
    systemPrompt: string;
    communityContext: CommunityContext;
    target: PublicationTarget;
}) => ({
    model,
    messages: [
        {
            role: "system",
            content: systemPrompt
        },
        {
            role: "user",
            content: JSON.stringify({
                community: communityContext,
                publication: target
            })
        }
    ],
    response_format: {
        type: "json_schema",
        json_schema: {
            name: "bitsocial_ai_moderation_verdict",
            strict: true,
            schema: MODEL_RESPONSE_SCHEMA
        }
    }
});

const createModelRequestBody = ({
    options,
    systemPrompt,
    communityContext,
    target
}: {
    options: ParsedOptions;
    systemPrompt: string;
    communityContext: CommunityContext;
    target: PublicationTarget;
}) => {
    const props = {
        model: options.model,
        systemPrompt,
        communityContext,
        target
    };
    return options.apiFormat === "chat-completions" ? createChatCompletionsRequestBody(props) : createResponsesRequestBody(props);
};

const postJson = async ({ options, apiKey, body }: { options: ParsedOptions; apiKey: string; body: unknown }) => {
    log.trace(`POST ${options.apiUrl} request body: %o`, body);
    const response = await fetch(options.apiUrl, {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json"
        },
        body: JSON.stringify(body)
    });

    const responseText = await response.text().catch(() => "");
    log.trace(`POST ${options.apiUrl} response status: ${response.status}, body: %s`, responseText);

    if (!response.ok) {
        const details = responseText ? `: ${responseText}` : "";
        throw new Error(`AI moderation API error (${response.status})${details}`);
    }

    try {
        return JSON.parse(responseText) as unknown;
    } catch {
        throw new Error("Invalid JSON response from AI moderation API");
    }
};

const textFromContentValue = (content: unknown): string | undefined => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;

    const parts = content
        .map((item) => {
            if (!isRecord(item)) return undefined;
            if (typeof item.text === "string") return item.text;
            if (typeof item.content === "string") return item.content;
            return undefined;
        })
        .filter((part): part is string => Boolean(part));

    return parts.length ? parts.join("") : undefined;
};

const extractResponseText = (responseBody: unknown): string | undefined => {
    if (!isRecord(responseBody)) return undefined;
    if (typeof responseBody.output_text === "string") return responseBody.output_text;

    if (Array.isArray(responseBody.output)) {
        for (const item of responseBody.output) {
            if (!isRecord(item) || !Array.isArray(item.content)) continue;
            for (const contentItem of item.content) {
                if (isRecord(contentItem) && contentItem.type === "output_text" && typeof contentItem.text === "string") {
                    return contentItem.text;
                }
            }
        }
    }

    if (Array.isArray(responseBody.choices)) {
        for (const choice of responseBody.choices) {
            if (!isRecord(choice) || !isRecord(choice.message)) continue;
            const content = textFromContentValue(choice.message.content);
            if (content) return content;
        }
    }

    return undefined;
};

const parseModelResponse = (data: unknown) => {
    const outputText = extractResponseText(data);
    if (!outputText) {
        throw new Error("AI moderation response did not include output text");
    }

    let parsedOutput: unknown;
    try {
        parsedOutput = JSON.parse(outputText);
    } catch {
        throw new Error("AI moderation response output was not valid JSON");
    }

    try {
        return ModelVerdictSchema.parse(parsedOutput);
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const suffix = message ? `: ${message}` : "";
        throw new Error(`Invalid AI moderation verdict${suffix}`);
    }
};

const evaluate = async ({
    target,
    communityContext,
    options
}: {
    target: PublicationTarget;
    communityContext: CommunityContext;
    options: ParsedOptions;
}) => {
    const systemPrompt = await loadSystemPrompt(options);
    const apiKey = getApiKey(options);
    const cacheKey = stableStringify({
        apiUrl: options.apiUrl,
        apiFormat: options.apiFormat,
        apiKeyEnv: options.apiKeyEnv,
        model: options.model,
        promptVersion: options.promptVersion,
        systemPrompt,
        target,
        communityContext
    });
    const cached = evaluateCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const promise = postJson({
        options,
        apiKey,
        body: createModelRequestBody({
            options,
            systemPrompt,
            communityContext,
            target
        })
    }).then(parseModelResponse);

    promise.catch(() => {
        const timeout = setTimeout(() => {
            if (evaluateCache.get(cacheKey) === promise) {
                evaluateCache.delete(cacheKey);
            }
        }, FAILED_CACHE_TTL_MS);
        timeout.unref?.();
    });

    addCachedPromise(cacheKey, promise);
    return promise;
};

const getChallenge = async (args: GetChallengeArgs): Promise<ChallengeResultInput> => {
    const parsedOptions = parseOptions(args.challengeSettings);
    if (!parsedOptions.success) {
        return { success: false, error: parsedOptions.error };
    }

    const options = parsedOptions.data;
    const moderationTarget = getModerationTarget(args.challengeRequestMessage);
    if (!moderationTarget) {
        return getBypassResult(options);
    }

    const communityContext = getCommunityContext(getRuntimeCommunity(args));

    try {
        const response = await evaluate({
            target: moderationTarget.target,
            communityContext,
            options
        });
        return getBranchResult(moderationTarget.kind, options, response.verdict, response.reason);
    } catch (error) {
        return getFallbackResult(moderationTarget.kind, options, error);
    }
};

function ChallengeFileFactory(_communityChallengeSettings: GetChallengeArgs["challengeSettings"]): ChallengeFileInput {
    return { getChallenge, optionInputs, type, description };
}

export default ChallengeFileFactory;
