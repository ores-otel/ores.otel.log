import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..');
const targetRoot = join(repositoryRoot, 'sdk', 'nodejs');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const rootPackage = await readJson(join(repositoryRoot, 'package.json'));
const { scripts: _scripts, devDependencies: _devDependencies, ...releasePackage } = rootPackage;
releasePackage.files = ['dist', 'src', 'contracts', '.cli-flags.toml', 'README.md', 'LICENSE'];
releasePackage.repository = {
  ...rootPackage.repository,
  directory: 'sdk/nodejs',
};

await access(join(repositoryRoot, 'dist', 'cli', 'main.js'));
await mkdir(targetRoot, { recursive: true });
await writeFile(join(targetRoot, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);

for (const generated of ['dist', 'src', 'contracts', 'README.md', 'LICENSE', '.cli-flags.toml']) {
  await rm(join(targetRoot, generated), { recursive: true, force: true });
}

for (const directory of ['dist', 'src', 'contracts']) {
  await cp(join(repositoryRoot, directory), join(targetRoot, directory), {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}
for (const file of ['README.md', 'LICENSE', '.cli-flags.toml']) {
  await copyFile(join(repositoryRoot, file), join(targetRoot, file));
}
await chmod(join(targetRoot, 'dist', 'cli', 'main.js'), 0o755);

console.log(`staged ${releasePackage.name}@${releasePackage.version} in sdk/nodejs`);
