// SPDX-License-Identifier: Apache-2.0

import { computeStructuralDelta } from './calm-diff.js';
import { computeSnapshotSha256, serializeCalmSnapshot } from './timeline-emitter.js';
import type {
    ClusteringEngine,
    ClusterSpec,
    CommitHistoryDigest,
    DeltaChangeItem,
    MomentCluster,
    StructuralCommitDelta,
} from './types.js';

const FOLLOW_UP_KEYWORD_PATTERN =
    /\b(wip|fixup|wire|wired|wiring|connect|connected|connecting|refine|refined|refining|polish|polished|polishing|harden|hardened|hardening|attach|attached|attaching|link|linked|linking)\b/i;

const MAX_CLUSTER_COMMITS = 5;

function stripCommitPrefixes(text: string): string {
    return text
        .replace(/^(feat|fix|docs|chore|refactor|perf|test|build|ci|style)(\([^)]*\))?!?:\s*/i, '')
        .replace(/^\d{1,3}(?:[.):_-]+\s*|\s+(?:[-–—.]\s*)?)/, '');
}

function toKebabSlug(text: string): string {
    const cleaned = stripCommitPrefixes(text.toLowerCase())
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned.slice(0, 48).replace(/-+$/g, '') || 'moment';
}

function cleanCommitSubject(subject: string): string {
    const stripped = stripCommitPrefixes(subject)
        .replace(/\s*\(#\d+\)\s*$/g, '')
        .trim();
    if (!stripped) return subject.trim() || 'Architecture Update';
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function isMajorMilestoneDelta(delta: StructuralCommitDelta): boolean {
    if (delta.isInitial) return true;
    const c = delta.counts;
    return (
        c.nodesAdded > 0 ||
        c.nodesRemoved > 0 ||
        c.controlsAdded > 0 ||
        c.controlsRemoved > 0 ||
        c.flowsAdded > 0 ||
        c.flowsRemoved > 0 ||
        delta.commit.coChangedAdrs.length > 0
    );
}

function daysBetweenDates(dateA: string, dateB: string): number | null {
    const msA = Date.parse(dateA);
    const msB = Date.parse(dateB);
    if (Number.isNaN(msA) || Number.isNaN(msB)) {
        return dateA === dateB ? 0 : null;
    }
    return Math.abs(msB - msA) / 86_400_000;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTouchedNodeIds(delta: StructuralCommitDelta): Set<string> {
    const ids = new Set<string>();
    for (const item of delta.changeItems) {
        if (item.category === 'node' && item.id) {
            ids.add(item.id);
        } else if (item.category === 'control' && item.id.includes(':')) {
            const ownerId = item.id.split(':')[0]?.trim();
            if (ownerId) ids.add(ownerId);
        }
    }
    return ids;
}

function hasOverlappingNodeTouch(prev: StructuralCommitDelta, curr: StructuralCommitDelta): boolean {
    const prevNodes = extractTouchedNodeIds(prev);
    const currNodes = extractTouchedNodeIds(curr);

    for (const id of currNodes) {
        if (prevNodes.has(id)) return true;
    }

    const matchesChangeItems = (candidateIds: Set<string>, items: DeltaChangeItem[]): boolean => {
        for (const id of candidateIds) {
            const pattern = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escapeRegExp(id)}(?:$|[^a-zA-Z0-9_-])`);
            for (const item of items) {
                if (pattern.test(item.id) || pattern.test(item.text)) {
                    return true;
                }
            }
        }
        return false;
    };

    return matchesChangeItems(prevNodes, curr.changeItems) || matchesChangeItems(currNodes, prev.changeItems);
}

function formatProseList(items: string[], maxItems = 4): string {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    if (items.length <= maxItems) {
        return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
    }
    return `${items.slice(0, maxItems).join(', ')}, and ${items.length - maxItems} more`;
}

function joinClauses(clauses: string[]): string {
    const filtered = clauses.filter((c) => c.length > 0);
    if (filtered.length === 0) return '';
    if (filtered.length === 1) return filtered[0];
    if (filtered.length === 2) return `${filtered[0]} and ${filtered[1]}`;
    return `${filtered.slice(0, -1).join(', ')}, and ${filtered[filtered.length - 1]}`;
}

function stripChangePrefix(text: string, prefix: RegExp, stripBracketSuffix = false): string {
    const base = text.replace(prefix, '').trim();
    return stripBracketSuffix ? base.replace(/\s+\[[^\]]+\]$/, '').trim() : base;
}

function synthesizeNarrativeDescription(
    slice: StructuralCommitDelta[],
    changeItems: DeltaChangeItem[],
    adrs: string[],
    isInitialCluster: boolean,
): string {
    const first = slice[0];
    const last = slice[slice.length - 1];
    const commitRange =
        slice.length > 1
            ? `${slice.length} commits: ${first.commit.shortSha}..${last.commit.shortSha}`
            : `1 commit: ${last.commit.shortSha}`;

    const addedNodes: string[] = [];
    const modifiedNodes: string[] = [];
    const removedNodes: string[] = [];
    const addedRels: string[] = [];
    const modifiedRels: string[] = [];
    const removedRels: string[] = [];
    const touchedControls: string[] = [];
    const touchedFlows: string[] = [];

    for (const item of changeItems) {
        if (item.category === 'node') {
            if (item.kind === 'add') {
                addedNodes.push(stripChangePrefix(item.text, /^Added node\s+/i));
            } else if (item.kind === 'del') {
                removedNodes.push(stripChangePrefix(item.text, /^Removed node\s+/i));
            } else if (item.text.startsWith('Renamed node ')) {
                modifiedNodes.push(stripChangePrefix(item.text, /^Renamed node\s+/i));
            } else {
                modifiedNodes.push(stripChangePrefix(item.text, /^Modified node\s+/i, true));
            }
        } else if (item.category === 'relationship') {
            if (item.kind === 'add') {
                addedRels.push(item.id);
            } else if (item.kind === 'del') {
                removedRels.push(item.id);
            } else {
                modifiedRels.push(item.id);
            }
        } else if (item.category === 'control') {
            touchedControls.push(item.id);
        } else if (item.category === 'flow') {
            touchedFlows.push(stripChangePrefix(item.text, /^(Added|Modified|Removed) flow\s+/i));
        }
    }

    const sentences: string[] = [];

    if (isInitialCluster) {
        const baselineParts: string[] = [];
        if (addedNodes.length > 0) {
            baselineParts.push(`with ${formatProseList(addedNodes)}`);
        }
        if (addedRels.length > 0) {
            baselineParts.push(`connected via ${formatProseList(addedRels)}`);
        }
        const detail = baselineParts.length > 0 ? ` ${baselineParts.join(', ')}` : '';
        sentences.push(`Establishes the initial architecture baseline${detail} (${commitRange}).`);
    } else {
        const nodeClauses: string[] = [];
        if (addedNodes.length > 0) nodeClauses.push(`introduces ${formatProseList(addedNodes)}`);
        if (modifiedNodes.length > 0) nodeClauses.push(`updates ${formatProseList(modifiedNodes)}`);
        if (removedNodes.length > 0) nodeClauses.push(`retires ${formatProseList(removedNodes)}`);

        const relVerbClauses: string[] = [];
        if (addedRels.length > 0) relVerbClauses.push(`wires ${formatProseList(addedRels)}`);
        if (modifiedRels.length > 0) relVerbClauses.push(`refines relationships ${formatProseList(modifiedRels)}`);
        if (removedRels.length > 0) relVerbClauses.push(`removes relationships ${formatProseList(removedRels)}`);

        if (nodeClauses.length > 0) {
            sentences.push(`This phase ${joinClauses(nodeClauses)} (${commitRange}).`);
            if (relVerbClauses.length > 0) {
                const relNounClauses: string[] = [];
                if (addedRels.length > 0) relNounClauses.push(`new links ${formatProseList(addedRels)}`);
                if (modifiedRels.length > 0) relNounClauses.push(`updated links ${formatProseList(modifiedRels)}`);
                if (removedRels.length > 0) relNounClauses.push(`retired links ${formatProseList(removedRels)}`);
                sentences.push(`Connectivity shifts through ${joinClauses(relNounClauses)}.`);
            }
        } else if (relVerbClauses.length > 0) {
            sentences.push(`This phase ${joinClauses(relVerbClauses)} (${commitRange}).`);
        } else if (touchedControls.length > 0 || touchedFlows.length > 0 || adrs.length > 0) {
            sentences.push(`This phase updates architecture governance and runtime definitions (${commitRange}).`);
        } else {
            sentences.push(`Refines architecture metadata and documentation (${commitRange}).`);
        }
    }

    const governanceClauses: string[] = [];
    if (touchedControls.length > 0) {
        governanceClauses.push(`applies controls ${formatProseList(touchedControls)}`);
    }
    if (touchedFlows.length > 0) {
        governanceClauses.push(`covers flows ${formatProseList(touchedFlows)}`);
    }
    if (adrs.length > 0) {
        governanceClauses.push(`records architectural decisions in ${formatProseList(adrs)}`);
    }
    if (governanceClauses.length > 0) {
        const joined = joinClauses(governanceClauses);
        sentences.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
    }

    return sentences.join(' ');
}

function pickDefaultClusterName(slice: StructuralCommitDelta[], startIndex: number): string {
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (startIndex === 0) {
        return `Initial Architecture: ${cleanCommitSubject(first.commit.subject)}`;
    }
    if (slice.length > 1) {
        const primary = slice.find((d) => !FOLLOW_UP_KEYWORD_PATTERN.test(d.commit.subject)) ?? first;
        return cleanCommitSubject(primary.commit.subject);
    }
    return cleanCommitSubject(last.commit.subject);
}

function buildClusterFromRange(
    deltas: StructuralCommitDelta[],
    startIndex: number,
    endIndex: number,
    customMeta?: { uniqueId?: string; name?: string; description?: string },
): MomentCluster {
    const slice = deltas.slice(startIndex, endIndex + 1);
    const last = slice[slice.length - 1];

    const prevDoc = startIndex > 0 ? deltas[startIndex - 1].commit.document : null;
    const net = computeStructuralDelta(prevDoc, last.commit.document);

    const adrSet = new Set<string>();
    for (const d of slice) {
        for (const adr of d.commit.coChangedAdrs) adrSet.add(adr);
    }
    const docAdrs = last.commit.document['adrs'];
    if (Array.isArray(docAdrs)) {
        for (const adr of docAdrs) {
            if (typeof adr === 'string' && adr.trim()) adrSet.add(adr.trim());
        }
    }
    const adrs = [...adrSet];

    const defaultName = pickDefaultClusterName(slice, startIndex);
    const name = customMeta?.name?.trim() || defaultName;
    const description =
        customMeta?.description?.trim() ||
        synthesizeNarrativeDescription(slice, net.changeItems, adrs, startIndex === 0);
    const rawId = customMeta?.uniqueId?.trim() || `${last.commit.date}-${toKebabSlug(name)}`;

    return {
        startIndex,
        endIndex,
        uniqueId: toKebabSlug(rawId),
        name,
        description,
        validFrom: last.commit.date,
        adrs,
        commits: slice,
        mergedChangeItems: net.changeItems.filter((i) => i.category !== 'metadata'),
        snapshotDocument: last.commit.document,
        snapshotSha256: computeSnapshotSha256(serializeCalmSnapshot(last.commit.document)),
        ...(last.commit.nodeProvenance ? { nodeProvenance: last.commit.nodeProvenance } : {}),
    };
}

export function deterministicClusterCommits(deltas: StructuralCommitDelta[]): MomentCluster[] {
    if (deltas.length === 0) return [];

    const ranges: Array<{ start: number; end: number }> = [];
    let currentStart = 0;
    let clusterAdrs = new Set<string>(deltas[0].commit.coChangedAdrs);

    for (let i = 1; i < deltas.length; i++) {
        const prev = deltas[i - 1];
        const curr = deltas[i];
        const clusterLen = i - currentStart;

        let shouldMerge = false;
        if (clusterLen < MAX_CLUSTER_COMMITS) {
            if (deltas[currentStart].isInitial) {
                shouldMerge = curr.commit.date === deltas[0].commit.date && !isMajorMilestoneDelta(curr);
            } else {
                const dayDiff = daysBetweenDates(prev.commit.date, curr.commit.date);
                const followUpKeyword =
                    FOLLOW_UP_KEYWORD_PATTERN.test(curr.commit.subject) && dayDiff !== null && dayDiff <= 7;
                const c = curr.counts;
                const relOrMetaOnly =
                    c.nodesAdded === 0 &&
                    c.nodesRemoved === 0 &&
                    c.controlsAdded === 0 &&
                    c.flowsAdded === 0 &&
                    curr.commit.coChangedAdrs.length === 0 &&
                    dayDiff !== null &&
                    dayDiff <= 14;
                const introducesNewAdr =
                    curr.counts.adrsAdded > 0 ||
                    curr.commit.coChangedAdrs.some((adr) => !clusterAdrs.has(adr));
                const overlappingNodes =
                    dayDiff !== null && dayDiff <= 5 && !introducesNewAdr && hasOverlappingNodeTouch(prev, curr);

                shouldMerge = followUpKeyword || relOrMetaOnly || overlappingNodes;
            }
        }

        if (shouldMerge) {
            for (const adr of curr.commit.coChangedAdrs) {
                clusterAdrs.add(adr);
            }
        } else {
            ranges.push({ start: currentStart, end: i - 1 });
            currentStart = i;
            clusterAdrs = new Set<string>(curr.commit.coChangedAdrs);
        }
    }
    ranges.push({ start: currentStart, end: deltas.length - 1 });

    return ranges.map(({ start, end }) => buildClusterFromRange(deltas, start, end));
}

export function validateClusterSpecs(raw: unknown, totalCount: number): ClusterSpec[] | null {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const arr = Array.isArray(raw)
        ? raw
        : record && Array.isArray(record['clusters'])
          ? (record['clusters'] as unknown[])
          : record && Array.isArray(record['moments'])
            ? (record['moments'] as unknown[])
            : null;

    if (!arr || arr.length === 0) return null;

    const specs: ClusterSpec[] = [];
    let expectedStart = 0;

    for (const item of arr) {
        if (!item || typeof item !== 'object') return null;
        const obj = item as Record<string, unknown>;
        const startIndex = Number(obj['startIndex']);
        const endIndex = Number(obj['endIndex']);
        if (
            !Number.isInteger(startIndex) ||
            !Number.isInteger(endIndex) ||
            startIndex !== expectedStart ||
            endIndex < startIndex ||
            endIndex >= totalCount
        ) {
            return null;
        }
        specs.push({
            startIndex,
            endIndex,
            uniqueId: typeof obj['uniqueId'] === 'string' ? obj['uniqueId'] : undefined,
            name: typeof obj['name'] === 'string' ? obj['name'] : undefined,
            description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
        });
        expectedStart = endIndex + 1;
    }

    if (expectedStart !== totalCount) return null;
    return specs;
}

export function diagnoseClusterSpecsError(raw: unknown, totalCount: number): string {
    const maxIdx = Math.max(0, totalCount - 1);
    const basePrefix = `Invalid cluster definitions (expected a non-empty JSON array covering commit indices 0..${maxIdx} contiguously without gaps or overlaps)`;
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const arr = Array.isArray(raw)
        ? raw
        : record && Array.isArray(record['clusters'])
          ? (record['clusters'] as unknown[])
          : record && Array.isArray(record['moments'])
            ? (record['moments'] as unknown[])
            : null;

    if (!arr || arr.length === 0) {
        return `${basePrefix}: input must be a non-empty array of cluster objects.`;
    }

    let expectedStart = 0;
    for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (!item || typeof item !== 'object') {
            return `${basePrefix}: clusters[${i}] must be an object.`;
        }
        const obj = item as Record<string, unknown>;
        const startIndex = Number(obj['startIndex']);
        const endIndex = Number(obj['endIndex']);
        if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
            return `${basePrefix}: clusters[${i}] must specify integer startIndex and endIndex.`;
        }
        if (startIndex !== expectedStart) {
            const detail =
                startIndex > expectedStart
                    ? `gap skipping commit index ${expectedStart}`
                    : `overlap at commit index ${startIndex}`;
            return `${basePrefix}: clusters[${i}].startIndex is ${startIndex}, expected ${expectedStart} (${detail}).`;
        }
        if (endIndex < startIndex) {
            return `${basePrefix}: clusters[${i}].endIndex (${endIndex}) precedes startIndex (${startIndex}).`;
        }
        if (endIndex >= totalCount) {
            return `${basePrefix}: clusters[${i}].endIndex (${endIndex}) exceeds maximum commit index ${maxIdx}.`;
        }
        expectedStart = endIndex + 1;
    }

    if (expectedStart !== totalCount) {
        const lastEnd = expectedStart - 1;
        return `${basePrefix}: final endIndex is ${lastEnd}, expected ${maxIdx} (commit indices ${expectedStart}..${maxIdx} uncovered).`;
    }

    return `${basePrefix}.`;
}

export function applyClusterSpecs(deltas: StructuralCommitDelta[], rawSpecs: unknown): MomentCluster[] {
    if (deltas.length === 0) return [];

    const validated = validateClusterSpecs(rawSpecs, deltas.length);
    if (!validated) {
        throw new Error(diagnoseClusterSpecsError(rawSpecs, deltas.length));
    }

    return validated.map((spec) =>
        buildClusterFromRange(deltas, spec.startIndex, spec.endIndex, {
            uniqueId: spec.uniqueId,
            name: spec.name,
            description: spec.description,
        }),
    );
}

export function buildCommitHistoryDigest(
    deltas: StructuralCommitDelta[],
    meta: {
        sourceFile: string;
        sources?: import('./types.js').FederatedSourceDescriptor[];
        totalCommitsScanned: number;
        validSnapshotsParsed: number;
        noiseCommitsFiltered: number;
    },
): CommitHistoryDigest {
    const lastIndex = Math.max(0, deltas.length - 1);
    const latestCommitDate = deltas.length > 0 ? deltas[deltas.length - 1].commit.date : '';

    return {
        schemaVersion: '1.0',
        sourceFile: meta.sourceFile,
        ...(meta.sources && meta.sources.length > 0 ? { sources: meta.sources } : {}),
        latestCommitDate,
        stats: {
            totalCommitsScanned: meta.totalCommitsScanned,
            validSnapshotsParsed: meta.validSnapshotsParsed,
            noiseCommitsFiltered: meta.noiseCommitsFiltered,
            structuralCommitsRetained: deltas.length,
        },
        instructions: [
            `Group the ${deltas.length} structural commits below (indices 0..${lastIndex}) into cohesive architectural moments (phases).`,
            `Every commit index from 0 to ${lastIndex} MUST be covered contiguously with zero gaps or overlaps: first startIndex=0, each next startIndex = previous endIndex + 1, final endIndex=${lastIndex}.`,
            'Group multi-commit sprints, node-addition + relationship-wiring sequences, protocol hardening, and coupled control/ADR rollouts into unified phases while keeping pivotal milestones distinct.',
            'Write an executive `name` (3-7 words; no leading step numbers and no conventional-commit prefixes such as "feat:" or "chore:").',
            'Write a 2-3 sentence narrative `description` explaining WHAT changed architecturally, HOW connectivity or security boundaries shifted, and WHY, citing concrete node IDs, protocols, controls, or ADRs. Do not output mechanical count strings such as "+1 node(s)".',
            'Save the resulting JSON array to a `<name>.clusters.json` file and pass `--clusters <name>.clusters.json` back to `calm-timelapse`.',
        ],
        expectedClusterSchema: {
            type: 'array',
            items: {
                type: 'object',
                required: ['startIndex', 'endIndex', 'uniqueId', 'name', 'description'],
                properties: {
                    startIndex: { type: 'integer', minimum: 0, maximum: lastIndex },
                    endIndex: { type: 'integer', minimum: 0, maximum: lastIndex },
                    uniqueId: { type: 'string', description: 'kebab-case moment identifier' },
                    name: { type: 'string', description: 'Executive phase title (3-7 words)' },
                    description: { type: 'string', description: '2-3 sentence architectural narrative' },
                },
            },
        },
        commits: deltas.map((d, idx) => ({
            index: idx,
            sha: d.commit.sha,
            shortSha: d.commit.shortSha,
            date: d.commit.date,
            author: d.commit.author,
            subject: d.commit.subject,
            summaryLine: d.summaryLine,
            snapshotSha256: computeSnapshotSha256(serializeCalmSnapshot(d.commit.document)),
            changes: d.changeItems.map((c) => c.text),
            coChangedAdrs: [...d.commit.coChangedAdrs],
            ...(d.commit.sourceId ? { sourceId: d.commit.sourceId } : {}),
            ...(d.commit.sourceLabel ? { sourceLabel: d.commit.sourceLabel } : {}),
            ...(d.commit.repoName ? { repoName: d.commit.repoName } : {}),
        })),
    };
}

export function clusterCommitsIntoMoments(
    deltas: StructuralCommitDelta[],
    options: {
        clusterSpecs?: unknown;
    } = {},
): { clusters: MomentCluster[]; engine: ClusteringEngine } {
    if (options.clusterSpecs !== undefined) {
        return {
            clusters: applyClusterSpecs(deltas, options.clusterSpecs),
            engine: 'clusters-file',
        };
    }
    return {
        clusters: deterministicClusterCommits(deltas),
        engine: 'deterministic',
    };
}
