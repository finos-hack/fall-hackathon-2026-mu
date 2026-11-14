// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
    applyClusterSpecs,
    buildCommitHistoryDigest,
    clusterCommitsIntoMoments,
    deterministicClusterCommits,
    validateClusterSpecs,
} from '../src/cluster.js';
import { filterStructuralCommits } from '../src/git-history.js';
import type { GitCommitSnapshot } from '../src/types.js';

function makeSnapshot(
    overrides: Partial<GitCommitSnapshot> & { document: Record<string, unknown> },
): GitCommitSnapshot {
    return {
        sha: '1111',
        shortSha: '1111',
        date: '2026-01-10',
        author: 'Architect',
        subject: 'feat: update',
        body: '',
        historicalPath: 'arch.json',
        coChangedAdrs: [],
        ...overrides,
    };
}

describe('deterministicClusterCommits, digest generation, and cluster specs', () => {
    it('groups same-day fixups while keeping major milestones separate', () => {
        const base = {
            nodes: [{ 'unique-id': 'svc', 'node-type': 'service', name: 'Svc', description: 'v1' }],
            relationships: [],
        };
        const mod1 = {
            nodes: [{ 'unique-id': 'svc', 'node-type': 'service', name: 'Svc', description: 'v2' }],
            relationships: [],
        };
        const mod2 = {
            nodes: [{ 'unique-id': 'svc', 'node-type': 'service', name: 'Svc', description: 'v3' }],
            relationships: [],
        };
        const added = {
            nodes: [
                { 'unique-id': 'svc', 'node-type': 'service', name: 'Svc', description: 'v3' },
                { 'unique-id': 'db', 'node-type': 'database', name: 'DB' },
            ],
            relationships: [],
        };

        const { deltas } = filterStructuralCommits([
            makeSnapshot({ sha: 'c1', shortSha: 'c1', date: '2026-02-01', subject: 'feat: init', document: base }),
            makeSnapshot({ sha: 'c2', shortSha: 'c2', date: '2026-02-05', subject: 'fix: desc', document: mod1 }),
            makeSnapshot({ sha: 'c3', shortSha: 'c3', date: '2026-02-05', subject: 'chore: polish', document: mod2 }),
            makeSnapshot({ sha: 'c4', shortSha: 'c4', date: '2026-02-05', subject: 'feat: add db', document: added }),
        ]);

        const clusters = deterministicClusterCommits(deltas);
        expect(clusters).toHaveLength(3);
        expect(clusters[1].commits.map((c) => c.commit.shortSha)).toEqual(['c2', 'c3']);
    });

    it('validates contiguous cluster specs in array or wrapper formats and rejects gaps or overlaps', () => {
        const validArray = [{ startIndex: 0, endIndex: 1, uniqueId: 'init', name: 'Init', description: 'Desc' }];
        expect(validateClusterSpecs(validArray, 2)).toHaveLength(1);
        expect(validateClusterSpecs({ clusters: validArray }, 2)).toHaveLength(1);
        expect(validateClusterSpecs({ moments: validArray }, 2)).toHaveLength(1);

        expect(validateClusterSpecs([{ startIndex: 0, endIndex: 0 }], 2)).toBeNull();
        expect(
            validateClusterSpecs(
                [
                    { startIndex: 0, endIndex: 0 },
                    { startIndex: 2, endIndex: 2 },
                ],
                3,
            ),
        ).toBeNull();
        expect(
            validateClusterSpecs(
                [
                    { startIndex: 0, endIndex: 1 },
                    { startIndex: 1, endIndex: 2 },
                ],
                3,
            ),
        ).toBeNull();
        expect(validateClusterSpecs([], 2)).toBeNull();
        expect(validateClusterSpecs('not-json', 2)).toBeNull();
    });

    it('builds a deterministic commit history digest and applies external cluster specs cleanly', () => {
        const { deltas, noiseCommitsFiltered } = filterStructuralCommits([
            makeSnapshot({
                sha: 's1fullsha',
                shortSha: 's1',
                date: '2026-01-01',
                author: 'Alice',
                subject: 'feat: add service A',
                document: { nodes: [{ 'unique-id': 'a', 'node-type': 'service', name: 'A' }], relationships: [] },
            }),
            makeSnapshot({
                sha: 's2fullsha',
                shortSha: 's2',
                date: '2026-01-04',
                author: 'Bob',
                subject: 'feat: attach database B',
                coChangedAdrs: ['adrs/001-storage.md'],
                document: {
                    nodes: [
                        { 'unique-id': 'a', 'node-type': 'service', name: 'A' },
                        { 'unique-id': 'b', 'node-type': 'database', name: 'B' },
                    ],
                    relationships: [],
                },
            }),
        ]);

        const digest = buildCommitHistoryDigest(deltas, {
            sourceFile: 'arch.calm.json',
            totalCommitsScanned: 3,
            validSnapshotsParsed: 3,
            noiseCommitsFiltered: 1,
        });

        expect(digest.schemaVersion).toBe('1.0');
        expect(digest.sourceFile).toBe('arch.calm.json');
        expect(digest.latestCommitDate).toBe('2026-01-04');
        expect(digest.stats).toEqual({
            totalCommitsScanned: 3,
            validSnapshotsParsed: 3,
            noiseCommitsFiltered: 1,
            structuralCommitsRetained: 2,
        });
        expect(digest.instructions.length).toBeGreaterThanOrEqual(5);
        expect(digest.commits).toHaveLength(2);
        expect(digest.commits[0]).toMatchObject({
            index: 0,
            sha: 's1fullsha',
            shortSha: 's1',
            date: '2026-01-01',
            author: 'Alice',
            subject: 'feat: add service A',
        });
        expect(digest.commits[1].coChangedAdrs).toEqual(['adrs/001-storage.md']);
        expect(noiseCommitsFiltered).toBe(0);

        const detRes = clusterCommitsIntoMoments(deltas);
        expect(detRes.engine).toBe('deterministic');
        expect(detRes.clusters).toHaveLength(2);

        const specRes = clusterCommitsIntoMoments(deltas, {
            clusterSpecs: [
                {
                    startIndex: 0,
                    endIndex: 1,
                    uniqueId: 'core-foundation',
                    name: 'Core Service and Persistence Layer',
                    description: 'Establishes service A and attaches database B under ADR-001.',
                },
            ],
        });
        expect(specRes.engine).toBe('clusters-file');
        expect(specRes.clusters).toHaveLength(1);
        expect(specRes.clusters[0].uniqueId).toBe('core-foundation');
        expect(specRes.clusters[0].name).toBe('Core Service and Persistence Layer');
        expect(specRes.clusters[0].adrs).toEqual(['adrs/001-storage.md']);

        const partialSpec = applyClusterSpecs(deltas, [{ startIndex: 0, endIndex: 1, name: 'Unified Foundation' }]);
        expect(partialSpec[0].description).toContain('Establishes the initial architecture baseline');

        expect(() => applyClusterSpecs(deltas, [{ startIndex: 0, endIndex: 0 }])).toThrow(
            /covering commit indices 0\.\.1 contiguously/,
        );
    });

    it('strips leading 1-3 digit step numbers after conventional-commit prefixes', () => {
        const doc1 = { nodes: [{ 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' }], relationships: [] };
        const doc2 = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' },
                { 'unique-id': 'idp', 'node-type': 'service', name: 'OIDC IdP' },
            ],
            relationships: [],
        };
        const doc3 = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' },
                { 'unique-id': 'idp', 'node-type': 'service', name: 'OIDC IdP' },
                { 'unique-id': 'vault', 'node-type': 'service', name: 'Secrets Vault' },
            ],
            relationships: [],
        };

        const { deltas } = filterStructuralCommits([
            makeSnapshot({
                sha: 'a1',
                shortSha: 'a1',
                date: '2026-01-01',
                subject: 'feat: 01 initial gateway',
                document: doc1,
            }),
            makeSnapshot({
                sha: 'a2',
                shortSha: 'a2',
                date: '2026-01-10',
                subject: 'feat: 02 add OIDC SSO',
                document: doc2,
            }),
            makeSnapshot({
                sha: 'a3',
                shortSha: 'a3',
                date: '2026-01-20',
                subject: 'feat(sec): 03 - add vault (#19)',
                document: doc3,
            }),
        ]);

        const clusters = deterministicClusterCommits(deltas);
        expect(clusters).toHaveLength(3);
        expect(clusters[0].name).toBe('Initial Architecture: Initial gateway');
        expect(clusters[0].uniqueId).toBe('2026-01-01-initial-architecture-initial-gateway');
        expect(clusters[1].name).toBe('Add OIDC SSO');
        expect(clusters[1].uniqueId).toBe('2026-01-10-add-oidc-sso');
        expect(clusters[2].name).toBe('Add vault');
        expect(clusters[2].uniqueId).toBe('2026-01-20-add-vault');
    });

    it('clusters follow-ups, rel-only commits within 14d, overlapping nodes within 5d, and caps at 5 commits', () => {
        const docInit = {
            nodes: [{ 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' }],
            relationships: [],
        };
        const docInitFix = {
            nodes: [{ 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway', description: 'Edge GW' }],
            relationships: [],
        };
        const docAuth = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway', description: 'Edge GW' },
                { 'unique-id': 'auth', 'node-type': 'service', name: 'Auth Service' },
            ],
            relationships: [],
        };
        const docWireAuth = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway', description: 'Edge GW' },
                { 'unique-id': 'auth', 'node-type': 'service', name: 'Auth Service' },
            ],
            relationships: [
                {
                    'unique-id': 'gw-auth',
                    protocol: 'HTTPS',
                    'relationship-type': { connects: { source: { node: 'gw' }, destination: { node: 'auth' } } },
                },
            ],
        };
        const docRelMod10d = {
            nodes: docWireAuth.nodes,
            relationships: [
                {
                    'unique-id': 'gw-auth',
                    protocol: 'mTLS',
                    'relationship-type': { connects: { source: { node: 'gw' }, destination: { node: 'auth' } } },
                },
            ],
        };
        const docOverlapAuth = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway', description: 'Edge GW' },
                { 'unique-id': 'auth', 'node-type': 'service', name: 'Auth Service', description: 'OIDC + RBAC' },
                { 'unique-id': 'audit', 'node-type': 'service', name: 'Audit Log' },
            ],
            relationships: docRelMod10d.relationships,
        };
        const docOverlapConflictAdr = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway', description: 'Edge GW' },
                { 'unique-id': 'auth', 'node-type': 'service', name: 'Auth Service', description: 'Zero Trust' },
                { 'unique-id': 'audit', 'node-type': 'service', name: 'Audit Log' },
            ],
            relationships: docRelMod10d.relationships,
        };

        const { deltas } = filterStructuralCommits([
            makeSnapshot({ sha: 'c0', shortSha: 'c0', date: '2026-01-01', subject: 'feat: baseline', document: docInit }),
            makeSnapshot({
                sha: 'c1',
                shortSha: 'c1',
                date: '2026-01-01',
                subject: 'fix: clarify gateway',
                document: docInitFix,
            }),
            makeSnapshot({
                sha: 'c2',
                shortSha: 'c2',
                date: '2026-01-10',
                subject: 'feat: add auth service',
                document: docAuth,
            }),
            makeSnapshot({
                sha: 'c3',
                shortSha: 'c3',
                date: '2026-01-13',
                subject: 'feat: wire gateway to auth',
                document: docWireAuth,
            }),
            makeSnapshot({
                sha: 'c4',
                shortSha: 'c4',
                date: '2026-01-23',
                subject: 'chore: switch link to mTLS',
                document: docRelMod10d,
            }),
            makeSnapshot({
                sha: 'c5',
                shortSha: 'c5',
                date: '2026-01-26',
                subject: 'feat: add audit and auth RBAC',
                document: docOverlapAuth,
            }),
            makeSnapshot({
                sha: 'c6',
                shortSha: 'c6',
                date: '2026-01-28',
                subject: 'feat: zero trust ADR for auth',
                coChangedAdrs: ['adrs/002-zero-trust.md'],
                document: docOverlapConflictAdr,
            }),
        ]);

        const clusters = deterministicClusterCommits(deltas);
        expect(clusters.map((cl) => cl.commits.map((c) => c.commit.shortSha))).toEqual([
            ['c0', 'c1'],
            ['c2', 'c3', 'c4'],
            ['c5'],
            ['c6'],
        ]);

        const capSnapshots: GitCommitSnapshot[] = Array.from({ length: 7 }, (_, idx) =>
            makeSnapshot({
                sha: `s${idx}`,
                shortSha: `s${idx}`,
                date: `2026-03-0${idx + 1}`,
                subject: idx === 0 ? 'feat: seed' : `feat: iterate svc v${idx}`,
                document: {
                    nodes: [
                        {
                            'unique-id': idx === 0 ? 'base' : 'svc',
                            'node-type': 'service',
                            name: 'Svc',
                            description: `v${idx}`,
                        },
                    ],
                    relationships: [],
                },
            }),
        );
        const capDeltas = filterStructuralCommits(capSnapshots).deltas;
        const capClusters = deterministicClusterCommits(capDeltas);
        expect(capClusters.map((cl) => cl.commits.map((c) => c.commit.shortSha))).toEqual([
            ['s0'],
            ['s1', 's2', 's3', 's4', 's5'],
            ['s6'],
        ]);
    });

    it('synthesizes natural narrative descriptions without mechanical count tokens', () => {
        const doc1 = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'API Gateway' },
                { 'unique-id': 'legacy', 'node-type': 'service', name: 'Legacy Proxy' },
            ],
            relationships: [],
        };
        const doc2 = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'API Gateway', description: 'Hardened' },
                { 'unique-id': 'auth', 'node-type': 'service', name: 'Auth Service' },
            ],
            relationships: [
                {
                    'unique-id': 'gw-auth',
                    protocol: 'mTLS',
                    'relationship-type': { connects: { source: { node: 'gw' }, destination: { node: 'auth' } } },
                },
            ],
            controls: {
                'oidc-enforcement': { description: 'Require OIDC tokens' },
            },
        };
        const doc3 = {
            ...doc2,
            relationships: [
                {
                    'unique-id': 'gw-auth',
                    protocol: 'mTLS',
                    description: 'Encrypted service link',
                    'relationship-type': { connects: { source: { node: 'gw' }, destination: { node: 'auth' } } },
                },
            ],
        };

        const { deltas } = filterStructuralCommits([
            makeSnapshot({ sha: '111aaaa', shortSha: '111aaaa', date: '2026-02-01', subject: 'feat: initial', document: doc1 }),
            makeSnapshot({
                sha: '222bbbb',
                shortSha: '222bbbb',
                date: '2026-02-05',
                subject: 'feat: introduce auth and retire legacy',
                coChangedAdrs: ['adrs/001-oidc.md'],
                document: doc2,
            }),
            makeSnapshot({
                sha: '333cccc',
                shortSha: '333cccc',
                date: '2026-02-07',
                subject: 'chore: polish gw-auth link',
                document: doc3,
            }),
        ]);

        const clusters = deterministicClusterCommits(deltas);
        expect(clusters).toHaveLength(2);

        const initDesc = clusters[0].description;
        expect(initDesc).toContain('Establishes the initial architecture baseline');
        expect(initDesc).toContain('API Gateway (gw)');
        expect(initDesc).toContain('(1 commit: 111aaaa)');

        const phaseDesc = clusters[1].description;
        expect(phaseDesc).toContain('Auth Service (auth)');
        expect(phaseDesc).toContain('API Gateway (gw)');
        expect(phaseDesc).toContain('Legacy Proxy (legacy)');
        expect(phaseDesc).toContain('gw-auth');
        expect(phaseDesc).toContain('oidc-enforcement');
        expect(phaseDesc).toContain('adrs/001-oidc.md');
        expect(phaseDesc).toContain('(2 commits: 222bbbb..333cccc)');
        expect(phaseDesc).not.toMatch(/\+\d+\s+node\(s\)/);
        expect(phaseDesc).not.toMatch(/\+\d+\s+rel\(s\)/);
        expect(phaseDesc).not.toContain('controls(');
    });
});
