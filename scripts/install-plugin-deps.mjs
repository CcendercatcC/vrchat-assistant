// 安装官方插件自带的依赖（若插件目录内有 package.json，则对该目录执行 npm ci --prefix）。
// 用途：仓库根 `npm run install-plugins`，或在 CI 里 `npm ci`（根依赖）之后调用，保证每个带第三方依赖的插件可加载。
// 无 package.json 的插件直接跳过（零依赖插件如 auth-guard/booth 等）。跨平台（Win/Linux/mac/NAS/容器）。
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OFFICIAL = path.join(repoRoot, 'plugins', 'official');
const LOCAL = path.join(repoRoot, 'plugins', 'local');

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function installPluginsIn(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) continue; // 零依赖插件，无 package.json，跳过
    console.log(`[install-plugins] npm ci --prefix ${path.relative(repoRoot, dir)}`);
    // Windows 上 npm 是 npm.cmd，不能直接 CreateProcess 启动；shell:true 走 cmd /c（Unix 走 sh -c），跨平台一致
    execFileSync(npmBin, ['ci', '--prefix', dir], { stdio: 'inherit', cwd: repoRoot, shell: true });
    count++;
  }
  return count;
}

let n = 0;
n += installPluginsIn(OFFICIAL);
n += installPluginsIn(LOCAL);
console.log(`[install-plugins] 完成，共安装 ${n} 个插件依赖。`);
