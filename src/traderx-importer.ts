// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeStructuralDelta, summarizeCounts } from './calm-diff.js';
import { buildCommitHistoryDigest } from './cluster.js';
import { defaultGitRunner } from './git-history.js';
import type { FullGitTimelineResult } from './index.js';
import {
  assembleCalmTimeline,
  validateCalmArchitectureSnapshot,
  validateTimelineStructure,
} from './timeline-emitter.js';
import { buildTimelapsePayloadFromClusters, writeTimelapseHtml } from './timelapse-html.js';
import type {
  GitCommandRunner,
  GitCommitSnapshot,
  MomentCluster,
  StructuralCommitDelta,
} from './types.js';

export const CALM_13_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm.json';

export interface TraderXCatalogState {
  id: string;
  title: string;
  status?: string;
  track?: string;
  isConvergence?: boolean;
  featurePack: string;
  previous?: string[];
  publish?: {
    branch?: string;
    tag?: string;
  };
}

export interface TraderXArchitectureNode {
  id: string;
  label?: string;
  kind?: string;
  description?: string;
}

export interface TraderXArchitectureEdge {
  from: string;
  to: string;
  label?: string;
}

export interface TraderXArchitectureModel {
  stateId?: string;
  title?: string;
  description?: string;
  inheritsFrom?: string | null;
  nodes?: TraderXArchitectureNode[];
  edges?: TraderXArchitectureEdge[];
  notes?: string[];
}

export interface GenerateTraderXTimelineOptions {
  outputPath?: string;
  snapshotsDir?: string;
  timelapsePath?: string;
  defaultView?: 'stage' | 'feed';
  emitDigestPath?: string;
  validate?: boolean;
  validateSnapshots?: boolean;
  gitRunner?: GitCommandRunner;
  onDebug?: (message: string) => void;
}

const TRADERX_KIND_TO_CALM_NODE_TYPE: Record<string, string> = {
  actor: 'actor',
  frontend: 'webclient',
  database: 'database',
  boundary: 'network',
  platform: 'system',
  service: 'service',
  gateway: 'service',
  messaging: 'service',
  observability: 'service',
  tooling: 'service',
  component: 'service',
};

function inferCalmProtocol(
  edgeLabel: string,
  targetNodeType: string,
): 'HTTPS' | 'HTTP' | 'SocketIO' | 'WebSocket' | 'JDBC' | undefined {
  if (/https/i.test(edgeLabel)) return 'HTTPS';
  if (/socket\.?io/i.test(edgeLabel)) return 'SocketIO';
  if (/websocket|nats-ws|\bws\b/i.test(edgeLabel)) return 'WebSocket';
  if (targetNodeType === 'database' || /jdbc|postgres|persist|h2\b/i.test(edgeLabel)) return 'JDBC';
  if (edgeLabel.startsWith('/') || /\bhttp\b|rest\b/i.test(edgeLabel)) return 'HTTP';
  return undefined;
}

function isPlaceholderScaffoldModel(model: TraderXArchitectureModel): boolean {
  const desc = (model.description ?? '').trim();
  return /^update this model with the authoritative architecture/i.test(desc);
}

