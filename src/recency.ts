export type ArticleRecency = {
    minimumAgeSeconds?: number;
    maximumAgeSeconds?: number;
    maxAgeSeconds?: number;
    status: "outside-window" | "within-window" | "uncertain" | "unconfigured";
};

// URL dates remain hints, not fetched/verified article timestamps. Day precision uses the
// full UTC day already represented by the parser; a straddling or future day cannot prove age.
export const getArticleRecency = ({
    kind,
    htmlTagName,
    hasLink,
    submittedAtSeconds,
    dateHint,
    maxAgeHours
}: {
    kind: string;
    htmlTagName?: string;
    hasLink: boolean;
    submittedAtSeconds?: number;
    dateHint?: { earliestPossibleAt: string; latestPossibleAt: string };
    maxAgeHours?: number;
}): ArticleRecency | undefined => {
    const applies = kind === "post" && hasLink && !["img", "video", "audio"].includes(htmlTagName?.toLowerCase() ?? "");
    const maxAgeSeconds = applies && maxAgeHours !== undefined ? maxAgeHours * 3600 : undefined;
    const earliest = dateHint ? Date.parse(dateHint.earliestPossibleAt) : NaN;
    const latest = dateHint ? Date.parse(dateHint.latestPossibleAt) : NaN;
    if (submittedAtSeconds === undefined || !Number.isFinite(earliest) || !Number.isFinite(latest) || latest < earliest) {
        return maxAgeSeconds === undefined ? undefined : { maxAgeSeconds, status: "uncertain" };
    }
    const minimumAgeSeconds = (submittedAtSeconds * 1000 - latest) / 1000;
    const maximumAgeSeconds = (submittedAtSeconds * 1000 - earliest) / 1000;
    return {
        minimumAgeSeconds,
        maximumAgeSeconds,
        ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
        status:
            maxAgeSeconds === undefined
                ? "unconfigured"
                : minimumAgeSeconds > maxAgeSeconds
                  ? "outside-window"
                  : minimumAgeSeconds >= 0 && maximumAgeSeconds <= maxAgeSeconds
                    ? "within-window"
                    : "uncertain"
    };
};
