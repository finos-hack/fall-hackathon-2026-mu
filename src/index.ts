// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCommitHistoryDigest, clusterCommitsIntoMoments } from './cluster.js';
import { extractGitHistory, filterStructuralCommits } from './git-history.js';
import {
  assembleCalmTimeline,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './timeline-emitter.js';
import {
  buildTimelapsePayloadFromClusters,
  buildTimelapsePayloadFromTimelineFile,
  writeTimelapseHtml,
} from './timelapse-html.js';
import type {
  CommitHistoryDigest,
  GitCommandRunner,
  GitTimelineResult,
  MomentCluster,
} from './types.js';

export * from './types.js';
export * from './calm-diff.js';
export * from './git-history.js';
export * from './cluster.js';
export * from './timeline-emitter.js';
export * from './timelapse-html.js';

export interface GenerateTimelineOptions {
  outputPath?: string;
  snapshotsDir?: string;
  timelapsePath?: string;
  emitDigestPath?: string;
  clustersPath?: string;
  clusterSpecs?: unknown;
  maxCommits?: number;
  includeMetadataChanges?: boolean;
  validate?: boolean;
  validateSnapshots?: boolean;
  gitRunner?: GitCommandRunner;
  onDebug?: (message: string) => void;
}

export interface FullGitTimelineResult extends GitTimelineResult {
  clusters: MomentCluster[];
  digest: CommitHistoryDigest;
  digestPath?: string;
  timelapsePath?: string;
  validationErrors: string[];
}

export async function generateTimelineFromGit(
  targetFilePath: string,
  options: GenerateTimelineOptions = {},
): Promise<FullGitTimelineResult> {
  const { commits, totalCommitsScanned } = extractGitHistory(targetFilePath, {
    maxCommits: options.maxCommits,
    gitRunner: options.gitRunner,
    onDebug: options.onDebug,
  });

  if (commits.length === 0) {
    throw new Error(
      `No valid CALM JSON snapshots found in git history for "${targetFilePath}".`,
    );
  }

  const { deltas, noiseCommitsFiltered } = filterStructuralCommits(commits, {
    includeMetadataChanges: options.includeMetadataChanges,
  });

  if (deltas.length === 0) {
    throw new Error(
      `No structural CALM commits remained after filtering ${totalCommitsScanned} commit(s).`,
    );
  }

  const digest = buildCommitHistoryDigest(deltas, {
    sourceFile: path.basename(targetFilePath),
    totalCommitsScanned,
    validSnapshotsParsed: commits.length,
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
    sourceFilePath: targetFilePath,
    outputPath: options.outputPath,
    snapshotsDir: options.snapshotsDir,
  });

  timeline.metadata = {
    ...(timeline.metadata ?? {}),
    'clustering-engine': engine,
    'total-commits-scanned': String(totalCommitsScanned),
    'noise-commits-filtered': String(noiseCommitsFiltered),
    'structural-commits-retained': String(deltas.length),
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
      sourceFile: targetFilePath,
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
    digestPath: writtenDigestPath,
    timelapsePath: writtenTimelapsePath,
    validationErrors,
    stats: {
      totalCommitsScanned,
      validSnapshotsParsed: commits.length,
      noiseCommitsFiltered,
      structuralCommitsRetained: deltas.length,
      momentsGenerated: timeline.moments.length,
      clusteringEngine: engine,
    },
  };
}

export function renderTimelapseFromTimelineFile(
  timelineFilePath: string,
  outputHtmlPath: string,
): string {
  const payload = buildTimelapsePayloadFromTimelineFile(timelineFilePath);
  return writeTimelapseHtml(outputHtmlPath, payload);
}