export function convertTraderXStateToCalm(
  model: TraderXArchitectureModel,
  catalogState: TraderXCatalogState,
  adrs: string[] = [],
): Record<string, unknown> {
  const rawNodes = Array.isArray(model.nodes) ? model.nodes : [];
  const rawEdges = Array.isArray(model.edges) ? model.edges : [];

  const nodeTypeById = new Map<string, string>();
  const calmNodes: Array<Record<string, unknown>> = [];
  const seenNodeIds = new Set<string>();

  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode.id !== 'string' || !rawNode.id.trim()) continue;
    const id = rawNode.id.trim();
    if (seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);

    const rawKind = (rawNode.kind ?? 'service').trim().toLowerCase();
    const calmNodeType = TRADERX_KIND_TO_CALM_NODE_TYPE[rawKind] ?? 'service';
    nodeTypeById.set(id, calmNodeType);

    const name = rawNode.label?.trim() || id;
    const description =
      rawNode.description?.trim() || `${name} (${rawKind} component in TraderX ${catalogState.id}).`;

    const calmNode: Record<string, unknown> = {
      'unique-id': id,
      'node-type': calmNodeType,
      name,
      description,
    };
    if (rawKind && rawKind !== calmNodeType) {
      calmNode.metadata = { 'traderx-kind': rawKind };
    }
    calmNodes.push(calmNode);
  }

  const calmRelationships: Array<Record<string, unknown>> = [];
  const usedRelIds = new Set<string>();
  const referencedNodes = new Set<string>();

  for (const rawEdge of rawEdges) {
    if (!rawEdge || typeof rawEdge.from !== 'string' || typeof rawEdge.to !== 'string') continue;
    const from = rawEdge.from.trim();
    const to = rawEdge.to.trim();
    if (!seenNodeIds.has(from) || !seenNodeIds.has(to)) continue;
    referencedNodes.add(from);
    referencedNodes.add(to);

    const baseRelId = `rel-${from}-${to}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
    let relId = baseRelId;
    let suffix = 2;
    while (usedRelIds.has(relId)) {
      relId = `${baseRelId}-${suffix++}`;
    }
    usedRelIds.add(relId);

    const label = rawEdge.label?.trim() ?? '';
    const description = label || `${from} communicates with ${to}.`;
    const fromNodeType = nodeTypeById.get(from) ?? 'service';
    const toNodeType = nodeTypeById.get(to) ?? 'service';

    if (fromNodeType === 'actor') {
      calmRelationships.push({
        'unique-id': relId,
        description,
        'relationship-type': {
          interacts: {
            actor: from,
            nodes: [to],
          },
        },
      });
    } else {
      const protocol = inferCalmProtocol(label, toNodeType);
      calmRelationships.push({
        'unique-id': relId,
        description,
        ...(protocol ? { protocol } : {}),
        'relationship-type': {
          connects: {
            source: { node: from },
            destination: { node: to },
          },
        },
      });
    }
  }

  const OBS_NODE_PATTERN = /^(?:prometheus|blackbox|loki|promtail|tempo|otel|grafana)$/i;
  const unreferencedBoundaries = rawNodes
    .filter(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        (n.kind ?? '').trim().toLowerCase() === 'boundary' &&
        !referencedNodes.has(n.id.trim()),
    )
    .map((n) => n.id.trim());

  if (unreferencedBoundaries.length > 0) {
    const deployableNodes = calmNodes
      .map((n) => String(n['unique-id']))
      .filter((id) => {
        const nt = nodeTypeById.get(id);
        return nt !== 'actor' && nt !== 'network';
      });
    const hasObsBoundary = unreferencedBoundaries.some((id) => /^obs/i.test(id));
    for (const boundaryId of unreferencedBoundaries) {
      const isObs = /^obs/i.test(boundaryId);
      const childIds = hasObsBoundary
        ? deployableNodes.filter((id) => (isObs ? OBS_NODE_PATTERN.test(id) : !OBS_NODE_PATTERN.test(id)))
        : deployableNodes;
      if (childIds.length > 0) {
        const depRelId = `rel-deployed-in-${boundaryId}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
        calmRelationships.push({
          'unique-id': depRelId,
          description: `Workloads deployed in ${boundaryId}.`,
          'relationship-type': {
            'deployed-in': {
              container: boundaryId,
              nodes: childIds,
            },
          },
        });
      }
    }
  }

  const stateTitle = catalogState.title || model.title || catalogState.id;
  const stateDesc =
    model.description?.trim() || `FINOS TraderX architecture state ${catalogState.id}: ${stateTitle}.`;

  const metadata: Record<string, unknown> = {
    'source-project': 'finos/traderx',
    'state-id': catalogState.id,
  };
  if (catalogState.track) metadata.track = catalogState.track;
  if (catalogState.status) metadata.status = catalogState.status;
  if (model.inheritsFrom) metadata['inherits-from'] = model.inheritsFrom;
  if (Array.isArray(model.notes) && model.notes.length > 0) {
    const nonEmptyNotes = model.notes.filter((n) => typeof n === 'string' && n.trim().length > 0);
    if (nonEmptyNotes.length > 0) {
      metadata.notes = nonEmptyNotes;
    }
  }

  const calmDoc: Record<string, unknown> = {
    $schema: CALM_13_SCHEMA,
    'unique-id': `traderx-${catalogState.id}`,
    name: `FINOS TraderX — ${stateTitle}`,
    description: stateDesc,
    nodes: calmNodes,
    relationships: calmRelationships,
    metadata,
  };

  const cleanAdrs = adrs.filter((a) => a.trim().length > 0);
  if (cleanAdrs.length > 0) {
    calmDoc.adrs = cleanAdrs;
  }

  return calmDoc;
}

