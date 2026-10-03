// Daily note: one note per day, titled YYYY-MM-DD, in a "Journal" board.
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const body = () =>
  `**${new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}**\n\n## Notes\n\n\n## To do\n- [ ] \n`;

export function activate(scute) {
  async function journalBoard(spaceId) {
    const name = scute.storage.get("board") || "Journal";
    const found = scute.boards.list(spaceId).find((b) => b.title.toLowerCase() === name.toLowerCase());
    return found ? found.id : scute.boards.create({ spaceId, title: name });
  }

  async function openToday() {
    const space = scute.spaces.current();
    if (!space) return scute.ui.toast({ title: "Pick a space first", error: true });
    if (!space.writable || space.kind !== "notes") return scute.ui.toast({ title: "Daily notes need an ordinary space you can edit", error: true });
    const title = today();
    const existing = scute.notes.list({ spaceId: space.id }).find((n) => n.title === title && n.tags.includes("journal"));
    if (existing) return scute.notes.open(existing.id);
    const boardId = await journalBoard(space.id);
    const id = await scute.notes.create({ spaceId: space.id, boardId, title, text: body(), tags: ["journal"] });
    scute.ui.toast(`Created ${title}`);
    setTimeout(() => scute.notes.open(id), 150);
  }

  scute.commands.register({ id: "today", title: "Open today's note", key: "mod+shift+d", run: openToday });

  scute.commands.register({
    id: "board-name",
    title: "Daily note: choose board…",
    async run() {
      const name = await scute.ui.prompt("Board to keep daily notes in:", scute.storage.get("board") || "Journal");
      if (name && name.trim()) {
        await scute.storage.set("board", name.trim());
        scute.ui.toast(`Daily notes will go in “${name.trim()}”`);
      }
    },
  });

  scute.templates.register({
    id: "journal",
    title: "Journal entry",
    create: () => ({ title: today(), text: body(), tags: ["journal"] }),
  });
}
