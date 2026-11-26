#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PREFIX = '@moonwitness/orm-';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function parseRootArg(argv) {
  const idx = argv.indexOf('--root');
  if (idx !== -1 && typeof argv[idx + 1] === 'string' && argv[idx + 1].trim() !== '') {
    return path.resolve(argv[idx + 1]);
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, '..');
}

async function collectFiles(dirPath) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return results;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

async function main() {
  const rootDir = parseRootArg(process.argv.slice(2));
  const srcDir = path.join(rootDir, 'src');
  const violations = [];

  const srcStat = await stat(srcDir).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    console.error(`[check-zero-orm-imports] Missing src/ directory at ${srcDir}`);
    process.exit(1);
  }

  const files = await collectFiles(srcDir);
  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (line.includes(FORBIDDEN_PREFIX)) {
        violations.push({
          file: path.relative(rootDir, filePath),
          line: index + 1,
          snippet: line.trim(),
        });
      }
    });
  }

  const pkgPath = path.join(rootDir, 'package.json');
  const pkgRaw = await readFile(pkgPath, 'utf8').catch(() => null);
  if (pkgRaw !== null) {
    const pkg = JSON.parse(pkgRaw);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[section];
      if (deps && typeof deps === 'object') {
        for (const depName of Object.keys(deps)) {
          if (depName.startsWith(FORBIDDEN_PREFIX)) {
            violations.push({
              file: 'package.json',
              line: 0,
              snippet: `${section}.${depName}`,
            });
          }
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `[check-zero-orm-imports] FAIL: found ${violations.length} forbidden "${FORBIDDEN_PREFIX}*" reference(s):`,
    );
    for (const violation of violations) {
      const loc = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file;
      console.error(`  - ${loc}: ${violation.snippet}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-zero-orm-imports] PASS: scanned ${files.length} source file(s) under ${path.relative(process.cwd(), srcDir) || 'src'}; 0 "${FORBIDDEN_PREFIX}*" imports.`,
  );
}

await main();
