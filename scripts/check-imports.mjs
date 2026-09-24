/**
 * 离线导入自检脚本（不装任何依赖，纯 Node）。
 *
 * 为什么需要它：本仓库刻意**不预装依赖**（安装命令交给人工执行），
 * 在没装 typescript 的环境里 `tsc --noEmit` 跑不起来，跨模块的「名字拼错 / 忘了 export」
 * 就只能靠肉眼。这个脚本用正则做一遍近似但快速的检查：
 *   1. `import { a, b } from './x.js'` → 目标文件里必须真的 `export` 了 a/b（含 type 导出）；
 *   2. 相对路径必须能落到实际存在的 `.ts` 文件（本仓库用 `.js` 后缀写 import，需映射回 `.ts`）；
 *   3. `@retake/core` 的导入按 workspace 别名解析到 packages/core/src/index.ts 的再导出集合。
 *
 * 用法：`node scripts/check-imports.mjs`（发现问题时退出码 1 并打印清单）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [path.join(ROOT, 'packages/core/src'), path.join(ROOT, 'packages/server/src')];

/** 把块注与行注剔掉（文档注释里的 `import { ... } from '...'` 例子会被正则误捕）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 收集一个文件里的全部导出名（export const/function/class/interface/type/enum + export * from 的再导出）。 */
function collectExports(file, seen = new Set()) {
  const names = new Set();
  if (seen.has(file)) {
    return names;
  }
  seen.add(file);
  const src = stripComments(readFileSync(file, 'utf8'));
  const direct = [
    /export\s+(?:declare\s+)?(?:const|let|var|function\*?|async\s+function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/g,
    /export\s*\{([^}]*)\}/g,
  ];
  for (const re of direct) {
    for (const match of src.matchAll(re)) {
      const chunk = match[1];
      if (!chunk) {
        continue;
      }
      // export { a, b as c } → 取 as 之后的对外名
      for (const piece of chunk.split(',')) {
        const token = piece.trim();
        if (token.length === 0) {
          continue;
        }
        const asMatch = token.match(/\bas\s+([A-Za-z0-9_$]+)$/);
        names.add(asMatch ? asMatch[1] : token.replace(/^type\s+/, ''));
      }
    }
  }
  // export * from './x.js' → 递归并入
  for (const match of src.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
    const target = resolveSpec(match[1], file);
    if (target) {
      for (const name of collectExports(target, seen)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** 把 import 说明符解析成实际 .ts 文件（本仓库统一写 .js 后缀）。 */
function resolveSpec(spec, fromFile) {
  if (spec === '@retake/core') {
    return path.join(ROOT, 'packages/core/src/index.ts');
  }
  if (!spec.startsWith('.')) {
    return null; // 第三方包（fastify 等）交给 tsc / 运行时
  }
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) {
      return candidate;
    }
  }
  return null;
}

const problems = [];
const exportCache = new Map();

function exportsOf(file) {
  if (!exportCache.has(file)) {
    exportCache.set(file, collectExports(file));
  }
  return exportCache.get(file);
}

for (const dir of SCAN_DIRS) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) {
        continue;
      }
      const src = stripComments(readFileSync(full, 'utf8'));
      for (const match of src.matchAll(/import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+'([^']+)'/g)) {
        const [, rawNames, spec] = match;
        const target = resolveSpec(spec, full);
        if (!target) {
          if (spec.startsWith('.')) {
            problems.push(`${rel(full)}: 找不到相对模块 ${spec}`);
          }
          continue;
        }
        const available = exportsOf(target);
        for (const piece of rawNames.split(',')) {
          const token = piece.trim().replace(/^type\s+/, '');
          if (token.length === 0) {
            continue;
          }
          const name = token.split(/\s+as\s+/)[0].trim();
          if (!available.has(name)) {
            problems.push(`${rel(full)}: ${spec} 未导出 "${name}"`);
          }
        }
      }
      // 相对路径存在性（默认导入 / 命名空间导入）
      for (const match of src.matchAll(/import\s+[A-Za-z0-9_$]+\s+from\s+'(\.[^']+)'/g)) {
        if (!resolveSpec(match[1], full)) {
          problems.push(`${rel(full)}: 找不到相对模块 ${match[1]}`);
        }
      }
    }
  }
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

if (problems.length > 0) {
  console.error(`发现 ${problems.length} 处导入问题：`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
} else {
  console.log('导入自检通过：所有相对模块可解析，且命名导入均能在目标文件找到 export。');
}
