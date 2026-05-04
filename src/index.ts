import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgs
} from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import Logger from "@pkcprotocol/pkc-logger";
import {
    DEFAULT_CACHE_PATH,
    DEFAULT_API_URL,
    DEFAULT_ERROR,
    DEFAULT_MODEL,
    ModelVerdictSchema,
    createOptionsSchema,
    type ModelVerdict,
    type ParsedOptions
} from "./schema.js";

const log = Logger("bitsocial:community:challenge:ai-moderation");
const LEGACY_RUNTIME_COMMUNITY_KEY = String.fromCharCode(115, 117, 98, 112, 108, 101, 98, 98, 105, 116);
const MAX_CACHE_ENTRIES = 1000;
const MAX_JSON_CACHE_ENTRIES = 10_000;
const FAILED_CACHE_TTL_MS = 30_000;

const DEFAULT_SYSTEM_PROMPT = [
    "You are the automated first-pass moderation filter for a Bitsocial community.",
    "",
    "Decide whether the submitted publication should be allowed or routed to moderator review.",
    "",
    "Return review only when the content:",
    "",
    "- clearly violates one or more supplied community rules;",
    "- is obvious commercial spam, scam, phishing, malware, pornographic-site promotion, escort/adult-service promotion, referral/affiliate link spam, or repeated low-effort flooding;",
    "- is targeted abuse, harassment, threats, or repeated offensive-word spam.",
    "",
    "Return allow when:",
    "",
    "- the case is ambiguous, lacks evidence, or would need human judgment;",
    "- the post is merely offensive, inflammatory, political, controversial, rude, or low-quality but does not clearly cross a rule;",
    "- offensive or derogatory terms are mentioned, quoted, discussed, used historically, or used as the subject of a question rather than as targeted abuse.",
    "- the only concern is missing context, unclear topic fit, missing media/link evidence, uncertain media format, or inability to inspect linked media.",
    "",
    'Review is not a "maybe" label. If you are unsure whether content crosses a rule, return allow.',
    "",
    "Treat community.features as metadata, not community rules. Do not return review solely because of feature fields such as requirePostLink, requirePostLinkIsMedia, safeForWork, noSpoilers, noSpoilerReplies, pseudonymityMode, or voting settings unless the same requirement is explicitly present in community.rules or the post is obvious spam/abuse as defined above.",
    "",
    "Do not enforce general platform-safety preferences beyond the supplied community rules and the obvious spam/abuse categories above.",
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
        option: "apiKey",
        label: "API key",
        default: "",
        description: "Private provider API key",
        placeholder: "sk-..."
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
        option: "cachePath",
        label: "Cache path",
        default: DEFAULT_CACHE_PATH,
        description: "Path to a private JSON verdict cache; leave empty to disable persistent caching",
        placeholder: "~/.bitsocial-ai-moderation-cache.json"
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

type JsonCacheEntry = {
    cachedAt: number;
    verdict: ModelVerdict;
};

type JsonCacheFile = {
    version: 1;
    entries: Record<string, JsonCacheEntry>;
};

const evaluateCache = new Map<string, Promise<ModelVerdict>>();
const jsonCacheWrites = new Map<string, Promise<void>>();

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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const addCachedPromise = (key: string, promise: Promise<ModelVerdict>) => {
    if (evaluateCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = evaluateCache.keys().next().value;
        if (typeof firstKey === "string") {
            evaluateCache.delete(firstKey);
        }
    }
    evaluateCache.set(key, promise);
};

const expandCachePath = (cachePath: string) => {
    if (cachePath === "~") return homedir();
    if (cachePath.startsWith("~/")) return join(homedir(), cachePath.slice(2));
    return cachePath;
};

const parseJsonCacheFile = (value: unknown): JsonCacheFile => {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
        return { version: 1, entries: {} };
    }

    const entries = Object.entries(value.entries).reduce<Record<string, JsonCacheEntry>>((acc, [key, entry]) => {
        if (!isRecord(entry) || typeof entry.cachedAt !== "number") return acc;
        const verdict = ModelVerdictSchema.safeParse(entry.verdict);
        if (!verdict.success) return acc;
        acc[key] = {
            cachedAt: entry.cachedAt,
            verdict: verdict.data
        };
        return acc;
    }, {});

    return { version: 1, entries };
};

