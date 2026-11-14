// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicClusterCommits } from '../src/cluster.js';
import { filterStructuralCommits } from '../src/git-history.js';
import {
    assembleCalmTimeline,
    CALM_ALLOWED_PROTOCOLS,
    CALM_TIMELINE_SCHEMA,
    validateCalmArchitectureSnapshot,
    validateTimelineStructure,
} from '../src/timeline-emitter.js';
import type { GitCommitSnapshot } from '../src/types.js';

let tempDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-tl-emit-'));
});

afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function snap(sha: string, date: string, subject: string, doc: Record<string, unknown>): GitCommitSnapshot {
    return {
        sha,
        shortSha: sha,
        date,
        author: 'Architect',
        subject,
        body: '',
        historicalPath: 'arch.json',
        coChangedAdrs: [],
        document: doc,
    };
}

describe('assembleCalmTimeline and validateTimelineStructure', () => {
    it('clamps out-of-order valid-from dates, disambiguates duplicate IDs, and passes validation', () => {
        const doc1 = { nodes: [{ 'unique-id': 'a', 'node-type': 'service', name: 'A' }], relationships: [] };
        const doc2 = {
            nodes: [
                { 'unique-id': 'a', 'node-type': 'service', name: 'A' },
                { 'unique-id': 'b', 'node-type': 'database', name: 'B' },
            ],
            relationships: [],
        };

        const { deltas } = filterStructuralCommits([
            snap('c1', '2026-04-10', 'feat: baseline', doc1),
            snap('c2', '2026-04-02', 'feat: add db', doc2),
        ]);
        const clusters = deterministicClusterCommits(deltas);
        clusters[1].uniqueId = clusters[0].uniqueId;

        const outPath = path.join(tempDir, 'out', 'app.timeline.json');
        const { timeline, snapshotPaths } = assembleCalmTimeline(clusters, {
            sourceFilePath: 'arch.json',
            outputPath: outPath,
        });

        expect(timeline.$schema).toBe(CALM_TIMELINE_SCHEMA);
        expect(timeline.moments[0]['unique-id']).not.toBe(timeline.moments[1]['unique-id']);
        expect(timeline.moments[1]['valid-from']).toBe('2026-04-10');
        expect(snapshotPaths.every((p) => fs.existsSync(p))).toBe(true);
        expect(validateTimelineStructure(timeline)).toEqual([]);
        expect(validateTimelineStructure(timeline, { timelineFilePath: outPath })).toEqual([]);
    });

    it('populates moment.metadata with commits, commit-messages, and commit-count', () => {
        const doc1 = {
            nodes: [{ 'unique-id': 'api', 'node-type': 'service', name: 'API', description: 'API service' }],
            relationships: [],
        };
        const doc2 = {
            nodes: [
                { 'unique-id': 'api', 'node-type': 'service', name: 'API', description: 'API service' },
                { 'unique-id': 'db', 'node-type': 'database', name: 'DB', description: 'Primary DB' },
            ],
            relationships: [],
        };
        const doc3 = {
            ...doc2,
            relationships: [
                {
                    'unique-id': 'api-db',
                    description: 'Connects to DB',
                    protocol: 'JDBC',
                    'relationship-type': { connects: { source: { node: 'api' }, destination: { node: 'db' } } },
                },
            ],
        };

        const { deltas } = filterStructuralCommits([
            snap('111aaaa', '2026-04-01', 'feat: initial api', doc1),
            snap('222bbbb', '2026-04-02', 'feat: add database', doc2),
            snap('333cccc', '2026-04-03', 'feat: wire api to database', doc3),
        ]);
        const clusters = deterministicClusterCommits(deltas);
        const multiCommitCluster = {
            ...clusters[1],
            endIndex: clusters[clusters.length - 1].endIndex,
            commits: deltas.slice(1),
            snapshotDocument: doc3,
        };

        const outPath = path.join(tempDir, 'out', 'meta.timeline.json');
        const { timeline } = assembleCalmTimeline([clusters[0], multiCommitCluster], {
            sourceFilePath: 'arch.json',
            outputPath: outPath,
        });

        expect(timeline.moments[0].metadata).toEqual({
            commits: ['111aaaa'],
            'commit-messages': ['feat: initial api'],
            'commit-count': 1,
        });
        expect(timeline.moments[1].metadata).toEqual({
            commits: ['222bbbb', '333cccc'],
            'commit-messages': ['feat: add database', 'feat: wire api to database'],
            'commit-count': 2,
        });
    });

    it('detects missing snapshot files when timelineFilePath is provided', () => {
        const doc = {
            nodes: [{ 'unique-id': 'a', 'node-type': 'service', name: 'A', description: 'Service A' }],
            relationships: [],
        };
        const { deltas } = filterStructuralCommits([snap('c1', '2026-04-01', 'feat: baseline', doc)]);
        const clusters = deterministicClusterCommits(deltas);

        const outPath = path.join(tempDir, 'out', 'check.timeline.json');
        const { timeline, snapshotPaths } = assembleCalmTimeline(clusters, {
            sourceFilePath: 'arch.json',
            outputPath: outPath,
        });

        expect(validateTimelineStructure(timeline, { timelineFilePath: outPath })).toEqual([]);

        fs.unlinkSync(snapshotPaths[0]);
        const errors = validateTimelineStructure(timeline, { timelineFilePath: outPath });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('referenced snapshot does not exist');
        expect(validateTimelineStructure(timeline)).toEqual([]);
    });
});

