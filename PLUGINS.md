# Writing Scute plug-ins

A plug-in is a folder with a `plugin.json` manifest and one JavaScript module. Scute loads it in the browser after you sign in, so it sees your notes **decrypted**, just like the rest of the app. It can add:

- **Commands**: entries in the puzzle-piece menu in the header, optionally with a keyboard shortcut
- **Note actions**: buttons at the bottom of an open note
- **Views**: full pages listed under "Plug-ins" in the sidebar
- **Templates**: entries in the New menu that open a pre-filled note
- **Card badges**: small labels on note cards
- **Markdown extensions**: a text transform before rendering and a DOM post-processor after it
- **Event handlers**: run code when a note opens, notes change, or the space changes

The four plug-ins in [`plugins/`](plugins/) are small, commented, working examples:

| Plug-in | Shows how to |
| --- | --- |
| `word-count` | note action + card badge, no permissions (the smallest useful plug-in) |
| `daily-note` | commands with a shortcut, a template, creating boards and notes, storage |
| `wiki-links` | Markdown transform + post-processor, a stylesheet, opening/creating notes, dialogs |
| `space-stats` | a view that redraws on `notes:change` |

## Security: read this first

Plug-ins are **trusted code**. They run in the same page as Scute, with the same origin, so a plug-in can technically do anything Scute can do in your browser: read every decrypted note in every space you can open, and send it anywhere. The `permissions` list is a **declaration**, not a sandbox: Scute checks it on the `scute.*` API calls and shows it to the admin before enabling, which catches mistakes and makes intent visible, but it can't stop hostile code.

So: only install plug-ins you wrote or have read. The server admin decides which plug-ins are available to everyone; each user can still switch any of them off for themselves. Plug-ins never see anyone's password or encryption keys through the API, and the server never sees decrypted data.

To disable the whole system, set `SCUTE_PLUGINS=off`.

## Installing

Either:

- **Drop a folder** into the plug-ins directory (`./data/plugins/<id>/` with the Docker setup, or `SCUTE_PLUGINS_DIR`). The folder name must equal the manifest `id`. Then open Settings → Plug-ins and press **Reload plug-ins**, or
- **Upload a zip** in Settings → Plug-ins → **Install from .zip** (admins only). The zip may contain the files at its root or inside a single top-level folder. Limits: 20 MB zip, 50 MB unpacked. Installing an id that already exists replaces it.

New plug-ins start **off**. The admin switches on **Available to everyone**; each user has a **Use it myself** switch. Installed plug-ins can be removed from the same screen; the bundled examples can only be switched off.

Packaging a zip:

```bash
cd my-plugins && zip -r hello.zip hello/
```

## Starter plug-in

