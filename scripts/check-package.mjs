// Fails if the npm package would ship anything other than the built script, its map and the standard files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const expected = ['LICENSE', 'README.md', 'dist/consentbridge.min.js', 'dist/consentbridge.min.js.map', 'package.json'];

const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = pack.files.map((f) => f.path).sort();
if (files.join() !== expected.join()) {
  throw new Error(`unexpected package contents: ${files.join(', ')}`);
}

const min = readFileSync('dist/consentbridge.min.js', 'utf8');
if (!min.endsWith('//# sourceMappingURL=consentbridge.min.js.map')) {
  throw new Error('dist/consentbridge.min.js does not end with its sourceMappingURL');
}

const map = JSON.parse(readFileSync('dist/consentbridge.min.js.map', 'utf8'));
if (!map.sourcesContent?.[0]) {
  throw new Error('source map does not embed the source');
}

console.log(`package ok: ${files.length} files`);
