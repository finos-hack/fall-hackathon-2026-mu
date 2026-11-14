// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { computeStructuralDelta } from '../src/calm-diff.js';
import {
  buildTimelapsePayloadFromClusters,
  buildTimelapsePayloadFromTimelineFile,
  computeSuperGraphLayout,
  extractActiveControls,
  extractGraphEdges,
  extractGraphNodes,
  renderTimelapseHtml,
  writeTimelapseHtml,
} from '../src/timelapse-html.js';
import type { MomentCluster } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('timelapse-html', () => {
  it('extracts nodes and edges from standard CALM and pattern prefixItems schemas', () => {
    const standardDoc = {
      nodes: [
        { 'unique-id': 'user', name: 'Trader', 'node-type': 'actor' },
        { 'unique-id': 'gw', name: 'API Gateway', 'node-type': 'service' },
        { 'unique-id': 'db', name: 'Orders DB', 'node-type': 'database' },
      ],
      relationships: [
        {
          'unique-id': 'r1',
          protocol: 'HTTPS',
          'relationship-type': {
            interacts: { actor: 'user', nodes: ['gw'] },
          },
        },
        {
          'unique-id': 'r2',
          protocol: 'JDBC',
          'relationship-type': {
            connects: {
              source: { node: 'gw' },
              destination: { node: 'db' },
            },
          },
        },
      ],
    };

    const nodes = extractGraphNodes(standardDoc);
    const edges = extractGraphEdges(standardDoc);
    expect(nodes.map((n) => n.id)).toEqual(['user', 'gw', 'db']);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ source: 'user', target: 'gw', relType: 'interacts' });
    expect(edges[1]).toMatchObject({ source: 'gw', target: 'db', relType: 'connects' });

    const patternDoc = {
      properties: {
        nodes: {
          prefixItems: [
            {
              properties: {
                'unique-id': { const: 'p1' },
                name: { const: 'Pattern Svc' },
                'node-type': { const: 'service' },
              },
            },
          ],
        },
      },
    };
    expect(extractGraphNodes(patternDoc)).toEqual([
      { id: 'p1', name: 'Pattern Svc', nodeType: 'service', description: undefined },
    ]);
  });

  it('computes deterministic layered super-graph layout even with cycles', () => {
    const nodes = [
      { id: 'a', name: 'Actor', nodeType: 'actor' },
      { id: 'b', name: 'Service B', nodeType: 'service' },
      { id: 'c', name: 'Service C', nodeType: 'service' },
    ];
    const edges = [
      { id: 'e1', source: 'a', target: 'b', label: 'HTTPS', relType: 'connects' },
      { id: 'e2', source: 'b', target: 'c', label: 'gRPC', relType: 'connects' },
      { id: 'e3', source: 'c', target: 'b', label: 'callback', relType: 'connects' },
    ];

    const layout = computeSuperGraphLayout(nodes, edges);
    expect(layout.positions['a'].layer).toBeLessThanOrEqual(layout.positions['b'].layer);
    expect(layout.positions['c']).toBeDefined();
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(960);
    expect(layout.canvasHeight).toBeGreaterThanOrEqual(540);
  });

  it('builds payload from clusters, tracks removed/added nodes, and escapes script tags in HTML', () => {
    const doc1 = {
      nodes: [
        { 'unique-id': 'web', name: 'Web UI </script>', 'node-type': 'web-client' },
        { 'unique-id': 'legacy', name: 'Legacy Monolith', 'node-type': 'service' },
      ],
      relationships: [
        {
          'unique-id': 'r1',
          'relationship-type': {
            connects: { source: { node: 'web' }, destination: { node: 'legacy' } },
          },
        },
      ],
    };
    const doc2 = {
      nodes: [
        { 'unique-id': 'web', name: 'Web UI </script>', 'node-type': 'web-client' },
        { 'unique-id': 'orders', name: 'Orders Service', 'node-type': 'service' },
      ],
      relationships: [
        {
          'unique-id': 'r2',
          'relationship-type': {
            connects: { source: { node: 'web' }, destination: { node: 'orders' } },
          },
        },
      ],
    };

    const d1 = computeStructuralDelta(null, doc1);
    const d2 = computeStructuralDelta(doc1, doc2);

    const clusters: MomentCluster[] = [
      {
        startIndex: 0,
        endIndex: 0,
        uniqueId: 'moment-01',
        name: 'Initial System',
        description: 'Baseline monolith',
        validFrom: '2026-01-01T00:00:00Z',
        adrs: ['docs/adr/001.md'],
        commits: [
          {
            commit: {
              sha: '1111111111111111',
              shortSha: '1111111',
              date: '2026-01-01T00:00:00Z',
              author: 'Dev',
              subject: 'init',
              body: '',
              historicalPath: 'arch.json',
              coChangedAdrs: ['docs/adr/001.md'],
              document: doc1,
            },
            isInitial: true,
            changeItems: d1.changeItems,
            counts: d1.counts,
            summaryLine: 'Initial architecture',
          },
        ],
        mergedChangeItems: d1.changeItems,
        snapshotDocument: doc1,
      },
      {
        startIndex: 1,
        endIndex: 1,
        uniqueId: 'moment-02',
        name: 'Extract Orders Service',
        description: 'Replace legacy monolith',
        validFrom: '2026-01-02T00:00:00Z',
        adrs: [],
        commits: [
          {
            commit: {
              sha: '2222222222222222',
              shortSha: '2222222',
              date: '2026-01-02T00:00:00Z',
              author: 'Dev',
              subject: 'extract orders',
              body: '',
              historicalPath: 'arch.json',
              coChangedAdrs: [],
              document: doc2,
            },
            isInitial: false,
            changeItems: d2.changeItems,
            counts: d2.counts,
            summaryLine: '+1 node, -1 node',
          },
        ],
        mergedChangeItems: d2.changeItems,
        snapshotDocument: doc2,
      },
    ];

    const payload = buildTimelapsePayloadFromClusters(clusters, {
      sourceFile: '/some/local/path/arch.json',
      engine: 'deterministic',
    });

    expect(payload.sourceFile).toBe('arch.json');
    expect(payload.frames).toHaveLength(2);
    expect(payload.frames[1].addedNodeIds).toEqual(['orders']);
    expect(payload.frames[1].removedNodeIds).toEqual(['legacy']);
    expect(payload.positions['legacy']).toBeDefined();

    const html = renderTimelapseHtml(payload);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).not.toContain('Web UI </script>');
    expect(html).toContain('id="focus-select"');
    expect(html).toContain('id="focus-isolate"');
    expect(html).toContain('id="node-inspector"');

    const scriptBlocks = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scriptBlocks).toHaveLength(1);
    expect(() => new Function(scriptBlocks[0][1])).not.toThrow();
  });

  it('builds payload from a saved calm-timeline JSON file and writes HTML', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-timelapse-html-'));
    tempDirs.push(dir);

    const snap1 = path.join(dir, 'snapshots', 'moment-01.json');
    fs.mkdirSync(path.dirname(snap1), { recursive: true });
    fs.writeFileSync(
      snap1,
      JSON.stringify({
        nodes: [{ 'unique-id': 'svc', name: 'Svc', 'node-type': 'service' }],
        relationships: [],
      }),
    );

    const timelinePath = path.join(dir, 'timeline.json');
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({
        $schema: 'https://calm.finos.org/release/1.3/meta/calm-timeline.json',
        'current-moment': 'moment-01',
        moments: [
          {
            'unique-id': 'moment-01',
            'node-type': 'moment',
            name: 'Moment 1',
            description: 'Initial',
            details: {
              'detailed-architecture': 'snapshots/moment-01.json',
            },
          },
        ],
      }),
    );

    const payload = buildTimelapsePayloadFromTimelineFile(timelinePath);
    expect(payload.engine).toBe('manual-timeline');
    expect(payload.sourceFile).toBe('timeline.json');
    expect(payload.frames).toHaveLength(1);
    expect(payload.frames[0].validFrom).toBe('');
    expect(payload.frames[0].nodes[0].id).toBe('svc');

    const outHtml = path.join(dir, 'out.html');
    const written = writeTimelapseHtml(outHtml, payload);
    expect(fs.existsSync(written)).toBe(true);
  });

  it('extracts and deduplicates top-level and node-level CALM controls', () => {
    const doc = {
      nodes: [
        {
          'unique-id': 'gw',
          name: 'API Gateway',
          'node-type': 'service',
          controls: {
            'mtls-everywhere': {
              description: '',
              requirements: [{ 'requirement-url': 'https://calm.finos.org/req/mtls' }],
            },
            'rate-limit': {
              description: 'Enforce 1000 req/s per client',
              requirements: [
                { 'requirement-url': 'https://calm.finos.org/req/rate-1' },
                { 'requirement-url': 'https://calm.finos.org/req/rate-2' },
              ],
            },
          },
        },
        {
          'unique-id': 'vault',
          name: 'Audit Vault',
          'node-type': 'storage',
          controls: {
            'sec-17a4-worm': {
              description: 'Immutable WORM retention',
            },
          },
        },
      ],
      controls: {
        'mtls-everywhere': {
          description: 'All east-west service traffic must use mTLS 1.3.',
          requirements: [
            { 'requirement-url': 'https://calm.finos.org/req/mtls-1' },
            { 'requirement-url': 'https://calm.finos.org/req/mtls-2' },
          ],
        },
      },
    };

    const controls = extractActiveControls(doc);
    expect(controls).toEqual([
      {
        id: 'mtls-everywhere',
        description: 'All east-west service traffic must use mTLS 1.3.',
        requirementCount: 2,
      },
      {
        id: 'rate-limit',
        description: 'Enforce 1000 req/s per client',
        requirementCount: 2,
      },
      {
        id: 'sec-17a4-worm',
        description: 'Immutable WORM retention',
        requirementCount: 0,
      },
    ]);

    const nodes = extractGraphNodes(doc);
    expect(nodes[0].controlCount).toBe(2);
    expect(nodes[1].controlCount).toBe(1);
  });

  it('computes 18-node barycenter layout minimizing edge crossings with generous spacing', () => {
    const nodes = [
      { id: 'l0-alpha', name: 'Alpha Gateway', nodeType: 'actor' },
      { id: 'l0-zeta', name: 'Zeta Gateway', nodeType: 'actor' },

      { id: 'l1-a-zeta', name: 'A-Service (for Zeta)', nodeType: 'service' },
      { id: 'l1-b-zeta', name: 'B-Service (for Zeta)', nodeType: 'service' },
      { id: 'l1-c-alpha', name: 'C-Service (for Alpha)', nodeType: 'service' },
      { id: 'l1-d-alpha', name: 'D-Service (for Alpha)', nodeType: 'service' },
      { id: 'l1-e-alpha', name: 'E-Service (for Alpha)', nodeType: 'service' },
      { id: 'l1-f-zeta', name: 'F-Service (for Zeta)', nodeType: 'service' },

      { id: 'l2-a', name: 'A-Worker', nodeType: 'service' },
      { id: 'l2-b', name: 'B-Worker', nodeType: 'service' },
      { id: 'l2-c', name: 'C-Worker', nodeType: 'service' },
      { id: 'l2-d', name: 'D-Worker', nodeType: 'service' },
      { id: 'l2-e', name: 'E-Worker', nodeType: 'service' },

      { id: 'l3-db1', name: 'Alpha Ledger DB', nodeType: 'database' },
      { id: 'l3-db2', name: 'Zeta Ledger DB', nodeType: 'database' },
      { id: 'l3-cache', name: 'Quote Cache', nodeType: 'database' },
      { id: 'l3-vault', name: 'WORM Vault', nodeType: 'storage' },
      { id: 'l3-otel', name: 'OTel Collector', nodeType: 'infrastructure' },
    ];

    const edges = [
      { id: 'e1', source: 'l0-zeta', target: 'l1-a-zeta', label: 'HTTPS', relType: 'connects' },
      { id: 'e2', source: 'l0-zeta', target: 'l1-b-zeta', label: 'HTTPS', relType: 'connects' },
      { id: 'e3', source: 'l0-zeta', target: 'l1-f-zeta', label: 'HTTPS', relType: 'connects' },
      { id: 'e4', source: 'l0-alpha', target: 'l1-c-alpha', label: 'HTTPS', relType: 'connects' },
      { id: 'e5', source: 'l0-alpha', target: 'l1-d-alpha', label: 'HTTPS', relType: 'connects' },
      { id: 'e6', source: 'l0-alpha', target: 'l1-e-alpha', label: 'HTTPS', relType: 'connects' },

      { id: 'e7', source: 'l1-c-alpha', target: 'l2-d', label: 'gRPC', relType: 'connects' },
      { id: 'e8', source: 'l1-d-alpha', target: 'l2-e', label: 'gRPC', relType: 'connects' },
      { id: 'e9', source: 'l1-a-zeta', target: 'l2-a', label: 'gRPC', relType: 'connects' },
      { id: 'e10', source: 'l1-b-zeta', target: 'l2-b', label: 'gRPC', relType: 'connects' },
      { id: 'e11', source: 'l1-f-zeta', target: 'l2-c', label: 'gRPC', relType: 'connects' },

      { id: 'e12', source: 'l2-d', target: 'l3-db1', label: 'JDBC', relType: 'connects' },
      { id: 'e13', source: 'l2-e', target: 'l3-cache', label: 'RESP', relType: 'connects' },
      { id: 'e14', source: 'l2-a', target: 'l3-db2', label: 'JDBC', relType: 'connects' },
      { id: 'e15', source: 'l2-b', target: 'l3-vault', label: 'HTTPS', relType: 'connects' },
      { id: 'e16', source: 'l2-c', target: 'l3-otel', label: 'OTLP', relType: 'connects' },
    ];

    const layout = computeSuperGraphLayout(nodes, edges);
    expect(Object.keys(layout.positions)).toHaveLength(18);

    const coordSet = new Set(
      Object.values(layout.positions).map((p) => `${p.x}:${p.y}`),
    );
    expect(coordSet.size).toBe(18);

    const xs = [...new Set(Object.values(layout.positions).map((p) => p.x))].sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThanOrEqual(4);
    expect(xs[1] - xs[0]).toBe(290);

    expect(layout.positions['l0-alpha'].y).toBeLessThan(layout.positions['l0-zeta'].y);
    expect(layout.positions['l1-c-alpha'].y).toBeLessThan(layout.positions['l1-a-zeta'].y);
    expect(layout.positions['l1-d-alpha'].y).toBeLessThan(layout.positions['l1-b-zeta'].y);
  });

  it('hydrates moment metadata, raw stats, controls, and compliance UI elements from timeline file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-timelapse-compliance-'));
    tempDirs.push(dir);

    const snap1 = path.join(dir, 'snapshots', 'm1.json');
    const snap2 = path.join(dir, 'snapshots', 'm2.json');
    fs.mkdirSync(path.dirname(snap1), { recursive: true });
    fs.writeFileSync(
      snap1,
      JSON.stringify({
        nodes: [
          { 'unique-id': 'web', name: 'Web UI', 'node-type': 'web-client' },
          { 'unique-id': 'api', name: 'Core API', 'node-type': 'service' },
        ],
        relationships: [
          {
            'unique-id': 'r1',
            protocol: 'HTTPS',
            'relationship-type': {
              connects: { source: { node: 'web' }, destination: { node: 'api' } },
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      snap2,
      JSON.stringify({
        nodes: [
          { 'unique-id': 'web', name: 'Web UI', 'node-type': 'web-client' },
          {
            'unique-id': 'api',
            name: 'Core API',
            'node-type': 'service',
            controls: {
              'mtls-strict': {
                description: 'Enforce mTLS on all internal calls',
                requirements: [{ 'requirement-url': 'https://calm.finos.org/req/mtls' }],
              },
            },
          },
        ],
        relationships: [
          {
            'unique-id': 'r1',
            protocol: 'HTTPS',
            'relationship-type': {
              connects: { source: { node: 'web' }, destination: { node: 'api' } },
            },
          },
        ],
        controls: {
          'sec-audit': {
            description: 'SEC 17a-4 immutable audit logging',
            requirements: [{ 'requirement-url': 'https://calm.finos.org/req/sec' }],
          },
        },
      }),
    );

    const timelinePath = path.join(dir, 'timeline.json');
    fs.writeFileSync(
      timelinePath,
      JSON.stringify({
        $schema: 'https://calm.finos.org/release/1.3/meta/calm-timeline.json',
        'current-moment': 'm2',
        metadata: {
          'clustering-engine': 'clusters-file',
          'total-commits-scanned': '40',
          'noise-commits-filtered': '5',
          'structural-commits-retained': '35',
        },
        moments: [
          {
            'unique-id': 'm1',
            'node-type': 'moment',
            name: 'Initial Web Platform',
            description: 'Baseline web and API',
            'valid-from': '2026-01-01',
            details: { 'detailed-architecture': 'snapshots/m1.json' },
            adrs: ['adrs/001-baseline.md'],
            metadata: {
              commits: ['aaa1111', 'bbb2222'],
              'commit-messages': ['feat: init web', 'feat: init api'],
              'commit-count': 2,
            },
          },
          {
            'unique-id': 'm2',
            'node-type': 'moment',
            name: 'Zero-Trust Hardening',
            description: 'Added mTLS and SEC 17a-4 controls',
            'valid-from': '2026-02-01',
            details: { 'detailed-architecture': 'snapshots/m2.json' },
            adrs: ['adrs/002-mtls.md'],
            metadata: {
              commits: ['ccc3333'],
              'commit-messages': ['feat: enforce mTLS and audit controls'],
              'commit-count': 1,
            },
          },
        ],
      }),
    );

    const payload = buildTimelapsePayloadFromTimelineFile(timelinePath);
    expect(payload.engine).toBe('clusters-file');
    expect(payload.stats).toEqual({
      totalCommitsScanned: 40,
      noiseCommitsFiltered: 5,
      structuralCommitsRetained: 35,
      momentsGenerated: 2,
    });
    expect(payload.frames[0].commits).toEqual(['aaa1111', 'bbb2222']);
    expect(payload.frames[0].commitMessages).toEqual(['feat: init web', 'feat: init api']);
    expect(payload.frames[0].commitCount).toBe(2);
    expect(payload.frames[1].controls).toHaveLength(2);
    expect(payload.frames[1].controls?.map((c) => c.id)).toEqual(['sec-audit', 'mtls-strict']);

    const html = renderTimelapseHtml(payload);
    expect(html).toContain('id="badge-funnel"');
    expect(html).toContain('40 commits -&gt; 5 noise filtered -&gt; 2 moments');
    expect(html).toContain('id="as-of-date"');
    expect(html).toContain('id="compare-select"');
    expect(html).toContain('id="btn-reset-compare"');
    expect(html).toContain('id="governance-card"');
    expect(html).toContain('id="btn-zoom-in"');
    expect(html).toContain('id="btn-zoom-out"');
    expect(html).toContain('id="btn-zoom-fit"');
    expect(html).toContain('id="focus-select"');
    expect(html).toContain('id="focus-isolate"');
    expect(html).toContain('id="btn-reset-focus"');
    expect(html).toContain('id="node-inspector"');
    expect(html).toContain('id="playback-bar"');
    expect(html).toContain('id="scrubber-label"');
    expect(html).toContain('height: 100dvh;');
    expect(html).toContain('overflow: hidden;');

    const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scriptMatches).toHaveLength(2);
    expect(() => JSON.parse(scriptMatches[0][1])).not.toThrow();
    expect(() => new vm.Script(scriptMatches[1][1])).not.toThrow();
  });

  it('passes optional stats through buildTimelapsePayloadFromClusters', () => {
    const doc = {
      nodes: [{ 'unique-id': 's1', name: 'Service 1', 'node-type': 'service' }],
      relationships: [],
      controls: {
        'ctrl-1': { description: 'Control 1', requirements: [{ 'requirement-url': 'https://example.com' }] },
      },
    };
    const d1 = computeStructuralDelta(null, doc);
    const payload = buildTimelapsePayloadFromClusters(
      [
        {
          startIndex: 0,
          endIndex: 0,
          uniqueId: 'm1',
          name: 'Init',
          description: 'Init',
          validFrom: '2026-01-01',
          adrs: [],
          commits: [
            {
              commit: {
                sha: '11111111',
                shortSha: '1111111',
                date: '2026-01-01',
                author: 'Dev',
                subject: 'init',
                body: '',
                historicalPath: 'arch.json',
                coChangedAdrs: [],
                document: doc,
              },
              isInitial: true,
              changeItems: d1.changeItems,
              counts: d1.counts,
              summaryLine: 'Init',
            },
          ],
          mergedChangeItems: d1.changeItems,
          snapshotDocument: doc,
        },
      ],
      {
        sourceFile: 'arch.json',
        engine: 'deterministic',
        stats: {
          totalCommitsScanned: 12,
          noiseCommitsFiltered: 3,
          structuralCommitsRetained: 9,
        },
      },
    );

    expect(payload.stats).toEqual({
      totalCommitsScanned: 12,
      noiseCommitsFiltered: 3,
      structuralCommitsRetained: 9,
      momentsGenerated: 1,
    });
    expect(payload.frames[0].controls).toEqual([
      { id: 'ctrl-1', description: 'Control 1', requirementCount: 1 },
    ]);
  });
});