const readJsonCache = async (cachePath: string): Promise<JsonCacheFile> => {
    try {
        const data = await readFile(expandCachePath(cachePath), "utf8");
        return parseJsonCacheFile(JSON.parse(data));
    } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
            return { version: 1, entries: {} };
        }
        const message = error instanceof Error ? error.message : "Unknown JSON cache read error";
        log.error("AI moderation JSON cache read failed: %s", message);
        return { version: 1, entries: {} };
    }
};

const getCachedVerdictFromJson = async (cachePath: string | undefined, cacheKey: string) => {
    if (!cachePath) return undefined;
    const cache = await readJsonCache(cachePath);
    return cache.entries[cacheKey]?.verdict;
};

const pruneJsonCacheEntries = (entries: Record<string, JsonCacheEntry>) => {
    const sortedEntries = Object.entries(entries).sort((a, b) => b[1].cachedAt - a[1].cachedAt);
    return Object.fromEntries(sortedEntries.slice(0, MAX_JSON_CACHE_ENTRIES));
};

const writeJsonCache = async ({ cachePath, cacheKey, verdict }: { cachePath: string; cacheKey: string; verdict: ModelVerdict }) => {
    const resolvedCachePath = expandCachePath(cachePath);
    const cache = await readJsonCache(cachePath);
    cache.entries[cacheKey] = {
        cachedAt: Date.now(),
        verdict
    };
    cache.entries = pruneJsonCacheEntries(cache.entries);

    await mkdir(dirname(resolvedCachePath), { recursive: true });
    const tempPath = `${resolvedCachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await rename(tempPath, resolvedCachePath);
};

const setCachedVerdictInJson = async ({
    cachePath,
    cacheKey,
    verdict
}: {
    cachePath: string | undefined;
    cacheKey: string;
    verdict: ModelVerdict;
}) => {
    if (!cachePath) return;

    const previousWrite = jsonCacheWrites.get(cachePath) ?? Promise.resolve();
    const nextWrite = previousWrite
        .catch(() => undefined)
        .then(() => writeJsonCache({ cachePath, cacheKey, verdict }))
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Unknown JSON cache write error";
            log.error("AI moderation JSON cache write failed: %s", message);
        });

    jsonCacheWrites.set(cachePath, nextWrite);
    await nextWrite;
    if (jsonCacheWrites.get(cachePath) === nextWrite) {
        jsonCacheWrites.delete(cachePath);
    }
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
    const apiKey = options.apiKey;
    if (!apiKey) {
        throw new Error("AI moderation API key is not configured in challenge options");
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
    const promptHash = sha256(systemPrompt);
    const cacheKey = sha256(
        stableStringify({
            apiUrl: options.apiUrl,
            apiFormat: options.apiFormat,
            model: options.model,
            promptHash,
            target,
            communityContext
        })
    );
    const cached = evaluateCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const cachedVerdict = await getCachedVerdictFromJson(options.cachePath, cacheKey);
    if (cachedVerdict) {
        const cachedPromise = Promise.resolve(cachedVerdict);
        addCachedPromise(cacheKey, cachedPromise);
        return cachedVerdict;
    }

    const requestBody = createModelRequestBody({
        options,
        systemPrompt,
        communityContext,
        target
    });

    const promise = postJson({
        options,
        apiKey,
        body: requestBody
    })
        .then(parseModelResponse)
        .then(async (verdict) => {
            await setCachedVerdictInJson({
                cachePath: options.cachePath,
                cacheKey,
                verdict
            });
            return verdict;
        });

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
