const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
let count = 0;
function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkDirectory(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
      count++;
    }
  }
}
checkDirectory('frontend');
checkDirectory('netlify/functions');
checkDirectory('scripts');
console.log(`Syntax checked ${count} JavaScript files. No external services contacted.`);
