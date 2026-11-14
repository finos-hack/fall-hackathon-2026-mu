// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];
const cliPath = path.resolve(__dirname, '../dist/cli.js');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempGitRepo(): { repoDir: string; archFile: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-timelapse-e2e-'));
  tempDirs.push(repoDir);

  const runGit = (args: string[], env?: Record<string, string>) => {
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
  };

  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.name', 'Test User']);
  runGit(['config', 'user.email', 'test@example.com']);

  const archFile = path.join(repoDir, 'architecture.calm.json');

  fs.writeFileSync(
    archFile,
    JSON.stringify(
      {
        nodes: [
          { 'unique-id': 'gw', name: 'API Gateway', 'node-type': 'service' },
          { 'unique-id': 'db', name: 'Primary DB', 'node-type': 'database' },
        ],
        relationships: [
          {
            'unique-id': 'gw-db',
            protocol: 'JDBC',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'db' } },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  runGit(['add', '.']);
  runGit(['commit', '-m', 'feat: initial gateway and db'], {
    GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z',
  });

  fs.writeFileSync(
    archFile,
    JSON.stringify(
      {
        relationships: [
          {
            'unique-id': 'gw-db',
            protocol: 'JDBC',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'db' } },
            },
          },
        ],
        nodes: [
          { 'unique-id': 'gw', name: 'API Gateway', 'node-type': 'service' },
          { 'unique-id': 'db', name: 'Primary DB', 'node-type': 'database' },
        ],
      },
      null,
      4,
    ),
  );
  runGit(['add', '.']);
  runGit(['commit', '-m', 'style: reorder keys'], {
    GIT_AUTHOR_DATE: '2026-01-02T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-02T10:00:00Z',
  });

  fs.mkdirSync(path.join(repoDir, 'adrs'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'adrs/001-events.md'), '# Adopt Event Bus\n');
  fs.writeFileSync(
    archFile,
    JSON.stringify(
      {
        nodes: [
          { 'unique-id': 'gw', name: 'API Gateway', 'node-type': 'service' },
          { 'unique-id': 'db', name: 'Primary DB', 'node-type': 'database' },
          { 'unique-id': 'kafka', name: 'Event Bus', 'node-type': 'queue' },
        ],
        relationships: [
          {
            'unique-id': 'gw-db',
            protocol: 'JDBC',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'db' } },
            },
          },
          {
            'unique-id': 'gw-kafka',
            protocol: 'Kafka',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'kafka' } },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  runGit(['add', '.']);
  runGit(['commit', '-m', 'feat: add event bus and ADR'], {
    GIT_AUTHOR_DATE: '2026-01-03T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-03T10:00:00Z',
  });

  return { repoDir, archFile };
}

