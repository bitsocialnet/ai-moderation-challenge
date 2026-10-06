#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import PKC from "@pkcprotocol/pkc-js";

const DEFAULT_AUDIT_LOG_PATH = "~/.bitsocial-ai-moderation-audit.jsonl";
const DEFAULT_STATE_PATH = "~/.bitsocial-ai-moderation-mod-log-state.json";
const DEFAULT_SIGNER_PATH = "~/.bitsocial-ai-moderation-mod-log-signer.json";
const DEFAULT_CHALLENGE_ANSWER_PATH = "~/.bitsocial-ai-moderation-mod-log-password";
const DEFAULT_PKC_RPC_URL = "ws://localhost:9138/";
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_POST_CONTENT_CHARS = 12000;
// Same archive retention as 5chan-board-manager's default.
const DEFAULT_ARCHIVE_PURGE_SECONDS = 172800;

const usage = () => `Usage: node scripts/publish-audit-log-to-community.mjs --community <address-or-name> [options]

Options:
  --audit-log <path>       JSONL audit log to read (default: ${DEFAULT_AUDIT_LOG_PATH})
  --state <path>           State file with last processed byte offset (default: ${DEFAULT_STATE_PATH})
  --signer <path>          Persistent author signer file (default: ${DEFAULT_SIGNER_PATH})
  --challenge-answer <text> Password answer for a protected mod-log community
  --challenge-answer-file <path>
                            File containing the password answer (default: ${DEFAULT_CHALLENGE_ANSWER_PATH})
  --pkc-rpc-url <url>      Bitsocial daemon RPC URL (default: ${DEFAULT_PKC_RPC_URL})
  --interval-ms <number>   Poll interval in --follow mode (default: ${DEFAULT_INTERVAL_MS})
  --timeout-ms <number>    Per-publication timeout (default: ${DEFAULT_TIMEOUT_MS})
  --from-start             Process the audit file from byte 0 when no state file exists
  --keep-posts <number>    Archive the posts this publisher made beyond the newest <number> (default: keep all).
                            The signer must be a moderator of the mod-log community.
  --archive-purge-seconds <number>
                            Purge archived posts this long after archiving them (default: ${DEFAULT_ARCHIVE_PURGE_SECONDS})
  --follow                 Keep polling for new entries
  --dry-run                Print formatted posts without publishing
  --help                   Show this help text
`;

