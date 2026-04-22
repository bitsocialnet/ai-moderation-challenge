import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgs
} from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import { signBufferEd25519 } from "./pkc-js-signer.js";
import {
    AiModerationEvaluateResponseSchema,
    DEFAULT_ERROR,
    DEFAULT_SERVER_URL,
    createOptionsSchema,
    type AiModerationEvaluateResponse,
    type ParsedOptions
} from "./schema.js";
import * as cborg from "cborg";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import Logger from "@pkcprotocol/pkc-logger";

const log = Logger("bitsocial:community:challenge:ai-moderation");
const LEGACY_RUNTIME_COMMUNITY_KEY = String.fromCharCode(115, 117, 98, 112, 108, 101, 98, 98, 105, 116);
const MAX_CACHE_ENTRIES = 1000;
const FAILED_CACHE_TTL_MS = 30_000;

const optionInputs = [
    {
        option: "serverUrl",
        label: "Server URL",
        default: DEFAULT_SERVER_URL,
        description: "URL of the Bitsocial moderation server",
        placeholder: "https://moderation.bitsocial.net/api/v1"
    },
    {
        option: "branch",
        label: "Branch",
        default: "allow",
        description: "AI moderation branch to evaluate: allow or review",
        placeholder: "allow"
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

type RuntimeSigner = {
    privateKey?: string;
    publicKey?: string;
    type?: string;
};

type RuntimeCommunity = {
    address?: string;
    title?: string;
    description?: string;
    rules?: unknown;
    features?: unknown;
    signer?: RuntimeSigner;
};

type CommunityContext = {
    address?: string;
    title?: string;
    description?: string;
    rules: string[];
    features?: Record<string, unknown>;
};

type ModeratedKind = "comment" | "content-edit";

const evaluateCache = new Map<string, Promise<AiModerationEvaluateResponse>>();

const isRuntimeCommunity = (value: unknown): value is RuntimeCommunity =>
    typeof value === "object" && value !== null && ("signer" in value || "address" in value || "rules" in value);

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

const createRequestSignature = async (
    propsToSign: Record<string, unknown>,
    signer: { privateKey?: string; publicKey?: string; type?: string }
) => {
    if (!signer.privateKey || !signer.publicKey || !signer.type) {
        throw new Error("Community signer is missing required fields");
    }

    const encoded = cborg.encode(propsToSign);
    const signatureBuffer = await signBufferEd25519(encoded, signer.privateKey);
    return {
        signature: signatureBuffer,
        publicKey: uint8ArrayFromString(signer.publicKey, "base64"),
        type: signer.type,
        signedPropertyNames: Object.keys(propsToSign)
    };
};

const postCbor = async (url: string, body: unknown): Promise<unknown> => {
    const encoded = cborg.encode(body);
    log.trace(`POST ${url} request body (CBOR, %d bytes)`, encoded.length);
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/cbor",
            accept: "application/json",
            "ngrok-skip-browser-warning": "true"
        },
        body: Buffer.from(encoded)
    });

    let responseBody: unknown;
    try {
        responseBody = (await response.json()) as unknown;
    } catch {
        responseBody = undefined;
    }

    log.trace(`POST ${url} response status: ${response.status}, body: %o`, responseBody);

    if (!response.ok) {
        const details = responseBody !== undefined ? `: ${JSON.stringify(responseBody)}` : "";
        throw new Error(`Bitsocial AI moderation server error (${response.status})${details}`);
    }

    if (responseBody === undefined) {
        throw new Error("Invalid JSON response from Bitsocial AI moderation server");
    }

    return responseBody;
};

const parseEvaluateResponse = (data: unknown) => {
    try {
        return AiModerationEvaluateResponseSchema.parse(data);
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const suffix = message ? `: ${message}` : "";
        throw new Error(`Invalid AI moderation response from Bitsocial server${suffix}`);
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

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

const addCachedPromise = (key: string, promise: Promise<AiModerationEvaluateResponse>) => {
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

const getModeratedKind = (challengeRequestMessage: GetChallengeArgs["challengeRequestMessage"]): ModeratedKind | undefined => {
    if (isRecord(challengeRequestMessage.comment)) {
        return "comment";
    }

    if (isRecord(challengeRequestMessage.commentEdit) && typeof challengeRequestMessage.commentEdit.content === "string") {
        return "content-edit";
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

const evaluate = async ({
    challengeRequestMessage,
    communityContext,
    options,
    signer
}: {
    challengeRequestMessage: GetChallengeArgs["challengeRequestMessage"];
    communityContext: CommunityContext;
    options: ParsedOptions;
    signer: RuntimeSigner;
}) => {
    const cacheKey = stableStringify({
        serverUrl: options.serverUrl,
        challengeRequest: challengeRequestMessage,
        communityContext
    });
    const cached = evaluateCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const propsToSign = {
        challengeRequest: challengeRequestMessage,
        communityContext,
        timestamp
    };

    const promise = createRequestSignature(propsToSign, signer).then((signature) =>
        postCbor(`${options.serverUrl}/ai-moderation/evaluate`, {
            ...propsToSign,
            signature
        }).then(parseEvaluateResponse)
    );

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
    const kind = getModeratedKind(args.challengeRequestMessage);
    if (!kind) {
        return getBypassResult(options);
    }

    const runtimeCommunity = getRuntimeCommunity(args);
    const signer = runtimeCommunity?.signer;
    if (!signer) {
        return getFallbackResult(kind, options, new Error("Community signer is required to call Bitsocial AI moderation"));
    }

    const communityContext = getCommunityContext(runtimeCommunity);

    try {
        const response = await evaluate({
            challengeRequestMessage: args.challengeRequestMessage,
            communityContext,
            options,
            signer
        });
        return getBranchResult(kind, options, response.verdict, response.reason);
    } catch (error) {
        return getFallbackResult(kind, options, error);
    }
};

function ChallengeFileFactory(_communityChallengeSettings: GetChallengeArgs["challengeSettings"]): ChallengeFileInput {
    return { getChallenge, optionInputs, type, description };
}

export default ChallengeFileFactory;
