// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  convertTraderXStateToCalm,
  generateTimelineFromTraderXRepo,
} from '../src/traderx-importer.js';

const tempDirs: string[] = [];
const cliPath = path.resolve(__dirname, '../dist/cli.js');

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('FINOS TraderX state catalog importer', () => {
  it('converts TraderX architecture.model.json into valid CALM 1.3 with interacts for actors and connects for services', () => {
    const calm = convertTraderXStateToCalm(
      {
        stateId: '006-messaging-nats-replacement',
        title: 'Messaging Layer Replacement with NATS',
        description: 'Replaces Socket.IO trade feed with NATS JetStream broker.',
        nodes: [
          { id: 'trader', label: 'Trader Browser', kind: 'actor', description: 'Human trader.' },
          { id: 'web', label: 'Angular UI', kind: 'frontend', description: 'Web front-end.' },
          { id: 'tradeSvc', label: 'Trade Service', kind: 'service', description: 'Java service.' },
          { id: 'nats', label: 'NATS Broker', kind: 'messaging', description: 'NATS pub/sub.' },
          { id: 'db', label: 'PostgreSQL', kind: 'database', description: 'Trades database.' },
        ],
        edges: [
          { from: 'trader', to: 'web', label: 'Uses UI' },
          { from: 'web', to: 'tradeSvc', label: '/trade-service' },
          { from: 'web', to: 'nats', label: '/nats-ws' },
          { from: 'tradeSvc', to: 'db', label: 'Persist trades' },
        ],
      },
      {
        id: '006-messaging-nats-replacement',
        title: 'Messaging Layer Replacement with NATS',
        featurePack: 'specs/006-messaging-nats-replacement',
      },
      ['docs/adr/005-state-006-use-nats-for-messaging-replacement.md'],
    );

    expect(calm.$schema).toBe('https://calm.finos.org/release/1.3/meta/calm.json');
    const nodes = calm.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(5);
    expect(nodes[0]['node-type']).toBe('actor');
    expect(nodes[1]['node-type']).toBe('webclient');
    expect(nodes[3]['node-type']).toBe('service');
    expect((nodes[3].metadata as Record<string, unknown>)['traderx-kind']).toBe('messaging');
    expect(nodes[4]['node-type']).toBe('database');

    const rels = calm.relationships as Array<Record<string, unknown>>;
    expect(rels).toHaveLength(4);
    expect(rels[0]['relationship-type']).toEqual({
      interacts: { actor: 'trader', nodes: ['web'] },
    });
    expect(rels[1].protocol).toBe('HTTP');
    expect(rels[2].protocol).toBe('WebSocket');
    expect(rels[3].protocol).toBe('JDBC');
  });

  it('imports a Git-tracked TraderX repo via generateTimelineFromTraderXRepo and CLI --from-traderx, skipping scaffold placeholders', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-traderx-import-'));
    tempDirs.push(repoDir);

    const runGit = (args: string[], dateIso: string) => {
      execFileSync('git', args, {
        cwd: repoDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: dateIso,
          GIT_COMMITTER_DATE: dateIso,
        },
      });
    };

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'FINOS Maintainer'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'maintainer@finos.org'], { cwd: repoDir, stdio: 'pipe' });

    fs.mkdirSync(path.join(repoDir, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'docs', 'adr'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'specs', '001-baseline', 'system'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'specs', '003-harness', 'system'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'specs', '014-fdc3', 'system'), { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'docs', 'adr', '001-adopt-speckit.md'), '# ADR 1\n');
    fs.writeFileSync(path.join(repoDir, 'docs', 'adr', '009-state-014-fdc3-sail.md'), '# ADR 9\n');

    fs.writeFileSync(
      path.join(repoDir, 'catalog', 'state-catalog.json'),
      JSON.stringify(
        {
          version: 1,
          states: [
            {
              id: '001-baseline',
              title: 'Baseline Uncontainerized App',
              status: 'released',
              track: 'prelude',
              featurePack: 'specs/001-baseline',
            },
            {
              id: '003-harness',
              title: 'Agentic Harness Scaffold',
              status: 'released',
              track: 'prelude',
              featurePack: 'specs/003-harness',
            },
            {
              id: '014-fdc3',
              title: 'FDC3 Intent Interoperability',
              status: 'released',
              track: 'c3',
              featurePack: 'specs/014-fdc3',
            },
          ],
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(repoDir, 'specs', '001-baseline', 'system', 'architecture.model.json'),
      JSON.stringify({
        stateId: '001-baseline',
        description: 'Baseline TraderX browser and trade service.',
        nodes: [
          { id: 'trader', label: 'Trader', kind: 'actor', description: 'Human trader.' },
          { id: 'tradeSvc', label: 'Trade Service', kind: 'service', description: 'Trade API.' },
        ],
        edges: [{ from: 'trader', to: 'tradeSvc', label: 'Submits trades' }],
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'specs', '003-harness', 'system', 'architecture.model.json'),
      JSON.stringify({
        stateId: '003-harness',
        description: 'Update this model with the authoritative architecture for this state.',
        nodes: [{ id: 'dev', label: 'Dev', kind: 'actor', description: 'Dev' }],
        edges: [],
      }),
    );
    fs.writeFileSync(
      path.join(repoDir, 'specs', '014-fdc3', 'system', 'architecture.model.json'),
      JSON.stringify({
        stateId: '014-fdc3',
        description: 'Layers FINOS FDC3 context and intent interoperability.',
        nodes: [
          { id: 'trader', label: 'Trader', kind: 'actor', description: 'Human trader.' },
          { id: 'tradeSvc', label: 'Trade Service', kind: 'service', description: 'Trade API.' },
          { id: 'sailSidecar', label: 'Sail Sidecar', kind: 'service', description: 'FDC3 Desktop Agent.' },
        ],
        edges: [
          { from: 'trader', to: 'tradeSvc', label: 'Submits trades' },
          { from: 'trader', to: 'sailSidecar', label: 'Launches FDC3 intents' },
        ],
      }),
    );

    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    runGit(['commit', '-m', 'feat: add TraderX state catalog and FDC3 state'], '2026-05-21T10:00:00Z');

    const outDir = path.join(repoDir, 'out');
    const outTimeline = path.join(outDir, 'finos-traderx.timeline.json');
    const outHtml = path.join(outDir, 'finos-traderx.timelapse.html');

    const directResult = generateTimelineFromTraderXRepo(repoDir, {
      outputPath: outTimeline,
      snapshotsDir: path.join(outDir, 'snapshots'),
      timelapsePath: outHtml,
      validate: true,
      validateSnapshots: true,
    });
    expect(directResult.validationErrors).toEqual([]);
    expect(directResult.timeline.moments).toHaveLength(2);
    expect(directResult.stats.noiseCommitsFiltered).toBe(1);
    expect(directResult.timeline.moments[0].adrs).toEqual(['docs/adr/001-adopt-speckit.md']);
    expect(directResult.timeline.moments[1].adrs).toEqual(['docs/adr/009-state-014-fdc3-sail.md']);

    const cliOutTimeline = path.join(outDir, 'cli.timeline.json');
    const cliRes = spawnSync(
      process.execPath,
      [
        cliPath,
        '--from-traderx',
        repoDir,
        '-o',
        cliOutTimeline,
        '--snapshots-dir',
        path.join(outDir, 'cli-snapshots'),
        '--validate',
        '--validate-snapshots',
      ],
      { encoding: 'utf8' },
    );
    expect(cliRes.status).toBe(0);
    expect(cliRes.stdout).toContain('Imported 2 FINOS TraderX state(s)');
    expect(fs.existsSync(cliOutTimeline)).toBe(true);
  });
});
