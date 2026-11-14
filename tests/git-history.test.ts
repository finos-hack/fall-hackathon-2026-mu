// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractGitHistory, filterStructuralCommits } from '../src/git-history.js';

let tempDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calm-tl-git-'));
});

afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('extractGitHistory and filterStructuralCommits', () => {
    it('follows git mv renames, skips broken JSON, filters noise commits, and links co-changed ADRs', () => {
        const repoDir = path.join(tempDir, 'repo');
        fs.mkdirSync(repoDir, { recursive: true });

        const git = (args: string[], commitDate?: string) => {
            const env = commitDate
                ? { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate }
                : process.env;
            execFileSync('git', args, { cwd: repoDir, env, stdio: 'ignore' });
        };

        git(['init']);
        git(['config', 'user.email', 'dev@finos.org']);
        git(['config', 'user.name', 'FINOS Dev']);

        fs.mkdirSync(path.join(repoDir, 'legacy'), { recursive: true });
        fs.writeFileSync(
            path.join(repoDir, 'legacy', 'arch.json'),
            JSON.stringify(
                {
                    $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
                    nodes: [{ 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' }],
                    relationships: [],
                },
                null,
                2,
            ),
        );
        git(['add', '.']);
        git(['commit', '-m', 'feat: initial gateway'], '2026-03-01T10:00:00Z');

        fs.mkdirSync(path.join(repoDir, 'arch'), { recursive: true });
        git(['mv', 'legacy/arch.json', 'arch/system.calm.json']);
        fs.writeFileSync(
            path.join(repoDir, 'arch', 'system.calm.json'),
            JSON.stringify(
                {
                    relationships: [],
                    nodes: [{ name: 'Gateway', 'node-type': 'service', 'unique-id': 'gw' }],
                    $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
                },
                null,
                2,
            ),
        );
        git(['add', '.']);
        git(['commit', '-m', 'chore: move architecture file'], '2026-03-02T10:00:00Z');

        fs.writeFileSync(path.join(repoDir, 'arch', 'system.calm.json'), '{ broken json');
        git(['add', '.']);
        git(['commit', '-m', 'wip: broken'], '2026-03-03T10:00:00Z');

        fs.mkdirSync(path.join(repoDir, 'docs', 'decisions'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'docs', 'decisions', '001-db.md'), '# Add DB');
        fs.writeFileSync(
            path.join(repoDir, 'arch', 'system.calm.json'),
            JSON.stringify(
                {
                    $schema: 'https://calm.finos.org/release/1.3/meta/calm.json',
                    nodes: [
                        { 'unique-id': 'gw', 'node-type': 'service', name: 'Gateway' },
                        { 'unique-id': 'db', 'node-type': 'database', name: 'Ledger DB' },
                    ],
                    relationships: [
                        {
                            'unique-id': 'gw-db',
                            'relationship-type': { connects: { source: { node: 'gw' }, destination: { node: 'db' } } },
                        },
                    ],
                },
                null,
                2,
            ),
        );
        git(['add', '.']);
        git(['commit', '-m', 'feat: add ledger db'], '2026-03-04T10:00:00Z');

        const history = extractGitHistory(path.join(repoDir, 'arch', 'system.calm.json'));
        expect(history.totalCommitsScanned).toBe(4);
        expect(history.commits).toHaveLength(3);
        expect(history.commits[2].coChangedAdrs).toEqual(['docs/decisions/001-db.md']);

        const { deltas, noiseCommitsFiltered } = filterStructuralCommits(history.commits);
        expect(noiseCommitsFiltered).toBe(1);
        expect(deltas).toHaveLength(2);
        expect(deltas[1].counts.nodesAdded).toBe(1);
        expect(deltas[1].counts.relationshipsAdded).toBe(1);
    });

    it('throws when no git history exists for target file', () => {
        const repoDir = path.join(tempDir, 'empty-repo');
        fs.mkdirSync(repoDir, { recursive: true });
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'dev@finos.org'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'FINOS Dev'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'README.md'), 'init');
        execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

        const untracked = path.join(repoDir, 'untracked.json');
        fs.writeFileSync(untracked, '{}');

        expect(() => extractGitHistory(untracked)).toThrow(/No Git commit history found/);
    });

    it('throws clear errors for nonexistent paths and non-git directories instead of spawnSync ENOENT', () => {
        const missingOutsideRepo = path.join(tempDir, 'missing-dir', 'missing-subdir', 'arch.calm.json');
        expect(() => extractGitHistory(missingOutsideRepo)).toThrow(/Path does not exist/);

        const plainFile = path.join(tempDir, 'plain.json');
        fs.writeFileSync(plainFile, '{}');
        expect(() => extractGitHistory(plainFile)).toThrow(/Not inside a Git repository/);

        const repoDir = path.join(tempDir, 'existing-repo');
        fs.mkdirSync(repoDir, { recursive: true });
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'dev@finos.org'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.name', 'FINOS Dev'], { cwd: repoDir, stdio: 'ignore' });
        fs.writeFileSync(path.join(repoDir, 'README.md'), 'init');
        execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

        const missingInRepo = path.join(repoDir, 'nonexistent-folder', 'arch.calm.json');
        expect(() => extractGitHistory(missingInRepo)).toThrow(/Path does not exist/);
    });

    it('walks unlimited commits by default and forwards --first-parent when requested', () => {
        const recordedCalls: string[][] = [];
        const mockRunner = (args: string[]): string => {
            recordedCalls.push(args);
            if (args[0] === 'rev-parse') return tempDir;
            if (args[0] === 'log') {
                return '\x1e1111111111111111\x1f1111111\x1f2026-03-01\x1fDev\x1finit\x1f\x1f2026-03-01T00:00:00Z\x1darch.json\n';
            }
            if (args[0] === 'show' && args[1] === '--format=%x1e%H') {
                return '\x1e1111111111111111\narch.json\n';
            }
            return JSON.stringify({ nodes: [{ 'unique-id': 'a', name: 'A', 'node-type': 'service' }], relationships: [] });
        };

        const dummyPath = path.join(tempDir, 'arch.json');
        fs.writeFileSync(dummyPath, '{}');

        extractGitHistory(dummyPath, { gitRunner: mockRunner });
        const defaultLogCall = recordedCalls.find((c) => c[0] === 'log')!;
        expect(defaultLogCall).not.toContain('-n');
        expect(defaultLogCall).not.toContain('--first-parent');

        recordedCalls.length = 0;
        extractGitHistory(dummyPath, { gitRunner: mockRunner, firstParent: true, maxCommits: 50 });
        const customLogCall = recordedCalls.find((c) => c[0] === 'log')!;
        expect(customLogCall).toContain('--first-parent');
        expect(customLogCall).toContain('-n');
        expect(customLogCall).toContain('50');
    });
});
