import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { minify } from 'terser';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const source = readFileSync('src/consentbridge.js', 'utf8');

const { code, map } = await minify({ 'consentbridge.js': source }, {
  compress: true,
  mangle: true,
  format: { preamble: `/*! ConsentBridge v${version} | MIT | https://github.com/rychidesign/ConsentBridge */` },
  sourceMap: { filename: 'consentbridge.min.js', url: 'consentbridge.min.js.map', includeSources: true },
});

mkdirSync('dist', { recursive: true });
writeFileSync('dist/consentbridge.min.js', code);
writeFileSync('dist/consentbridge.min.js.map', map);
console.log(`built dist/consentbridge.min.js (${code.length} bytes)`);