function createValidCalm13GitRepo(): { repoDir: string; archFile: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-timelapse-e2e-valid-'));
  tempDirs.push(repoDir);

  const runGit = (args: string[], env?: Record<string, string>) => {
    execFileSync('git', args, {
      cwd: repoDir,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
  };

  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.name', 'Test User']);
  runGit(['config', 'user.email', 'test@example.com']);

  const archFile = path.join(repoDir, 'architecture.calm.json');

  fs.writeFileSync(
    archFile,
    JSON.stringify(
      {
        nodes: [
          {
            'unique-id': 'gw',
            name: 'API Gateway',
            'node-type': 'service',
            description: 'Ingress gateway handling client traffic.',
          },
          {
            'unique-id': 'db',
            name: 'Primary DB',
            'node-type': 'database',
            description: 'Relational ledger database.',
          },
        ],
        relationships: [
          {
            'unique-id': 'gw-db',
            protocol: 'JDBC',
            description: 'Gateway queries primary ledger DB.',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'db' } },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  runGit(['add', '.']);
  runGit(['commit', '-m', 'feat: initial valid CALM 1.3 gateway and db'], {
    GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z',
  });

  fs.writeFileSync(
    archFile,
    JSON.stringify(
      {
        nodes: [
          {
            'unique-id': 'gw',
            name: 'API Gateway',
            'node-type': 'service',
            description: 'Ingress gateway handling client traffic.',
          },
          {
            'unique-id': 'db',
            name: 'Primary DB',
            'node-type': 'database',
            description: 'Relational ledger database.',
          },
          {
            'unique-id': 'broker',
            name: 'Event Broker',
            'node-type': 'service',
            description: 'AMQP broker for async order events.',
          },
        ],
        relationships: [
          {
            'unique-id': 'gw-db',
            protocol: 'JDBC',
            description: 'Gateway queries primary ledger DB.',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'db' } },
            },
          },
          {
            'unique-id': 'gw-broker',
            protocol: 'AMQP',
            description: 'Gateway publishes events over AMQP.',
            'relationship-type': {
              connects: { source: { node: 'gw' }, destination: { node: 'broker' } },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  runGit(['add', '.']);
  runGit(['commit', '-m', 'feat: add AMQP event broker'], {
    GIT_AUTHOR_DATE: '2026-01-08T10:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-08T10:00:00Z',
  });

  return { repoDir, archFile };
}

describe('calm-timelapse CLI e2e', () => {
  it('generates timeline JSON, snapshots, and HTML timelapse deterministically from git history', () => {
    const { repoDir, archFile } = createTempGitRepo();
    const outTimeline = path.join(repoDir, 'out', 'my.timeline.json');
    const outHtml = path.join(repoDir, 'out', 'my.timelapse.html');

    const res = spawnSync(
      process.execPath,
      [
        cliPath,
        '--from-git',
        archFile,
        '-o',
        outTimeline,
        '--timelapse',
        outHtml,
        '--validate',
      ],
      { encoding: 'utf8' },
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Generated timeline:');
    expect(res.stdout).toContain('filtered 1 noise');
    expect(res.stdout).toContain('using deterministic');
    expect(res.stdout).toContain('Generated HTML timelapse:');

    expect(fs.existsSync(outTimeline)).toBe(true);
    expect(fs.existsSync(outHtml)).toBe(true);

    const timeline = JSON.parse(fs.readFileSync(outTimeline, 'utf8'));
    expect(timeline.moments).toHaveLength(2);
    expect(timeline.moments[1].adrs).toEqual(['adrs/001-events.md']);
    expect(timeline.metadata['clustering-engine']).toBe('deterministic');
    expect(timeline.metadata['total-commits-scanned']).toBe('3');
    expect(timeline.metadata['noise-commits-filtered']).toBe('1');
    expect(timeline.metadata['structural-commits-retained']).toBe('2');

    const html = fs.readFileSync(outHtml, 'utf8');
    expect(html).toContain('Event Bus');
    expect(html).toContain('id="badge-funnel"');
    expect(html).toContain('3 commits -&gt; 1 noise filtered -&gt; 2 moments');

    const outHtml2 = path.join(repoDir, 'out', 're-rendered.html');
    const res2 = spawnSync(
      process.execPath,
      [cliPath, '--timeline', outTimeline, '--validate', '--timelapse', outHtml2, '--feed'],
      { encoding: 'utf8' },
    );
    expect(res2.status).toBe(0);
    expect(res2.stdout).toContain('Timeline valid:');
    expect(fs.existsSync(outHtml2)).toBe(true);
    const html2 = fs.readFileSync(outHtml2, 'utf8');
    expect(html2).toContain('"defaultView":"feed"');
    expect(html2).toContain('id="feed-view"');

    const resInvalidSnap = spawnSync(
      process.execPath,
      [cliPath, '--timeline', outTimeline, '--validate', '--validate-snapshots'],
      { encoding: 'utf8' },
    );
    expect(resInvalidSnap.status).not.toBe(0);
    expect(resInvalidSnap.stderr).toContain('Timeline validation failed:');
    expect(resInvalidSnap.stderr).toContain('invalid protocol');
  });

  it('supports the 2-step --emit-digest and --clusters workflow for external AI assistants', () => {
    const { repoDir, archFile } = createValidCalm13GitRepo();
    const digestPath = path.join(repoDir, 'out', 'arch.digest.json');
    const detTimeline = path.join(repoDir, 'out', 'det.timeline.json');

    const step1 = spawnSync(
      process.execPath,
      [
        cliPath,
        '--from-git',
        archFile,
        '-o',
        detTimeline,
        '--emit-digest',
        digestPath,
        '--validate',
        '--validate-snapshots',
      ],
      { encoding: 'utf8' },
    );
    expect(step1.status).toBe(0);
    expect(step1.stdout).toContain('Emitted commit diff digest:');
    expect(fs.existsSync(digestPath)).toBe(true);

    const digest = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    expect(digest.schemaVersion).toBe('1.0');
    expect(digest.commits).toHaveLength(2);
    expect(digest.commits[0].index).toBe(0);
    expect(digest.commits[1].index).toBe(1);

    const clustersPath = path.join(repoDir, 'out', 'arch.clusters.json');
    fs.writeFileSync(
      clustersPath,
      JSON.stringify(
        [
          {
            startIndex: 0,
            endIndex: 1,
            uniqueId: 'gateway-and-event-backbone',
            name: 'Gateway and AMQP Event Backbone',
            description:
              'Establishes the ingress API Gateway with relational Primary DB persistence and adds the asynchronous AMQP Event Broker.',
          },
        ],
        null,
        2,
      ),
    );

    const enrichedTimeline = path.join(repoDir, 'out', 'enriched.timeline.json');
    const enrichedHtml = path.join(repoDir, 'out', 'enriched.timelapse.html');
    const step3 = spawnSync(
      process.execPath,
      [
        cliPath,
        '--from-git',
        archFile,
        '--clusters',
        clustersPath,
        '-o',
        enrichedTimeline,
        '--snapshots-dir',
        path.join(repoDir, 'out', 'enriched-snapshots'),
        '--timelapse',
        enrichedHtml,
        '--validate',
        '--validate-snapshots',
      ],
      { encoding: 'utf8' },
    );
    expect(step3.status).toBe(0);
    expect(step3.stdout).toContain('emitted 1 moment(s) using clusters-file');

    const parsedEnriched = JSON.parse(fs.readFileSync(enrichedTimeline, 'utf8'));
    expect(parsedEnriched.metadata['clustering-engine']).toBe('clusters-file');
    expect(parsedEnriched.moments).toHaveLength(1);
    expect(parsedEnriched.moments[0]['unique-id']).toBe('gateway-and-event-backbone');
    expect(parsedEnriched.moments[0].metadata['commit-count']).toBe(2);

    const html = fs.readFileSync(enrichedHtml, 'utf8');
    expect(html).toContain('Gateway and AMQP Event Backbone');
    expect(html).toContain('clusters-file');

    const badClustersPath = path.join(repoDir, 'out', 'bad.clusters.json');
    fs.writeFileSync(badClustersPath, JSON.stringify([{ startIndex: 0, endIndex: 0 }]));
    const badRes = spawnSync(
      process.execPath,
      [cliPath, '--from-git', archFile, '--clusters', badClustersPath],
      { encoding: 'utf8' },
    );
    expect(badRes.status).not.toBe(0);
    expect(badRes.stderr).toContain('Invalid cluster definitions');
  });

  it('synchronizes multiple Git repositories via variadic --from-git and multiple --timeline files', () => {
    const { archFile: archA } = createValidCalm13GitRepo();
    const { archFile: archB } = createValidCalm13GitRepo();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-multi-cli-out-'));
    tempDirs.push(outDir);

    const outTimeline = path.join(outDir, 'multi.timeline.json');
    const outHtml = path.join(outDir, 'multi.timelapse.html');
    const res = spawnSync(
      process.execPath,
      [
        cliPath,
        '--from-git',
        `Orders=${archA}`,
        `Settlement=${archB}`,
        '-o',
        outTimeline,
        '--snapshots-dir',
        path.join(outDir, 'snapshots'),
        '--timelapse',
        outHtml,
        '--validate',
        '--validate-snapshots',
      ],
      { encoding: 'utf8' },
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Synchronized 2 architecture(s) across 2 repo(s)');
    expect(fs.existsSync(outTimeline)).toBe(true);
    expect(fs.existsSync(outHtml)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(outTimeline, 'utf8'));
    expect(parsed.metadata['sources-tracked']).toBe('2');
    expect(parsed.metadata['repositories-tracked']).toBe('2');

    // Also verify multi-file --timeline rendering
    const tA = path.join(outDir, 'a.timeline.json');
    const tB = path.join(outDir, 'b.timeline.json');
    expect(
      spawnSync(process.execPath, [cliPath, '--from-git', archA, '-o', tA, '--validate'], {
        encoding: 'utf8',
      }).status,
    ).toBe(0);
    expect(
      spawnSync(process.execPath, [cliPath, '--from-git', archB, '-o', tB, '--validate'], {
        encoding: 'utf8',
      }).status,
    ).toBe(0);

    const syncedHtml = path.join(outDir, 'synced.timelapse.html');
    const syncRes = spawnSync(
      process.execPath,
      [cliPath, '--timeline', tA, tB, '--timelapse', syncedHtml, '--validate'],
      { encoding: 'utf8' },
    );
    expect(syncRes.status).toBe(0);
    expect(fs.existsSync(syncedHtml)).toBe(true);
    expect(fs.readFileSync(syncedHtml, 'utf8')).toContain('id="project-select"');
  });

  it('exits non-zero when neither --from-git nor --timeline is provided', () => {
    const res = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('Specify either --from-git <files...> or --timeline <files...>');
  });
});
