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

  it('parses FDC3 contract-delta.md, appd.v2.json, and nonfunctional-delta.md into CALM 1.3 interfaces, flows, and controls', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-traderx-fdc3-'));
    tempDirs.push(repoDir);

    fs.mkdirSync(path.join(repoDir, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'specs', '001-baseline', 'system'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'specs', '014-fdc3-intent-interoperability', 'system'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'specs', '014-fdc3-intent-interoperability', 'contracts'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repoDir, 'specs', '014-fdc3-intent-interoperability', 'requirements'), {
      recursive: true,
    });
    fs.mkdirSync(
      path.join(repoDir, 'specs', '014-fdc3-intent-interoperability', 'generation', 'static'),
      { recursive: true },
    );

    fs.writeFileSync(
      path.join(repoDir, 'catalog', 'state-catalog.json'),
      JSON.stringify({
        states: [
          {
            id: '001-baseline',
            title: 'Baseline Parity',
            featurePack: 'specs/001-baseline',
          },
          {
            id: '014-fdc3-intent-interoperability',
            title: 'FDC3 Intent Interoperability on C3',
            featurePack: 'specs/014-fdc3-intent-interoperability',
            previous: ['001-baseline'],
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(repoDir, 'specs', '001-baseline', 'system', 'system-requirements.md'),
      [
        '# System Requirements',
        '## Functional Requirements',
        '- `SYS-FR-006` The trade-service SHALL validate account and ticker before publishing new trade orders.',
        '## Non-Functional Requirements',
        '- `SYS-NFR-009` Dependency upgrade targets SHALL be declared before template changes propagate.',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(repoDir, 'specs', '001-baseline', 'system', 'architecture.model.json'),
      JSON.stringify({
        stateId: '001-baseline',
        description: 'Baseline runtime.',
        entrypoints: [{ name: 'web-front-end-angular', url: 'http://localhost:18093' }],
        nodes: [
          { id: 'trader', label: 'Trader', kind: 'actor' },
          { id: 'web', label: 'Web UI', kind: 'frontend' },
          { id: 'tradeService', label: 'Trade Service', kind: 'service' },
        ],
        edges: [
          { from: 'trader', to: 'web', label: 'Uses UI' },
          { from: 'web', to: 'tradeService', label: '/trades' },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(
        repoDir,
        'specs',
        '014-fdc3-intent-interoperability',
        'contracts',
        'contract-delta.md',
      ),
      [
        '# Contract Delta: 014-fdc3-intent-interoperability',
        '### Supported Context Types',
        '- Inbound: `fdc3.instrument`',
        '- Outbound: `fdc3.instrument`',
        '### Inbound Intents (TraderX Listens For)',
        '- `ViewOrders` with `fdc3.instrument`',
        '- `TraderX.CreateTradeTicket` with `fdc3.instrument`',
        '- `TraderX.CreateOrderTicket` with `fdc3.instrument`',
        '### Outbound Intents (TraderX Raises)',
        '- `ViewChart` with `fdc3.instrument`',
        '- `ViewQuote` with `fdc3.instrument`',
        '### Context Mapping Rules',
        '- Optional: `id.ISIN`, `id.FIGI`, `id.RIC`',
        '- Account context is `{"type":"fdc3.account","id":{"accountId":"123"}}`.',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(
        repoDir,
        'specs',
        '014-fdc3-intent-interoperability',
        'generation',
        'static',
        'appd.v2.json',
      ),
      JSON.stringify({
        applications: [
          {
            appId: 'traderx-intent-launcher-1',
            name: 'TraderX Intent Launcher',
            details: { url: 'http://localhost:4040/' },
            publisher: 'FINOS',
            interop: {
              intents: {
                raises: {
                  'TraderX.CreateTradeTicket': { contexts: ['fdc3.instrument'] },
                  'TraderX.CreateOrderTicket': { contexts: ['fdc3.instrument'] },
                },
              },
            },
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(
        repoDir,
        'specs',
        '014-fdc3-intent-interoperability',
        'requirements',
        'nonfunctional-delta.md',
      ),
      [
        '# Non-Functional Delta',
        '## Runtime / Operations',
        '- TraderX must operate in two modes: interop-enabled and degraded local-only.',
        '- Local Sail sidecar should run as an independent service outside TraderX ingress path on `http://localhost:8090`.',
        '## Security / Compliance',
        '- No authn/authz model changes are introduced.',
        '- Outbound context payloads should include symbol identifiers only, excluding account/user-sensitive fields.',
        '- Intent handlers must validate context shape before applying UI actions.',
        '- Generated state-014 frontend manifests must enforce a scoped temporary npm override for `@robmoffat/fdc3-get-agent -> uuid:^14.0.0` to mitigate GHSA-w5hq-g745-h8pq.',
        '## Reliability / Observability',
        '- Interop failures must degrade safely and keep core TraderX workflows functional.',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(
        repoDir,
        'specs',
        '014-fdc3-intent-interoperability',
        'system',
        'architecture.model.json',
      ),
      JSON.stringify({
        stateId: '014-fdc3-intent-interoperability',
        inheritsFrom: '001-baseline',
        entrypoints: [
          { name: 'traderx-ui', url: 'http://localhost:8080' },
          { name: 'sail-ui', url: 'http://localhost:8090' },
        ],
        nodes: [
          { id: 'trader', label: 'Trader', kind: 'actor' },
          { id: 'traderxUi', label: 'TraderX Angular UI', kind: 'service' },
          { id: 'traderxIngress', label: 'TraderX Ingress', kind: 'gateway' },
          { id: 'sailSidecar', label: 'Sail Sidecar', kind: 'service' },
          { id: 'sailDirectory', label: 'Sail App Directory Profile', kind: 'component' },
          { id: 'demoApps', label: 'Demo FDC3 Apps', kind: 'service' },
          { id: 'orderApi', label: 'Order Matcher API', kind: 'service' },
          { id: 'tradeApi', label: 'Trade Service API', kind: 'service' },
          { id: 'nats', label: 'NATS Broker', kind: 'service' },
        ],
        edges: [
          { from: 'trader', to: 'traderxUi', label: 'Selects blotter rows' },
          { from: 'trader', to: 'sailSidecar', label: 'Uses Sail launcher' },
          { from: 'sailDirectory', to: 'sailSidecar', label: 'Provides app/intents/context metadata' },
          { from: 'sailSidecar', to: 'traderxUi', label: 'Routes contexts/intents to TraderX' },
          { from: 'traderxUi', to: 'sailSidecar', label: 'Broadcasts fdc3.instrument and raises intents' },
          { from: 'sailSidecar', to: 'demoApps', label: 'Hosts/resolves demo app workflows' },
          { from: 'demoApps', to: 'sailSidecar', label: 'Raises ticket-launch and view intents' },
          { from: 'traderxUi', to: 'traderxIngress', label: '/api' },
          { from: 'traderxIngress', to: 'tradeApi', label: '/trades' },
          { from: 'traderxIngress', to: 'orderApi', label: '/orders' },
          { from: 'traderxUi', to: 'nats', label: 'nats-ws' },
        ],
      }),
    );

    const outHtml = path.join(repoDir, 'out', 'traderx.timelapse.html');
    const res = generateTimelineFromTraderXRepo(repoDir, {
      outputPath: path.join(repoDir, 'out', 'traderx.timeline.json'),
      snapshotsDir: path.join(repoDir, 'out', 'snapshots'),
      timelapsePath: outHtml,
      validate: true,
      validateSnapshots: true,
    });

    expect(res.validationErrors).toEqual([]);
    const state14Doc = res.clusters[1].snapshotDocument;
    const flows = state14Doc.flows as Array<Record<string, unknown>>;
    expect(flows).toHaveLength(3);
    expect(flows.map((f) => f['unique-id'])).toEqual([
      'flow-fdc3-outbound-instrument-and-chart-intent',
      'flow-fdc3-inbound-ticket-launch-to-execution',
      'flow-fdc3-view-orders-and-realtime-blotter',
    ]);

    const controls = state14Doc.controls as Record<string, Record<string, unknown>>;
    expect(Object.keys(controls)).toEqual(
      expect.arrayContaining([
        'traderx-001-pre-trade-and-account-validation',
        'traderx-014-fdc3-context-data-minimization',
        'traderx-014-sail-sidecar-isolation-and-supply-chain',
        'traderx-014-fdc3-degraded-mode-resilience',
      ]),
    );

    const state14Nodes = state14Doc.nodes as Array<Record<string, unknown>>;
    const uiNode = state14Nodes.find((n) => n['unique-id'] === 'traderxUi')!;
    const uiIfaces = uiNode.interfaces as Array<Record<string, unknown>>;
    expect(uiIfaces.some((i) => Array.isArray(i['listens-for']) && i['listens-for'].includes('TraderX.CreateTradeTicket'))).toBe(true);
    expect(uiIfaces.some((i) => Array.isArray(i.raises) && i.raises.includes('ViewChart'))).toBe(true);

    const htmlContent = fs.readFileSync(outHtml, 'utf-8');
    expect(htmlContent).toContain('Active CALM Flows');
    expect(htmlContent).toContain('flow-fdc3-inbound-ticket-launch-to-execution');
  });
});
