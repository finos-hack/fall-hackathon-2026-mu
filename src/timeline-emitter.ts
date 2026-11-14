// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
    FederatedSourceDescriptor,
    GeneratedGitMoment,
    GeneratedGitTimeline,
    MomentCluster,
} from './types.js';

export const CALM_TIMELINE_SCHEMA = 'https://calm.finos.org/release/1.3/meta/calm-timeline.json';

export const CALM_ALLOWED_PROTOCOLS = [
    'HTTP',
    'HTTPS',
    'FTP',
    'SFTP',
    'JDBC',
    'WebSocket',
    'SocketIO',
    'LDAP',
    'AMQP',
    'TLS',
    'mTLS',
    'TCP',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function validateCalmArchitectureSnapshot(doc: Record<string, unknown>, label?: string): string[] {
    const errors: string[] = [];
    const prefix = label ? `${label}: ` : '';

    if (Array.isArray(doc.nodes)) {
        for (let i = 0; i < doc.nodes.length; i++) {
            const node = doc.nodes[i];
            if (!isPlainObject(node)) {
                errors.push(`${prefix}nodes[${i}] must be an object.`);
                continue;
            }
            const nodeLabel = isNonEmptyString(node['unique-id']) ? `'${node['unique-id']}'` : `[${i}]`;
            if (!isNonEmptyString(node['unique-id'])) {
                errors.push(`${prefix}node[${i}] is missing non-empty unique-id.`);
            }
            if (!isNonEmptyString(node['node-type'])) {
                errors.push(`${prefix}node ${nodeLabel} is missing non-empty node-type.`);
            }
            if (!isNonEmptyString(node.name)) {
                errors.push(`${prefix}node ${nodeLabel} is missing non-empty name.`);
            }
            if (!isNonEmptyString(node.description)) {
                errors.push(`${prefix}node ${nodeLabel} is missing non-empty description.`);
            }
        }
    }

    if (Array.isArray(doc.relationships)) {
        const allowedProtocols: readonly string[] = CALM_ALLOWED_PROTOCOLS;
        for (let i = 0; i < doc.relationships.length; i++) {
            const rel = doc.relationships[i];
            if (!isPlainObject(rel)) {
                errors.push(`${prefix}relationships[${i}] must be an object.`);
                continue;
            }
            const relLabel = isNonEmptyString(rel['unique-id']) ? `'${rel['unique-id']}'` : `[${i}]`;
            if (!isNonEmptyString(rel['unique-id'])) {
                errors.push(`${prefix}relationship[${i}] is missing non-empty unique-id.`);
            }
            if (!isPlainObject(rel['relationship-type'])) {
                errors.push(`${prefix}relationship ${relLabel} must have an object relationship-type.`);
            }
            if (rel.protocol !== undefined) {
                if (typeof rel.protocol !== 'string' || !allowedProtocols.includes(rel.protocol)) {
                    errors.push(
                        `${prefix}relationship ${relLabel} has invalid protocol '${String(rel.protocol)}'. Expected one of: ${CALM_ALLOWED_PROTOCOLS.join(', ')}.`,
                    );
                }
            }
        }
    }

    if (isPlainObject(doc.controls)) {
        for (const [controlId, controlValue] of Object.entries(doc.controls)) {
            if (!isPlainObject(controlValue)) {
                errors.push(`${prefix}control '${controlId}' must be an object.`);
                continue;
            }
            if (!isNonEmptyString(controlValue.description)) {
                errors.push(`${prefix}control '${controlId}' is missing non-empty description.`);
            }
            if (!Array.isArray(controlValue.requirements) || controlValue.requirements.length === 0) {
                errors.push(`${prefix}control '${controlId}' must have a non-empty requirements array.`);
                continue;
            }
            for (let j = 0; j < controlValue.requirements.length; j++) {
                const req = controlValue.requirements[j];
                if (!isPlainObject(req)) {
                    errors.push(`${prefix}control '${controlId}' requirements[${j}] must be an object.`);
                    continue;
                }
                if (!isNonEmptyString(req['requirement-url'])) {
                    errors.push(
                        `${prefix}control '${controlId}' requirements[${j}] is missing non-empty requirement-url.`,
                    );
                }
                const hasConfig = isPlainObject(req.config);
                const hasConfigUrl = isNonEmptyString(req['config-url']);
                if (!hasConfig && !hasConfigUrl) {
                    errors.push(
                        `${prefix}control '${controlId}' requirements[${j}] must specify config or config-url.`,
                    );
                }
            }
        }
    }

    return errors;
}

export function assembleCalmTimeline(
    clusters: MomentCluster[],
    options: {
        sourceFilePath: string;
        outputPath?: string;
        snapshotsDir?: string;
        sources?: FederatedSourceDescriptor[];
    },
): { timeline: GeneratedGitTimeline; snapshotPaths: string[] } {
    const refBaseDir = options.outputPath ? path.dirname(path.resolve(options.outputPath)) : process.cwd();
    const resolvedSnapshotsDir = options.snapshotsDir
        ? path.resolve(options.snapshotsDir)
        : path.join(refBaseDir, 'snapshots');

    mkdirSync(resolvedSnapshotsDir, { recursive: true });

    const seenIds = new Set<string>();
    const snapshotPaths: string[] = [];
    let lastValidFrom: string | null = null;

    const moments: GeneratedGitMoment[] = clusters.map((cluster, index) => {
        const baseId = cluster.uniqueId || `moment-${index + 1}`;
        let uniqueId = baseId;
        let suffix = 1;
        while (seenIds.has(uniqueId)) {
            uniqueId = `${baseId}-${suffix++}`;
        }
        seenIds.add(uniqueId);
        cluster.uniqueId = uniqueId;

        let validFrom = cluster.validFrom;
        if (lastValidFrom && Date.parse(validFrom) < Date.parse(lastValidFrom)) {
            validFrom = lastValidFrom;
        }
        lastValidFrom = validFrom;
        cluster.validFrom = validFrom;

        const endCommit = cluster.commits[cluster.commits.length - 1].commit;
        const paddedIdx = String(index + 1).padStart(2, '0');
        const snapshotFileName = `${paddedIdx}-${endCommit.shortSha}-${uniqueId}.architecture.json`;
        const snapshotAbsPath = path.join(resolvedSnapshotsDir, snapshotFileName);
        writeFileSync(snapshotAbsPath, JSON.stringify(cluster.snapshotDocument, null, 2) + '\n');
        snapshotPaths.push(snapshotAbsPath);

        const relativeArchRef = path
            .relative(refBaseDir, snapshotAbsPath)
            .split(path.sep)
            .join('/');

        const moment: GeneratedGitMoment = {
            'unique-id': uniqueId,
            'node-type': 'moment',
            name: cluster.name || `Moment ${index + 1}`,
            description: cluster.description || `Architectural state at commit ${endCommit.shortSha}`,
            'valid-from': validFrom,
            details: {
                'detailed-architecture': relativeArchRef,
            },
            metadata: {
                commits: cluster.commits.map((c) => c.commit.shortSha),
                'commit-messages': cluster.commits.map((c) => c.commit.subject),
                'commit-count': cluster.commits.length,
                ...(cluster.nodeProvenance ? { 'node-provenance': cluster.nodeProvenance } : {}),
            },
        };

        const nonEmptyAdrs = cluster.adrs.filter((a) => a.trim().length > 0);
        if (nonEmptyAdrs.length > 0) {
            moment.adrs = nonEmptyAdrs;
        }

        return moment;
    });

    const sourceDisplay =
        options.sources && options.sources.length > 1
            ? options.sources.map((s) => s.sourceLabel).join(' + ')
            : path.basename(options.sourceFilePath);
    const timeline: GeneratedGitTimeline = {
        $schema: CALM_TIMELINE_SCHEMA,
        moments,
        metadata: {
            title: `Git Architecture Timeline — ${sourceDisplay}`,
            description: `Automatically synthesized from Git commit history of ${sourceDisplay}`,
            generator: 'calm-timelapse',
            ...(options.sources && options.sources.length > 1 ? { sources: options.sources } : {}),
        },
    };

    if (moments.length > 0) {
        timeline['current-moment'] = moments[moments.length - 1]['unique-id'];
    }

    return { timeline, snapshotPaths };
}

export function validateTimelineStructure(
    timeline: GeneratedGitTimeline,
    options?: { timelineFilePath?: string },
): string[] {
    const errors: string[] = [];
    if (!timeline.$schema) {
        errors.push('Missing $schema property.');
    }
    if (!Array.isArray(timeline.moments) || timeline.moments.length === 0) {
        errors.push('Timeline must contain at least one moment.');
        return errors;
    }

    const baseDir = options?.timelineFilePath ? path.dirname(path.resolve(options.timelineFilePath)) : null;
    const ids = new Set<string>();
    let prevTs: number | null = null;

    for (let i = 0; i < timeline.moments.length; i++) {
        const m = timeline.moments[i];
        if (!m['unique-id']?.trim()) errors.push(`Moment[${i}] is missing unique-id.`);
        if (ids.has(m['unique-id'])) errors.push(`Duplicate moment unique-id '${m['unique-id']}'.`);
        ids.add(m['unique-id']);

        if (m['node-type'] !== 'moment') errors.push(`Moment '${m['unique-id']}' node-type must be 'moment'.`);
        if (!m.name?.trim()) errors.push(`Moment '${m['unique-id']}' has empty name.`);
        if (!m.description?.trim()) errors.push(`Moment '${m['unique-id']}' has empty description.`);
        const archRef = m.details?.['detailed-architecture']?.trim();
        if (!archRef) {
            errors.push(`Moment '${m['unique-id']}' is missing details.detailed-architecture.`);
        } else if (baseDir && !/^https?:\/\//i.test(archRef)) {
            const resolvedSnapshotPath = path.resolve(baseDir, archRef);
            if (!existsSync(resolvedSnapshotPath)) {
                errors.push(`Moment '${m['unique-id']}' referenced snapshot does not exist: ${archRef}`);
            }
        }
        if (m['valid-from']) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(m['valid-from'])) {
                errors.push(`Moment '${m['unique-id']}' has invalid valid-from date '${m['valid-from']}'.`);
            } else {
                const ts = Date.parse(m['valid-from']);
                if (prevTs !== null && ts < prevTs) {
                    errors.push(
                        `Moment '${m['unique-id']}' valid-from '${m['valid-from']}' is out of chronological order.`,
                    );
                }
                prevTs = ts;
            }
        }
    }

    if (!timeline['current-moment'] || !ids.has(timeline['current-moment'])) {
        errors.push('current-moment must reference an existing moment unique-id.');
    }

    return errors;
}
