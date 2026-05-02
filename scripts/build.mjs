import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const src = path.join(root, 'src');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

async function copyStaticAssets() {
  await copyDirectory(path.join(src, 'assets'), path.join(dist, 'assets'));
  await copyDirectory(path.join(src, 'lib'), path.join(dist, 'lib'));
  await copyDirectory(path.join(src, 'prompts'), path.join(dist, 'prompts'));
}

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, targetPath);
    }
  }
}

await mkdir(dist, { recursive: true });
await run('tsc', ['--noEmit']);
await run('vite', ['build', '--config', 'vite.config.mjs']);
await copyStaticAssets();
