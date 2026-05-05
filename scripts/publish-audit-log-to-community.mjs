#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import PKC from "@pkcprotocol/pkc-js";

const DEFAULT_AUDIT_LOG_PATH = "~/.bitsocial-ai-moderation-audit.jsonl";
const DEFAULT_STATE_PATH = "~/.bitsocial-ai-moderation-mod-log-state.json";
const DEFAULT_SIGNER_PATH = "~/.bitsocial-ai-moderation-mod-log-signer.json";
const DEFAULT_CHALLENGE_ANSWER_PATH = "~/.bitsocial-ai-moderation-mod-log-password";
const DEFAULT_PKC_RPC_URL = "ws://localhost:9138/";
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_POST_CONTENT_CHARS = 12000;

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
  --follow                 Keep polling for new entries
  --dry-run                Print formatted posts without publishing
  --help                   Show this help text
`;

const parseArgs = (argv) => {
    const args = {
        auditLog: DEFAULT_AUDIT_LOG_PATH,
        state: DEFAULT_STATE_PATH,
        signer: DEFAULT_SIGNER_PATH,
        challengeAnswerFile: DEFAULT_CHALLENGE_ANSWER_PATH,
        pkcRpcUrl: DEFAULT_PKC_RPC_URL,
        intervalMs: DEFAULT_INTERVAL_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
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

const publishPost = async ({ pkc, signer, community, entry, timeoutMs, challengeAnswer }) => {
    const post = formatPost(entry);
    const createOptions = {
        communityAddress: community,
        author: { displayName: "AI moderation log" },
        signer,
        title: post.title,
        content: post.content,
        timestamp: Math.round(Date.now() / 1000)
    };

    if (challengeAnswer) {
        createOptions.challengeRequest = {
            challengeAnswers: [challengeAnswer]
        };
    }

    const comment = await pkc.createComment(createOptions);

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out publishing audit entry ${entry.cacheKey || ""}`)), timeoutMs);
        timeout.unref?.();

        comment.on("challenge", () => {
            if (!challengeAnswer) {
                clearTimeout(timeout);
                reject(new Error("Mod log community requested a challenge answer, but no challenge answer was configured"));
                return;
            }

            comment.publishChallengeAnswers([challengeAnswer]).catch(reject);
        });
        comment.on("challengeverification", (verification) => {
            clearTimeout(timeout);
            if (verification?.challengeSuccess === false) {
                reject(new Error(`Mod log community rejected audit entry: ${verification.reason || "unknown reason"}`));
                return;
            }
            resolve();
        });
        comment.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        comment.publish().catch((error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

    return post;
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
            await publishPost({
                pkc,
                signer,
                community: args.community,
                entry,
                timeoutMs: args.timeoutMs,
                challengeAnswer
            });
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
            state = await readJsonFile(args.state, state);
            if (args.follow) await sleep(args.intervalMs);
        } while (args.follow);
    } finally {
        await pkc?.destroy();
    }
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
