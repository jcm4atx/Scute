// Wiki links: [[Title]] or [[Title|shown text]] become links between notes.
const RE = /\[\[([^\[\]|\n]{1,200})(?:\|([^\[\]\n]{1,200}))?\]\]/g;
const enc = (s) => encodeURIComponent(s.trim());

export function activate(scute) {
  const find = (title, spaceId) => {
    const t = title.trim().toLowerCase();
    return scute.notes.list({ spaceId }).find((n) => n.title.trim().toLowerCase() === t) || null;
  };

  // 1. Before Markdown is rendered: turn [[x]] into an ordinary link with a marker URL.
  //    (Code spans are left alone.)
  scute.markdown.addTransform((src) =>
    src
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((part, i) => (i % 2 ? part : part.replace(RE, (_, title, label) => `[${(label || title).replace(/[\[\]]/g, "")}](#wiki:${enc(title)})`)))
      .join(""),
  );

  // 2. After rendering: style the links and make them clickable.
  scute.markdown.addPostProcessor((el, info) => {
    const note = info.noteId ? scute.notes.get(info.noteId) : null;
    const spaceId = note ? note.spaceId : scute.context().spaceId;
    el.querySelectorAll('a[href^="#wiki:"]').forEach((a) => {
      const title = decodeURIComponent(a.getAttribute("href").slice(6));
      a.classList.add("wiki-link");
      a.classList.toggle("wiki-missing", !find(title, spaceId));
      a.removeAttribute("target");
      a.setAttribute("role", "button");
      a.title = title;
      if (a.dataset.wikiBound) return;
      a.dataset.wikiBound = "1";
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hit = find(title, spaceId);
        if (hit) return scute.notes.open(hit.id);
        if (await scute.ui.confirm(`There's no note called “${title}” yet. Create it?`, { okLabel: "Create note" })) {
          const id = await scute.notes.create({ spaceId, boardId: note ? note.boardId : undefined, title, text: "" });
          setTimeout(() => scute.notes.open(id), 150);
        }
      });
    });
  });

  // 3. Backlinks: which notes link here?
  scute.noteActions.register({
    id: "backlinks",
    title: "Backlinks",
    async run(note) {
      const me = note.title.trim().toLowerCase();
      if (!me) return scute.ui.alert("This note has no title, so nothing can link to it.");
      const hits = scute.notes.list({ spaceId: note.spaceId }).filter((n) => n.id !== note.id && [...n.text.matchAll(RE)].some((m) => m[1].trim().toLowerCase() === me));
      await scute.ui.alert(hits.length ? hits.map((n) => `• ${n.title || "Untitled"}`).join("\n") : "No notes link here yet.", `Links to “${note.title}”`);
    },
  });
}
