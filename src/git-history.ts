// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { computeStructuralDelta, summarizeCounts } from './calm-diff.js';
import type { GitCommandRunner, GitCommitSnapshot, StructuralCommitDelta } from './types.js';

const ADR_PATH_PATTERN =
    /(?:^|\/)(?:adrs?|decisions?)\/[^/]+\.(?:md|mdx|adoc)$|(?:^|\/)adr[-_0-9][^/]*\.(?:md|mdx|adoc)$/i;

export const defaultGitRunner: GitCommandRunner = (args: string[], cwd: string): string => {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
};

export interface ExtractGitHistoryOptions {
    maxCommits?: number;
    firstParent?: boolean;
    gitRunner?: GitCommandRunner;
    onDebug?: (message: string) => void;
}

function findNearestExistingDirectory(startDir: string): string | null {
    let cursor = startDir;
    while (!existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            return null;
        }
        cursor = parent;
    }
    return cursor;
}

export function extractGitHistory(
    targetFilePath: string,
    options: ExtractGitHistoryOptions = {},
): { commits: GitCommitSnapshot[]; totalCommitsScanned: number; repoRoot: string; relPath: string } {
    const runGit = options.gitRunner ?? defaultGitRunner;
    const rawAbsTarget = path.resolve(targetFilePath);
    const targetExistsOnDisk = existsSync(rawAbsTarget);
    const absTarget = targetExistsOnDisk ? realpathSync(rawAbsTarget) : rawAbsTarget;
    const desiredDir = targetExistsOnDisk ? path.dirname(absTarget) : path.dirname(rawAbsTarget);
    const probeDir = options.gitRunner ? desiredDir : findNearestExistingDirectory(desiredDir);

    if (!probeDir) {
        throw new Error(`Path does not exist: "${targetFilePath}"`);
    }

    const canonicalTarget = targetExistsOnDisk
        ? absTarget
        : existsSync(probeDir)
          ? path.join(realpathSync(probeDir), path.relative(probeDir, rawAbsTarget))
          : rawAbsTarget;

    let rawRepoRoot: string;
    try {
        rawRepoRoot = runGit(['rev-parse', '--show-toplevel'], probeDir).trim();
    } catch {
        if (!targetExistsOnDisk) {
            throw new Error(`Path does not exist: "${targetFilePath}"`);
        }
        throw new Error(`Not inside a Git repository: "${targetFilePath}"`);
    }

    const repoRoot = existsSync(rawRepoRoot) ? realpathSync(rawRepoRoot) : rawRepoRoot;
    const relTarget = path.relative(repoRoot, canonicalTarget).split(path.sep).join('/');

    const logArgs = ['log'];
    if (options.firstParent) {
        logArgs.push('--first-parent');
    }
    logArgs.push('--follow', '-M30%');
    if (options.maxCommits !== undefined) {
        logArgs.push('-n', String(options.maxCommits));
    }
    logArgs.push(
        '--format=%x1e%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%b%x1f%cI%x1d',
        '--name-only',
        '--',
        relTarget,
    );
    const rawLog = runGit(logArgs, repoRoot);
    const records = rawLog.split('\x1e').filter((chunk) => chunk.trim().length > 0);
    const totalCommitsScanned = records.length;

    if (totalCommitsScanned === 0) {
        if (!targetExistsOnDisk) {
            throw new Error(`Path does not exist (and has no Git history): "${targetFilePath}"`);
        }
        throw new Error(`No Git commit history found for '${relTarget}'.`);
    }

    interface ParsedRecord {
        sha: string;
        shortSha: string;
        date: string;
        timestampIso?: string;
        author: string;
        subject: string;
        body: string;
        historicalPath: string;
    }

    const parsedNewestFirst: ParsedRecord[] = [];
    for (const record of records) {
        const [headerPart, filesPart = ''] = record.split('\x1d');
        const fields = headerPart.split('\x1f');
        if (fields.length < 5) continue;
        const [sha, shortSha, date, author, subject, body = '', timestampIso = ''] = fields;
        const fileLines = filesPart
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        const historicalPath = fileLines[0] ?? relTarget;
        parsedNewestFirst.push({
            sha: sha.trim(),
            shortSha: shortSha.trim(),
            date: date.trim(),
            timestampIso: timestampIso.trim() || undefined,
            author: author.trim(),
            subject: subject.trim(),
            body: body.trim(),
            historicalPath,
        });
    }

    const adrMap = new Map<string, string[]>();
    if (parsedNewestFirst.length > 0) {
        try {
            const batchSize = 200;
            for (let start = 0; start < parsedNewestFirst.length; start += batchSize) {
                const batchShas = parsedNewestFirst.slice(start, start + batchSize).map((r) => r.sha);
                const showOut = runGit(
                    ['show', '--format=%x1e%H', '--name-only', ...batchShas],
                    repoRoot,
                );
                for (const block of showOut.split('\x1e')) {
                    const lines = block
                        .split(/\r?\n/)
                        .map((l) => l.trim())
                        .filter(Boolean);
                    if (lines.length === 0) continue;
                    const commitSha = lines[0];
                    const changedFiles = lines.slice(1);
                    if (changedFiles.length <= 20) {
                        const adrs = changedFiles.filter((filePath) => ADR_PATH_PATTERN.test(filePath));
                        if (adrs.length > 0) {
                            adrMap.set(commitSha, adrs);
                        }
                    }
                }
            }
        } catch {
            options.onDebug?.('Skipping co-changed ADR scan due to git show error.');
        }
    }

    const chronological = [...parsedNewestFirst].reverse();
    const snapshots: GitCommitSnapshot[] = [];

    for (const entry of chronological) {
        let rawBlob: string;
        try {
            rawBlob = runGit(['show', `${entry.sha}:${entry.historicalPath}`], repoRoot);
        } catch {
            options.onDebug?.(`Skipping commit ${entry.shortSha}: '${entry.historicalPath}' not readable at commit.`);
            continue;
        }

        try {
            const parsed = JSON.parse(rawBlob) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                continue;
            }
            snapshots.push({
                sha: entry.sha,
                shortSha: entry.shortSha,
                date: entry.date,
                ...(entry.timestampIso ? { timestampIso: entry.timestampIso } : {}),
                author: entry.author,
                subject: entry.subject,
                body: entry.body,
                historicalPath: entry.historicalPath,
                coChangedAdrs: adrMap.get(entry.sha) ?? [],
                document: parsed as Record<string, unknown>,
            });
        } catch {
            options.onDebug?.(`Skipping commit ${entry.shortSha}: file was not valid JSON.`);
        }
    }

    return { commits: snapshots, totalCommitsScanned, repoRoot, relPath: relTarget };
}

export function filterStructuralCommits(
    commits: GitCommitSnapshot[],
    options: { includeMetadataChanges?: boolean } = {},
): { deltas: StructuralCommitDelta[]; noiseCommitsFiltered: number } {
    const deltas: StructuralCommitDelta[] = [];
    let lastKeptDoc: Record<string, unknown> | null = null;
    let noiseCommitsFiltered = 0;

    for (const commit of commits) {
        const isInitial = lastKeptDoc === null;
        const { changeItems, counts, hasStructuralChange, hasMetadataChange } = computeStructuralDelta(
            lastKeptDoc,
            commit.document,
        );

        const keep =
            isInitial ||
            hasStructuralChange ||
            commit.coChangedAdrs.length > 0 ||
            (!!options.includeMetadataChanges && hasMetadataChange);

        if (!keep) {
            noiseCommitsFiltered++;
            continue;
        }

        const filteredItems = options.includeMetadataChanges
            ? changeItems
            : changeItems.filter((item) => item.category !== 'metadata');

        deltas.push({
            commit,
            isInitial,
            changeItems: filteredItems,
            counts,
            summaryLine: summarizeCounts(counts, isInitial),
        });
        lastKeptDoc = commit.document;
    }

    return { deltas, noiseCommitsFiltered };
}
