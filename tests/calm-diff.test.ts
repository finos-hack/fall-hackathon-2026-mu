// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { computeStructuralDelta, summarizeCounts } from '../src/calm-diff.js';

describe('computeStructuralDelta', () => {
    it('ignores object key reordering and $schema URL bumps', () => {
        const a = {
            $schema: 'https://calm.finos.org/release/1.2/meta/calm.json',
            nodes: [{ 'unique-id': 'api', 'node-type': 'service', name: 'API' }],
            relationships: [],
        };
        const b = {
            relationships: [],
            nodes: [{ name: 'API', 'node-type': 'service', 'unique-id': 'api' }],
            $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
        };

        const delta = computeStructuralDelta(a, b);
        expect(delta.hasStructuralChange).toBe(false);
        expect(delta.hasMetadataChange).toBe(false);
    });

    it('detects added, modified, renamed, and removed nodes and relationships', () => {
        const a = {
            nodes: [
                { 'unique-id': 'svc-old', 'node-type': 'service', name: 'Worker' },
                { 'unique-id': 'legacy-db', 'node-type': 'database', name: 'Legacy DB' },
                { 'unique-id': 'api', 'node-type': 'service', name: 'API', description: 'v1' },
            ],
            relationships: [
                {
                    'unique-id': 'r-old',
                    'relationship-type': { connects: { source: { node: 'api' }, destination: { node: 'legacy-db' } } },
                },
                {
                    'unique-id': 'r-mod',
                    protocol: 'HTTP',
                    'relationship-type': { connects: { source: { node: 'api' }, destination: { node: 'svc-old' } } },
                },
            ],
        };
        const b = {
            nodes: [
                { 'unique-id': 'svc-new', 'node-type': 'service', name: 'Worker' },
                { 'unique-id': 'api', 'node-type': 'service', name: 'API', description: 'v2' },
                { 'unique-id': 'pg-db', 'node-type': 'database', name: 'Postgres' },
            ],
            relationships: [
                {
                    'unique-id': 'r-mod',
                    protocol: 'HTTPS',
                    'relationship-type': { connects: { source: { node: 'api' }, destination: { node: 'svc-new' } } },
                },
                {
                    'unique-id': 'r-new',
                    'relationship-type': { connects: { source: { node: 'api' }, destination: { node: 'pg-db' } } },
                },
            ],
        };

        const delta = computeStructuralDelta(a, b);
        expect(delta.hasStructuralChange).toBe(true);
        expect(delta.counts.nodesAdded).toBe(1);
        expect(delta.counts.nodesRemoved).toBe(1);
        expect(delta.counts.nodesModified).toBe(2);
        expect(delta.counts.relationshipsAdded).toBe(1);
        expect(delta.counts.relationshipsRemoved).toBe(1);
        expect(delta.counts.relationshipsModified).toBe(1);
        expect(delta.changeItems.some((c) => c.text.includes('Renamed node svc-old → svc-new'))).toBe(true);
    });

    it('detects architecture controls, inline controls, flows, ADRs, and metadata', () => {
        const a = {
            nodes: [
                { 'unique-id': 'gw', 'node-type': 'service', name: 'GW', controls: { tls: { description: 'v1' } } },
            ],
            relationships: [],
            controls: { audit: { description: 'v1' } },
            flows: [{ 'unique-id': 'f1', name: 'Flow 1', transitions: [] }],
            adrs: ['docs/001.md'],
            metadata: { owner: 'team-a' },
        };
        const b = {
            nodes: [
                {
                    'unique-id': 'gw',
                    'node-type': 'service',
                    name: 'GW',
                    controls: { tls: { description: 'v2' }, waf: { description: 'new' } },
                },
            ],
            relationships: [],
            controls: { soc2: { description: 'new' } },
            flows: [
                { 'unique-id': 'f1', name: 'Flow 1', transitions: [{}] },
                { 'unique-id': 'f2', name: 'Flow 2' },
            ],
            adrs: ['docs/002.md'],
            metadata: { owner: 'team-b' },
        };

        const delta = computeStructuralDelta(a, b);
        expect(delta.counts.controlsAdded).toBe(2);
        expect(delta.counts.controlsModified).toBe(1);
        expect(delta.counts.controlsRemoved).toBe(1);
        expect(delta.counts.flowsAdded).toBe(1);
        expect(delta.counts.flowsModified).toBe(1);
        expect(delta.counts.adrsAdded).toBe(1);
        expect(delta.counts.adrsRemoved).toBe(1);
        expect(delta.hasMetadataChange).toBe(true);
        expect(summarizeCounts(delta.counts, false)).toContain('controls(+2/~1/-1)');
    });

    it('supports CALM pattern schemas via prefixItems, legacy items arrays, uniqueId renames, and referenced flow URLs', () => {
        const patLegacy = {
            properties: {
                nodes: {
                    items: [
                        {
                            properties: {
                                uniqueId: { const: 'api-gateway' },
                                type: { const: 'system' },
                                name: { const: 'API Gateway' },
                            },
                        },
                    ],
                },
                relationships: {
                    items: [
                        {
                            properties: {
                                uniqueId: { const: 'rel-1' },
                                'relationship-type': {
                                    const: { connects: { source: 'consumer', destination: 'api-gateway' } },
                                },
                            },
                        },
                    ],
                },
            },
        };
        const patRenamed = {
            properties: {
                nodes: {
                    prefixItems: [
                        {
                            properties: {
                                'unique-id': { const: 'api-gateway' },
                                'node-type': { const: 'system' },
                                name: { const: 'API Gateway' },
                            },
                        },
                        {
                            properties: {
                                'unique-id': { const: 'n2' },
                                'node-type': { const: 'database' },
                            },
                        },
                    ],
                },
                relationships: {
                    prefixItems: [
                        {
                            properties: {
                                'unique-id': { const: 'rel-1' },
                                'relationship-type': {
                                    const: {
                                        connects: {
                                            source: { node: 'consumer' },
                                            destination: { node: 'api-gateway' },
                                        },
                                    },
                                },
                            },
                        },
                    ],
                },
                flows: {
                    prefixItems: [{ const: 'https://calm.finos.org/workshop/flows/signup.flow.json' }],
                },
            },
        };

        const delta = computeStructuralDelta(patLegacy, patRenamed);
        expect(delta.counts.nodesAdded).toBe(1);
        expect(delta.counts.nodesModified).toBe(1);
        expect(delta.counts.relationshipsModified).toBe(1);
        expect(delta.counts.flowsAdded).toBe(1);
        expect(delta.hasStructuralChange).toBe(true);

        const archBeforeFlow = { nodes: [], relationships: [] };
        const archWithRefFlow = {
            nodes: [],
            relationships: [],
            flows: ['https://calm.finos.org/workshop/flows/conference-signup.flow.json'],
        };
        const flowDelta = computeStructuralDelta(archBeforeFlow, archWithRefFlow);
        expect(flowDelta.counts.flowsAdded).toBe(1);
        expect(flowDelta.hasStructuralChange).toBe(true);
    });
});
