// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCommitHistoryDigest, clusterCommitsIntoMoments } from './cluster.js';
import { extractAndSynchronizeGitSources, parseSourceTargetSpec } from './federation.js';
import { extractGitHistory, filterStructuralCommits } from './git-history.js';
import {
  assembleCalmTimeline,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './timeline-emitter.js';
import {
  buildTimelapsePayloadFromClusters,
  buildTimelapsePayloadFromTimelineFile,
  buildTimelapsePayloadFromTimelineFiles,
  writeTimelapseHtml,
} from './timelapse-html.js';
import type {
  CommitHistoryDigest,
  FederatedSourceDescriptor,
  GitCommandRunner,
  GitTimelineResult,
  MomentCluster,
  StructuralCommitDelta,
} from './types.js';

export * from './types.js';
export * from './calm-diff.js';
export * from './git-history.js';
export * from './cluster.js';
export * from './federation.js';
export * from './timeline-emitter.js';
export * from './timelapse-html.js';

export interface GenerateTimelineOptions {
  outputPath?: string;
  snapshotsDir?: string;
  timelapsePath?: string;
  defaultView?: 'stage' | 'feed';
  emitDigestPath?: string;
  clustersPath?: string;
  clusterSpecs?: unknown;
  maxCommits?: number;
  firstParent?: boolean;
  includeMetadataChanges?: boolean;
  resolveDetails?: boolean;
  validate?: boolean;
  validateSnapshots?: boolean;
  gitRunner?: GitCommandRunner;
  onDebug?: (message: string) => void;
}

export interface FullGitTimelineResult extends GitTimelineResult {
  clusters: MomentCluster[];
  digest: CommitHistoryDigest;
  sources?: FederatedSourceDescriptor[];
  digestPath?: string;
  timelapsePath?: string;
  validationErrors: string[];
}

export async function generateTimelineFromGit(
  targetFileOrFiles: string | string[],
  options: GenerateTimelineOptions = {},
): Promise<FullGitTimelineResult> {
  const targets = (Array.isArray(targetFileOrFiles) ? targetFileOrFiles : [targetFileOrFiles])
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (targets.length === 0) {
    throw new Error('At least one CALM JSON target file path is required.');
  }

  const useFederatedMode =
    targets.length > 1 || Boolean(options.resolveDetails) || targets[0].includes('=');

  let deltas: StructuralCommitDelta[];
  let totalCommitsScanned: number;
  let validSnapshotsParsed: number;
  let noiseCommitsFiltered: number;
  let sources: FederatedSourceDescriptor[] | undefined;
  let repositoriesTracked: number | undefined;
  const primaryFilePath = parseSourceTargetSpec(targets[0]).filePath;

  if (useFederatedMode) {
    const syncResult = extractAndSynchronizeGitSources(targets, {
      maxCommits: options.maxCommits,
      firstParent: options.firstParent,
      includeMetadataChanges: options.includeMetadataChanges,
      resolveDetails: options.resolveDetails,
      gitRunner: options.gitRunner,
      onDebug: options.onDebug,
    });
    deltas = syncResult.deltas;
    totalCommitsScanned = syncResult.totalCommitsScanned;
    validSnapshotsParsed = syncResult.validSnapshotsParsed;
    noiseCommitsFiltered = syncResult.noiseCommitsFiltered;
    sources = syncResult.sources;
    repositoriesTracked = syncResult.repositoriesTracked;
  } else {
    const targetFilePath = targets[0];
    const extracted = extractGitHistory(targetFilePath, {
      maxCommits: options.maxCommits,
      firstParent: options.firstParent,
      gitRunner: options.gitRunner,
      onDebug: options.onDebug,
    });

    if (extracted.commits.length === 0) {
      throw new Error(
        `No valid CALM JSON snapshots found in git history for "${targetFilePath}".`,
      );
    }

    const filtered = filterStructuralCommits(extracted.commits, {
      includeMetadataChanges: options.includeMetadataChanges,
    });
    deltas = filtered.deltas;
    totalCommitsScanned = extracted.totalCommitsScanned;
    validSnapshotsParsed = extracted.commits.length;
    noiseCommitsFiltered = filtered.noiseCommitsFiltered;
  }

  if (deltas.length === 0) {
    throw new Error(
      `No structural CALM commits remained after filtering ${totalCommitsScanned} commit(s).`,
    );
  }

  const digestSourceDisplay =
    sources && sources.length > 1
      ? sources.map((s) => s.sourceLabel).join(' + ')
      : path.basename(primaryFilePath);

  const digest = buildCommitHistoryDigest(deltas, {
    sourceFile: digestSourceDisplay,
    sources,
    totalCommitsScanned,
    validSnapshotsParsed,
    noiseCommitsFiltered,
  });

  let writtenDigestPath: string | undefined;
  if (options.emitDigestPath) {
    writtenDigestPath = path.resolve(options.emitDigestPath);
    mkdirSync(path.dirname(writtenDigestPath), { recursive: true });
    writeFileSync(writtenDigestPath, JSON.stringify(digest, null, 2) + '\n', 'utf-8');
  }

  let resolvedClusterSpecs = options.clusterSpecs;
  if (options.clustersPath) {
    const resolvedClustersPath = path.resolve(options.clustersPath);
    let rawContent: string;
    try {
      rawContent = readFileSync(resolvedClustersPath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read --clusters file "${resolvedClustersPath}": ${msg}`);
    }
    try {
      resolvedClusterSpecs = JSON.parse(rawContent) as unknown;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in --clusters file "${resolvedClustersPath}": ${msg}`);
    }
  }

  const { clusters, engine } = clusterCommitsIntoMoments(deltas, {
    clusterSpecs: resolvedClusterSpecs,
  });

  const { timeline, snapshotPaths } = assembleCalmTimeline(clusters, {
    sourceFilePath: primaryFilePath,
    sources,
    outputPath: options.outputPath,
    snapshotsDir: options.snapshotsDir,
  });

  timeline.metadata = {
    ...(timeline.metadata ?? {}),
    'clustering-engine': engine,
    'total-commits-scanned': String(totalCommitsScanned),
    'noise-commits-filtered': String(noiseCommitsFiltered),
    'structural-commits-retained': String(deltas.length),
    ...(sources && sources.length > 1
      ? {
          'sources-tracked': String(sources.length),
          'repositories-tracked': String(repositoriesTracked ?? 1),
        }
      : {}),
  };

  if (options.outputPath) {
    const resolvedOutput = path.resolve(options.outputPath);
    mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    writeFileSync(resolvedOutput, JSON.stringify(timeline, null, 2) + '\n', 'utf-8');
  }

  const validationErrors: string[] = options.validate
    ? validateTimelineStructure(timeline, { timelineFilePath: options.outputPath })
    : [];

  if (options.validateSnapshots) {
    for (const cluster of clusters) {
      validationErrors.push(
        ...validateCalmArchitectureSnapshot(cluster.snapshotDocument, cluster.uniqueId),
      );
    }
  }

  let writtenTimelapsePath: string | undefined;
  if (options.timelapsePath) {
    const payload = buildTimelapsePayloadFromClusters(clusters, {
      sourceFile: primaryFilePath,
      sources,
      defaultView: options.defaultView,
      engine,
      stats: {
        totalCommitsScanned,
        noiseCommitsFiltered,
        structuralCommitsRetained: deltas.length,
        momentsGenerated: timeline.moments.length,
      },
    });
    writtenTimelapsePath = writeTimelapseHtml(options.timelapsePath, payload);
  }

  return {
    timeline,
    snapshotPaths,
    clusters,
    digest,
    ...(sources ? { sources } : {}),
    digestPath: writtenDigestPath,
    timelapsePath: writtenTimelapsePath,
    validationErrors,
    stats: {
      totalCommitsScanned,
      validSnapshotsParsed,
      noiseCommitsFiltered,
      structuralCommitsRetained: deltas.length,
      momentsGenerated: timeline.moments.length,
      clusteringEngine: engine,
      ...(sources
        ? {
            sourcesTracked: sources.length,
            repositoriesTracked: repositoriesTracked ?? 1,
          }
        : {}),
    },
  };
}

export function renderTimelapseFromTimelineFile(
  timelineFileOrFiles: string | string[],
  outputHtmlPath: string,
  options?: { defaultView?: 'stage' | 'feed' },
): string {
  const files = (Array.isArray(timelineFileOrFiles) ? timelineFileOrFiles : [timelineFileOrFiles])
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (files.length === 0) {
    throw new Error('At least one CALM timeline file path is required.');
  }
  const payload =
    files.length > 1
      ? buildTimelapsePayloadFromTimelineFiles(files)
      : buildTimelapsePayloadFromTimelineFile(files[0]);
  if (options?.defaultView) {
    payload.defaultView = options.defaultView;
  }
  return writeTimelapseHtml(outputHtmlPath, payload);
}
