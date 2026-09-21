# udrop file listing — no external backend, GitHub-only

Everything runs inside your existing GitHub Actions workflow. No
Cloudflare/Netlify/Vercel account needed, and your udrop API keys never
leave GitHub's secret store.

## How it works

Every time the scheduled job runs and detects a change:

1. It lists your udrop account/folder via the API.
2. For every file, it calls `/file/download` once and stores the real
   direct-download URL in `files.json`.
3. For every folder (and the account root), it downloads all the files in
   that folder+subfolders and zips them locally, then uploads the zip as
   an asset on a fixed GitHub Release (tag `file-zips`).
4. It commits the updated `files.json`, which now has a `downloadUrl` per
   file and a `zipAsset` per folder — both just plain static links.

The page (`index.html`) only ever reads `files.json` and links straight to
those URLs. No JavaScript talks to udrop, and there's nothing running at
request time — the "backend" work already happened during the sync.

## Setup

1. Replace these four files in your existing repo with the versions here:
   - `scripts/sync.js`
   - `.github/workflows/sync.yml`
   - `index.html`
   - `package.json` (new — installs `archiver`, used to build the zips)
2. Your existing `UDROP_KEY1` / `UDROP_KEY2` repo secrets don't need to
   change. Nothing else to configure — `GITHUB_TOKEN` is provided
   automatically by Actions.
3. Commit, push, then trigger it once by hand: Actions tab → "Sync file
   list" → Run workflow.
4. Check the repo's **Releases** page — you should see a release tagged
   `file-zips` with a `.zip` per folder. Check `files.json` — files should
   now have a `downloadUrl`, folders a `zipAsset`.
5. Open the site: clicking a file should download it immediately; clicking
   "zip" next to a folder should download that folder as a `.zip`
   immediately. No udrop page in between either way.

## Things worth knowing

- **Every run that finds a change re-downloads every file and rebuilds
  every zip**, even if only one file changed — there's no per-folder diff.
  For a modest drive of scripts/PDFs this is quick; for a large one it'll
  make the Action noticeably slower (and use more of your Actions minutes).
  If that becomes a problem, the fix is per-folder change detection, which
  I can add later.
- The release marked `file-zips` is managed entirely by the script —
  assets get deleted and re-uploaded each run. Don't attach anything else
  to it by hand, it'll get overwritten.
- `/file/download` links are generated fresh each sync, but how long udrop
  keeps them valid isn't documented. If you ever see a file link stop
  working between syncs, the fix is to run the workflow by hand to refresh
  it — worth keeping an eye on for the first few days.
- GitHub disables scheduled workflows after 60 days of no repo activity —
  same as before, nothing new here.
- Anything published this way is downloadable by anyone with the link —
  keep private files out of the synced folder, same as before.
