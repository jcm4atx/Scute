// Space stats: a full-page view built with plain DOM (scute.ui.el).
const LABEL = { text: "Notes", link: "Bookmarks", password: "Passwords", image: "Images", video: "Videos", file: "Files" };

export function activate(scute) {
  const { el } = scute.ui;

  scute.views.register({
    id: "stats",
    title: "Space stats",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-8"/></svg>',
    mount(root) {
      const draw = () => {
        const space = scute.spaces.current();
        const notes = scute.notes.list();
        const byType = {};
        const byTag = {};
        for (const n of notes) {
          byType[n.type] = (byType[n.type] || 0) + 1;
          for (const t of n.tags) byTag[t] = (byTag[t] || 0) + 1;
        }
        const tags = Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 10);
        const max = tags.length ? tags[0][1] : 1;
        const week = Date.now() - 7 * 864e5;
        const recent = [...notes].sort((a, b) => b.modified - a.modified).slice(0, 8);
        root.replaceChildren(
          el("p", { class: "ss-label", "data-testid": "text-stats-space" }, space ? space.title : ""),
          el(
            "div",
            { class: "ss-grid" },
            el("div", { class: "ss-card" }, el("div", { class: "ss-num", "data-testid": "text-stats-total" }, notes.length), el("div", { class: "ss-label" }, "items")),
            el("div", { class: "ss-card" }, el("div", { class: "ss-num" }, notes.filter((n) => n.modified > week).length), el("div", { class: "ss-label" }, "changed this week")),
            ...Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, c]) => el("div", { class: "ss-card" }, el("div", { class: "ss-num" }, c), el("div", { class: "ss-label" }, LABEL[t] || t))),
          ),
          el("h2", { class: "ss-h" }, "Top tags"),
          ...(tags.length ? tags.map(([t, c]) => el("div", { class: "ss-bar" }, el("span", null, "#" + t), el("i", { style: { width: `${Math.max(4, (c / max) * 60)}%` } }), el("span", { class: "ss-label" }, c))) : [el("p", { class: "ss-label" }, "No tags yet")]),
          el("h2", { class: "ss-h" }, "Recently edited"),
          el("ul", { class: "ss-list" }, recent.map((n) => el("li", null, el("button", { type: "button", onClick: () => scute.notes.open(n.id) }, n.title || "Untitled"), el("time", null, new Date(n.modified).toLocaleDateString())))),
        );
      };
      draw();
      // keep the numbers live while the view is open
      const off = scute.events.on("notes:change", draw);
      return off;
    },
  });
}
