// SPDX-License-Identifier: Apache-2.0

export type ClusteringEngine = 'deterministic' | 'clusters-file' | 'traderx-state-catalog';

export type GitCommandRunner = (args: string[], cwd: string) => string;

export interface FederatedSourceDescriptor {
    sourceId: string;
    sourceLabel: string;
    repoName: string;
    fileName: string;
    relPath: string;
}

export interface FederatedNodeProvenance {
    primarySourceId: string;
    primarySourceLabel: string;
    sourceIds: string[];
    sourceLabels: string[];
    mergedViaDetailedArch?: boolean;
    resolvedFromParentId?: string;
}

export interface GitCommitSnapshot {
    sha: string;
    shortSha: string;
    date: string;
    timestampIso?: string;
    author: string;
    subject: string;
    body: string;
    historicalPath: string;
    coChangedAdrs: string[];
    document: Record<string, unknown>;
    sourceId?: string;
    sourceLabel?: string;
    repoName?: string;
    nodeProvenance?: Record<string, FederatedNodeProvenance>;
}

export interface DeltaChangeItem {
    kind: 'add' | 'mod' | 'del';
    category: 'node' | 'relationship' | 'control' | 'flow' | 'adr' | 'metadata';
    id: string;
    text: string;
}

export interface DeltaCounts {
    nodesAdded: number;
    nodesRemoved: number;
    nodesModified: number;
    relationshipsAdded: number;
    relationshipsRemoved: number;
    relationshipsModified: number;
    controlsAdded: number;
    controlsRemoved: number;
    controlsModified: number;
    flowsAdded: number;
    flowsRemoved: number;
    flowsModified: number;
    adrsAdded: number;
    adrsRemoved: number;
    metadataChanged: number;
}

export interface StructuralDeltaResult {
    changeItems: DeltaChangeItem[];
    counts: DeltaCounts;
    hasStructuralChange: boolean;
    hasMetadataChange: boolean;
}

export interface StructuralCommitDelta {
    commit: GitCommitSnapshot;
    isInitial: boolean;
    changeItems: DeltaChangeItem[];
    counts: DeltaCounts;
    summaryLine: string;
}

export interface ClusterSpec {
    startIndex: number;
    endIndex: number;
    uniqueId?: string;
    name?: string;
    description?: string;
}

export interface CommitDigestEntry {
    index: number;
    sha: string;
    shortSha: string;
    date: string;
    author: string;
    subject: string;
    summaryLine: string;
    changes: string[];
    coChangedAdrs: string[];
    sourceId?: string;
    sourceLabel?: string;
    repoName?: string;
}

export interface CommitHistoryDigest {
    schemaVersion: '1.0';
    sourceFile: string;
    sources?: FederatedSourceDescriptor[];
    latestCommitDate: string;
    stats: {
        totalCommitsScanned: number;
        validSnapshotsParsed: number;
        noiseCommitsFiltered: number;
        structuralCommitsRetained: number;
    };
    instructions: string[];
    expectedClusterSchema: Record<string, unknown>;
    commits: CommitDigestEntry[];
}

export interface MomentCluster {
    startIndex: number;
    endIndex: number;
    uniqueId: string;
    name: string;
    description: string;
    validFrom: string;
    adrs: string[];
    commits: StructuralCommitDelta[];
    mergedChangeItems: DeltaChangeItem[];
    snapshotDocument: Record<string, unknown>;
    nodeProvenance?: Record<string, FederatedNodeProvenance>;
}

export interface GeneratedGitMoment {
    'unique-id': string;
    'node-type': 'moment';
    name: string;
    description: string;
    'valid-from': string;
    details: {
        'detailed-architecture'?: string;
        'required-pattern'?: string;
    };
    adrs?: string[];
    metadata?: Record<string, unknown>;
}

export interface GeneratedGitTimeline {
    $schema: string;
    'current-moment'?: string;
    moments: GeneratedGitMoment[];
    metadata?: Record<string, unknown>;
}

export interface GitTimelineStats {
    totalCommitsScanned: number;
    validSnapshotsParsed: number;
    noiseCommitsFiltered: number;
    structuralCommitsRetained: number;
    momentsGenerated: number;
    clusteringEngine: ClusteringEngine;
    sourcesTracked?: number;
    repositoriesTracked?: number;
}

export interface GitTimelineResult {
    timeline: GeneratedGitTimeline;
    clusters: MomentCluster[];
    snapshotPaths: string[];
    stats: GitTimelineStats;
}