`hello/plugin.json`

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "0.1.0",
  "description": "Counts how many times you've said hello.",
  "author": "You",
  "main": "main.js",
  "permissions": ["storage"]
}
```

`hello/main.js`

```js
/** @param {import("../scute-plugin").Scute} scute */
export function activate(scute) {
  scute.commands.register({
    id: "hi",
    title: "Say hello",
    key: "mod+shift+h", // Ctrl on Linux/Windows, Cmd on macOS
    async run() {
      const n = (scute.storage.get("count") || 0) + 1;
      await scute.storage.set("count", n);
      scute.ui.toast(`Hello #${n}`);
    },
  });

  // Optional: return a function to clean up when the plug-in is switched off.
  return () => {};
}
```

Everything you register is removed automatically when the plug-in is unloaded; the returned function (or an exported `deactivate()`) is only for things Scute doesn't know about, like timers.

Type definitions for editors live in [`plugins/scute-plugin.d.ts`](plugins/scute-plugin.d.ts).

## Manifest (`plugin.json`)

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | `a-z`, `0-9`, `.`, `_`, `-`; 2–64 characters; must match the folder name |
| `name` | yes | Shown in Settings |
| `version` | yes | Free text, e.g. `1.2.0` |
| `main` | yes | A `.js` file inside the folder, loaded as an ES module |
| `description`, `author`, `homepage` | no | Shown in Settings |
| `styles` | no | A `.css` file inside the folder, added to the page while the plug-in is on. Prefix your selectors. |
| `permissions` | no | See below |
| `shareViewer` | no | API 6: a `.html` file inside the folder that `/shared/<name>/` serves for this plug-in's shares. It must be self-contained (inline its scripts and styles); it's served with a strict CSP that allows only same-origin fetches and OpenStreetMap tiles. |
| `shareAllow` | no | API 7: loosen the viewer's CSP for public (unencrypted) sites. Any of `web-images` (images from https: addresses), `web-media` (video and audio from https:), `video-embeds` (YouTube-nocookie and Vimeo players in iframes). |
| `apiVersion` | no | Default `1`. Scute 1.7.0 offers `2`, Scute 1.8.0 offers `3`, Scute 1.10.0 offers `4`, Scute 1.11.0 offers `5`, Scute 1.12.0 offers `6`, Scute 1.15.0 offers `7`, Scute 1.16.0 offers `8`, Scute 1.19.0 offers `9`. Plug-ins asking for a newer API than the server offers are refused. |

A plug-in can have extra files (images, more modules); they're served from `/plugins/<id>/<path>` and can be imported with relative `import` statements.

### Permissions

| Permission | Allows |
| --- | --- |
| *(none)* | Commands, note actions, views, templates, badges, Markdown, events, dialogs. Actions and badges still receive the note they're about. |
| `notes:read` | `spaces.*`, `boards.list`, `notes.list`, `notes.get` |
| `notes:write` | `boards.create`, `notes.create`, `notes.update`, `notes.delete` (ordinary spaces you can edit only; not Joplin spaces or the special ones) |
| `storage` | `storage.*`: a small per-user, per-plug-in key/value store, encrypted and synced with your settings (64 KB per plug-in) |
| `network` | The plug-in talks to other websites. Needed for `scute.net.fetch` (API 3, the relay) and `scute.net.get` (API 4, public web). Plain browser `fetch` isn't blocked, but declare it honestly either way; it's shown to the admin. |
| `publish` | API 6: `shares.*`, publishing read-only pages at `/shared/<name>/` that anyone with the address can load. Encrypt what you upload. |
| `inbox` | API 9: `inbox.*`, addresses other apps (such as OwnTracks) send data to, and what they've sent |
| `drive` | API 8: `drive.*`, the user's Scute Drive files (ordinary, unencrypted files on the server, also reachable over WebDAV) and its app passwords |
| `fediverse` | API 10: `fedi.*`, the user's Fediverse account and a Mastodon-API token that can read and post as them |

A call without the permission throws an error, which Scute shows as a toast.

## API reference

`activate(scute)` receives one frozen object. All callbacks are wrapped: if they throw or reject, Scute logs the error and shows a toast (at most one every 10 seconds per plug-in), and nothing else breaks.

### Notes as plug-ins see them

```ts
interface PlainNote {
  id: string; spaceId: string; boardId: string | null;
  type: "text" | "link" | "password" | "image" | "video" | "file" | ...;
  title: string; text: string; url?: string; tags: string[];
  color: string | null; pinned: boolean;
  file: { name: string; type: string; size: number; width?: number; height?: number; duration?: number; stored?: boolean } | null; // no file contents (see files.*). stored (1.15.1+) is false when the upload never finished
  created: number; modified: number;   // ms since epoch
  data?: unknown;                      // this plug-in's own data on the note
}
```

Password fields and encrypted thumbnails are never included. `data` is private to your plug-in: set it with `notes.create({ data })` / `notes.update(id, { data })`; other plug-ins can't see it. It's stored encrypted inside the note.

### Context

`scute.context()` → `{ spaceId, boardId, noteId }` for what's on screen now. Command `run`, action `run`, view `mount` and template `create` also receive it.

### Commands

```js
scute.commands.register({ id, title, icon?, key?, run(ctx) {} })
```

`key` is like `"mod+shift+d"`, `"alt+j"` (`mod` = Ctrl, or Cmd on a Mac). Shortcuts without `mod` don't fire while you're typing in a field. `icon` is an optional inline `<svg>` string (sanitised); the default is a puzzle piece.

### Note actions

```js
scute.noteActions.register({ id, title, icon?, when?(note), run(note, ctx) {} })
```

Shown when a note is open in view mode, to everyone who can see the note (including read-only guests). `when` hides the button for notes it doesn't apply to.

### Views

```js
scute.views.register({ id, title, icon?, mount(el, ctx) { ...; return () => cleanup } })
scute.views.open(id)
```

`el` is an empty `<div>` in the main area. Build it with DOM APIs or `scute.ui.el`. Avoid `innerHTML` with note content (that's how cross-site scripting happens).

### Templates

```js
scute.templates.register({ id, title, create(ctx) { return { title, text, tags } } })
```

Shown in the New menu; opens the note editor pre-filled (nothing is saved until the user saves). May return a Promise.

### Card badges

```js
scute.cards.addBadge((note) => (note.tags.includes("urgent") ? "!" : null))
```

Return a short string, or a falsy value for no badge. Called often, so keep it cheap.

### Markdown

```js
scute.markdown.addTransform((src) => src)           // string in, string out, before rendering
scute.markdown.addPostProcessor((el, { noteId }) => {}) // after rendering, the DOM element
```

The output of transforms still goes through Scute's HTML sanitiser, so they can't inject scripts. Post-processors run on cards and in the open note, again whenever the note or the set of notes changes; make them idempotent (see `wiki-links`).

### Events

```js
const off = scute.events.on("note:open", (note) => {})
scute.events.on("notes:change", ({ changed, removed }) => {}) // arrays of note ids
scute.events.on("space:change", ({ id, title }) => {})
scute.events.on("services:change", ({ name, available }) => {}) // API 3
```

### Space kinds (API 2)

A plug-in can add a special kind of space, chosen when a space is created. Spaces of that kind get the plug-in's own screens.

```js
scute.spaceKinds.register({
  id: "recipes", title: "Recipe box",
  layout: "tabs",            // "tabs": tab strip above the note grid; "full": you draw the whole area
  tabs: [{ id: "planner", title: "Meal plan", icon, mount(el, ctx) { return () => {} } }],
  mount(el, ctx) {},         // required for layout "full"
  newItems: [{ id: "new-recipe", title: "Recipe", icon, run(ctx) {} }],   // top of the New menu
  menuItems: [{ id: "import", title: "Import…", run(ctx) {} }],          // space menu
})
```

`notes` and `joplin` are built in and can't be claimed. A plug-in may only write to ordinary spaces and spaces of its own kinds. If the plug-in is disabled, its spaces stay (and stay encrypted and synced) but open as ordinary note grids until it's back.

### Note types (API 2)

```js
scute.noteTypes.register({
  id: "recipe", title: "Recipe", icon,
  field: "recipe",                       // where the structured data lives; defaults to id
  open(note, ctx) {},                    // replaces the built-in viewer for this type
  cardLine(note) { return { dot: "#c2577a", parts: ["Serves 4", "30 min"] } },
})
```

API 4 adds `cardCover(note)`: return SVG markup (it's sanitised: no scripts, styles or `foreignObject`) or a `data:image/png|jpeg|webp;base64,…` URL, and it's drawn across the top of the note's card, like a bookmark's picture. It's called on every render, so return the same string for the same note (cache it).

For notes of your own type, `data` on `notes.create` / `notes.update` / `PlainNote` is that field, stored encrypted in the note like any other field (for ordinary notes, `data` stays private per plug-in, as described above). Built-in type names and field names can't be used.

### Global menu items (API 2)

```js
scute.menus.register({ id: "new-recipe-box", location: "spaces", title: "New recipe box", run(ctx) {}, when(ctx) { return true } })
```

`location: "spaces"` is the space switcher menu.

### Spaces and bulk writes (API 2, `notes:write`)

```js
await scute.spaces.create({ title, color?: "#2f6f5e", kind?: "recipes" }) // → id; kind must be "notes" or one of yours
scute.spaces.open(id, { tab?: "planner" })
await scute.notes.createMany(spaceId, [{ id?, type, title, text, tags, data, created?, modified? }, ...], (done, total) => {}) // → ids
scute.util.uuid()        // a new UUID; pass it as id to link notes to each other before they exist
scute.status.online()    // createMany needs a connection; check first
```

`createMany` saves in one request and is meant for imports; it's all-or-nothing. Ids you pass must be new UUIDs. `created` is kept if it's a sensible timestamp, and since 1.17.0 so is `modified` (not before `created`, not in the future), so imports keep their edit dates. The same goes for `create` and `files.add`.

### Data (`notes:read` / `notes:write`)

```js
scute.spaces.list()     // [{ id, title, color, kind, role, writable }]
scute.spaces.current()
scute.boards.list(spaceId?)             // [{ id, spaceId, title, parentId }]
await scute.boards.create({ spaceId?, title })          // → id
scute.notes.list({ spaceId?, boardId?, type?, tag?, search? }) // spaceId "all" for every space
scute.notes.get(id)                     // PlainNote | null
await scute.notes.create({ id?, spaceId?, boardId?, type?: "text" | "link" | yourType, title, text, url, tags, color, pinned, data }) // → id
await scute.notes.update(id, { title?, text?, url?, tags?, color?, pinned?, boardId?, data? })
await scute.notes.delete(id)
scute.notes.open(id)                    // show it
```

Spaces the user has hidden (Scute 1.13.0) are left out of all of these, with their boards and notes, until the user shows them; `notes:change` fires when that happens. Don't keep your own copies of hidden content around.

`spaceId`/`boardId` default to what's on screen. Reads see your own writes immediately; changes are encrypted and synced like any other edit (and work offline).

### Attachments (API 5)

Photos, videos and files are encrypted like everything else; these calls decrypt them in the browser.

```js
scute.files.thumb(id)                    // notes:read. The small inline preview (data: URL) of an image or video note, or null
const url = await scute.files.url(id, { onProgress: (f) => {} }) // notes:read. Object URL of the attachment (cached, don't revoke it)
const blob = await scute.files.blob(id)  // notes:read
const newId = await scute.files.add(file, { spaceId?, boardId?, title?, text?, tags?, created?, data? }) // notes:write, needs a connection
```

`files.add` works like dropping a file on a space: the note becomes an image, video or file note with a thumbnail, size and dimensions. `data` is private to your plug-in, as on any ordinary note. `url` and `blob` download the whole file the first time (small files are then kept offline), so fetch lazily.

### Shares (API 6, `publish`)

A plug-in with a `shareViewer` page can publish files for people without an account. The server stores them under `/shared/<name>/` and serves your viewer page at `/shared/<name>/` itself; the page loads `share.json` and the other files relative to its own address, so the same folder also works when exported to another web server or reached through a reverse proxy (see the README).

```js
const { enabled, base } = await scute.shares.info()   // base = "https://notes.example.com/shared/"
await scute.shares.check("europe2026")                // { valid, available, mine, share }
await scute.shares.publish("europe2026", {
  files: ["share.json", "m/abc.bin", "f/0123.bin"],   // every file; unchanged ones from the last version are kept, not re-uploaded
  produce: async (f) => bytesFor(f),                  // Blob | Uint8Array | string
  expires: null, onProgress: (done, total) => {},
})
await scute.shares.setExpiry("europe2026", Date.now() + 7 * 86400e3)
await scute.shares.remove("europe2026")               // stop sharing (404 afterwards; expired shares give 410)
const html = await scute.shares.viewer()              // your shareViewer page, for exports
```

Anything in a share is public to whoever has the address, so encrypt it in the browser first (AES-GCM with a random key, and put the key in the link's `#fragment` or wrap it with a password). Names are up to 64 characters of `a-z`, `0-9` and `-` (not starting or ending with `-`), first come first served across the server. The photo album plug-in in scute-extras is a complete example.

