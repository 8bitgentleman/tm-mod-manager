// What the CLI and the app both do: check the game is closed, and run an
// install/update plan step by step.
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchBuild, cacheDir } from './fetch.js';
import { installFiles } from './install.js';
import { ensureBepInEx } from './bepinex.js';

// Is the game in gameDir running? Mac matches the executable's path, so a game
// running from another install folder doesn't count (the process is named
// "Tricky Madness", with a space). Windows matches the exe name only — GUESS,
// untested, and it can't tell two installs apart. Linux (Proton) matches the
// exe name anywhere in a command line — Proton's own wrappers carry it too,
// which is still "running" — and, like Windows, any install counts (untested
// on a Deck). os is the host OS; run is injectable for tests.
export async function gameRunning(os_, gameDir, { run = promisify(execFile) } = {}) {
  try {
    if (os_ === 'linux') {
      const { stdout } = await run('pgrep', ['-f', 'Tricky Madness\\.exe']);
      return stdout.trim() !== '';
    }
    if (os_ === 'mac') {
      const { stdout } = await run('pgrep', ['-fl', 'MacOS/Tricky Madness']);
      const real = gameDir ? `${await fsp.realpath(gameDir)}/` : null;
      return stdout.split('\n').some((line) => {
        const cmd = line.replace(/^\d+\s+/, '');
        return cmd && (!real || cmd.startsWith(real) || cmd.startsWith(`${gameDir}/`));
      });
    }
    // Unfiltered and parsed here, because Wine's tasklist ignores /FI and, when piped,
    // writes UTF-16 (hence the NUL strip). Matches by image name only, so any running
    // copy counts, not just the one in gameDir.
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH']);
    return stdout.replace(/\0/g, '').split(/\r?\n/)
      .some((line) => line.toLowerCase().startsWith('"tricky madness.exe"'));
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

// onEvent({type:'step'|'progress'|'done', entry, action, done, total})
export async function applySteps({ catalog, gameDir, ledger, platform, steps, zipsDir, force, onEvent = () => {} }) {
  if (steps.some((s) => s.action !== 'current')) {
    onEvent({ type: 'step', label: 'BepInEx' });
    await ensureBepInEx(gameDir, ledger, platform, {
      onProgress: (done, total) => onEvent({ type: 'progress', label: 'BepInEx', done, total }),
    });
  }
  const count = steps.filter((s) => s.action !== 'current').length;
  let index = 0;
  for (const { entry, build, action } of steps) {
    if (action === 'current') { onEvent({ type: 'done', entry, action }); continue; }
    index += 1;
    onEvent({ type: 'step', entry, action, label: entry.name, index, count });
    const zip = await fetchBuild(catalog, build, {
      localDir: zipsDir,
      onProgress: (done, total) => onEvent({ type: 'progress', entry, label: entry.name, done, total, index, count }),
    });
    const platformKey = Object.keys(entry.builds).find((k) => entry.builds[k] === build);
    onEvent({ type: 'step', entry, action, label: `Installing ${entry.name}`, index, count });
    await installFiles(gameDir, ledger, { id: entry.id, version: entry.version, platform: platformKey, zip, files: build.files }, { force });
    // Packs run to gigabytes; a downloaded zip has done its job once installed.
    if (zip.startsWith(cacheDir())) await fsp.rm(zip, { force: true });
    onEvent({ type: 'done', entry, action });
  }
}
