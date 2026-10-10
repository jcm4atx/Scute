# Scute

A self-hosted, end-to-end encrypted home for notes, bookmarks, passwords, images, videos and files. Scute is a modern take on [Turtl](https://github.com/turtl/server): the same idea (private, shareable, encrypted "spaces" of notes and boards), rebuilt as a single web app that installs as a PWA and works offline.

> A scute is one of the bony plates that make up a turtle's shell.

## Features

- **Six note types**: Markdown notes (with checklists, tables, code), bookmarks, passwords (with generator and copy buttons), images (encrypted thumbnails + full-size), videos, and file attachments.
- **Built-in video and audio player**: upload a video and it's encrypted like everything else; Scute grabs a poster frame and duration in the browser and plays it inline (decrypted in memory, with seek, fullscreen and picture-in-picture). Audio and video files attached as plain files play too. Bookmarks pointing at YouTube (via youtube-nocookie.com), Vimeo, or a direct `.mp4`/`.webm`/`.mp3` link play inside Scute; nothing is loaded from the third party until you press play.
- **Bulk upload**: pick or drop several files at once (New → Upload files, drag onto the note grid, or drop more onto a file note) and each becomes its own encrypted note, auto-typed as image, video or file. Shared notes, tags, board and color apply to all of them; failed uploads stay listed for a retry.
- **Bookmarks with previews and saved copies**: bookmarks show the page's title, description and picture, image links display the image, and video links show a thumbnail. Scute can keep an encrypted copy (in the spirit of ArchiveBox): a self-contained snapshot of the page, the full-size picture of a photo page, or the video itself from YouTube, Vimeo and other video sites (downloaded by the server with yt-dlp), so it stays available if the site changes or disappears. Saved copies can be shared as a read-only page with a secret link or a password. It also warns you about duplicate bookmarks.
- **Spaces and boards**: spaces separate collections (Personal, Work, Family); boards group notes inside a space. Tags, type filters, full-text search (runs locally on decrypted data), sort, pinning and colors.
- **Moving many notes at once**: select notes (or Ctrl+click, Shift+click for a range) and move them to another board or space, or drag them onto a board.
- **Hidden spaces**: keep sensitive spaces out of sight on your devices, optionally behind your password or a PIN.
- **Sharing**: invite other users on your server to a space as admin, member (read/write) or guest (read-only). Keys are sealed to the invitee's public key in the browser.
- **Offline-first PWA**: installable on desktop and mobile, service-worker app shell, encrypted local cache, and an outbox that syncs changes when you're back online. Share target: share a link from your phone straight into Scute.
- **Joplin Server sync**: a space can be linked to a self-hosted Joplin Server account and stay in two-way sync with the Joplin desktop and mobile apps (notebooks, notes, tags, to-dos, images and attachments).
- **Scute Drive**: a private cloud folder of ordinary files on your server, synced two ways with Linux (rclone) and Android over WebDAV, with a web file browser, trash and per-device app passwords (with the Scute Drive plug-in).
- **Inbox for other apps**: phone apps such as OwnTracks can send your location (or other data) to a private address; Scute seals it with your key as it arrives and the Location history plug-in turns it into encrypted notes and a travel dashboard.
- **Fediverse server**: your own Mastodon-compatible account (`@you@your.domain`) served by Scute. Follow and be followed from Mastodon, Pixelfed, Misskey and the rest, share posts and any kind of file, and use Mastodon apps such as Tusky, Ivory, Elk or Phanpy (with the Fediverse plug-in).
- **Plug-ins**: add your own commands, note buttons, views, templates and Markdown syntax with small JavaScript plug-ins. Four examples are included (daily note, wiki links, word count, space stats).
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

## Under a path on another site

Since 1.15.2 Scute also works under a path, for example `https://example.com/scute/` instead of its own subdomain. Nothing changes in Scute's settings; it finds its server from the address it was opened at. In Apache, inside the site's `<VirtualHost *:443>` (`a2enmod proxy proxy_http`):

```apache
<Location /scute/>
  ProxyPass        http://127.0.0.1:5000/ retry=0 timeout=300
  ProxyPassReverse http://127.0.0.1:5000/
</Location>
RedirectMatch 301 ^/scute$ /scute/
```

Use the address of the Scute machine instead of `127.0.0.1` if it runs elsewhere (and `https://…` with `SSLProxyEngine on` if that hop crosses the internet). Shares then live at `https://example.com/scute/shared/<name>/`.

Things to know:

- **It's a different origin.** The browser keeps sign-ins, the offline copy and the installed app separately for each origin, so at the new address you sign in again, it downloads its offline copy again, and you install the PWA again. Your data on the server is the same.
- **Shared origin.** Everything on `example.com` shares one origin, so other pages there could read what Scute keeps in the browser (including the signed-in session). Only do this on a site whose pages you trust; a subdomain keeps Scute separate.
- Raise Apache's `LimitRequestBody` if you've lowered it below `SCUTE_MAX_UPLOAD_MB`, and set `SCUTE_TRUST_PROXY=1` as for any proxy.

## Slideshow

The slideshow button in the top bar plays every image in the current view: the selected space, board, tag, type filter or search, in the same order as the grid. Videos are never included. You can also start from a specific image with **Slideshow** in its note.

Keys: ← / → move between images, Space pauses or resumes, F toggles full screen, Esc closes. On touch screens, swipe left or right. You can choose 3, 5, 8 or 15 seconds per image and turn shuffle on.

## Default space

Pick which space Scute opens when it starts: open the space switcher and choose **Make default space** (the default is marked with a star), tick **Open this space when Scute starts** in a space's settings, or choose it under Settings → Account → **Default space**. Choose "The space I used last" to go back to reopening wherever you left off. The choice is stored encrypted with your account, so it follows you to every device.

## Moving and deleting many notes

Press the **Select** button (the ticked box next to Sort) above the notes, or Ctrl+click (Cmd+click on a Mac) a note, and clicks select notes instead of opening them. Shift+click selects everything between the last note you clicked and this one; Ctrl+A selects every note in view (the current board, filter or search, including "search every space"); Esc stops selecting.

The bar at the bottom then offers:

- **Move…**: pick a space and a board (or "No board", or make a new board on the spot). Within a space only the board changes. Into another space each note's key is re-wrapped for that space, so its members can read it; attachments go along. Notes leaving a Joplin space have their Joplin attachments copied into Scute first, just like moving one note in the editor; notes moved into a Joplin space join its Joplin account on the next sync.
- **Delete**: removes the selected notes after asking.

You can also drag a note, or any selected note to take the whole selection, onto a board in the sidebar, or onto **All notes** to take it off its board. You need write access to both spaces: Move and Delete stay greyed out while the selection includes a note you can only read.

## Hidden spaces

Hide a space you'd rather not have on screen when someone's looking: **Hide this space** in the space switcher, **Hide this space on my devices** in its settings, or tick it under Settings → Account → **Hidden spaces**. A hidden space disappears from the switcher, and its boards and notes are left out of lists, search, links and plug-ins (the photo album won't see its photos either). If it was your default space, Scute opens another one.

To see hidden spaces again, choose **Show hidden spaces…** in the space switcher, press **Ctrl+Alt+H**, or use Settings → Account → Hidden spaces. Showing them can ask for your account password or a PIN (the password always works, in case the PIN is forgotten); in Settings you can also leave the menu item out, so only the shortcut and Settings remain. Once shown, hidden spaces are marked with a crossed-out eye and put away again with **Hide hidden spaces** (or Ctrl+Alt+H), when Scute reloads, or after five minutes in the background.

This keeps things from casual view; it isn't a lock. The list of hidden spaces and the PIN (as a salted PBKDF2 hash) are stored encrypted with your account, so they follow you to every device. Hidden spaces still sync (Joplin too), stay shared with their members, who see them as usual unless they hide them themselves, and are included in JSON exports. Anyone who can use your signed-in Scute could still find them, for example in an export.

## Video thumbnails

Scute captures a poster frame when a video is uploaded. Videos that don't have one yet, such as older uploads or file notes holding a video, get a thumbnail the first time their card scrolls into view, and it's saved with the note (still encrypted). To pick a different frame, open the video, pause where you want, and click **Use this frame as the thumbnail**.

## Bookmarks: previews, saved copies, duplicates

When you paste a URL into a new bookmark, Scute looks it up and fills in the title, description and preview picture. Links to images show the image itself; links to videos show a thumbnail (YouTube and Vimeo via their public thumbnail services, direct `.mp4`/`.webm` links from a frame of the video).

**Save a copy** (on by default, remembered per device) keeps what the bookmark points to, encrypted in your browser like any other attachment, in the spirit of a very small [ArchiveBox](https://archivebox.io/):

| The bookmark is… | Scute saves |
| --- | --- |
| a video page (YouTube, Vimeo, PeerTube, Internet Archive, Wikimedia Commons, and the [thousands of sites yt-dlp knows](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)) | the video, downloaded by the server with yt-dlp, up to `SCUTE_MEDIA_HEIGHT` (1080p) and preferring MP4 so every browser plays it; a smaller version is picked if the best one is over the upload limit |
| a photo page (Flickr, Imgur, Unsplash, DeviantArt, Commons `File:` pages, or any page that says it's a photo) | the full-size picture |
| an image, video, audio, PDF or other file | the file itself |
| any other page | a single-file snapshot: stylesheets, fonts and images embedded, scripts removed |

The arrow next to **Save a copy** / **Save again** lets you choose: the page, the picture, or the video. If a video can't be downloaded (some sites want a signed-in browser, or it's over the size limit), Scute saves the page instead and says why. Open the bookmark to watch or view the saved copy (pages open in a locked-down frame with no scripts), **Download** it, or **Save again** for a fresh one.

Video downloads need `yt-dlp` (and `ffmpeg` to combine separate video and audio streams) on the server. The Docker image includes both and runs `yt-dlp -U` at start and once a day, since sites change often; on bare metal install them yourself (`pipx install yt-dlp`, `apt install ffmpeg`) or set `SCUTE_YTDLP` to the program. YouTube also needs a JavaScript runtime, and yt-dlp uses Scute's own Node.js for that. The server downloads into `<data>/tmp/media/`, hands the file to your browser, and deletes it; nothing unencrypted stays on the server. YouTube sometimes refuses servers in data centers ("Sign in to confirm you're not a bot"); from a home connection it normally works.

**Share** on a saved copy publishes it as a read-only page at `/shared/<name>/` that anyone can open without an account: pages in the same locked-down frame, pictures full size, videos and audio in the browser's player, other files as a download. The copy is encrypted in your browser with a new key that is either part of the link (after the `#`, which browsers never send to the server) or behind a password, so the server only stores scrambled files. You choose the address, whether it stops working after a day, a week or 30 days, whether it shows where the copy came from, and whether visitors may download it. **Update shared copy** republishes after **Save again**; **Stop sharing** deletes it from the server. Shares of saved copies work with plug-ins on or off and follow the rules under [Published shares](#published-shares) (size limits, proxies, your own domain).

If the URL is already bookmarked (ignoring `www.`, tracking parameters like `utm_*`, `#fragments`, and `youtu.be` vs `youtube.com/watch` forms), the editor warns you and offers to open the existing one. **Bookmark tools…** in the space menu lists all duplicates (in this space or across every space) so you can keep one and delete the rest, and can save missing copies or refresh previews for older bookmarks in bulk.

The server fetches pages on your behalf (browsers can't read other sites directly), but it only sees the URL and the raw page; saved copies are encrypted before they're uploaded. By default it refuses private and local addresses (`localhost`, `10.x`, `192.168.x`, …) so it can't be used to probe your network; set `SCUTE_ARCHIVE_PRIVATE=on` if you want to bookmark things on your LAN. Pages that build themselves entirely with JavaScript may save imperfectly because scripts are stripped. Saved copies count against `SCUTE_MAX_UPLOAD_MB`. yt-dlp only gets the address you bookmarked checked against private addresses; it follows the site's own links from there.

## Joplin Server sync

A **Joplin space** mirrors one Joplin Server account. Scute talks the same sync protocol as the Joplin apps, so changes made in Joplin desktop, mobile or CLI show up in Scute and the other way round.

**Set it up**

1. Open the space switcher → **New space**, set **Kind** to **Joplin Server sync** (the name defaults to "Joplin") and create it.
2. Enter your Joplin Server URL (for example `https://joplin.example.com`), email and password, click **Test connection**, then **Save**.
3. The first sync starts on its own. After that Scute syncs every 5 minutes and about 15 seconds after you change something, while the space is open. **Sync now** in the Joplin bar runs it on demand; the gear button reopens the connection settings (also under the space switcher → **Joplin connection…**).

**How things map**

| Joplin | Scute |
| --- | --- |
| Notebook (including nested notebooks) | Board (nested boards are indented in the sidebar) |
| Note / to-do | Note (to-dos show a **To-do** badge; their status is kept) |
| Tag | Tag |
| Image or file embedded in a note | Shown inline in the note; files download on click |
| Note with a source URL | Keeps the URL |

Notes you create in Scute go the other way: text notes and bookmarks become Joplin notes (a bookmark's URL is the first line and the note's source URL), and image, video and file notes become a Joplin note with the file attached as a resource. Notes that aren't in a board go into a notebook named after the space. Deleting a note or board in Scute moves it to Joplin's trash; deleting or trashing it in Joplin removes it from Scute.

**Good to know**

- **Privacy**: Joplin Server stores notes without Scute's end-to-end encryption, so anything in a Joplin space is readable by whoever runs that server. Password notes are never sent to Joplin and stay only in Scute.
- **Joplin encryption** must be off for that Joplin account; Scute can't read Joplin-encrypted notes and will say so.
- **Conflicts**: if a note was changed in both places since the last sync, Joplin's version wins and your Scute edit is kept as a separate note titled "… (conflict copy)", which is also synced.
- **Sharing**: the connection details are stored encrypted inside the space, so members who can edit the space can sync it too. Guests (read-only) see the synced notes but can't start a sync.
- **Relay**: browsers can't call Joplin Server directly, so the Scute server relays the Joplin sync API for signed-in users (it stores nothing). That means the **Scute server** (the Docker container) must be able to reach the Joplin URL. If both run in Docker on the same host, use the public HTTPS URL or put them on a shared Docker network and use e.g. `http://joplin:22300`.
- **Moving notes out of a Joplin space**: photos and other attachments are copied into Scute (encrypted) as the note moves. A note that is just one photo becomes an image note; a note with several attachments keeps its text and each attachment becomes its own note in the same board, still shown inline. The old copy goes to Joplin's trash on the next sync. Notes moved with an older version show a **Copy into Scute** button to fetch their missing attachments (the Joplin space must still be connected).
- Joplin's own "conflicts" notebook and note revision history aren't imported. Very large Joplin libraries take a while on the first sync (every item is downloaded once per browser).
- Limit which Joplin servers can be used with `SCUTE_JOPLIN_URLS`, or turn the feature off with `SCUTE_JOPLIN=off` (see Configuration).

## Plug-ins

Plug-ins add features without changing Scute itself: commands (the puzzle-piece menu in the header, with optional shortcuts), buttons on open notes, full-page views in the sidebar, New-menu templates, badges on cards, extra Markdown syntax, and (API 2) their own kinds of spaces and note types.

**Included examples** (off until the admin enables them):

- **Daily note**: Ctrl+Shift+D opens today's note in a "Journal" board, creating it if needed; also a "Journal entry" template.
- **Wiki links**: `[[Note title]]` or `[[Note title|label]]` links to another note in the same space (click a missing one to create it), plus a "Backlinks" button.
- **Word count**: a "Word count" button on notes and a badge on long notes.
- **Space stats**: a dashboard of what's in the current space, top tags and recent edits.

**Installing your own**: either drop the plug-in folder into `./data/plugins/` (the folder name must match the `id` in its `plugin.json`) and press **Reload plug-ins**, or, as the server admin, use **Settings → Plug-ins → Install from .zip**. Then switch on **Available to everyone**. Each user can switch any plug-in off for themselves with **Use it myself**.

**Trust**: plug-ins run inside the app in your browser and can read your decrypted notes. Their listed permissions are shown before you enable them, but they are not a sandbox, so only install plug-ins you trust. `SCUTE_PLUGINS=off` turns the whole system off.

Plug-ins that talk to other services on your network (for example a local AI server) can go through the Scute server when the admin allows those addresses with `SCUTE_PLUGIN_NET`. Since 1.10.0 (plug-in API 4) plug-ins can also fetch public web pages and APIs through the server's page fetcher (same rules as bookmark previews, off with `SCUTE_ARCHIVE=off`), and draw their own card covers in the grid. Since 1.11.0 (API 5) they can show and upload photos, videos and files (decrypted in the browser only). Since 1.12.0 (API 6) they can publish shares (below), and since 1.15.0 (API 7) shares can also be public websites with images and videos.

Writing one is a manifest and a JavaScript file; see [PLUGINS.md](PLUGINS.md) for a starter, packaging and the full API.

## Published shares

Since 1.18.0 Scute uses the same mechanism to share saved bookmark copies (see [Bookmarks](#bookmarks-previews-saved-copies-duplicates)), and since 1.12.0 a plug-in with the `publish` permission (such as the photo album) can put an encrypted, read-only web page at `https://notes.example.com/shared/<name>/` for people who don't have a Scute account. Everything is encrypted in your browser before it's uploaded; the page decrypts it in the visitor's browser with a password, or with a key that's only in the link after `#` (never sent to any server). The server stores unreadable `.bin` files, can let a share expire, and forgets it when you stop sharing. Pages are served with `noindex` and `no-referrer`.

Since 1.15.0 a share can also be a public website with no password, such as a space published with the space website plug-in: its pages, images and videos are stored as ordinary files and anyone with the address can read them. The same own-address setup below works for both.

**Your own address.** To serve shares from another site you own, for example `https://example.com/photos/europe2026/` while Scute runs at `notes.example.com`, add this to that site's Apache `<VirtualHost *:443>` (needs `mod_proxy`, `mod_proxy_http` and `mod_ssl`) and reload Apache:

```apache
SSLProxyEngine on
<Location /photos/>
  ProxyPass        https://notes.example.com/shared/ retry=0 timeout=120
  ProxyPassReverse https://notes.example.com/shared/
  ProxyPreserveHost Off
</Location>
RedirectMatch 301 ^/photos$ /photos/
```

Every share then also works at `https://example.com/photos/<name>/`, and visitors see only your address. `ProxyPreserveHost Off` makes Apache ask for `notes.example.com` rather than `example.com` (it matters if the site turns it on elsewhere); `retry=0` stops Apache from refusing requests for a minute after one failed attempt. Only if both sites run on the same machine can you point `ProxyPass` at `http://127.0.0.1:5000/shared/` instead and drop `SSLProxyEngine`; on a separate server that address is the web server itself and gives 503. With nginx: `location /photos/ { proxy_pass https://notes.example.com/shared/; proxy_ssl_server_name on; }`.

**If `https://example.com/photos/…` answers 503 Service Unavailable**, that server couldn't connect to Scute. On it, run `curl -sI https://notes.example.com/shared/` and `sudo grep -E 'proxy|SSL' /var/log/apache2/error.log | tail`:

- `AH00957 … attempt to connect to … failed`: the address in `ProxyPass` is wrong (for example `127.0.0.1:5000` on a different machine), or a firewall is in the way: the hosting provider blocking outgoing connections, or the Scute side (router, `ufw`, fail2ban, a country block) not letting that server in. If `curl` from that server also fails, it's the network, not Apache.
- `AH01961 … failed to enable ssl support`: `SSLProxyEngine on` is missing (gives 500).
- 502 Bad Gateway with an SSL or handshake error: Apache asked for the wrong name or doesn't trust the certificate; check `ProxyPreserveHost Off`.
- Nothing logged: another `ProxyPass`, `Alias` or rewrite rule for `/photos` comes first, or the lines went into the port-80 `VirtualHost` instead of the 443 one.

**Other ways to use your own address:**

- **Redirect**: `RedirectMatch 302 ^/photos/(.*)$ https://notes.example.com/shared/$1` sends visitors on to Scute (the `#key` part of a link survives the redirect). Nothing to proxy, but the address bar shows Scute's address.
- **Host the files yourself**: the photo album's **Download for my web server** saves the same encrypted page as a folder; upload it to `/var/www/example.com/photos/<name>/` (for example with `rsync`) and Scute isn't involved when people look at it. It's usually also the fastest choice when Scute runs on a home connection, since the photos then come from the web host.

**Speed.** Everything a visitor sees comes from the server that stores it, so on a home connection the upload speed sets the pace: a 20 MB original takes about 13 seconds at 12 Mbit/s. Sharing at 2048 px instead of originals makes photos about ten times smaller. HTTPS itself adds a fraction of a second, once; it can't be left out, because browsers only allow the decryption the page needs on `https://` pages (or `localhost`). If you test from inside your own network with Scute's public address, a slow router ("NAT loopback") can make it look far slower than it is for visitors; try from a phone on mobile data.

Plug-ins can also offer the same page as a download (a folder with `index.html` and the encrypted files) to upload to any static web host; nothing then goes through Scute at all. `SCUTE_SHARES=off` turns published shares off.

**If publishing fails with 502, 503 or 504**, the reverse proxy in front of Scute gave up rather than Scute: Scute was restarting, or one file (usually an original-size photo or a video) took too long or was too big for the proxy. Photos go up one file at a time, so raise the proxy's limits for Scute's site if you share large files, for example in Apache `ProxyTimeout 300` (and no `LimitRequestBody` smaller than your largest photo or video); in nginx `client_max_body_size 200m; proxy_read_timeout 300s;`.

## Scute Drive

Since 1.16.0 Scute can be your own private cloud folder, a replacement for Seafile or Nextcloud Files. Install the **Scute Drive** plug-in (in scute-extras) for the web file browser and the device setup; the server side is part of Scute.

- **Files are ordinary files on the server**, not encrypted, so you can reach them there too: `$SCUTE_DATA_DIR/drive/<username>/` (with Docker, `./data/drive/<username>/` next to `docker-compose.yml`). Folders keep their names; nothing is renamed or chunked. Deleted and replaced files go to a trash in `drive/.scute/trash/` for `SCUTE_DRIVE_TRASH_DAYS`.
- **Everything speaks WebDAV** at `https://notes.example.com/dav/`, signed in with your username and an **app password** made in Drive → Devices (never your Scute password; each device gets its own and can be removed on its own).
- **Linux**: two-way sync with rclone's `bisync` through the `scute-drive` script the plug-in downloads (`scute-drive setup`, then `scute-drive enable` for a systemd user timer every 5 minutes, plus sync right after local changes when `inotify-tools` is installed). Conflicts keep both copies (`name.conflict1.ext`), the newer one under the original name. `rclone mount`, GNOME Files (`davs://…`), Dolphin (`webdavs://…`) and davfs2 work too.
- **Android**: Round Sync (rclone for Android) or any WebDAV app, with the same address and an app password. The plug-in can download a ready `rclone.conf`.
- The server keeps SHA-1 and MD5 checksums of what it receives (ownCloud style), so `rclone check` and checksum syncs work, and keeps modification times.

Things to know:

- Files edited directly on the server show up in the web browser at once and on devices at their next sync. With Docker the files belong to the container's `node` user (uid 1000), with `0644`/`0755` permissions.
- To put the files on another disk, set `SCUTE_DRIVE_DIR` (with Docker, mount it as a volume, e.g. `- /srv/scute-drive:/drive` and `SCUTE_DRIVE_DIR=/drive`). Keep trash and uploads on the same disk: they're in `<SCUTE_DRIVE_DIR>/.scute/`.
- **Reverse proxy**: WebDAV uses methods such as `PROPFIND`, `MOVE` and `COPY`; Apache's `ProxyPass` and nginx pass them on as they are. Don't enable Apache's own `mod_dav` for that site. Uploads are streamed, so allow big bodies and long requests: Apache `LimitRequestBody 0` (or larger than `SCUTE_DRIVE_MAX_FILE_GB`) and `ProxyTimeout 600`; nginx `client_max_body_size 0; proxy_request_buffering off; proxy_read_timeout 600s;`.
- **Under a path** (`https://example.com/scute/`): also send the path, so the addresses in WebDAV answers are right. In the `<Location /scute/>` block add `RequestHeader set X-Forwarded-Prefix "/scute"` (`a2enmod headers`), or set `SCUTE_BASE_PATH=/scute`. Devices then use `https://example.com/scute/dav/`.
- Wrong app passwords are slowed down per address and username after 20 tries in 15 minutes; set `SCUTE_TRUST_PROXY=1` behind a proxy so that's the real address. `SCUTE_DRIVE=off` turns the drive off (it's also off when plug-ins are off).

## Inbox: data from other apps

Since 1.19.0 other apps can send data to Scute, for example your phone sending its location with OwnTracks, Overland, GPSLogger or Traccar Client. Install the **Location history** plug-in (in scute-extras) to use it; the plug-in makes the addresses and shows how to set each app up.

- Each address looks like `https://notes.example.com/in/<id>` and has its own password, which the app sends as an HTTP Basic-auth password (OwnTracks' username/password fields), a Bearer token, `?token=…`, or at the end of the address (`/in/<id>/<password>`). Wrong passwords get a 401.
- Scute can't read your notes, so it can't add what arrives to them. Instead each request is **sealed to your public key as it arrives** (the same ECDH P-256 box that shares space keys) and kept in the database until Scute is open in a browser; the plug-in then opens it, stores it in encrypted notes and tells the server to forget it. Nothing readable is written to disk, but the server does see requests while they arrive (an app's payload encryption, such as OwnTracks', hides even that).
- The reply is what the apps expect (`[]` for OwnTracks, `{"result":"ok"}` for Overland, `OK` otherwise). Requests are limited to `SCUTE_INBOX_MAX_KB` each and 600 a minute per address; when `SCUTE_INBOX_MAX_ITEMS` are waiting the server answers 429 until a browser picks them up, and apps keep them queued.
- **Reverse proxy**: nothing extra; `/in/` is under the same address (`https://example.com/scute/in/<id>` under a path). Don't strip the `Authorization` header. `SCUTE_INBOX=off` turns it off (it's also off when plug-ins are off).

## Fediverse

Since 1.20.0 Scute can be a small Fediverse server, like a one-person Mastodon. With it on, a Scute user can make an account such as `@jcm@jcm.social` and follow (and be followed by) people on Mastodon, Pixelfed, Misskey, GoToSocial and anything else that speaks ActivityPub. Install the **Fediverse** plug-in (in scute-extras) for the web interface: timelines, notifications, threads, profiles, search, and a composer with content warnings, polls, visibility and attachments.

- **Turn it on** with `SCUTE_FEDI_DOMAIN`, the domain in your handle, e.g. `SCUTE_FEDI_DOMAIN: "jcm.social"`. That domain must be served by Scute **at its root** (`https://jcm.social/`, not under a path), because other servers look for `https://jcm.social/.well-known/webfinger`, `/users/…`, `/inbox` and so on. Point its DNS at your server, get a certificate, and proxy the whole site to Scute with the original `Host` header kept (Apache `ProxyPreserveHost On`, nginx `proxy_set_header Host $host`), plus WebSocket upgrades for `/api/v1/streaming`. The notes app stays where it is (for example `https://example.com/scute/`); on the Fediverse domain Scute only answers Fediverse addresses, and `/` goes to the first account's profile.
- Apache, for a separate domain:

  ```apache
  <VirtualHost *:443>
      ServerName jcm.social
      # SSL lines (certbot) …
      ProxyPreserveHost On
      RequestHeader set X-Forwarded-Proto "https"
      ProxyPass        /api/v1/streaming http://127.0.0.1:5000/api/v1/streaming upgrade=websocket
      ProxyPass        / http://127.0.0.1:5000/ retry=0 timeout=600
      ProxyPassReverse / http://127.0.0.1:5000/
      LimitRequestBody 0
  </VirtualHost>
  ```

  The site serving the notes app needs `upgrade=websocket` on its `ProxyPass` too, for live timelines in the plug-in (Apache 2.4.47+; `a2enmod proxy_wstunnel` on older versions). nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
- **Accounts**: each Scute user may make one Fediverse account (any name of letters, digits and `_`), in the plug-in. `SCUTE_FEDI_USERS` limits who may (comma-separated Scute usernames). Deleting it tells other servers, removes its posts and media, and retires the name for good.
- **Plain, not encrypted**: the Fediverse is public by nature, so posts, profiles, follows, notifications and media are stored as they are, in the `fedi_*` tables of `scute.db` and in `$SCUTE_DATA_DIR/fedi/media/`. Nothing from your encrypted notes is shared unless you post it (the plug-in's "Share to Fediverse" note button copies a note's text and file into a new post). Direct messages work as on Mastodon: only the people mentioned see them, but they aren't end-to-end encrypted.
- **Files**: posts can carry up to 4 attachments of any kind up to `SCUTE_FEDI_MAX_MB` each. Pictures, videos and audio show inline everywhere; other files (PDFs, zips, documents…) are sent as documents, which Mastodon and most apps show as a download link. Video posters are made with ffmpeg (in the Docker image). Media from other servers isn't copied; it's shown from where it lives.
- **Mastodon apps**: Scute implements the Mastodon client API (`/api/v1`, `/api/v2`, OAuth, streaming and Web Push), so Tusky, Ivory, Ice Cubes, Mona, Elk, Phanpy and others work. Enter your Fediverse domain as the server and sign in with your **Scute** username and password; the sign-in page checks the password in your browser, the same way the Scute app does, so it never reaches the server. The plug-in lists connected apps and can sign them out.
- What's there: following (with approval if you lock your account), posts with mentions, hashtags, links, content warnings, polls, edits, replies, boosts, favourites, bookmarks, pins, blocks and mutes, profile fields and pictures, account moves from other servers, public profile pages at `https://<domain>/@name`, and NodeInfo. Not (yet): lists, filters, scheduled posts, translations, trends, reports, and relays. Posts from people you don't follow only arrive when someone you follow boosts or replies to them, or when you look them up.
- Scute signs its lookups on other servers with a server key (the actor at `https://<domain>/instance-actor`; `/actor` before 1.20.2). If a server refuses it, for example because it still remembers an earlier program on the same domain, Scute retries with the first account's own key.
- Deliveries to other servers are queued and retried with backoff for about three days. `SCUTE_FEDI=off` turns the Fediverse off again without losing anything; it's also off when plug-ins are off.

## Scute in Joplin

The **Scute Notes** plug-in for Joplin desktop (`us.mayson.scutenotes.jpl`, in scute-extras) signs in to your Scute server and shows your notes in a panel beside the editor, decrypted on your computer. You can read them, insert them into a Joplin note, copy them (with attachments) into notebooks, and send Joplin notes to Scute, encrypted. It needs Scute 1.17.0 or later and `SCUTE_API_CORS` left on. Unlike a Joplin space, nothing passes through Joplin Server and password notes stay encrypted unless you choose to copy them.

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
| `SCUTE_JOPLIN` | `on` | Set to `off` to disable Joplin Server sync (the relay and the space kind) |
| `SCUTE_PLUGINS` | `on` | Set to `off` to disable plug-ins entirely |
| `SCUTE_PLUGINS_DIR` | `$SCUTE_DATA_DIR/plugins` | Where installed plug-ins live |
| `SCUTE_PLUGIN_NET` | off | Comma-separated URL prefixes plug-ins may reach through the server (e.g. a local AI server: `http://ollama:11434`); `*` allows any. See [PLUGINS.md](PLUGINS.md#network-relay-api-3-network). |
| `SCUTE_ARCHIVE` | `on` | Set to `off` to disable bookmark previews and saved copies (the server-side page fetcher) |
| `SCUTE_ARCHIVE_PRIVATE` | `off` | Set to `on` to let bookmarks fetch private/LAN addresses |
| `SCUTE_ARCHIVE_MAX_MB` | `SCUTE_MAX_UPLOAD_MB` | Largest single page or file the fetcher will download |
| `SCUTE_MEDIA` | `on` | Set to `off` to stop bookmarks from downloading videos (on only when yt-dlp is found) |
| `SCUTE_YTDLP` | `yt-dlp` | The yt-dlp program, if it isn't on the `PATH` |
| `SCUTE_MEDIA_HEIGHT` | `1080` | Highest video resolution a bookmark saves |
| `SCUTE_MEDIA_MAX_MB` | `SCUTE_MAX_UPLOAD_MB` | Largest video a bookmark saves |
| `SCUTE_YTDLP_UPDATE` | `on` | Set to `off` to stop running `yt-dlp -U` at start and once a day (it only works when the program is writable, as in the Docker image) |
| `SCUTE_SHARES` | `on` | Set to `off` to disable published shares (`/shared/…`), including shared bookmark copies |
| `SCUTE_SHARE_MAX_MB` | `4096` | Largest total size of one published share |
| `SCUTE_DRIVE` | `on` | Set to `off` to disable Scute Drive (`/dav/`); also off when plug-ins are off |
| `SCUTE_DRIVE_DIR` | `$SCUTE_DATA_DIR/drive` | Where Scute Drive keeps files, one folder per user |
| `SCUTE_DRIVE_QUOTA_GB` | `0` | Space per user in GB; `0` for no limit (the disk's free space) |
| `SCUTE_DRIVE_MAX_FILE_GB` | `50` | Largest single file |
| `SCUTE_DRIVE_TRASH_DAYS` | `30` | How long deleted and replaced files stay in the trash; `0` deletes at once |
| `SCUTE_INBOX` | `on` | Set to `off` to stop other apps from sending data to Scute (`/in/…`); also off when plug-ins are off |
| `SCUTE_INBOX_MAX_KB` | `1024` | Largest single request an app may send to the inbox |
| `SCUTE_INBOX_MAX_ITEMS` | `200000` | Most requests waiting per inbox address before Scute answers 429 |
| `SCUTE_FEDI_DOMAIN` | none | Turns the Fediverse on: the domain in handles (`@name@jcm.social`). Must be served by Scute at its root |
| `SCUTE_FEDI_URL` | `https://<SCUTE_FEDI_DOMAIN>` | Where that domain is reached, if not plain https on the same name |
| `SCUTE_FEDI_USERS` | anyone | Comma-separated Scute usernames allowed a Fediverse account |
| `SCUTE_FEDI_MAX_MB` | `100` | Largest file one Fediverse attachment may be |
| `SCUTE_FEDI` | `on` | Set to `off` to turn the Fediverse off while keeping `SCUTE_FEDI_DOMAIN` set |
| `SCUTE_BASE_PATH` | none | The path Scute is served under (e.g. `/scute`) when the proxy doesn't send `X-Forwarded-Prefix` |
| `SCUTE_JOPLIN_URLS` | any | Comma-separated list of Joplin Server URLs users may connect to, e.g. `https://joplin.example.com`. Recommended on shared servers. |
| `SCUTE_API_CORS` | `on` | Lets apps on other origins (such as the Scute Notes plug-in for Joplin) call `/api` with a Bearer token. Safe because Scute never uses cookies for the API; set to `off` to allow only the Scute web app itself. |

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

All endpoints are JSON under `/api`, authenticated with `Authorization: Bearer <token>`. Since 1.17.0 they answer cross-origin requests (CORS) unless `SCUTE_API_CORS=off`.

- `GET /api/auth/params`, `POST /api/auth/register|login|logout`
- `GET /api/me`, `GET|DELETE /api/me/sessions[/:id]`, `POST /api/me/password`, `POST /api/me/delete`
- `GET /api/sync?since=<seq>` — incremental sync of everything the user can access
- `PUT|DELETE /api/spaces/:id`, `PUT|DELETE /api/spaces/:id/members/:userId`, `POST /api/spaces/:id/accept`
- `PUT|DELETE /api/boards/:id`, `PUT|DELETE /api/notes/:id`, `PUT|GET /api/files/:noteId`
- `GET /api/users/:username/key`, `GET /api/health`
- `GET /api/spaces/:id/tombstones` — ids of deleted notes/boards (used by Joplin sync)
- `GET /api/plugins`, `PUT|DELETE /api/plugins/:id`, `POST /api/plugins` (zip body, admin) — plug-in list and management; files are served from `/plugins/<id>/…`
- `POST /api/web/fetch` — fetches a public URL for bookmark previews and saved copies
- `POST /api/web/media` `{url}`, `GET /api/web/media/:id`, `GET /api/web/media/:id/file`, `DELETE /api/web/media/:id` — server-side video downloads for saved copies (yt-dlp); the file is deleted once fetched
- `GET /api/shares[?plugin=]`, `GET|PATCH|DELETE /api/shares/:slug`, `POST /api/shares/:slug/begin`, `PUT /api/shares/:slug/:version/<file>`, `POST /api/shares/:slug/:version/commit` — published shares; public pages and files are at `/shared/<slug>/…` (no login)
- `GET|POST /api/inbox?plugin=`, `PATCH|DELETE /api/inbox/:id`, `GET /api/inbox-items?plugin=&after=&limit=`, `POST /api/inbox-items/delete` — inbox addresses and the sealed requests waiting in them; apps send to `/in/<id>[/<password>]` (no login, any method)
- `GET /api/fedi`, `POST /api/fedi/account`, `POST /api/fedi/token`, `GET /api/fedi/apps`, `DELETE /api/fedi/apps/:id`, `POST /api/fedi/account/delete` — the signed-in user's Fediverse account; the Mastodon client API (`/api/v1/…`, `/api/v2/…`, `/oauth/…`) and ActivityPub (`/.well-known/webfinger`, `/users/<name>`, `/inbox`) are served on both the Scute address and the Fediverse domain
- `POST /api/plugins-net` — network relay for plug-ins, limited to `SCUTE_PLUGIN_NET`
- `ANY /api/joplin/<joplin api path>` with `X-Joplin-Url` — relay to a Joplin Server's sync API

## License

MIT