Since API 7 a share can also hold ordinary public files: besides `.bin` and `.json`, names may end in `.jpg .png .gif .webp .avif .mp4 .m4v .webm .mov .ogv .mp3 .m4a .oga .ogg .wav .flac .pdf` (one folder level at most, e.g. `m/abc.jpg`). They're served with the matching Content-Type, `nosniff` and a sandboxing CSP, and support range requests, so `<img>`, `<video>` and PDF links work straight from your viewer. Only publish things this way that are meant to be public. The space website plug-in in scute-extras is an example.

### Drive (API 8, `drive`)

Scute Drive is a folder of ordinary files per user on the server, served over WebDAV at `/dav/` (for rclone, Round Sync, file managers). Plug-ins see it through `scute.drive`; paths are relative to the drive, like `"Photos/2026/a.jpg"`, with `""` for the top.

```js
const info = await scute.drive.info()          // { enabled, username, url: "https://notes.example.com/dav/", used, quota, maxFile, trashDays, folder }
await scute.drive.list("Photos")               // [{ name, dir, size, mtime, type }]
await scute.drive.tree("Photos")               // every file below, [{ path, size, mtime }] (for zips)
await scute.drive.mkdir("Photos/2026")         // parents must exist (405 if it's already there)
await scute.drive.upload("Photos/2026/a.jpg", file, { mtime, onProgress: (done, total) => {}, signal })
const blob = await scute.drive.download("notes.txt", { onProgress, signal })
const url = await scute.drive.link("film.mp4")  // works without signing in for about 6 hours: <video src>, downloads (add ?dl=1)
await scute.drive.move("a.txt", "Old/a.txt", { overwrite: false, copy: false })
await scute.drive.remove("Old")                // to the trash
await scute.drive.trash.list()                 // { days, items: [{ id, path, dir, size, deleted, reason }] }
await scute.drive.trash.restore(id, { to?, replace? }); await scute.drive.trash.remove(id); await scute.drive.trash.empty()
await scute.drive.tokens.create("Laptop")      // { id, label, token }: an app password for WebDAV, shown only now
await scute.drive.tokens.list(); await scute.drive.tokens.remove(id)
```

