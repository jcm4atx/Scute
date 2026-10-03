// Word count: the smallest useful plug-in. No permissions needed; it only
// looks at the note it's handed.
const words = (t) => (t.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~\[\]()!|-]/g, " ").match(/\S+/g) || []).length;

export function activate(scute) {
  scute.noteActions.register({
    id: "count",
    title: "Word count",
    when: (note) => note.text.trim().length > 0,
    run(note) {
      const w = words(note.text);
      const mins = Math.max(1, Math.round(w / 230));
      scute.ui.toast({ title: `${w.toLocaleString()} words`, description: `${note.text.length.toLocaleString()} characters · about ${mins} min to read` });
    },
  });

  scute.cards.addBadge((note) => {
    const w = note.type === "text" ? words(note.text) : 0;
    return w >= 300 ? `${w.toLocaleString()} words` : null;
  });
}
