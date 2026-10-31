# Tricky Madness Mods

A desktop app (Mac, Windows and Steam Deck) that installs, updates and removes
[Tricky Madness](https://store.steampowered.com/app/2743850/) mods and map packs.
It installs BepInEx for you, picks up the Level Hook version each map pack
needs, edits each mod's settings, and can put back files it replaced.

The list of mods comes from the community catalog,
[8bitgentleman/tm-mod-catalog](https://github.com/8bitgentleman/tm-mod-catalog).
The downloads themselves are hosted on MEGA.

## Install

Download the latest release from the
[Releases page](https://github.com/8bitgentleman/tm-mod-manager/releases):

- **Mac:** `TrickyMadnessMods-<version>-mac.dmg`. It works on Apple Silicon and Intel Macs.
- **Windows:** `TrickyMadnessMods-<version>-win.exe`
- **Steam Deck / Linux:** `TrickyMadnessMods-<version>-linux.AppImage` (see below)

The app is not code-signed, so the first launch gets a warning:

- **Mac:** open it once, then go to System Settings → Privacy & Security and
  click **Open Anyway**.
- **Windows:** on the SmartScreen prompt, click **More info**, then **Run anyway**.

### Steam Deck

> Not tested on a Deck yet. If you try it, please report back on the Discord,
> whether it works or not.

The mods are made for the Windows version of Tricky Madness, so on a Deck the
game runs through Proton (Steam's tool for running Windows games). The app
installs the Windows mods for you; you change two settings in Steam yourself.

1. **Switch to Desktop Mode.** Hold the power button → **Switch to Desktop**.
   A mouse and keyboard help a lot; **Steam + X** opens the on-screen keyboard.
2. **Download the app.** In Firefox, open the
   [Releases page](https://github.com/8bitgentleman/tm-mod-manager/releases) and
   download the `.AppImage` file. It is the whole app — there's nothing to install.
3. **Let it run.** In the file manager, right-click the file → **Properties →
   Permissions** → tick **Is executable**. Then double-click it.
4. **Change two Steam settings.** Right-click Tricky Madness in Steam →
   **Properties**:
   - **Compatibility:** tick **Force the use of a specific Steam Play
     compatibility tool** and pick Proton. Steam then downloads the Windows
     version of the game.
   - **General → Launch Options:** paste this line (the app has a Copy button for it):
     ```
     WINEDLLOVERRIDES="winhttp=n,b" %command%
     ```
     Without it the mod loader never starts, and the game runs with no mods.
5. **Install mods** in the app, as on any computer.
6. **Play.** Double-click **Return to Gaming Mode** on the desktop and start
   the game from your library as usual — the mods load. You only need Desktop
   Mode again to install or update mods.

The app has to run on the Deck itself: a Deck plugged into a computer doesn't
show up as a drive, so mods can't be installed from another machine.

### Updates

The app checks this repo for a newer release when it starts. When one exists,
it shows a banner with a download link.

## What it does to your game folder

- It finds the game through Steam. You can also pick any folder in Settings,
  e.g. a copy of the game.
- It records every file it installs in `BepInEx/tm-manager/installed.json`.
  Uninstall removes exactly those files and leaves your edited `.cfg`
  settings alone.
- A mod or pack you installed by hand counts as installed when its files match
  the catalog's current version exactly. An older or partial copy shows
  **Install**.
- If you had already installed something by hand, it moves your copy into
  `BepInEx/tm-manager/backup/`. Uninstalling puts it back.
- It won't change files while the game is running.

Alpha and beta entries are hidden unless you turn on **Show test versions**
in Settings.

## Command line

The same engine runs without the window:

```bash
node src/cli.js list
node src/cli.js install tricky-ports
node src/cli.js --help
```

## Development

Needs Node 20 or later.

```bash
npm ci
npm start      # run the app
npm test       # unit tests
npm run dist   # build installers for this OS into dist/ (not published)
```

Useful environment variables:

| Variable | Effect |
|---|---|
| `TMM_GAME` | game folder |
| `TMM_CATALOG` | catalog URL or local file |
| `TMM_ZIPS` | install from a folder of release zips instead of MEGA |
| `TMM_UPDATE_CHECK=1` | run the app-update check in a dev run (it's off unless packaged) |
| `TMM_RELEASES_API` | point that check at another repo's `releases/latest` |

## Releasing

1. Set the version in `package.json` and commit.
2. Tag the commit and push the tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. GitHub Actions builds the Mac dmg, the Windows installer and the Linux
   AppImage, then attaches them to a **draft** release.
4. Check the draft and publish it. Apps already installed only see the release
   once it is published.

## License

MIT