Errors carry `status` (404, 405, 409, 413 too big, 507 out of space). The Scute Drive plug-in in scute-extras is the complete example.

### Inbox (API 9, `inbox`)

Web addresses other apps can send data to without signing in, such as a phone app sending its location. Each address belongs to the plug-in that made it. The server seals every request to the user's public key when it arrives and keeps it until a plug-in in the browser fetches it; `fetch()` opens the seal with the user's private key, so the plug-in gets the request as it was sent. Store what you need in notes, then `ack()` the items so the server deletes them.

```js
const info = await scute.inbox.info()     // { enabled, maxKb, base, endpoints: [{ id, label, url, created, lastUsed, received, waiting }] }
const a = await scute.inbox.create({ label: "OwnTracks · Phone" })   // { ...endpoint, secret }: the password, shown only now
await scute.inbox.update(a.id, { label, newSecret: true })          // newSecret: returns a new `secret`
await scute.inbox.remove(a.id)            // also drops what's waiting
const { items, more } = await scute.inbox.fetch({ limit: 500, after: 0 })
// items: [{ id, endpoint, received, method, contentType, query, headers, body, base64 }] (oldest first), or { id, endpoint, received, error }
await scute.inbox.ack(items.map((i) => i.id))
```

Apps send to `url` (or `url + "/" + secret`) with any method; the password can also come as a Basic-auth password, `Authorization: Bearer`, or `?token=`. `headers` keeps only `user-agent` and OwnTracks' `x-limit-u` / `x-limit-d`; `body` is text unless `base64` is true. Several browser tabs may run the plug-in at once, so fetch under `navigator.locks` (the Location history plug-in in scute-extras is the complete example).

