// Start the game with BepInEx loaded (MOD_MANAGER_PLAN.md Phase 0, spikes B/C).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exists } from './util.js';
import { APP_ID } from './locate.js';
import { ensureManagerHidden } from './bepinex.js';

// Mac: BepInEx only loads through run_bepinex.sh (Doorstop), and the script must be
// spawned by a real process API — `open -a Terminal` silently did nothing.
// Windows: winhttp.dll loads BepInEx however the exe starts, so Steam's own
// launch works (spike C NOT RUN — GUESS by mechanism).
// Linux (Steam Deck): always through Steam. Proton, and the winhttp override
// in the game's launch options, only apply when Steam starts the game, so the
// .exe is never spawned directly (untested on a Deck — GUESS by mechanism).
// os is the host OS ('mac' | 'windows' | 'linux').
// Returns how it launched, so the caller can tell the player.
export async function launchGame(gameDir, os_, { openUrl } = {}) {
  // Catches installs made before the manager set it, or edited back since.
  await ensureManagerHidden(gameDir);
  if (os_ === 'linux') {
    const url = `steam://rungameid/${APP_ID}`;
    if (openUrl) await openUrl(url);
    else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
      child.unref();
    }
    return 'steam';
  }
  if (os_ === 'mac') {
    const script = path.join(gameDir, 'run_bepinex.sh');
    if (!(await exists(script))) throw new Error('run_bepinex.sh is missing — install BepInEx first');
    // SteamAppId lets SteamAPI_Init find the app when Steam is running
    // (GUESS from Steamworks docs; spike B saw Init fail without Steam).
    const child = spawn(script, [], {
      cwd: gameDir, detached: true, stdio: 'ignore',
      env: { ...process.env, SteamAppId: APP_ID, SteamGameId: APP_ID },
    });
    await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    child.unref();
    return 'script';
  }
  if (openUrl) {
    await openUrl(`steam://rungameid/${APP_ID}`);
    return 'steam';
  }
  const exe = path.join(gameDir, 'Tricky Madness.exe');
  // Same SteamAppId guess as the Mac branch.
  const child = spawn(exe, [], {
    cwd: gameDir, detached: true, stdio: 'ignore',
    env: { ...process.env, SteamAppId: APP_ID, SteamGameId: APP_ID },
  });
  await new Promise((res, rej) => { child.once('spawn', res); child.once('error', rej); });
  child.unref();
  return 'exe';
}