function discoverTraderXAdrsByStateNum(repoDir: string): Map<string, string[]> {
  const adrDir = path.join(repoDir, 'docs', 'adr');
  const byStateNum = new Map<string, string[]>();
  if (!existsSync(adrDir)) return byStateNum;

  const files = readdirSync(adrDir)
    .filter((f) => /\.(?:md|mdx|adoc)$/i.test(f) && !/^index\./i.test(f))
    .sort();

  const pushAdr = (num: string, relPath: string): void => {
    const list = byStateNum.get(num) ?? [];
    if (!list.includes(relPath)) list.push(relPath);
    byStateNum.set(num, list);
  };

  for (const file of files) {
    const rel = `docs/adr/${file}`;
    const explicitStateMatch = file.match(/state-(\d{3})/i);
    if (explicitStateMatch) {
      pushAdr(explicitStateMatch[1], rel);
      continue;
    }
    if (/convergence/i.test(file)) {
      pushAdr('012', rel);
      continue;
    }
    const prefixMatch = file.match(/^(\d{3})-/);
    if (prefixMatch) {
      const prefixNum = Number.parseInt(prefixMatch[1], 10);
      if (prefixNum >= 1 && prefixNum <= 3) {
        pushAdr('001', rel);
      } else {
        pushAdr(prefixMatch[1], rel);
      }
    }
  }

  return byStateNum;
}

interface ParsedSimpleCommit {
  sha: string;
  shortSha: string;
  date: string;
  timestampIso?: string;
  author: string;
  subject: string;
}

function readStateGitCommits(
  repoDir: string,
  catalogState: TraderXCatalogState,
  runGit: GitCommandRunner,
): ParsedSimpleCommit[] {
  const commits: ParsedSimpleCommit[] = [];
  const seenShas = new Set<string>();

  const tryAddLogOutput = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [sha, shortSha, date, author, subject, timestampIso = ''] = trimmed.split('\x1f');
      if (!sha || !shortSha || seenShas.has(sha)) continue;
      seenShas.add(sha);
      commits.push({
        sha: sha.trim(),
        shortSha: shortSha.trim(),
        date: (date || '2026-05-21').trim(),
        timestampIso: timestampIso.trim() || undefined,
        author: (author || 'FINOS TraderX').trim(),
        subject: (subject || catalogState.title).trim(),
      });
    }
  };

  try {
    const specLog = runGit(
      [
        'log',
        '--reverse',
        '--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%cI',
        '--',
        catalogState.featurePack,
      ],
      repoDir,
    );
    tryAddLogOutput(specLog);
  } catch {
    // Non-git directory or shallow clone fallback handled below
  }

  const candidateRefs: string[] = [];
  if (catalogState.publish?.branch) {
    candidateRefs.push(
      `refs/remotes/origin/${catalogState.publish.branch}`,
      `refs/heads/${catalogState.publish.branch}`,
    );
  }
  if (catalogState.publish?.tag) {
    candidateRefs.push(`refs/tags/${catalogState.publish.tag}`);
  }
  for (const ref of candidateRefs) {
    try {
      const branchTip = runGit(
        ['log', '-n', '1', '--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%cI', ref],
        repoDir,
      );
      tryAddLogOutput(branchTip);
      break;
    } catch {
      // Optional published state branch ref not fetched locally
    }
  }

  return commits;
}