export const parseArgs = (argv) => {
    const args = {
        auditLog: DEFAULT_AUDIT_LOG_PATH,
        state: DEFAULT_STATE_PATH,
        signer: DEFAULT_SIGNER_PATH,
        challengeAnswerFile: DEFAULT_CHALLENGE_ANSWER_PATH,
        pkcRpcUrl: DEFAULT_PKC_RPC_URL,
        intervalMs: DEFAULT_INTERVAL_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        archivePurgeSeconds: DEFAULT_ARCHIVE_PURGE_SECONDS,
        fromStart: false,
        follow: false,
        dryRun: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const readValue = () => {
            const value = argv[i + 1];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return value;
        };

        if (arg === "--help") {
            console.log(usage());
            process.exit(0);
        } else if (arg === "--community") {
            args.community = readValue();
        } else if (arg === "--audit-log") {
            args.auditLog = readValue();
        } else if (arg === "--state") {
            args.state = readValue();
        } else if (arg === "--signer") {
            args.signer = readValue();
        } else if (arg === "--challenge-answer") {
            args.challengeAnswer = readValue();
        } else if (arg === "--challenge-answer-file") {
            args.challengeAnswerFile = readValue();
        } else if (arg === "--pkc-rpc-url") {
            args.pkcRpcUrl = readValue();
        } else if (arg === "--interval-ms") {
            args.intervalMs = Number(readValue());
        } else if (arg === "--timeout-ms") {
            args.timeoutMs = Number(readValue());
        } else if (arg === "--keep-posts") {
            args.keepPosts = Number(readValue());
        } else if (arg === "--archive-purge-seconds") {
            args.archivePurgeSeconds = Number(readValue());
        } else if (arg === "--from-start") {
            args.fromStart = true;
        } else if (arg === "--follow") {
            args.follow = true;
        } else if (arg === "--dry-run") {
            args.dryRun = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.community) throw new Error("--community is required");
    if (!Number.isFinite(args.intervalMs) || args.intervalMs <= 0) throw new Error("--interval-ms must be positive");
    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
    if (args.keepPosts !== undefined && (!Number.isInteger(args.keepPosts) || args.keepPosts < 0)) {
        throw new Error("--keep-posts must be a non-negative integer");
    }
    if (!Number.isFinite(args.archivePurgeSeconds) || args.archivePurgeSeconds < 0) {
        throw new Error("--archive-purge-seconds must be zero or positive");
    }
    return args;
};

const expandHome = (path) => {
    if (path === "~") return process.env.HOME || path;
    if (path.startsWith("~/")) return `${process.env.HOME || ""}/${path.slice(2)}`;
    return path;
};

const fileExists = async (path) => {
    try {
        await access(path, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
};

const readJsonFile = async (path, fallback) => {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch {
        return fallback;
    }
};

const readOptionalTextFile = async (path) => {
    try {
        const value = (await readFile(path, "utf8")).trim();
        return value || undefined;
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
};

const writeJsonFile = async (path, value, mode) => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
    if (mode) await chmod(tempPath, mode);
    await rename(tempPath, path);
};

const loadOrCreateSigner = async (pkc, signerPath) => {
    const existing = await readJsonFile(signerPath, undefined);
    if (existing && typeof existing.privateKey === "string" && existing.type === "ed25519") {
        return pkc.createSigner({ privateKey: existing.privateKey, type: "ed25519" });
    }

    const signer = await pkc.createSigner();
    await writeJsonFile(
        signerPath,
        {
            type: "ed25519",
            privateKey: signer.privateKey
        },
        0o600
    );
    return signer;
};

const short = (value, length = 12) => (typeof value === "string" && value.length > length ? value.slice(0, length) : value);

const valueLine = (label, value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (Array.isArray(value) && value.length === 0) return undefined;
    return `${label}: ${Array.isArray(value) ? value.join(", ") : value}`;
};

const codeBlock = (label, value) => {
    if (typeof value !== "string" || value.length === 0) return undefined;
    return [label + ":", "```", value, "```"].join("\n");
};

const truncate = (value, maxLength) => {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 80)}\n\n[truncated ${value.length - (maxLength - 80)} chars]`;
};

const normalizeEntry = (entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Audit entry is not an object");
    const publication = entry.publication && typeof entry.publication === "object" ? entry.publication : {};
    const community = entry.community && typeof entry.community === "object" ? entry.community : {};
    const provider = entry.provider && typeof entry.provider === "object" ? entry.provider : {};
    const verdict = entry.verdict && typeof entry.verdict === "object" ? entry.verdict : undefined;
    return { ...entry, publication, community, provider, verdict };
};

const formatPost = (rawEntry) => {
    const entry = normalizeEntry(rawEntry);
    const publication = entry.publication;
    const verdict = entry.verdict;
    const action = typeof entry.action === "string" ? entry.action : verdict?.verdict === "allow" ? "approved" : "queued_for_review";
    const communityLabel = [entry.community.title, entry.community.address].filter(Boolean).join(" / ") || "unknown community";
    const kind = publication.kind || "publication";
    const loggedAt = entry.loggedAt || new Date().toISOString();
    const title = `[${action}] ${entry.community.address || "community"} ${kind} ${short(entry.cacheKey, 8)}`;
    const publishedAt = typeof publication.timestamp === "number" ? new Date(publication.timestamp * 1000).toISOString() : undefined;

    const sections = [
        `AI moderation action: ${action}`,
        valueLine("Verdict", verdict?.verdict),
        valueLine("Reason", verdict?.reason || entry.error),
        valueLine("Matched rule indexes", verdict?.matchedRuleIndexes),
        "",
        valueLine("Source community", communityLabel),
        valueLine("Publication kind", kind),
        valueLine("Original timestamp", publishedAt),
        valueLine("Author address", publication.authorAddress),
        valueLine("Author public key", publication.authorPublicKey),
        valueLine("Signature public key", publication.signaturePublicKey),
        valueLine("Signature hash", publication.signatureHash),
        valueLine("Challenge request hash", publication.challengeRequestIdHash),
        valueLine("Parent CID", publication.parentCid),
        valueLine("Post CID", publication.postCid),
        valueLine("Comment CID", publication.commentCid),
        valueLine("Link", publication.linkUrl),
        valueLine("Link domain", publication.linkDomain),
        valueLine("Link tag", publication.linkHtmlTagName),
        valueLine("Flags", JSON.stringify(publication.flags || {})),
        valueLine("Flairs", publication.flairs),
        codeBlock("Title", publication.title),
        codeBlock("Content", publication.content),
        "",
        valueLine("Provider", [entry.provider.apiHost, entry.provider.apiFormat, entry.provider.model].filter(Boolean).join(" / ")),
        valueLine("Audit source", entry.source),
        valueLine("Logged at", loggedAt),
        valueLine("Cache key", entry.cacheKey),
        valueLine("Prompt hash", entry.promptHash),
        valueLine("Rules hash", entry.community.rulesHash)
    ].filter((line) => line !== undefined);

    return {
        title: truncate(title, 180),
        content: truncate(sections.join("\n"), MAX_POST_CONTENT_CHARS)
    };
};

class PublicationRejectedError extends Error {}

const publishWithChallengeAnswer = (publication, { challengeAnswer, timeoutMs, label }) =>
    new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out publishing ${label}`)), timeoutMs);
        timeout.unref?.();

        publication.on("challenge", () => {
            if (!challengeAnswer) {
                clearTimeout(timeout);
                reject(new Error("Mod log community requested a challenge answer, but no challenge answer was configured"));
                return;
            }

            publication.publishChallengeAnswers({ challengeAnswers: [challengeAnswer] }).catch(reject);
        });
        publication.on("challengeverification", (verification) => {
            clearTimeout(timeout);
            if (verification?.challengeSuccess === false) {
                reject(new PublicationRejectedError(`Mod log community rejected ${label}: ${verification.reason || "unknown reason"}`));
                return;
            }
            resolve(verification);
        });
        publication.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        publication.publish().catch((error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

const challengeRequestOptions = (challengeAnswer) => (challengeAnswer ? { challengeRequest: { challengeAnswers: [challengeAnswer] } } : {});

const publishPost = async ({ pkc, signer, community, entry, timeoutMs, challengeAnswer }) => {
    const post = formatPost(entry);
    const comment = await pkc.createComment({
        communityAddress: community,
        author: { displayName: "AI moderation log" },
        signer,
        title: post.title,
        content: post.content,
        timestamp: Math.round(Date.now() / 1000),
        ...challengeRequestOptions(challengeAnswer)
    });
    const verification = await publishWithChallengeAnswer(comment, {
        challengeAnswer,
        timeoutMs,
        label: `audit entry ${entry.cacheKey || ""}`
    });
    return { ...post, cid: verification?.commentUpdate?.cid ?? comment.cid };
};

const moderate = async ({ pkc, signer, community, cid, commentModeration, timeoutMs, challengeAnswer }) => {
    const moderation = await pkc.createCommentModeration({
        communityAddress: community,
        signer,
        commentCid: cid,
        commentModeration,
        ...challengeRequestOptions(challengeAnswer)
    });
    await publishWithChallengeAnswer(moderation, { challengeAnswer, timeoutMs, label: `moderation of ${cid}` });
};

// Keeps the mod log bounded the way 5chan-board-manager bounds a board: posts beyond the newest --keep-posts are
// archived, and archived posts are purged after --archive-purge-seconds. Only posts this publisher recorded in its
// state are touched. Any failure other than a rejection stops the pass and leaves the entry for the next one.
export const pruneModLog = async ({ args, pkc, signer, state, challengeAnswer, now = Math.round(Date.now() / 1000), save }) => {
    if (args.keepPosts === undefined || args.dryRun) return;
    state.posts ??= [];
    state.archived ??= [];
    const options = { pkc, signer, community: args.community, timeoutMs: args.timeoutMs, challengeAnswer };

    // Resolves false when the community rejects the moderation; it cannot succeed later, so the entry is dropped.
    const run = async (cid, commentModeration) => {
        try {
            await moderate({ ...options, cid, commentModeration });
            return true;
        } catch (error) {
            if (!(error instanceof PublicationRejectedError)) throw error;
            console.error(error.message);
            return false;
        }
    };

    while (state.posts.length > args.keepPosts) {
        const [oldest] = state.posts;
        const archived = await run(oldest.cid, {
            archived: true,
            reason: `AI moderation log: archived, older than the newest ${args.keepPosts} entries`
        });
        state.posts.shift();
        if (archived) state.archived.push({ cid: oldest.cid, archivedAt: now });
        await save();
    }

    while (state.archived.length > 0 && now - state.archived[0].archivedAt >= args.archivePurgeSeconds) {
        const [expired] = state.archived;
        await run(expired.cid, { purged: true, reason: "AI moderation log: purged, archive retention expired" });
        state.archived.shift();
        await save();
    }
};

const readNewLines = async ({ auditLogPath, state, fromStart }) => {
    if (!(await fileExists(auditLogPath))) return { lines: [], nextOffset: state.offset || 0 };

    const fileStat = await stat(auditLogPath);
    let offset = typeof state.offset === "number" ? state.offset : undefined;
    if (offset === undefined) offset = fromStart ? 0 : fileStat.size;
    if (fileStat.size < offset) offset = 0;
    if (fileStat.size === offset) return { lines: [], nextOffset: offset };

    const handle = await open(auditLogPath, "r");
    try {
        const length = fileStat.size - offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline === -1) return { lines: [], nextOffset: offset };
        const complete = buffer.subarray(0, lastNewline + 1);
        const records = [];
        let start = 0;
        for (let i = 0; i < complete.length; i += 1) {
            if (complete[i] !== 0x0a) continue;
            const line = complete.subarray(start, i).toString("utf8");
            if (line) records.push({ line, offsetAfter: offset + i + 1 });
            start = i + 1;
        }

        return {
            lines: records,
            nextOffset: offset + complete.length
        };
    } finally {
        await handle.close();
    }
};

const processOnce = async ({ args, pkc, signer, state, challengeAnswer }) => {
    const { lines, nextOffset } = await readNewLines({
        auditLogPath: args.auditLog,
        state,
        fromStart: args.fromStart
    });

    let publishedCount = 0;
    for (const { line, offsetAfter } of lines) {
        const entry = JSON.parse(line);
        if (args.dryRun) {
            const post = formatPost(entry);
            console.log(`--- ${post.title} ---\n${post.content}\n`);
        } else {
            const { cid } = await publishPost({
                pkc,
                signer,
                community: args.community,
                entry,
                timeoutMs: args.timeoutMs,
                challengeAnswer
            });
            if (args.keepPosts !== undefined && cid) {
                state.posts ??= [];
                state.posts.push({ cid, publishedAt: Math.round(Date.now() / 1000) });
            }
            state.offset = offsetAfter;
            state.updatedAt = new Date().toISOString();
            state.auditLog = args.auditLog;
            state.community = args.community;
            await writeJsonFile(args.state, state, 0o600);
        }
        publishedCount += 1;
    }

    if (!args.dryRun && lines.length === 0 && state.offset === undefined) {
        state.offset = nextOffset;
        await writeJsonFile(args.state, state, 0o600);
    }

    return publishedCount;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    args.auditLog = expandHome(args.auditLog);
    args.state = expandHome(args.state);
    args.signer = expandHome(args.signer);
    args.challengeAnswerFile = expandHome(args.challengeAnswerFile);

    let state = await readJsonFile(args.state, {});
    if (state.community && state.community !== args.community && (state.posts?.length || state.archived?.length)) {
        // Tracked posts belong to the previous mod-log community; never moderate them in the new one.
        console.log(`Mod log community changed from ${state.community}; no longer tracking its posts for archiving`);
        state.posts = [];
        state.archived = [];
    }
    const challengeAnswer = args.challengeAnswer || (await readOptionalTextFile(args.challengeAnswerFile));
    const pkc = args.dryRun ? undefined : await PKC({ pkcRpcClientsOptions: [args.pkcRpcUrl], resolveAuthorNames: false });
    const signer = pkc ? await loadOrCreateSigner(pkc, args.signer) : undefined;

    try {
        do {
            const publishedCount = await processOnce({ args, pkc, signer, state, challengeAnswer });
            if (publishedCount > 0) {
                const verb = args.dryRun ? "Formatted" : "Published";
                console.log(`${verb} ${publishedCount} moderation audit entries to ${args.community}`);
            }
            await pruneModLog({ args, pkc, signer, state, challengeAnswer, save: () => writeJsonFile(args.state, state, 0o600) });
            state = await readJsonFile(args.state, state);
            if (args.follow) await sleep(args.intervalMs);
        } while (args.follow);
    } finally {
        await pkc?.destroy();
    }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