describe('validateCalmArchitectureSnapshot', () => {
    it('accepts valid CALM 1.3 nodes, protocols, and controls (config or config-url)', () => {
        expect(CALM_ALLOWED_PROTOCOLS).toContain('HTTP');
        expect(CALM_ALLOWED_PROTOCOLS).toContain('mTLS');

        const validDoc: Record<string, unknown> = {
            nodes: [
                {
                    'unique-id': 'svc-a',
                    'node-type': 'service',
                    name: 'Service A',
                    description: 'Handles requests',
                },
                {
                    'unique-id': 'db-a',
                    'node-type': 'database',
                    name: 'Database A',
                    description: 'Stores state',
                },
            ],
            relationships: [
                {
                    'unique-id': 'rel-http',
                    'relationship-type': {
                        connects: { source: { node: 'svc-a' }, destination: { node: 'db-a' } },
                    },
                    protocol: 'HTTPS',
                },
                {
                    'unique-id': 'rel-local',
                    'relationship-type': {
                        connects: { source: { node: 'svc-a' }, destination: { node: 'db-a' } },
                    },
                },
            ],
            controls: {
                'tls-everywhere': {
                    description: 'Enforce TLS for external calls',
                    requirements: [
                        {
                            'requirement-url': 'https://calm.finos.org/release/1.3/meta/control-requirement.json',
                            config: { 'control-id': 'tls-1', name: 'TLS', description: 'Require TLS' },
                        },
                        {
                            'requirement-url': 'https://example.org/req.json',
                            'config-url': 'https://example.org/config.json',
                        },
                    ],
                },
            },
        };

        expect(validateCalmArchitectureSnapshot(validDoc)).toEqual([]);
    });

    it('reports invalid nodes, protocols, relationships, and controls with optional label', () => {
        const invalidDoc: Record<string, unknown> = {
            nodes: [
                {
                    'unique-id': '',
                    'node-type': 'service',
                    name: '   ',
                    description: '',
                },
                {
                    'unique-id': 'n2',
                    'node-type': '',
                    name: 'Valid Name',
                    description: 'Valid desc',
                },
            ],
            relationships: [
                {
                    'unique-id': 'r1',
                    protocol: 'Git CLI',
                    'relationship-type': 'connects',
                },
                {
                    'unique-id': '',
                    protocol: 'HTTP',
                    'relationship-type': { connects: {} },
                },
            ],
            controls: {
                'bad-empty': {
                    description: '',
                    requirements: [],
                },
                'bad-req': {
                    description: 'Has broken requirement',
                    requirements: [
                        {
                            'requirement-url': '',
                        },
                    ],
                },
            },
        };

        const errors = validateCalmArchitectureSnapshot(invalidDoc, 'snapshot-1');
        expect(errors.every((e) => e.startsWith('snapshot-1: '))).toBe(true);
        expect(errors.some((e) => e.includes('unique-id'))).toBe(true);
        expect(errors.some((e) => e.includes('node-type'))).toBe(true);
        expect(errors.some((e) => e.includes('name'))).toBe(true);
        expect(errors.some((e) => e.includes('description'))).toBe(true);
        expect(errors.some((e) => e.includes("invalid protocol 'Git CLI'"))).toBe(true);
        expect(errors.some((e) => e.includes('relationship-type'))).toBe(true);
        expect(errors.some((e) => e.includes("control 'bad-empty'"))).toBe(true);
        expect(errors.some((e) => e.includes('requirement-url'))).toBe(true);
        expect(errors.some((e) => e.includes('config or config-url'))).toBe(true);
    });

    it('validates repository architecture.calm.json with zero errors', () => {
        const archPath = path.resolve(process.cwd(), 'architecture.calm.json');
        const archDoc = JSON.parse(fs.readFileSync(archPath, 'utf-8')) as Record<string, unknown>;
        expect(validateCalmArchitectureSnapshot(archDoc, 'architecture.calm.json')).toEqual([]);
        expect(archDoc.controls).toBeDefined();
    });
});