### Fediverse (API 10, `fediverse`)

When the server has a Fediverse domain (`SCUTE_FEDI_DOMAIN`), each user can have one ActivityPub account, `@name@domain`. Plug-ins manage it through `scute.fedi` and then talk to Scute's **Mastodon client API** like any Mastodon app would, with a token for this device.

```js
const info = await scute.fedi.info()   // { enabled, domain, url, allowed, version, account: <Mastodon Account> | null, queue: { waiting, retrying, lastError }, api }
await scute.fedi.createAccount({ username: "jcm", displayName: "John" })  // { account, token }
const { token, api } = await scute.fedi.token()   // a Bearer token for this signed-in device (replaces its previous one)
const home = await fetch(`${api}/api/v1/timelines/home`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
await scute.fedi.apps()                // Mastodon apps signed in to the account: [{ id, name, website, created, lastUsed, scopes, scute, push }]
await scute.fedi.revokeApp(id)
await scute.fedi.deleteAccount("jcm")  // the account name, to confirm
```

`api` is Scute's own address (e.g. `https://example.com/scute`), so requests are same-origin; the streaming API is a WebSocket at `${api}/api/v1/streaming?stream=user&access_token=…`. Everything in the Fediverse is stored in plain form on the server; don't post the contents of encrypted notes unless the user asks. The Fediverse plug-in in scute-extras is the complete example.

### Storage (`storage`)

```js
scute.storage.get(key); scute.storage.all()
await scute.storage.set(key, jsonValue); await scute.storage.remove(key)
```

### Services (API 3)

Plug-ins can share an object with each other. The service disappears when its plug-in is turned off.

