// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isCalmPatternDocument } from './calm-diff.js';
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

export function serializeCalmSnapshot(doc: Record<string, unknown>): string {
    return JSON.stringify(doc, null, 2) + '\n';
}

export function computeSnapshotSha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

const GENERIC_CALM_BASENAME_RE =
    /^(?:architecture(?:\.calm|\.arch)?|calm(?:\.architecture|\.arch)?|system(?:\.calm|\.arch)?)\.json$/i;

export function formatCalmSourceDisplay(filePath: string, repoRoot?: string): string {
    const trimmed = filePath.trim();
    if (!trimmed) return 'architecture.json';

    const normalized = trimmed.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    if (!GENERIC_CALM_BASENAME_RE.test(base)) {
        return base;
    }

    if (repoRoot && repoRoot.trim()) {
        const repoBase = path.basename(path.resolve(repoRoot));
        if (repoBase && repoBase !== '/' && repoBase !== '.') {
            return `${repoBase}/${base}`;
        }
    }

    const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.');
    if (
        !normalized.startsWith('/') &&
        !/^[a-zA-Z]:/.test(normalized) &&
        parts.length === 2 &&
        parts[0] !== '..'
    ) {
        return `${parts[0]}/${base}`;
    }

    if (normalized.includes('/') || existsSync(trimmed)) {
        const parentName = path.basename(path.dirname(path.resolve(trimmed)));
        if (parentName && parentName !== '/' && parentName !== '.') {
            return `${parentName}/${base}`;
        }
    }

    return base;
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
        repoRoot?: string;
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
        const isPattern = isCalmPatternDocument(cluster.snapshotDocument);
        const snapshotExt = isPattern ? 'pattern.json' : 'architecture.json';
        const snapshotFileName = `${paddedIdx}-${endCommit.shortSha}-${uniqueId}.${snapshotExt}`;
        const snapshotAbsPath = path.join(resolvedSnapshotsDir, snapshotFileName);
        const serializedSnapshot = serializeCalmSnapshot(cluster.snapshotDocument);
        writeFileSync(snapshotAbsPath, serializedSnapshot);
        const snapshotSha256 = computeSnapshotSha256(serializedSnapshot);
        cluster.snapshotSha256 = snapshotSha256;
        snapshotPaths.push(snapshotAbsPath);

        const relativeArchRef = path
            .relative(refBaseDir, snapshotAbsPath)
            .split(path.sep)
            .join('/');

        const commitShas = cluster.commits.map((c) => c.commit.shortSha).filter((s) => s.trim().length > 0);
        const commitSubjects = cluster.commits
            .map((c) => (c.commit.subject || c.commit.shortSha).trim())
            .filter((s) => s.length > 0);

        const momentMeta: Record<string, unknown> = {
            'snapshot-sha256': snapshotSha256,
        };
        if (commitShas.length > 0) {
            momentMeta.commits = commitShas;
        }
        if (commitSubjects.length > 0) {
            momentMeta['commit-messages'] = commitSubjects;
        }
        if (cluster.commits.length > 0) {
            momentMeta['commit-count'] = cluster.commits.length;
        }
        if (cluster.nodeProvenance && Object.keys(cluster.nodeProvenance).length > 0) {
            momentMeta['node-provenance'] = cluster.nodeProvenance;
        }

        const moment: GeneratedGitMoment = {
            'unique-id': uniqueId,
            'node-type': 'moment',
            name: cluster.name || `Moment ${index + 1}`,
            description: cluster.description || `Architectural state at commit ${endCommit.shortSha}`,
            'valid-from': validFrom,
            details: isPattern
                ? { 'required-pattern': relativeArchRef }
                : { 'detailed-architecture': relativeArchRef },
            ...(Object.keys(momentMeta).length > 0 ? { metadata: momentMeta } : {}),
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
            : formatCalmSourceDisplay(options.sourceFilePath, options.repoRoot);
    const timeline: GeneratedGitTimeline = {
        $schema: CALM_TIMELINE_SCHEMA,
        moments,
        metadata: {
            title: `Git Architecture Timeline — ${sourceDisplay}`,
            description: `Automatically synthesized from Git commit history of ${sourceDisplay}`,
            'source-file': sourceDisplay,
            generator: 'calm-timelapse',
            ...(options.sources && options.sources.length > 1 ? { sources: options.sources } : {}),
        },
    };

    if (moments.length > 0) {
        timeline['current-moment'] = moments[moments.length - 1]['unique-id'];
    }

    return { timeline, snapshotPaths };
}

function collectEmptyPropertyViolations(value: unknown, jsonPath: string, errors: string[]): void {
    if (!value) {
        errors.push(
            `timeline-has-no-empty-properties: '${jsonPath}' must be set to a nonempty, nonzero, non-false value.`,
        );
        return;
    }
    if (Array.isArray(value)) {
        for (let idx = 0; idx < value.length; idx++) {
            collectEmptyPropertyViolations(value[idx], `${jsonPath}/${idx}`, errors);
        }
        return;
    }
    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            collectEmptyPropertyViolations(child, `${jsonPath}/${key}`, errors);
        }
    }
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

    for (const [rootKey, rootVal] of Object.entries(timeline)) {
        collectEmptyPropertyViolations(rootVal, `/${rootKey}`, errors);
    }

    const baseDir = options?.timelineFilePath ? path.dirname(path.resolve(options.timelineFilePath)) : null;
    const ids = new Set<string>();
    let prevTs: number | null = null;
    let currentMomentIndex = -1;

    for (let i = 0; i < timeline.moments.length; i++) {
        const m = timeline.moments[i];
        const rawMoment = m as unknown as Record<string, unknown>;
        if (!m['unique-id']?.trim()) errors.push(`Moment[${i}] is missing unique-id.`);
        if (ids.has(m['unique-id'])) errors.push(`Duplicate moment unique-id '${m['unique-id']}'.`);
        ids.add(m['unique-id']);
        if (timeline['current-moment'] && m['unique-id'] === timeline['current-moment']) {
            currentMomentIndex = i;
        }

        if (m['node-type'] !== 'moment') errors.push(`Moment '${m['unique-id']}' node-type must be 'moment'.`);
        if (!m.name?.trim()) errors.push(`Moment '${m['unique-id']}' has empty name.`);
        if (!m.description?.trim()) errors.push(`Moment '${m['unique-id']}' has empty description.`);
        if ('interfaces' in rawMoment) {
            errors.push(`Moment '${m['unique-id']}' must not define 'interfaces'.`);
        }

        if (!isPlainObject(m.details)) {
            errors.push(`Moment '${m['unique-id']}' is missing details object.`);
        } else {
            for (const key of Object.keys(m.details)) {
                if (key !== 'detailed-architecture' && key !== 'required-pattern') {
                    errors.push(`Moment '${m['unique-id']}' has unsupported details key '${key}'.`);
                }
            }
            const archRef = (m.details['detailed-architecture'] ?? m.details['required-pattern'])?.trim();
            if (!archRef) {
                errors.push(
                    `Moment '${m['unique-id']}' must define details.detailed-architecture or details.required-pattern.`,
                );
            } else {
                const rawExpectedHash = isPlainObject(m.metadata)
                    ? m.metadata['snapshot-sha256']
                    : undefined;
                if (rawExpectedHash !== undefined) {
                    if (
                        typeof rawExpectedHash !== 'string' ||
                        !/^[a-f0-9]{64}$/i.test(rawExpectedHash.trim())
                    ) {
                        errors.push(
                            `Moment '${m['unique-id']}' metadata.snapshot-sha256 must be a 64-character hex SHA-256 digest.`,
                        );
                    }
                }
                if (baseDir && !/^https?:\/\//i.test(archRef)) {
                    const resolvedSnapshotPath = path.resolve(baseDir, archRef);
                    if (!existsSync(resolvedSnapshotPath)) {
                        errors.push(`Moment '${m['unique-id']}' referenced snapshot does not exist: ${archRef}`);
                    } else if (
                        typeof rawExpectedHash === 'string' &&
                        /^[a-f0-9]{64}$/i.test(rawExpectedHash.trim())
                    ) {
                        const actualHash = computeSnapshotSha256(readFileSync(resolvedSnapshotPath));
                        if (actualHash !== rawExpectedHash.trim().toLowerCase()) {
                            errors.push(
                                `Moment '${m['unique-id']}' snapshot SHA-256 mismatch for ${archRef}: expected ${rawExpectedHash.trim().toLowerCase()}, got ${actualHash}.`,
                            );
                        }
                    }
                }
            }
        }

        if (m['valid-from']) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(m['valid-from'])) {
                errors.push(`Moment '${m['unique-id']}' has invalid valid-from date '${m['valid-from']}'.`);
            } else {
                const ts = Date.parse(m['valid-from']);
                if (Number.isNaN(ts)) {
                    errors.push(`Moment '${m['unique-id']}' has unparseable valid-from date '${m['valid-from']}'.`);
                } else {
                    if (prevTs !== null && ts < prevTs) {
                        errors.push(
                            `Moment '${m['unique-id']}' valid-from '${m['valid-from']}' is out of chronological order.`,
                        );
                    }
                    prevTs = ts;
                }
            }
        }
    }

    if (!timeline['current-moment'] || !ids.has(timeline['current-moment'])) {
        errors.push('current-moment must reference an existing moment unique-id.');
    } else if (currentMomentIndex >= 0) {
        for (let i = currentMomentIndex + 1; i < timeline.moments.length; i++) {
            const futureMoment = timeline.moments[i];
            if (futureMoment['valid-from']) {
                errors.push(
                    `Moment '${futureMoment['unique-id']}' appears after current-moment '${timeline['current-moment']}' and must not define valid-from.`,
                );
            }
        }
    }

    return errors;
}
