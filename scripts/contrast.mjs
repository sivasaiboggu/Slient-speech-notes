import { readFileSync } from 'node:fs';

const tokens = JSON.parse(readFileSync(new URL('../tokens.json', import.meta.url), 'utf8'));
function luminance({ hex }) {
  const channels = hex.slice(1).match(/.{2}/g).map(channel => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function color(theme, name) {
  const value = tokens.themes[theme][name] ?? tokens.fixed[name];
  return typeof value === 'string' ? tokens.neutral[value] : value;
}

const cases = [
  ['Primary text on paper', 'ink', 'paper', 4.5],
  ['Primary text on controls', 'ink', 'surface', 4.5],
  ['Primary text on hover controls', 'ink', 'raised', 4.5],
  ['Secondary text on paper', 'secondary', 'paper', 4.5],
  ['Tracking labels on paper', 'muted', 'paper', 4.5],
  ['Link and focus color on paper', 'accent', 'paper', 4.5],
  ['Focus against control fill', 'accent', 'surface', 3],
  ['Control outline against paper', 'outline', 'paper', 3],
  ['Primary control text', 'action-text', 'action', 4.5],
  ['Primary control hover text', 'action-text', 'action-hover', 4.5],
  ['Primary control pressed text', 'action-text', 'action-active', 4.5],
  ['Model ready label on paper', 'success', 'paper', 4.5],
  ['Model warning label on paper', 'warning', 'paper', 4.5],
  ['Recording control on surface', 'danger', 'surface', 4.5],
  ['Recording control on hover surface', 'danger', 'raised', 4.5],
  ['Viewfinder label on fixed stage', 'stage-muted', 'stage', 4.5],
  ['Live labels on opaque badge', 'stage-ink', 'stage-badge', 4.5],
  ['Recording timer on opaque badge', 'stage-record', 'stage-badge', 4.5],
  ['Contour against dark keyline', 'signal', 'signal-keyline', 3],
];

console.log('| Pair | Light | Dark | Minimum |');
console.log('| --- | ---: | ---: | ---: |');
for (const [label, foreground, background, minimum] of cases) {
  const results = ['light', 'dark'].map(theme => {
    const values = [foreground, background].map(name => luminance(color(theme, name)));
    const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    if (ratio < minimum) process.exitCode = 1;
    return ratio.toFixed(2) + ':1';
  });
  console.log('| ' + [label, ...results, minimum + ':1'].join(' | ') + ' |');
}
