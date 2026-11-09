<img src="assets/icon.svg" width="56" height="56" alt="">

# Nuvio Art Fixer

A small browser-only tool that swaps the AI-generated artwork on your [Nuvio](https://nuvio.tv) collection tiles for real movie and show backdrops. Your collections, tile names, catalogs and order stay exactly as they are. Only the artwork changes.

> **Unofficial.** This project is not made, endorsed or supported by Nuvio. It talks to the same sync API the Nuvio apps use. That API is not documented for third parties and may change at any time, which could break this tool. Use it at your own risk, and keep the backup it gives you.

## What it does

1. You sign in with your Nuvio email and password, then pick a profile.
2. **Before anything else, a full JSON backup of that profile's collections downloads to your device.**
3. You see every tile: its current art, a suggested real backdrop, other options, a search box, and a *Skip* checkbox.
   - Common tile names (genres, streaming services, studios, decades, themes, world cinema…) match a built-in list of hand-picked films and shows. *Horror* gets *The Shining*, *Netflix* gets *Stranger Things*, and so on.
   - Other titles are fuzzy-matched. When the tool isn't sure, the tile stays skipped until you pick an image yourself.
   - Every backdrop is checked to make sure it actually loads before it can be used.
4. **Apply selected** shows a summary of exactly what will change, then saves.
5. **Restore from backup** puts a backup file back, either the artwork only (recommended) or the whole collection set.

For each tile you apply, the tool sets the cover and hero backdrop to the real image, removes the AI GIF and title logo, sets the tile to landscape and shows its title. It never touches tile IDs, catalogs, sources, emoji, names, collection settings, or any field it doesn't recognise.

## Privacy

- Everything runs in your browser. There is no server behind this page and nothing to log in to except Nuvio itself.
- Your password is sent **only** to the Nuvio server you sign in to (`api.nuvio.tv` unless you choose a self-hosted one, in which case the page shows you where it's going first). It is never saved: not in `localStorage`, not in cookies, nowhere.
- The sign-in token is held in memory only. Reloading or closing the tab forgets it, and *Sign out* also revokes it on the server.
- No analytics, no tracking, no third-party scripts. A strict Content-Security-Policy blocks any script that isn't part of this repo.
- Artwork comes from public catalogs: [Cinemeta](https://v3-cinemeta.strem.io) for search and [Metahub](https://images.metahub.space) for images. Those requests contain only movie titles and IMDb IDs, never your account details.
- An optional TMDB API key (for better search) is kept in memory for the current tab only.

## Safety

Nuvio's sync API replaces a profile's **whole** collection set on every save, so the tool is careful:

- A backup downloads automatically before anything else is possible, and saving stays disabled until you confirm you have the file.
- If reading your collections fails or comes back empty, the tool stops.
- Before you confirm, you see a summary of every tile that will change.
- Right before saving, it reads your collections again. If anything changed since they were loaded (for example from your TV), it stops without writing.
- It always sends the complete collection set with only the art fields changed, then reads it back and checks the server holds exactly what was sent.
- If a save times out, it checks what actually landed instead of retrying blindly. It never rolls back automatically.
- Backups record the server, account and profile they came from. A backup can't be restored into a different account or profile.

One limit: the API has no way to lock your collections, so a change made on another device in the split second between the final check and the save could be overwritten. Don't edit collections elsewhere while the tool is saving.

## Run it locally

No build step and no dependencies. ES modules need to be served over HTTP, so any static server works:

```sh
git clone <this-repo-url> nuvio-art-fixer
cd nuvio-art-fixer
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Host it

It's a static site, so it works on any static host:

- **GitHub Pages:** push the repo, then *Settings → Pages → Deploy from a branch → `main` / root*. The `.nojekyll` file is already included.
- Netlify, Cloudflare Pages, or any web server: publish the repository root as-is.

The Nuvio API and the art sources allow browser requests from any origin, so no proxy is needed.

## Self-hosted Nuvio servers

Open *Self-hosted server* on the sign-in screen and enter your server's address (it must use `https://`, except `http://localhost` for development). The tool reads `/.well-known/nuvio` from it to find the backend and its public key, so nothing is hard-coded.

## Development

Tests cover the pure logic (parsing, matching, merging art fields without touching anything else, restore payloads) and the guarded write sequence, with all network calls mocked:

```sh
node --test
```

Requires Node 20 or newer. Layout:

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | The page |
| `js/app.js` | UI and flow |
| `js/nuvio.js` | Nuvio API client (discovery, sign-in, profiles, pull, push) |
| `js/collections.js` | Pure data logic: parsing, art merge, backups, restore |
| `js/workflow.js` | Guarded write: re-check → save → verify |
| `js/art.js`, `js/seed-map.js` | Art suggestion engine and built-in picks |
| `js/images.js` | Checks that a backdrop loads before it is used |

## License

[MIT](LICENSE)
