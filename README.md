# Scute

A web-based replacement and update for Turtl

A self-hosted, end-to-end encrypted home for notes, bookmarks, passwords, images, videos and files. Scute is a modern take on [Turtl](https://github.com/turtl/server): the same idea (private, shareable, encrypted "spaces" of notes and boards), rebuilt as a single web app that installs as a PWA and works offline.

> A scute is one of the bony plates that make up a turtle's shell.

## Features

- **Six note types**: Markdown notes (with checklists, tables, code), bookmarks, passwords (with generator and copy buttons), images (encrypted thumbnails + full-size), videos, and file attachments.
- **Built-in video and audio player**: upload a video and it's encrypted like everything else; Scute grabs a poster frame and duration in the browser and plays it inline (decrypted in memory, with seek, fullscreen and picture-in-picture). Audio and video files attached as plain files play too. Bookmarks pointing at YouTube (via youtube-nocookie.com), Vimeo, or a direct `.mp4`/`.webm`/`.mp3` link play inside Scute; nothing is loaded from the third party until you press play.
- **Bulk upload**: pick or drop several files at once (New → Upload files, drag onto the note grid, or drop more onto a file note) and each becomes its own encrypted note, auto-typed as image, video or file. Shared notes, tags, board and color apply to all of them; failed uploads stay listed for a retry.
- **Spaces and boards**: spaces separate collections (Personal, Work, Family); boards group notes inside a space. Tags, type filters, full-text search (runs locally on decrypted data), sort, pinning and colors.
- **Sharing**: invite other users on your server to a space as admin, member (read/write) or guest (read-only). Keys are sealed to the invitee's public key in the browser.
- **Offline-first PWA**: installable on desktop and mobile, service-worker app shell, encrypted local cache, and an outbox that syncs changes when you're back online. Share target: share a link from your phone straight into Scute.
- **Import/export**: decrypted JSON export (with or without attachments), import of Scute exports and best-effort import of Turtl JSON backups.
- **Tiny footprint**: one Node.js process and one SQLite file. No Postgres, no Redis.
- Light and dark themes, device/session management, password change without re-encrypting notes, account deletion.

## Quick start

### Docker (recommended)

```bash
docker compose up -d --build
# then put HTTPS in front of 127.0.0.1:5000 (see below) and open https://notes.example.com
```

Data lives in `./data` (`scute.db` plus `files/`).

### Bare metal

Requires Node.js 20+ and a C/C++ toolchain for `better-sqlite3` (`build-essential python3` on Debian/Ubuntu).

```bash
npm ci
npm run build
SCUTE_DATA_DIR=/var/lib/scute PORT=5000 npm start
```

An example hardened systemd unit is in `scute.service`.

For development: `npm run dev` (Vite + API with hot reload on port 5000).

### First run

The first account created becomes the server admin. Registration is open by default; set `SCUTE_REGISTRATION=closed` once everyone has an account (the very first account can always be created).

## HTTPS is required

Scute uses the browser's WebCrypto API and service workers, which only work in a **secure context**: `https://…` or `http://localhost`. Accessing it over plain HTTP on a LAN IP will show a warning and sign-in will not work. Use a reverse proxy, e.g. Caddy:

```caddyfile
notes.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:5000
}
```

nginx works too; raise `client_max_body_size` to at least `SCUTE_MAX_UPLOAD_MB` and set `SCUTE_TRUST_PROXY=1` so login throttling sees the real client IP.

## Slideshow

The slideshow button in the top bar plays every image in the current view: the selected space, board, tag, type filter or search, in the same order as the grid. Videos are never included. You can also start from a specific image with **Slideshow** in its note.

Keys: ← / → move between images, Space pauses or resumes, F toggles full screen, Esc closes. On touch screens, swipe left or right. You can choose 3, 5, 8 or 15 seconds per image and turn shuffle on.

## Video thumbnails

Scute captures a poster frame when a video is uploaded. Videos that don't have one yet, such as older uploads or file notes holding a video, get a thumbnail the first time their card scrolls into view, and it's saved with the note (still encrypted). To pick a different frame, open the video, pause where you want, and click **Use this frame as the thumbnail**.

## Updating

1. Replace the source with the new release (keep your `data/` folder).
2. Rebuild. With Docker, `docker compose up -d` alone reuses the old image, so always pass `--build`:
   ```bash
   docker compose up -d --build
   ```
   Bare metal: `npm ci && npm run build && sudo systemctl restart scute`.
3. Check the server: `curl -s https://notes.example.com/api/health` should report the new `version`.
4. Open or reload Scute. The app compares its version with the server's and refreshes itself; Settings shows the running version at the bottom.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SCUTE_DATA_DIR` | `./data` | Directory for `scute.db` and encrypted files |
| `SCUTE_REGISTRATION` | `open` | `open` or `closed` |
| `SCUTE_MAX_UPLOAD_MB` | `200` | Maximum size of one attachment or video (after encryption). Files are decrypted in browser memory, so very large values are hard on phones. |
| `SCUTE_SESSION_DAYS` | `90` | How long a device stays signed in |
| `SCUTE_TRUST_PROXY` | off | Set to `1` behind a reverse proxy |

## Video notes

- Formats: whatever your browser can decode. MP4 (H.264 + AAC) and WebM (VP9/AV1 + Opus) play everywhere; `.mov` usually plays in Safari and Chrome; MKV/AVI are stored fine but may only offer a download. To convert: `ffmpeg -i in.mkv -c:v libx264 -crf 23 -c:a aac -movflags +faststart out.mp4`.
- Size: limited by `SCUTE_MAX_UPLOAD_MB` (default 200) **and** your reverse proxy (`LimitRequestBody` in Apache, `client_max_body_size` in nginx). Because a video is end-to-end encrypted as one blob, the whole file is downloaded and decrypted in the browser before playback starts, so keep phone-bound videos moderate.
- Videos over 12 MB aren't kept in the offline cache; smaller ones play offline once opened.

## How the encryption works

All cryptography runs in the browser with WebCrypto. The server only ever sees ciphertext, public keys, and a hash of a derived auth token.

1. **Password → keys.** PBKDF2-SHA256 with 600,000 iterations and a per-user random salt derives 512 bits. The first half is an *auth key* sent to the server (which stores only an scrypt hash of it); the second half is a *key-encryption key* that never leaves the device.
2. **Master key.** A random AES-256 master key is wrapped with the key-encryption key. Changing your password re-wraps only this key.
3. **Identity keypair.** Each user has an ECDH P-256 keypair; the private key is encrypted with the master key, the public key is published so others can share with you.
4. **Spaces.** Every space has a random AES-256 key. It's sealed to each member's public key (ephemeral ECDH P-256 + AES-256-GCM), which is how sharing works without the server learning the key.
5. **Notes and files.** Every note has its own random key, wrapped with its space key. Note content (title, body, URL, username, password, tags, image thumbnail, file metadata) and attachments are encrypted with AES-256-GCM using that note key.

What the server can see: usernames, which users belong to which spaces and their roles, the number and approximate size of items, and timestamps. What it cannot see: anything you typed or uploaded, including titles and tags.

When inviting someone, Scute shows the invitee's public-key fingerprint so you can verify it out of band if you don't trust the server operator.

There is **no password recovery**. Losing the password means losing the data — keep an export somewhere safe.

## Migrating from Turtl

Export your data from the Turtl desktop app (Settings → Export), then in Scute open **Settings → Data → Import** and pick the JSON file. Spaces, boards, notes, tags, bookmarks and passwords are recreated and re-encrypted locally. Turtl file attachments aren't included in Turtl exports, so re-attach those manually.

## Backups

Stop the server (or use `sqlite3 scute.db ".backup backup.db"`) and copy the whole data directory. Backups are already encrypted; they're useless without users' passwords. Users can also make their own decrypted exports from Settings.

## API overview

All endpoints are JSON under `/api`, authenticated with `Authorization: Bearer <token>`.

- `GET /api/auth/params`, `POST /api/auth/register|login|logout`
- `GET /api/me`, `GET|DELETE /api/me/sessions[/:id]`, `POST /api/me/password`, `POST /api/me/delete`
- `GET /api/sync?since=<seq>` — incremental sync of everything the user can access
- `PUT|DELETE /api/spaces/:id`, `PUT|DELETE /api/spaces/:id/members/:userId`, `POST /api/spaces/:id/accept`
- `PUT|DELETE /api/boards/:id`, `PUT|DELETE /api/notes/:id`, `PUT|GET /api/files/:noteId`
- `GET /api/users/:username/key`, `GET /api/health`

## License

MIT
