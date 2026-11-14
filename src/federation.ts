// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { computeStructuralDelta, summarizeCounts } from './calm-diff.js';
import { extractGitHistory, filterStructuralCommits } from './git-history.js';
import type {
    FederatedNodeProvenance,
    FederatedSourceDescriptor,
    GeneratedGitTimeline,
    GitCommandRunner,
    GitCommitSnapshot,
    StructuralCommitDelta,
} from './types.js';

export const CALM_RELEASE_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm.json';

export interface ParsedSourceSpec {
    explicitLabel?: string;
    filePath: string;
}

export interface ActiveSourceSnapshot {
    sourceId: string;
    sourceLabel: string;
    repoRoot?: string;
    repoName: string;
    relPath: string;
    fileName: string;
    document: Record<string, unknown>;
}

export interface ResolvedDetailLink {
    parentSourceId: string;
    parentNodeRawId: string;
    childSourceId: string;
    rawRef: string;
}

export interface ComposedFederationResult {
    document: Record<string, unknown>;
    nodeProvenance: Record<string, FederatedNodeProvenance>;
    resolvedLinks: ResolvedDetailLink[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toSlug(value: string): string {
    const cleaned = value
        .toLowerCase()
        .replace(/\.(?:architecture|arch|calm|timeline)?\.json$/i, '')
        .replace(/\.json$/i, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return cleaned || 'arch';
}

export function parseSourceTargetSpec(rawSpec: string): ParsedSourceSpec {
    const trimmed = rawSpec.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx >= 2) {
        const prefix = trimmed.slice(0, eqIdx).trim();
        const rest = trimmed.slice(eqIdx + 1).trim();
        if (/^[a-zA-Z0-9][a-zA-Z0-9 ._:-]{0,63}$/.test(prefix) && rest.length > 0) {
            return { explicitLabel: prefix, filePath: rest };
        }
    }
    return { filePath: trimmed };
}

function normalizePosixRelative(fromFileRelPath: string, targetRef: string): string {
    const cleanRef = targetRef.replace(/\\/g, '/').trim();
    const baseDir = path.posix.dirname(fromFileRelPath.replace(/\\/g, '/'));
    const joined = baseDir === '.' ? cleanRef : path.posix.join(baseDir, cleanRef);
    return path.posix.normalize(joined).replace(/^\.\//, '');
}

function findMatchingChildSource(
    parent: ActiveSourceSnapshot,
    rawRef: string,
    candidates: ActiveSourceSnapshot[],
): ActiveSourceSnapshot | undefined {
    const ref = rawRef.trim();
    if (!ref || /^https?:\/\//i.test(ref)) return undefined;

    if (parent.repoRoot) {
        const expectedRel = normalizePosixRelative(parent.relPath, ref);
        const sameRepoMatch = candidates.find(
            (c) => c.sourceId !== parent.sourceId && c.repoRoot === parent.repoRoot && c.relPath === expectedRel,
        );
        if (sameRepoMatch) return sameRepoMatch;
    }

    const directIdMatch = candidates.find((c) => c.sourceId !== parent.sourceId && c.sourceId === ref);
    if (directIdMatch) return directIdMatch;

    const refBase = path.posix.basename(ref.replace(/\\/g, '/'));
    const fileMatches = candidates.filter(
        (c) =>
            c.sourceId !== parent.sourceId &&
            (c.fileName === refBase ||
                `${c.sourceId}.json` === refBase ||
                `${c.sourceId}.calm.json` === refBase ||
                `${c.sourceId}.architecture.json` === refBase),
    );
    if (fileMatches.length === 1) {
        return fileMatches[0];
    }
    return undefined;
}

function wouldIntroduceCycle(
    parentId: string,
    childId: string,
    parentByChild: Map<string, ResolvedDetailLink>,
): boolean {
    let cursor: string | undefined = parentId;
    while (cursor) {
        if (cursor === childId) return true;
        cursor = parentByChild.get(cursor)?.parentSourceId;
    }
    return false;
}

export function composeFederatedArchitecture(activeSources: ActiveSourceSnapshot[]): ComposedFederationResult {
    if (activeSources.length === 0) {
        return {
            document: { $schema: CALM_RELEASE_SCHEMA, nodes: [], relationships: [] },
            nodeProvenance: {},
            resolvedLinks: [],
        };
    }

    const sourceById = new Map(activeSources.map((s) => [s.sourceId, s]));
    const parentByChild = new Map<string, ResolvedDetailLink>();

    for (const src of activeSources) {
        const nodes = Array.isArray(src.document.nodes) ? src.document.nodes : [];
        for (const rawNode of nodes) {
            if (!isPlainObject(rawNode)) continue;
            const nodeId = typeof rawNode['unique-id'] === 'string' ? rawNode['unique-id'].trim() : '';
            if (!nodeId) continue;
            const details = isPlainObject(rawNode.details) ? rawNode.details : null;
            const detailRef = typeof details?.['detailed-architecture'] === 'string' ? details['detailed-architecture'] : '';
            if (!detailRef.trim()) continue;

            const child = findMatchingChildSource(src, detailRef, activeSources);
            if (!child) continue;
            if (parentByChild.has(child.sourceId)) continue;
            if (wouldIntroduceCycle(src.sourceId, child.sourceId, parentByChild)) continue;

            parentByChild.set(child.sourceId, {
                parentSourceId: src.sourceId,
                parentNodeRawId: nodeId,
                childSourceId: child.sourceId,
                rawRef: detailRef.trim(),
            });
        }
    }

    const orderedSources: ActiveSourceSnapshot[] = [];
    const visited = new Set<string>();
    const visit = (src: ActiveSourceSnapshot): void => {
        if (visited.has(src.sourceId)) return;
        const link = parentByChild.get(src.sourceId);
        if (link) {
            const parentSrc = sourceById.get(link.parentSourceId);
            if (parentSrc) visit(parentSrc);
        }
        visited.add(src.sourceId);
        orderedSources.push(src);
    };
    for (const src of activeSources) visit(src);

    const nodeIdMap = new Map<string, Map<string, string>>();
    const ifaceIdMap = new Map<string, Map<string, string>>();
    const canonicalNodes = new Map<string, Record<string, unknown>>();
    const canonicalNodeRawIfaces = new Map<string, Map<string, string>>();
    const nodeProvenance: Record<string, FederatedNodeProvenance> = {};
    const synthesizedRelationships: Record<string, unknown>[] = [];

    for (const src of orderedSources) {
        const srcNodeMap = new Map<string, string>();
        const srcIfaceMap = new Map<string, string>();
        nodeIdMap.set(src.sourceId, srcNodeMap);
        ifaceIdMap.set(src.sourceId, srcIfaceMap);

        const link = parentByChild.get(src.sourceId);
        const parentNodeMap = link ? nodeIdMap.get(link.parentSourceId) : undefined;
        const parentAnchorCanonicalId =
            link && parentNodeMap ? parentNodeMap.get(link.parentNodeRawId) : undefined;

        const internalChildNodeIds: string[] = [];
        const rawNodes = Array.isArray(src.document.nodes) ? src.document.nodes : [];

        for (const rawNode of rawNodes) {
            if (!isPlainObject(rawNode)) continue;
            const rawId = typeof rawNode['unique-id'] === 'string' ? rawNode['unique-id'].trim() : '';
            if (!rawId) continue;

            const mergeTargetCanonicalId =
                link && parentNodeMap && parentNodeMap.has(rawId)
                    ? parentNodeMap.get(rawId)
                    : undefined;

            if (mergeTargetCanonicalId && canonicalNodes.has(mergeTargetCanonicalId)) {
                srcNodeMap.set(rawId, mergeTargetCanonicalId);
                const existingNode = canonicalNodes.get(mergeTargetCanonicalId)!;
                const existingRawIfaces = canonicalNodeRawIfaces.get(mergeTargetCanonicalId)!;

                if (Array.isArray(rawNode.interfaces)) {
                    const mergedIfaces = Array.isArray(existingNode.interfaces)
                        ? [...(existingNode.interfaces as unknown[])]
                        : [];
                    for (const rawIface of rawNode.interfaces) {
                        if (!isPlainObject(rawIface)) continue;
                        const rawIfaceId =
                            typeof rawIface['unique-id'] === 'string' ? rawIface['unique-id'].trim() : '';
                        if (!rawIfaceId) continue;
                        const existingMapped = existingRawIfaces.get(rawIfaceId);
                        if (existingMapped) {
                            srcIfaceMap.set(rawIfaceId, existingMapped);
                        } else {
                            const scopedIfaceId = `${src.sourceId}--${rawIfaceId}`;
                            srcIfaceMap.set(rawIfaceId, scopedIfaceId);
                            existingRawIfaces.set(rawIfaceId, scopedIfaceId);
                            mergedIfaces.push({ ...structuredClone(rawIface), 'unique-id': scopedIfaceId });
                        }
                    }
                    if (mergedIfaces.length > 0) {
                        existingNode.interfaces = mergedIfaces;
                    }
                }

                const prov = nodeProvenance[mergeTargetCanonicalId];
                if (prov) {
                    if (!prov.sourceIds.includes(src.sourceId)) prov.sourceIds.push(src.sourceId);
                    if (!prov.sourceLabels.includes(src.sourceLabel)) prov.sourceLabels.push(src.sourceLabel);
                    prov.mergedViaDetailedArch = true;
                }
                continue;
            }

            const canonicalId = `${src.sourceId}--${rawId}`;
            srcNodeMap.set(rawId, canonicalId);
            const clonedNode = structuredClone(rawNode);
            clonedNode['unique-id'] = canonicalId;

            const rawIfaceLookup = new Map<string, string>();
            canonicalNodeRawIfaces.set(canonicalId, rawIfaceLookup);
            if (Array.isArray(clonedNode.interfaces)) {
                clonedNode.interfaces = clonedNode.interfaces.map((iface) => {
                    if (!isPlainObject(iface)) return iface;
                    const rId = typeof iface['unique-id'] === 'string' ? iface['unique-id'].trim() : '';
                    if (!rId) return iface;
                    const scopedIfaceId = `${src.sourceId}--${rId}`;
                    srcIfaceMap.set(rId, scopedIfaceId);
                    rawIfaceLookup.set(rId, scopedIfaceId);
                    return { ...iface, 'unique-id': scopedIfaceId };
                });
            }

            canonicalNodes.set(canonicalId, clonedNode);
            nodeProvenance[canonicalId] = {
                primarySourceId: src.sourceId,
                primarySourceLabel: src.sourceLabel,
                sourceIds: [src.sourceId],
                sourceLabels: [src.sourceLabel],
                ...(parentAnchorCanonicalId ? { resolvedFromParentId: parentAnchorCanonicalId } : {}),
            };

            if (parentAnchorCanonicalId && canonicalId !== parentAnchorCanonicalId) {
                internalChildNodeIds.push(canonicalId);
            }
        }

        if (link && parentAnchorCanonicalId) {
            const parentNode = canonicalNodes.get(parentAnchorCanonicalId);
            if (parentNode && isPlainObject(parentNode.details)) {
                const nextDetails = { ...parentNode.details };
                delete nextDetails['detailed-architecture'];
                if (Object.keys(nextDetails).length === 0) {
                    delete parentNode.details;
                } else {
                    parentNode.details = nextDetails;
                }
            }

            if (internalChildNodeIds.length > 0) {
                const parentName =
                    typeof parentNode?.name === 'string' ? parentNode.name : link.parentNodeRawId;
                synthesizedRelationships.push({
                    'unique-id': `${src.sourceId}--resolved-detailed-architecture`,
                    description: `Detailed architecture of ${parentName} resolved from ${src.fileName}`,
                    'relationship-type': {
                        'composed-of': {
                            container: parentAnchorCanonicalId,
                            nodes: internalChildNodeIds,
                        },
                    },
                });
            }
        }
    }

    const canonicalRelationships: Record<string, unknown>[] = [];
    const seenEdgeSignatures = new Set<string>();
    const relIdMap = new Map<string, Map<string, string>>();

    const mapNodeId = (sourceId: string, rawId: unknown): unknown => {
        if (typeof rawId !== 'string') return rawId;
        return nodeIdMap.get(sourceId)?.get(rawId) ?? `${sourceId}--${rawId}`;
    };

    const mapSingleIface = (
        sourceId: string,
        targetCanonicalNodeId: unknown,
        rawId: unknown,
    ): unknown => {
        if (typeof rawId !== 'string') return rawId;
        const srcIfaces = ifaceIdMap.get(sourceId);
        const nodeIfaces =
            typeof targetCanonicalNodeId === 'string'
                ? canonicalNodeRawIfaces.get(targetCanonicalNodeId)
                : undefined;
        return srcIfaces?.get(rawId) ?? nodeIfaces?.get(rawId) ?? `${sourceId}--${rawId}`;
    };

    const mapIfaceArray = (sourceId: string, targetCanonicalNodeId: unknown, rawArr: unknown): unknown => {
        if (!Array.isArray(rawArr)) return rawArr;
        return rawArr.map((id) => mapSingleIface(sourceId, targetCanonicalNodeId, id));
    };

    for (const src of orderedSources) {
        const srcRelMap = new Map<string, string>();
        relIdMap.set(src.sourceId, srcRelMap);
        const rawRels = Array.isArray(src.document.relationships) ? src.document.relationships : [];

        for (const rawRel of rawRels) {
            if (!isPlainObject(rawRel)) continue;
            const rawRelId = typeof rawRel['unique-id'] === 'string' ? rawRel['unique-id'].trim() : '';
            if (!rawRelId) continue;

            const clonedRel = structuredClone(rawRel);
            const scopedRelId = `${src.sourceId}--${rawRelId}`;
            clonedRel['unique-id'] = scopedRelId;

            const rt = isPlainObject(clonedRel['relationship-type']) ? clonedRel['relationship-type'] : null;
            let signature = '';

            if (rt) {
                if (isPlainObject(rt.connects)) {
                    const c = rt.connects;
                    if (isPlainObject(c.source)) {
                        const mappedSrc = mapNodeId(src.sourceId, c.source.node);
                        c.source.node = mappedSrc;
                        if (c.source.interfaces !== undefined) {
                            c.source.interfaces = mapIfaceArray(src.sourceId, mappedSrc, c.source.interfaces);
                        }
                        if (c.source.interface !== undefined) {
                            c.source.interface = mapSingleIface(src.sourceId, mappedSrc, c.source.interface);
                        }
                    }
                    if (isPlainObject(c.destination)) {
                        const mappedDst = mapNodeId(src.sourceId, c.destination.node);
                        c.destination.node = mappedDst;
                        if (c.destination.interfaces !== undefined) {
                            c.destination.interfaces = mapIfaceArray(src.sourceId, mappedDst, c.destination.interfaces);
                        }
                        if (c.destination.interface !== undefined) {
                            c.destination.interface = mapSingleIface(src.sourceId, mappedDst, c.destination.interface);
                        }
                    }
                    const sNode = isPlainObject(c.source) ? String(c.source.node ?? '') : '';
                    const dNode = isPlainObject(c.destination) ? String(c.destination.node ?? '') : '';
                    const dIfaces = isPlainObject(c.destination)
                        ? Array.isArray(c.destination.interfaces)
                            ? c.destination.interfaces.join(',')
                            : String(c.destination.interface ?? '')
                        : '';
                    signature = `connects|${sNode}|${dNode}|${dIfaces}|${String(clonedRel.protocol ?? '')}`;
                } else if (isPlainObject(rt.interacts)) {
                    rt.interacts.actor = mapNodeId(src.sourceId, rt.interacts.actor);
                    if (Array.isArray(rt.interacts.nodes)) {
                        rt.interacts.nodes = rt.interacts.nodes.map((n) => mapNodeId(src.sourceId, n));
                    }
                    signature = `interacts|${String(rt.interacts.actor)}|${JSON.stringify(rt.interacts.nodes ?? [])}`;
                } else if (isPlainObject(rt['deployed-in'])) {
                    const d = rt['deployed-in'];
                    d.container = mapNodeId(src.sourceId, d.container);
                    if (Array.isArray(d.nodes)) {
                        d.nodes = d.nodes.map((n) => mapNodeId(src.sourceId, n));
                    }
                    signature = `deployed-in|${String(d.container)}|${JSON.stringify(d.nodes ?? [])}`;
                } else if (isPlainObject(rt['composed-of'])) {
                    const comp = rt['composed-of'];
                    comp.container = mapNodeId(src.sourceId, comp.container);
                    if (Array.isArray(comp.nodes)) {
                        comp.nodes = comp.nodes.map((n) => mapNodeId(src.sourceId, n));
                    }
                    signature = `composed-of|${String(comp.container)}|${JSON.stringify(comp.nodes ?? [])}`;
                }
            }

            if (signature && parentByChild.has(src.sourceId) && seenEdgeSignatures.has(signature)) {
                continue;
            }
            if (signature) seenEdgeSignatures.add(signature);
            srcRelMap.set(rawRelId, scopedRelId);
            canonicalRelationships.push(clonedRel);
        }
    }

    for (const synth of synthesizedRelationships) {
        canonicalRelationships.push(synth);
    }

    const mergedControls: Record<string, unknown> = {};
    const mergedFlows: Record<string, unknown>[] = [];
    const mergedAdrs = new Set<string>();

    for (const src of orderedSources) {
        if (isPlainObject(src.document.controls)) {
            for (const [ctrlKey, ctrlVal] of Object.entries(src.document.controls)) {
                if (!isPlainObject(ctrlVal)) continue;
                const scopedCtrlId = `${src.sourceId}--${ctrlKey}`;
                const clonedCtrl = structuredClone(ctrlVal);
                if (typeof clonedCtrl.description === 'string') {
                    clonedCtrl.description = `[${src.sourceLabel}] ${clonedCtrl.description}`;
                }
                mergedControls[scopedCtrlId] = clonedCtrl;
            }
        }

        if (Array.isArray(src.document.flows)) {
            const srcRelMap = relIdMap.get(src.sourceId);
            for (const rawFlow of src.document.flows) {
                if (!isPlainObject(rawFlow)) continue;
                const rawFlowId = typeof rawFlow['unique-id'] === 'string' ? rawFlow['unique-id'].trim() : '';
                if (!rawFlowId) continue;
                const clonedFlow = structuredClone(rawFlow);
                clonedFlow['unique-id'] = `${src.sourceId}--${rawFlowId}`;
                if (typeof clonedFlow.name === 'string') {
                    clonedFlow.name = `[${src.sourceLabel}] ${clonedFlow.name}`;
                }
                if (Array.isArray(clonedFlow.transitions)) {
                    clonedFlow.transitions = clonedFlow.transitions
                        .filter((t) => {
                            if (!isPlainObject(t)) return false;
                            const rId = t['relationship-unique-id'];
                            return typeof rId === 'string' && (!srcRelMap || srcRelMap.has(rId));
                        })
                        .map((t) => {
                            const tr = { ...(t as Record<string, unknown>) };
                            const rId = String(tr['relationship-unique-id']);
                            tr['relationship-unique-id'] = srcRelMap?.get(rId) ?? `${src.sourceId}--${rId}`;
                            return tr;
                        });
                }
                if (!Array.isArray(clonedFlow.transitions) || clonedFlow.transitions.length > 0) {
                    mergedFlows.push(clonedFlow);
                }
            }
        }

        if (Array.isArray(src.document.adrs)) {
            for (const adr of src.document.adrs) {
                if (typeof adr === 'string' && adr.trim()) {
                    mergedAdrs.add(adr.trim());
                }
            }
        }
    }

    const federatedDoc: Record<string, unknown> = {
        $schema: CALM_RELEASE_SCHEMA,
        nodes: [...canonicalNodes.values()],
        relationships: canonicalRelationships,
    };
    if (mergedFlows.length > 0) federatedDoc.flows = mergedFlows;
    if (Object.keys(mergedControls).length > 0) federatedDoc.controls = mergedControls;
    if (mergedAdrs.size > 0) federatedDoc.adrs = [...mergedAdrs];

    return {
        document: federatedDoc,
        nodeProvenance,
        resolvedLinks: [...parentByChild.values()],
    };
}

interface ExtractedSourceStream {
    descriptor: FederatedSourceDescriptor;
    repoRoot: string;
    autoDiscovered?: boolean;
    deltas: StructuralCommitDelta[];
    totalCommitsScanned: number;
    validSnapshotsParsed: number;
    noiseCommitsFiltered: number;
}

function assignUniqueSourceDescriptors(
    rawEntries: Array<{
        explicitLabel?: string;
        repoRoot: string;
        relPath: string;
        filePath: string;
    }>,
): FederatedSourceDescriptor[] {
    const distinctRepos = new Set(rawEntries.map((e) => e.repoRoot));
    const multiRepo = distinctRepos.size > 1;
    const usedIds = new Set<string>();

    return rawEntries.map((entry) => {
        const repoName = path.basename(entry.repoRoot) || 'repo';
        const fileName = path.basename(entry.filePath);
        const fileStem = toSlug(fileName);
        const baseCandidate = entry.explicitLabel
            ? toSlug(entry.explicitLabel)
            : multiRepo
              ? toSlug(`${repoName}-${fileStem}`)
              : fileStem;

        let sourceId = baseCandidate;
        let n = 2;
        while (usedIds.has(sourceId)) {
            sourceId = `${baseCandidate}-${n++}`;
        }
        usedIds.add(sourceId);

        const sourceLabel = entry.explicitLabel
            ? entry.explicitLabel
            : multiRepo
              ? `${repoName}/${fileStem}`
              : fileStem;

        return {
            sourceId,
            sourceLabel,
            repoName,
            fileName,
            relPath: entry.relPath,
        };
    });
}

function parseSortableTimestamp(commit: GitCommitSnapshot): number {
    if (commit.timestampIso) {
        const ts = Date.parse(commit.timestampIso);
        if (!Number.isNaN(ts)) return ts;
    }
    const fallback = Date.parse(commit.date);
    return Number.isNaN(fallback) ? 0 : fallback;
}

export interface SynchronizeGitSourcesOptions {
    maxCommits?: number;
    includeMetadataChanges?: boolean;
    resolveDetails?: boolean;
    gitRunner?: GitCommandRunner;
    onDebug?: (message: string) => void;
}

export interface SynchronizedGitHistoryResult {
    sources: FederatedSourceDescriptor[];
    repositoriesTracked: number;
    deltas: StructuralCommitDelta[];
    totalCommitsScanned: number;
    validSnapshotsParsed: number;
    noiseCommitsFiltered: number;
}

export function extractAndSynchronizeGitSources(
    targetSpecs: string[],
    options: SynchronizeGitSourcesOptions = {},
): SynchronizedGitHistoryResult {
    const parsedSpecs = targetSpecs.map(parseSourceTargetSpec);
    const extractedRaw: Array<{
        explicitLabel?: string;
        autoDiscovered?: boolean;
        filePath: string;
        repoRoot: string;
        relPath: string;
        commits: GitCommitSnapshot[];
        totalCommitsScanned: number;
    }> = [];

    const seenRepoRelKeys = new Set<string>();

    for (const spec of parsedSpecs) {
        const hist = extractGitHistory(spec.filePath, {
            maxCommits: options.maxCommits,
            gitRunner: options.gitRunner,
            onDebug: options.onDebug,
        });
        if (hist.commits.length === 0) {
            throw new Error(`No valid CALM JSON snapshots found in git history for "${spec.filePath}".`);
        }
        seenRepoRelKeys.add(`${hist.repoRoot}::${hist.relPath}`);
        extractedRaw.push({
            explicitLabel: spec.explicitLabel,
            filePath: spec.filePath,
            repoRoot: hist.repoRoot,
            relPath: hist.relPath,
            commits: hist.commits,
            totalCommitsScanned: hist.totalCommitsScanned,
        });
    }

    if (options.resolveDetails) {
        const queue = [...extractedRaw];
        while (queue.length > 0) {
            const curr = queue.shift()!;
            for (const snap of curr.commits) {
                const nodes = Array.isArray(snap.document.nodes) ? snap.document.nodes : [];
                for (const rawNode of nodes) {
                    if (!isPlainObject(rawNode) || !isPlainObject(rawNode.details)) continue;
                    const ref = rawNode.details['detailed-architecture'];
                    if (typeof ref !== 'string' || !ref.trim() || /^https?:\/\//i.test(ref.trim())) continue;
                    const candidateRel = normalizePosixRelative(curr.relPath, ref.trim());
                    const repoKey = `${curr.repoRoot}::${candidateRel}`;
                    if (seenRepoRelKeys.has(repoKey)) continue;
                    seenRepoRelKeys.add(repoKey);

                    const candidateAbs = path.join(curr.repoRoot, ...candidateRel.split('/'));
                    try {
                        const childHist = extractGitHistory(candidateAbs, {
                            maxCommits: options.maxCommits,
                            gitRunner: options.gitRunner,
                            onDebug: options.onDebug,
                        });
                        if (childHist.commits.length > 0) {
                            const entry = {
                                autoDiscovered: true,
                                filePath: candidateAbs,
                                repoRoot: childHist.repoRoot,
                                relPath: childHist.relPath,
                                commits: childHist.commits,
                                totalCommitsScanned: childHist.totalCommitsScanned,
                            };
                            extractedRaw.push(entry);
                            queue.push(entry);
                        }
                    } catch {
                        options.onDebug?.(
                            `Skipping detailed-architecture '${candidateRel}' (no git history found in ${path.basename(curr.repoRoot)}).`,
                        );
                    }
                }
            }
        }
    }

    const descriptors = assignUniqueSourceDescriptors(extractedRaw);
    const streams: ExtractedSourceStream[] = extractedRaw.map((raw, idx) => {
        const filtered = filterStructuralCommits(raw.commits, {
            includeMetadataChanges: options.includeMetadataChanges,
        });
        return {
            descriptor: descriptors[idx],
            repoRoot: raw.repoRoot,
            autoDiscovered: raw.autoDiscovered,
            deltas: filtered.deltas,
            totalCommitsScanned: raw.totalCommitsScanned,
            validSnapshotsParsed: raw.commits.length,
            noiseCommitsFiltered: filtered.noiseCommitsFiltered,
        };
    });
    const autoDiscoveredIds = new Set(
        streams.filter((s) => s.autoDiscovered).map((s) => s.descriptor.sourceId),
    );

    interface TimedEvent {
        streamIdx: number;
        deltaIdx: number;
        ts: number;
        stream: ExtractedSourceStream;
        delta: StructuralCommitDelta;
    }

    const allEvents: TimedEvent[] = [];
    streams.forEach((stream, streamIdx) => {
        stream.deltas.forEach((delta, deltaIdx) => {
            allEvents.push({
                streamIdx,
                deltaIdx,
                ts: parseSortableTimestamp(delta.commit),
                stream,
                delta,
            });
        });
    });

    allEvents.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        if (a.streamIdx !== b.streamIdx) return a.streamIdx - b.streamIdx;
        return a.deltaIdx - b.deltaIdx;
    });

    const ticks: TimedEvent[][] = [];
    for (const ev of allEvents) {
        const prevTick = ticks[ticks.length - 1];
        if (
            prevTick &&
            prevTick[0].stream.repoRoot === ev.stream.repoRoot &&
            prevTick[0].delta.commit.sha === ev.delta.commit.sha
        ) {
            prevTick.push(ev);
        } else {
            ticks.push([ev]);
        }
    }

    const activeStates = new Map<string, ActiveSourceSnapshot>();
    const federatedDeltas: StructuralCommitDelta[] = [];
    let prevFederatedDoc: Record<string, unknown> | null = null;
    let extraNoiseFiltered = 0;

    for (const tick of ticks) {
        for (const ev of tick) {
            const desc = ev.stream.descriptor;
            activeStates.set(desc.sourceId, {
                sourceId: desc.sourceId,
                sourceLabel: desc.sourceLabel,
                repoRoot: ev.stream.repoRoot,
                repoName: desc.repoName,
                relPath: desc.relPath,
                fileName: desc.fileName,
                document: ev.delta.commit.document,
            });
        }

        const allActive = descriptors
            .map((d) => activeStates.get(d.sourceId))
            .filter((s): s is ActiveSourceSnapshot => s !== undefined);

        let orderedActive = allActive;
        if (autoDiscoveredIds.size > 0) {
            const reachableIds = new Set<string>(
                allActive.filter((s) => !autoDiscoveredIds.has(s.sourceId)).map((s) => s.sourceId),
            );
            let changed = true;
            while (changed) {
                changed = false;
                for (const parentSnap of allActive) {
                    if (!reachableIds.has(parentSnap.sourceId)) continue;
                    const pNodes = Array.isArray(parentSnap.document.nodes)
                        ? parentSnap.document.nodes
                        : [];
                    for (const pNode of pNodes) {
                        if (!isPlainObject(pNode) || !isPlainObject(pNode.details)) continue;
                        const rawRef = pNode.details['detailed-architecture'];
                        if (typeof rawRef !== 'string') continue;
                        const childMatch = findMatchingChildSource(parentSnap, rawRef, allActive);
                        if (childMatch && !reachableIds.has(childMatch.sourceId)) {
                            reachableIds.add(childMatch.sourceId);
                            changed = true;
                        }
                    }
                }
            }
            orderedActive = allActive.filter((s) => reachableIds.has(s.sourceId));
            if (orderedActive.length === 0) {
                extraNoiseFiltered++;
                continue;
            }
        }

        const composed = composeFederatedArchitecture(orderedActive);
        const isInitial = prevFederatedDoc === null;
        const structDelta = computeStructuralDelta(prevFederatedDoc, composed.document);

        const primaryEv = tick[tick.length - 1];
        const tickAdrs = new Set<string>();
        for (const ev of tick) {
            for (const adr of ev.delta.commit.coChangedAdrs) {
                tickAdrs.add(`[${ev.stream.descriptor.sourceLabel}] ${adr}`);
            }
        }

        const keep =
            isInitial ||
            structDelta.hasStructuralChange ||
            tickAdrs.size > 0 ||
            (!!options.includeMetadataChanges && structDelta.hasMetadataChange);

        if (!keep) {
            extraNoiseFiltered++;
            continue;
        }

        const labelsInTick = [...new Set(tick.map((e) => e.stream.descriptor.sourceLabel))];
        const labelPrefix = `[${labelsInTick.join(' + ')}]`;
        const combinedSubject =
            tick.length === 1
                ? `${labelPrefix} ${primaryEv.delta.commit.subject}`
                : `${labelPrefix} ${primaryEv.delta.commit.subject} (+${tick.length - 1} co-committed file(s))`;

        const filteredItems = (
            options.includeMetadataChanges
                ? structDelta.changeItems
                : structDelta.changeItems.filter((item) => item.category !== 'metadata')
        ).map((item) => ({
            ...item,
            text: `${labelPrefix} ${item.text}`,
        }));

        const primaryDesc = primaryEv.stream.descriptor;
        const syntheticCommit: GitCommitSnapshot = {
            sha: primaryEv.delta.commit.sha,
            shortSha: primaryEv.delta.commit.shortSha,
            date: primaryEv.delta.commit.date,
            timestampIso: primaryEv.delta.commit.timestampIso,
            author: [...new Set(tick.map((e) => e.delta.commit.author))].join(', '),
            subject: combinedSubject,
            body: tick.map((e) => e.delta.commit.body).filter(Boolean).join('\n'),
            historicalPath: tick.map((e) => e.stream.descriptor.relPath).join(', '),
            coChangedAdrs: [...tickAdrs],
            document: composed.document,
            sourceId: primaryDesc.sourceId,
            sourceLabel: labelsInTick.join(' + '),
            repoName: primaryDesc.repoName,
            nodeProvenance: composed.nodeProvenance,
        };

        federatedDeltas.push({
            commit: syntheticCommit,
            isInitial,
            changeItems: filteredItems,
            counts: structDelta.counts,
            summaryLine: `${labelPrefix} ${summarizeCounts(structDelta.counts, isInitial)}`,
        });

        prevFederatedDoc = composed.document;
    }

    const distinctRepos = new Set(streams.map((s) => s.repoRoot));
    return {
        sources: descriptors,
        repositoriesTracked: distinctRepos.size,
        deltas: federatedDeltas,
        totalCommitsScanned: streams.reduce((sum, s) => sum + s.totalCommitsScanned, 0),
        validSnapshotsParsed: streams.reduce((sum, s) => sum + s.validSnapshotsParsed, 0),
        noiseCommitsFiltered:
            streams.reduce((sum, s) => sum + s.noiseCommitsFiltered, 0) + extraNoiseFiltered,
    };
}

export interface SynchronizedTimelineMomentFrame {
    uniqueId: string;
    name: string;
    description: string;
    validFrom: string;
    commits: string[];
    commitMessages: string[];
    commitCount: number;
    adrs: string[];
    document: Record<string, unknown>;
    nodeProvenance: Record<string, FederatedNodeProvenance>;
}

export function synchronizeSavedTimelines(timelineSpecs: string[]): {
    sources: FederatedSourceDescriptor[];
    frames: SynchronizedTimelineMomentFrame[];
} {
    const parsedSpecs = timelineSpecs.map(parseSourceTargetSpec);
    const rawMeta = parsedSpecs.map((spec) => {
        const abs = path.resolve(spec.filePath);
        const dir = path.dirname(abs);
        const parentFolder = path.basename(dir) || 'timeline';
        return {
            explicitLabel: spec.explicitLabel,
            repoRoot: dir,
            relPath: path.basename(abs),
            filePath: abs,
            parentFolder,
        };
    });

    const descriptors = assignUniqueSourceDescriptors(rawMeta);

    interface TimelineStepEvent {
        sourceIdx: number;
        momentIdx: number;
        validFrom: string;
        sortKey: number;
        descriptor: FederatedSourceDescriptor;
        momentName: string;
        momentDesc: string;
        momentId: string;
        commits: string[];
        commitMessages: string[];
        commitCount: number;
        adrs: string[];
        snapshotDoc: Record<string, unknown>;
        snapshotRelPath: string;
    }

    const events: TimelineStepEvent[] = [];

    parsedSpecs.forEach((spec, sourceIdx) => {
        const abs = path.resolve(spec.filePath);
        const baseDir = path.dirname(abs);
        const raw = JSON.parse(readFileSync(abs, 'utf-8')) as GeneratedGitTimeline;
        if (!Array.isArray(raw.moments) || raw.moments.length === 0) {
            throw new Error(`Timeline '${abs}' contains no moments.`);
        }
        const descriptor = descriptors[sourceIdx];

        raw.moments.forEach((m, momentIdx) => {
            const archRef = (m.details?.['detailed-architecture'] ?? m.details?.['required-pattern'])?.trim();
            if (!archRef || /^https?:\/\//i.test(archRef)) {
                throw new Error(
                    `Moment '${m['unique-id']}' in '${descriptor.fileName}' must reference a local detailed-architecture or required-pattern snapshot.`,
                );
            }
            const snapAbs = path.resolve(baseDir, archRef);
            if (!existsSync(snapAbs)) {
                throw new Error(`Snapshot '${archRef}' referenced by '${descriptor.fileName}' does not exist.`);
            }
            const snapshotDoc = JSON.parse(readFileSync(snapAbs, 'utf-8')) as Record<string, unknown>;
            const validFrom = m['valid-from'] ?? '';
            const parsedTs = validFrom ? Date.parse(validFrom) : Number.NaN;
            const sortKey = Number.isNaN(parsedTs) ? momentIdx : parsedTs;

            const meta = isPlainObject(m.metadata) ? m.metadata : {};
            const commits = Array.isArray(meta.commits)
                ? meta.commits.filter((c): c is string => typeof c === 'string')
                : [];
            const rawMsgs = meta['commit-messages'] ?? meta.commitMessages;
            const commitMessages = Array.isArray(rawMsgs)
                ? rawMsgs.filter((msg): msg is string => typeof msg === 'string')
                : [];
            const commitCount =
                typeof meta['commit-count'] === 'number' ? meta['commit-count'] : commits.length;

            events.push({
                sourceIdx,
                momentIdx,
                validFrom,
                sortKey,
                descriptor,
                momentName: m.name,
                momentDesc: m.description,
                momentId: m['unique-id'],
                commits,
                commitMessages,
                commitCount,
                adrs: Array.isArray(m.adrs) ? m.adrs : [],
                snapshotDoc,
                snapshotRelPath: path.basename(archRef),
            });
        });
    });

    events.sort((a, b) => {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        if (a.sourceIdx !== b.sourceIdx) return a.sourceIdx - b.sourceIdx;
        return a.momentIdx - b.momentIdx;
    });

    const activeStates = new Map<string, ActiveSourceSnapshot>();
    const frames: SynchronizedTimelineMomentFrame[] = [];

    events.forEach((ev, idx) => {
        activeStates.set(ev.descriptor.sourceId, {
            sourceId: ev.descriptor.sourceId,
            sourceLabel: ev.descriptor.sourceLabel,
            repoRoot: path.dirname(rawMeta[ev.sourceIdx].filePath),
            repoName: ev.descriptor.repoName,
            relPath: ev.snapshotRelPath,
            fileName: ev.snapshotRelPath,
            document: ev.snapshotDoc,
        });

        const orderedActive = descriptors
            .map((d) => activeStates.get(d.sourceId))
            .filter((s): s is ActiveSourceSnapshot => s !== undefined);

        const composed = composeFederatedArchitecture(orderedActive);
        const prefix = `[${ev.descriptor.sourceLabel}]`;

        frames.push({
            uniqueId: `${ev.descriptor.sourceId}--${ev.momentId}-${idx + 1}`,
            name: `${prefix} ${ev.momentName}`,
            description: ev.momentDesc,
            validFrom: ev.validFrom,
            commits: ev.commits,
            commitMessages: ev.commitMessages.map((m) => `${prefix} ${m}`),
            commitCount: ev.commitCount,
            adrs: ev.adrs.map((a) => `${prefix} ${a}`),
            document: composed.document,
            nodeProvenance: composed.nodeProvenance,
        });
    });

    return { sources: descriptors, frames };
}
