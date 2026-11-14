// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTimelapsePayloadFromTimelineFiles,
  composeFederatedArchitecture,
  generateTimelineFromGit,
  parseSourceTargetSpec,
  renderTimelapseHtml,
  synchronizeSavedTimelines,
  validateCalmArchitectureSnapshot,
} from '../src/index.js';

const tempDirs: string[] = [];

function createTempGitRepo(repoName: string): string {
  const base = mkdtempSync(path.join(os.tmpdir(), 'calm-fed-test-'));
  tempDirs.push(base);
  const repoDir = path.join(base, repoName);
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test Architect'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'architect@example.org'], {
    cwd: repoDir,
    stdio: 'pipe',
  });
  return repoDir;
}

function commitJson(
  repoDir: string,
  relPath: string,
  doc: Record<string, unknown>,
  message: string,
  isoDate: string,
): void {
  const fullPath = path.join(repoDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
  execFileSync('git', ['add', relPath], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], {
    cwd: repoDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('multi-repository and multi-architecture federation', () => {
  it('parses plain paths and label=path source specs', () => {
    const plain = parseSourceTargetSpec('examples/arch.json');
    expect(plain.explicitLabel).toBeUndefined();
    expect(plain.filePath).toBe('examples/arch.json');

    const labeled = parseSourceTargetSpec('TraderX Core=examples/arch.json');
    expect(labeled.explicitLabel).toBe('TraderX Core');
    expect(labeled.filePath).toBe('examples/arch.json');
  });

  it('never merges colliding unique-ids across unlinked peer repositories', async () => {
    const repoAlpha = createTempGitRepo('repo-alpha');
    const repoBeta = createTempGitRepo('repo-beta');
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'calm-fed-out-'));
    tempDirs.push(outDir);

    commitJson(
      repoAlpha,
      'arch.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'api-gw',
            'node-type': 'service',
            name: 'Alpha API Gateway',
            description: 'Ingress gateway for Alpha project',
          },
          {
            'unique-id': 'postgres-db',
            'node-type': 'database',
            name: 'Alpha Ledger Postgres',
            description: 'Primary store for Alpha',
          },
        ],
        relationships: [
          {
            'unique-id': 'gw-to-db',
            description: 'Alpha persistence link',
            protocol: 'JDBC',
            'relationship-type': {
              connects: {
                source: { node: 'api-gw' },
                destination: { node: 'postgres-db' },
              },
            },
          },
        ],
      },
      'feat: initial alpha architecture',
      '2026-01-10T10:00:00Z',
    );

    commitJson(
      repoBeta,
      'arch.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'api-gw',
            'node-type': 'service',
            name: 'Beta API Gateway',
            description: 'Ingress gateway for Beta project',
          },
          {
            'unique-id': 'postgres-db',
            'node-type': 'database',
            name: 'Beta Risk Postgres',
            description: 'Primary store for Beta',
          },
        ],
        relationships: [
          {
            'unique-id': 'gw-to-db',
            description: 'Beta persistence link',
            protocol: 'JDBC',
            'relationship-type': {
              connects: {
                source: { node: 'api-gw' },
                destination: { node: 'postgres-db' },
              },
            },
          },
        ],
      },
      'feat: initial beta architecture',
      '2026-01-15T10:00:00Z',
    );

    commitJson(
      repoAlpha,
      'arch.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'api-gw',
            'node-type': 'service',
            name: 'Alpha API Gateway',
            description: 'Ingress gateway for Alpha project',
          },
          {
            'unique-id': 'postgres-db',
            'node-type': 'database',
            name: 'Alpha Ledger Postgres',
            description: 'Primary store for Alpha',
          },
          {
            'unique-id': 'audit-worker',
            'node-type': 'service',
            name: 'Alpha Audit Worker',
            description: 'Streams Alpha events',
          },
        ],
        relationships: [
          {
            'unique-id': 'gw-to-db',
            description: 'Alpha persistence link',
            protocol: 'JDBC',
            'relationship-type': {
              connects: {
                source: { node: 'api-gw' },
                destination: { node: 'postgres-db' },
              },
            },
          },
          {
            'unique-id': 'worker-to-db',
            description: 'Audit read link',
            protocol: 'JDBC',
            'relationship-type': {
              connects: {
                source: { node: 'audit-worker' },
                destination: { node: 'postgres-db' },
              },
            },
          },
        ],
      },
      'feat: add alpha audit worker',
      '2026-01-22T10:00:00Z',
    );

    const timelinePath = path.join(outDir, 'peer.timeline.json');
    const htmlPath = path.join(outDir, 'peer.timelapse.html');

    const res = await generateTimelineFromGit(
      [`Alpha=${path.join(repoAlpha, 'arch.json')}`, `Beta=${path.join(repoBeta, 'arch.json')}`],
      {
        outputPath: timelinePath,
        timelapsePath: htmlPath,
        validate: true,
        validateSnapshots: true,
      },
    );

    expect(res.validationErrors).toEqual([]);
    expect(res.stats.sourcesTracked).toBe(2);
    expect(res.stats.repositoriesTracked).toBe(2);
    expect(res.clusters.length).toBe(3);

    const finalCluster = res.clusters[res.clusters.length - 1];
    const finalNodes = finalCluster.snapshotDocument.nodes as Array<Record<string, unknown>>;
    const finalIds = finalNodes.map((n) => String(n['unique-id']));

    expect(finalIds).toContain('alpha--api-gw');
    expect(finalIds).toContain('alpha--postgres-db');
    expect(finalIds).toContain('alpha--audit-worker');
    expect(finalIds).toContain('beta--api-gw');
    expect(finalIds).toContain('beta--postgres-db');
    expect(finalNodes).toHaveLength(5);

    for (const prov of Object.values(finalCluster.nodeProvenance ?? {})) {
      expect(prov.mergedViaDetailedArch).toBe(false);
      expect(prov.sourceIds).toHaveLength(1);
    }
  });

  it('merges shared boundary nodes ONLY when resolved through details.detailed-architecture while keeping unlinked peers separate', () => {
    const composed = composeFederatedArchitecture([
      {
        sourceId: 'platform',
        sourceLabel: 'Platform',
        repoRoot: '/virtual/repo-platform',
        repoName: 'repo-platform',
        relPath: 'platform.calm.json',
        fileName: 'platform.calm.json',
        document: {
          $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
          nodes: [
            {
              'unique-id': 'clearing-hub',
              'node-type': 'system',
              name: 'Clearing Hub',
              description: 'Parent clearing subsystem',
              details: {
                'detailed-architecture': 'clearing-detail.calm.json',
              },
            },
            {
              'unique-id': 'shared-ledger-db',
              'node-type': 'database',
              name: 'Shared Clearing Ledger',
              description: 'Authoritative ledger database',
            },
          ],
          relationships: [
            {
              'unique-id': 'hub-to-ledger',
              description: 'Clearing hub writes ledger',
              protocol: 'JDBC',
              'relationship-type': {
                connects: {
                  source: { node: 'clearing-hub' },
                  destination: { node: 'shared-ledger-db' },
                },
              },
            },
          ],
        },
      },
      {
        sourceId: 'clearing-detail',
        sourceLabel: 'Clearing Detail',
        repoRoot: '/virtual/repo-clearing',
        repoName: 'repo-clearing',
        relPath: 'clearing-detail.calm.json',
        fileName: 'clearing-detail.calm.json',
        document: {
          $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
          nodes: [
            {
              'unique-id': 'clearing-api',
              'node-type': 'service',
              name: 'Clearing REST API',
              description: 'Internal API tier',
            },
            {
              'unique-id': 'clearing-worker',
              'node-type': 'service',
              name: 'Clearing Settlement Worker',
              description: 'Internal settlement worker',
            },
            {
              'unique-id': 'shared-ledger-db',
              'node-type': 'database',
              name: 'Shared Clearing Ledger',
              description: 'Re-declared boundary database in child detail file',
            },
          ],
          relationships: [
            {
              'unique-id': 'api-to-worker',
              description: 'Dispatches settlement tasks',
              protocol: 'AMQP',
              'relationship-type': {
                connects: {
                  source: { node: 'clearing-api' },
                  destination: { node: 'clearing-worker' },
                },
              },
            },
            {
              'unique-id': 'worker-to-ledger',
              description: 'Persists settled trades',
              protocol: 'JDBC',
              'relationship-type': {
                connects: {
                  source: { node: 'clearing-worker' },
                  destination: { node: 'shared-ledger-db' },
                },
              },
            },
          ],
        },
      },
      {
        sourceId: 'surveillance',
        sourceLabel: 'Surveillance Peer',
        repoRoot: '/virtual/repo-surveillance',
        repoName: 'repo-surveillance',
        relPath: 'surveillance.calm.json',
        fileName: 'surveillance.calm.json',
        document: {
          $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
          nodes: [
            {
              'unique-id': 'shared-ledger-db',
              'node-type': 'database',
              name: 'Unlinked Surveillance DB',
              description: 'Colliding ID in unlinked peer repo that MUST NOT merge',
            },
          ],
          relationships: [],
        },
      },
    ]);

    expect(composed.resolvedLinks).toHaveLength(1);
    const nodes = composed.document.nodes as Array<Record<string, unknown>>;
    const nodeIds = nodes.map((n) => String(n['unique-id']));

    // Shared boundary DB between Platform & Clearing Detail merged into platform--shared-ledger-db
    expect(nodeIds).toContain('platform--shared-ledger-db');
    expect(nodeIds).not.toContain('clearing-detail--shared-ledger-db');
    expect(composed.nodeProvenance['platform--shared-ledger-db'].mergedViaDetailedArch).toBe(true);
    expect(composed.nodeProvenance['platform--shared-ledger-db'].sourceIds).toEqual([
      'platform',
      'clearing-detail',
    ]);

    // Unlinked peer repo's colliding ID stayed strictly isolated!
    expect(nodeIds).toContain('surveillance--shared-ledger-db');
    expect(composed.nodeProvenance['surveillance--shared-ledger-db'].mergedViaDetailedArch).toBe(
      false,
    );

    // Parent node stripped its relative details.detailed-architecture pointer and received composed-of
    const parentNode = nodes.find((n) => n['unique-id'] === 'platform--clearing-hub')!;
    expect(parentNode.details).toBeUndefined();

    const rels = composed.document.relationships as Array<Record<string, unknown>>;
    const composedRel = rels.find(
      (r) => r['unique-id'] === 'clearing-detail--resolved-detailed-architecture',
    );
    expect(composedRel).toBeDefined();
    expect(composedRel?.['relationship-type']).toEqual({
      'composed-of': {
        container: 'platform--clearing-hub',
        nodes: ['clearing-detail--clearing-api', 'clearing-detail--clearing-worker'],
      },
    });

    expect(validateCalmArchitectureSnapshot(composed.document, 'merged-test')).toEqual([]);
  });

  it('auto-discovers same-repo detailed-architecture files with resolveDetails: true and synchronizes saved timelines', async () => {
    const repoDir = createTempGitRepo('calm-system-repo');
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'calm-fed-auto-'));
    tempDirs.push(outDir);

    commitJson(
      repoDir,
      'hub-detail.calm.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'hub-rest',
            'node-type': 'service',
            name: 'Hub REST Resource',
            description: 'REST resource layer',
          },
          {
            'unique-id': 'mongodb',
            'node-type': 'database',
            name: 'Hub MongoDB',
            description: 'Document database',
          },
        ],
        relationships: [
          {
            'unique-id': 'rest-to-mongo',
            description: 'Reads/writes architectures',
            protocol: 'TCP',
            'relationship-type': {
              connects: {
                source: { node: 'hub-rest' },
                destination: { node: 'mongodb' },
              },
            },
          },
        ],
      },
      'feat: add hub detail architecture',
      '2026-02-01T09:00:00Z',
    );

    commitJson(
      repoDir,
      'system.calm.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'calm-hub',
            'node-type': 'system',
            name: 'CALM Hub',
            description: 'Repository backend',
            details: {
              'detailed-architecture': 'hub-detail.calm.json',
            },
          },
          {
            'unique-id': 'mongodb',
            'node-type': 'database',
            name: 'Hub MongoDB',
            description: 'Document database',
          },
        ],
        relationships: [
          {
            'unique-id': 'hub-to-mongo',
            description: 'Stores models',
            protocol: 'TCP',
            'relationship-type': {
              connects: {
                source: { node: 'calm-hub' },
                destination: { node: 'mongodb' },
              },
            },
          },
        ],
      },
      'feat: add system calm model referencing hub-detail',
      '2026-02-05T09:00:00Z',
    );

    const t1Path = path.join(outDir, 'system.timeline.json');
    const autoRes = await generateTimelineFromGit(path.join(repoDir, 'system.calm.json'), {
      outputPath: t1Path,
      resolveDetails: true,
      validate: true,
      validateSnapshots: true,
    });

    expect(autoRes.validationErrors).toEqual([]);
    expect(autoRes.stats.sourcesTracked).toBe(2);
    const lastSnapNodes = autoRes.clusters[autoRes.clusters.length - 1].snapshotDocument
      .nodes as Array<Record<string, unknown>>;
    // system--calm-hub, system--mongodb (merged!), hub-detail--hub-rest => 3 nodes total
    expect(lastSnapNodes).toHaveLength(3);

    // Create a second independent timeline and synchronize both saved timeline files
    const peerRepo = createTempGitRepo('peer-cli-repo');
    commitJson(
      peerRepo,
      'cli.calm.json',
      {
        $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        nodes: [
          {
            'unique-id': 'calm-cli',
            'node-type': 'service',
            name: 'CALM CLI',
            description: 'Validation CLI',
          },
        ],
        relationships: [],
      },
      'feat: initial cli architecture',
      '2026-02-03T12:00:00Z',
    );

    const t2Path = path.join(outDir, 'cli.timeline.json');
    await generateTimelineFromGit(path.join(peerRepo, 'cli.calm.json'), {
      outputPath: t2Path,
      validate: true,
    });

    const synced = synchronizeSavedTimelines([t1Path, t2Path]);
    expect(synced.sources).toHaveLength(2);
    expect(synced.frames.length).toBeGreaterThanOrEqual(2);

    const payload = buildTimelapsePayloadFromTimelineFiles([t1Path, t2Path]);
    expect(payload.sources).toHaveLength(2);
    const html = renderTimelapseHtml(payload);
    expect(html).toContain('id="project-select"');
    expect(html).toContain('id="badge-sources"');

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new Function(scriptMatch![1])).not.toThrow();
  });
});
