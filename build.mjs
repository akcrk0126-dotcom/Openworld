/**
 * build.mjs — emits dist/index.html, a single self-contained file.
 *
 * The modular source is the thing you edit. This exists because a multi-file
 * ES module project only runs when every file is served from its correct
 * relative path: preview a lone index.html and `./src/main.js` 404s, and the
 * page dies before any of its own error handling can run.
 *
 * The flattening is deliberately naive — it strips relative imports and the
 * `export` keyword and concatenates in dependency order. That works because the
 * source obeys two rules: no circular imports, and no duplicate module-scope
 * identifiers. Both are checked below and the build fails loudly if broken.
 *
 *   node build.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** Dependency order. Leaves first. */
const MODULES = [
  'src/core/BootScreen.js',
  'src/core/Engine.js',
  'src/physics/PhysicsWorld.js',
  'src/destruction/ConvexFracture.js',
  'src/destruction/FracturePatternLibrary.js',
  'src/destruction/ShardPool.js',
  'src/world/DestructibleChunk.js',
  'src/destruction/DestructionManager.js',
  'src/gameplay/FreeLookController.js',
  'src/main.js',
];

const RELATIVE_IMPORT = /^\s*import\s+[\s\S]*?from\s+['"]\.[^'"]*['"];?\s*$/gm;
const THREE_IMPORT = /^\s*import\s+\*\s+as\s+THREE\s+from\s+['"]three['"];?\s*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm;

function strip(source) {
  return source
    .replace(RELATIVE_IMPORT, '')
    .replace(THREE_IMPORT, '')
    .replace(EXPORT_KEYWORD, '')
    .trim();
}

/** Guard the two assumptions the naive concatenation relies on. */
function assertNoDuplicateTopLevelNames(chunks) {
  const seen = new Map();
  const declaration = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

  for (const { path, code } of chunks) {
    for (const match of code.matchAll(declaration)) {
      const name = match[1];
      if (seen.has(name)) {
        throw new Error(
          `Duplicate top-level identifier "${name}" in ${path} and ${seen.get(name)}.\n` +
          `Single-file bundling puts every module in one scope. Rename one of them.`
        );
      }
      seen.set(name, path);
    }
  }
  return seen.size;
}

const chunks = [];
for (const path of MODULES) {
  const raw = await readFile(join(root, path), 'utf8');
  chunks.push({ path, code: strip(raw) });
}

const identifiers = assertNoDuplicateTopLevelNames(chunks);

const bundle = chunks
  .map(({ path, code }) => `// ${'='.repeat(72)}\n// ${path}\n// ${'='.repeat(72)}\n\n${code}`)
  .join('\n\n');

const template = await readFile(join(root, 'index.html'), 'utf8');

const inlined = template.replace(
  /<script id="entry" type="module" src="\.\/src\/main\.js"><\/script>/,
  `<script type="module">\nimport * as THREE from 'three';\n\n${bundle}\n</script>`
);

if (inlined === template) {
  throw new Error('Could not find the entry <script> tag in index.html — template changed?');
}

await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist', 'index.html'), inlined, 'utf8');

const kb = (Buffer.byteLength(inlined) / 1024).toFixed(1);
console.log(`dist/index.html  ${kb} kB  (${MODULES.length} modules, ${identifiers} top-level names)`);