export function generateTimelineFromTraderXRepo(
  traderxRepoDir: string,
  options: GenerateTraderXTimelineOptions = {},
): FullGitTimelineResult {
  const resolvedRepo = path.resolve(traderxRepoDir);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`TraderX repository path does not exist: "${traderxRepoDir}"`);
  }

  const catalogPath = path.join(resolvedRepo, 'catalog', 'state-catalog.json');
  if (!existsSync(catalogPath)) {
    throw new Error(
      `TraderX state catalog not found at "${catalogPath}" (expected a clone of https://github.com/finos/traderx).`,
    );
  }

  const rawCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
    states?: TraderXCatalogState[];
  };
  const states = Array.isArray(rawCatalog.states) ? rawCatalog.states : [];
  if (states.length === 0) {
    throw new Error(`No states found in TraderX catalog "${catalogPath}".`);
  }

  const runGit = options.gitRunner ?? defaultGitRunner;
  const adrsByStateNum = discoverTraderXAdrsByStateNum(resolvedRepo);

  const clusters: MomentCluster[] = [];
  const allDeltas: StructuralCommitDelta[] = [];
  let prevCalmDoc: Record<string, unknown> | null = null;
  let skippedTemplateStates = 0;
  let totalCommitRefsScanned = 0;

  for (const catalogState of states) {
    const modelRelPath = path.posix.join(
      catalogState.featurePack.replace(/\\/g, '/'),
      'system',
      'architecture.model.json',
    );
    const modelAbsPath = path.join(resolvedRepo, ...modelRelPath.split('/'));
    if (!existsSync(modelAbsPath)) {
      options.onDebug?.(`Skipping ${catalogState.id}: missing ${modelRelPath}`);
      skippedTemplateStates++;
      continue;
    }

    const model = JSON.parse(readFileSync(modelAbsPath, 'utf-8')) as TraderXArchitectureModel;
    if (isPlaceholderScaffoldModel(model)) {
      options.onDebug?.(`Skipping placeholder scaffold model in ${catalogState.id}.`);
      skippedTemplateStates++;
      continue;
    }

    const stateNumMatch = catalogState.id.match(/^(\d{3})/);
    const stateNum = stateNumMatch ? stateNumMatch[1] : '';
    const stateAdrs = stateNum ? (adrsByStateNum.get(stateNum) ?? []) : [];

    const calmDoc = convertTraderXStateToCalm(model, catalogState, stateAdrs);
    const gitCommits = readStateGitCommits(resolvedRepo, catalogState, runGit);
    totalCommitRefsScanned += Math.max(1, gitCommits.length);

    const delta = computeStructuralDelta(prevCalmDoc, calmDoc);
    const isInitial = prevCalmDoc === null;
    const summaryLine = summarizeCounts(delta.counts, isInitial);

    const effectiveCommits: ParsedSimpleCommit[] =
      gitCommits.length > 0
        ? gitCommits
        : [
            {
              sha: catalogState.id,
              shortSha: stateNum ? `state${stateNum}` : catalogState.id.slice(0, 7),
              date: '2026-05-21',
              author: 'FINOS TraderX',
              subject: `${catalogState.id}: ${catalogState.title}`,
            },
          ];

    const stateCommitDeltas: StructuralCommitDelta[] = effectiveCommits.map((c, idx) => {
      const isLastInState = idx === effectiveCommits.length - 1;
      const snap: GitCommitSnapshot = {
        sha: c.sha,
        shortSha: c.shortSha,
        date: c.date,
        ...(c.timestampIso ? { timestampIso: c.timestampIso } : {}),
        author: c.author,
        subject: c.subject,
        body: '',
        historicalPath: modelRelPath,
        coChangedAdrs: isLastInState ? stateAdrs : [],
        document: calmDoc,
      };
      return {
        commit: snap,
        isInitial: isInitial && idx === 0,
        changeItems: isLastInState ? delta.changeItems : [],
        counts: isLastInState
          ? delta.counts
          : {
              nodesAdded: 0,
              nodesModified: 0,
              nodesRemoved: 0,
              relationshipsAdded: 0,
              relationshipsModified: 0,
              relationshipsRemoved: 0,
              flowsAdded: 0,
              flowsModified: 0,
              flowsRemoved: 0,
              controlsAdded: 0,
              controlsModified: 0,
              controlsRemoved: 0,
              adrsAdded: 0,
              adrsRemoved: 0,
              metadataChanged: 0,
            },
        summaryLine: isLastInState ? summaryLine : c.subject,
      };
    });

    const leadCommit = effectiveCommits[effectiveCommits.length - 1];
    const displayNum = stateNum || String(clusters.length + 1).padStart(3, '0');
    const clusterIdxStart = allDeltas.length;
    allDeltas.push(...stateCommitDeltas);
    const clusterIdxEnd = allDeltas.length - 1;

    clusters.push({
      startIndex: clusterIdxStart,
      endIndex: clusterIdxEnd,
      uniqueId: `state-${catalogState.id}`,
      name: `State ${displayNum}: ${catalogState.title}`,
      description:
        model.description?.trim() || `${catalogState.title} (${summaryLine})`,
      validFrom: leadCommit.date,
      adrs: stateAdrs,
      commits: stateCommitDeltas,
      mergedChangeItems: delta.changeItems,
      snapshotDocument: calmDoc,
    });

    prevCalmDoc = calmDoc;
  }

  if (clusters.length === 0) {
    throw new Error(`No authoritative architecture states found in "${resolvedRepo}".`);
  }

  const digest = buildCommitHistoryDigest(allDeltas, {
    sourceFile: 'finos/traderx (state-catalog.json)',
    totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
    validSnapshotsParsed: clusters.length,
    noiseCommitsFiltered: skippedTemplateStates,
  });

  let writtenDigestPath: string | undefined;
  if (options.emitDigestPath) {
    writtenDigestPath = path.resolve(options.emitDigestPath);
    mkdirSync(path.dirname(writtenDigestPath), { recursive: true });
    writeFileSync(writtenDigestPath, JSON.stringify(digest, null, 2) + '\n', 'utf-8');
  }

  const engine = 'traderx-state-catalog';
  const { timeline, snapshotPaths } = assembleCalmTimeline(clusters, {
    sourceFilePath: 'finos-traderx',
    outputPath: options.outputPath,
    snapshotsDir: options.snapshotsDir,
  });

  timeline.metadata = {
    ...(timeline.metadata ?? {}),
    title: 'Git Architecture Timeline — FINOS TraderX (v2.0 Progressive States + FDC3)',
    description:
      'Extracted directly from upstream finos/traderx catalog/state-catalog.json, specs/*/system/architecture.model.json, docs/adr/*.md, and Git history.',
    'source-repository': 'https://github.com/finos/traderx',
    'clustering-engine': engine,
    'total-commits-scanned': String(totalCommitRefsScanned + skippedTemplateStates),
    'noise-commits-filtered': String(skippedTemplateStates),
    'structural-commits-retained': String(clusters.length),
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
      title: 'CALM Architecture Timelapse — FINOS TraderX (States 001–014 + FDC3)',
      sourceFile: 'finos/traderx',
      defaultView: options.defaultView,
      engine,
      stats: {
        totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
        noiseCommitsFiltered: skippedTemplateStates,
        structuralCommitsRetained: clusters.length,
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
      totalCommitsScanned: totalCommitRefsScanned + skippedTemplateStates,
      validSnapshotsParsed: clusters.length,
      noiseCommitsFiltered: skippedTemplateStates,
      structuralCommitsRetained: clusters.length,
      momentsGenerated: timeline.moments.length,
      clusteringEngine: engine,
    },
  };
}