```js
scute.services.provide("my-service", { version: 1, hello: (x) => `hi ${x}` }) // → off()
const other = scute.services.get("their-service") // → the object, or null
scute.events.on("services:change", ({ name, available }) => {})
```

Plug-ins load one after another, so a service may appear after you start: read it when you need it, or listen for `services:change`. Only one plug-in can provide a given name.

### Network relay (API 3, `network`)

Browsers can't call most self-hosted services from a Scute page: they don't send CORS headers, or they're plain `http://` while Scute is `https://`. The server can make the request instead, but only to URL prefixes the admin allows:

```yaml
environment:
  SCUTE_PLUGIN_NET: "http://ollama:11434,http://192.168.1.20:1234"   # comma separated; "*" = any http(s) URL
  # SCUTE_PLUGIN_NET_TIMEOUT: "600"   # seconds per request (default 600)
```

```js
scute.net.relay()          // → { enabled, allow: [...] }
scute.net.allowed(url)     // → true if the relay would accept this URL
const r = await scute.net.fetch("http://ollama:11434/v1/models", { method?, headers?, body?: string, signal? })
r.status; await r.json(); r.body.getReader() // a normal Response; the body streams as it arrives
```

Only signed-in users can use the relay, and it forwards to allowed prefixes only. Anything a user can reach through it runs from the Scute server's network, so keep the list tight. Cookies aren't forwarded. If `scute.net.fetch` throws, the relay refused the request or couldn't reach the target (the message says which). An error answer from the target itself comes back as a normal `Response` with that status.

Behind a reverse proxy, streamed answers can arrive in one piece if the proxy buffers or compresses them. For Apache:

```apache
ProxyPass        / http://127.0.0.1:5000/ flushpackets=on
ProxyPassReverse / http://127.0.0.1:5000/
SetEnvIf Request_URI "^/api/plugins-net" no-gzip
```

For nginx, the relay already sends `X-Accel-Buffering: no`.

### Public web (API 4, `network`)

For public web APIs (flight data, weather, Wikipedia…) there's no need to ask the admin for an allow list: `scute.net.get` asks the server's bookmark fetcher to GET the URL. It refuses private and LAN addresses (unless the admin set `SCUTE_ARCHIVE_PRIVATE=on`) and is off when `SCUTE_ARCHIVE=off`.

```js
if (await scute.net.web()) {
  const r = await scute.net.get("https://api.example.com/v1/thing?id=1", { headers: { "X-Api-Key": key }, maxBytes: 2_000_000 })
  r.status; r.headers.get("content-type"); await r.json()
}
```

Only GET. Extra headers are forwarded (API keys and the like), except ones that would change the request itself (`Host`, `Cookie`, `Range`, `User-Agent`, `X-Forwarded-*`, …). The server doesn't keep anything, but it does see the URL and headers.

### UI

```js
scute.ui.toast("Saved")  // or { title, description?, error? }
await scute.ui.alert(message, title?)
await scute.ui.confirm(message, { title?, okLabel? })   // → boolean
await scute.ui.prompt(message, value?, { title?, okLabel? }) // → string | null
scute.ui.el("div", { class: "x", onclick: fn, style: {...} }, "text", childEl, [more])
```

### Info

`scute.version` (Scute version), `scute.apiVersion` (`2` in Scute 1.7.0, `3` in 1.8.0, `4` in 1.10.0, `5` in 1.11.0, `6` in 1.12.0, `7` in 1.15.0, `8` in 1.16.0, `9` in 1.19.0, `10` in 1.20.0), `scute.plugin` (`{ id, name, version, permissions }`).

## Development tips

- Plug-in files are served with `Cache-Control: no-cache` and a version hash, so after editing just press **Reload plug-ins** (or reload the page).
- Errors appear as toasts and in the browser console, prefixed with `[plug-in <id>]`. A plug-in that fails to load shows its error in Settings → Plug-ins.
- Enabled plug-ins are cached by the service worker, so they keep working offline.
- A bundled plug-in (React, a CSS framework, etc.) is fine: `main` can be one big ES module. Scope its CSS under a class on your own root element, and render into a child element you create inside `el` rather than into `el` itself (Scute empties `el` when the view closes).
- Keep CSS selectors prefixed (`.myplugin-…`) and use Scute's CSS variables (`hsl(var(--primary))`, `hsl(var(--muted-foreground))`, `hsl(var(--border))`) so light and dark themes both work.
