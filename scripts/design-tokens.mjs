import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const tokens = JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8'));
const { neutral, fixed, themes, spacing, radius, type, elevation, motion } = tokens;
const colors = Object.fromEntries([
  ...Object.entries(neutral).map(([step, value]) => ['neutral-' + step, value]),
  ...Object.entries(fixed),
]);
const values = {
  ...Object.fromEntries(Object.entries(spacing).map(([key, value]) => ['space-' + key, value])),
  ...Object.fromEntries(Object.entries(radius).map(([key, value]) => ['radius-' + key, value])),
  ...Object.fromEntries(Object.entries(type).map(([key, value]) => ['type-' + key, value])),
  ...Object.fromEntries(Object.entries(elevation).map(([key, value]) => ['elevation-' + key, value])),
  ...Object.fromEntries(Object.entries(motion).map(([key, value]) => ['motion-' + key, value])),
};

function declarations(entries, format) {
  return Object.entries(entries).map(([key, value]) => {
    if (typeof value === 'string') {
      if (format === 'oklch') return '';
      const val = Object.hasOwn(neutral, value) ? 'var(--neutral-' + value + ')' : value;
      return '  --' + key + ': ' + val + ';\n';
    }
    return '  --' + key + ': ' + value[format] + ';\n';
  }).join('');
}

function rule(selector, entries, format) {
  return selector + ' {\n' + declarations(entries, format) + '}\n';
}

const light = { ...colors, ...themes.light, ...values };
const css = '/* Generated from tokens.json by scripts/design-tokens.mjs. */\n' +
  rule(':root', light, 'hex') + rule('[data-theme="dark"]', themes.dark, 'hex') +
  '@supports (color: oklch(0% 0 0)) {\n' +
  rule(':root', light, 'oklch').replace(/^/gm, '  ').trimEnd() + '\n' +
  rule('[data-theme="dark"]', themes.dark, 'oklch').replace(/^/gm, '  ').trimEnd() + '\n}\n';

const tailwind = '/* Tailwind CSS v4 adapter. Import after tailwindcss. */\n' +
  '@import "./tokens.css";\n\n@theme inline {\n' +
  Object.keys({ ...colors, ...themes.light }).map(key => '  --color-' + key + ': var(--' + key + ');\n').join('') +
  Object.keys(spacing).map(key => '  --spacing-ssn-' + key + ': var(--space-' + key + ');\n').join('') +
  ['display', 'heading', 'body', 'caption', 'label'].map(key => '  --text-' + key + ': var(--type-' + key + ');\n').join('') +
  '  --font-sans: var(--type-sans);\n  --font-mono: var(--type-mono);\n' +
  '  --radius-ssn-control: var(--radius-control);\n  --radius-ssn-frame: var(--radius-frame);\n' +
  '  --shadow-ssn-control: var(--elevation-control);\n  --shadow-ssn-frame: var(--elevation-frame);\n}\n';

for (const [name, content] of [['tokens.css', css], ['tailwind-theme.css', tailwind]]) {
  const file = new URL(name, root);
  if (process.argv.includes('--check')) {
    if (readFileSync(file, 'utf8') !== content) throw new Error(name + ' is out of sync with tokens.json');
  } else {
    writeFileSync(file, content);
  }
}
