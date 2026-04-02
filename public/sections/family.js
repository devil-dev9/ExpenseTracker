export function renderFamilySection(app) {
  const { state, section, listWrap, api, loadDashboard, contentEl } = app;
  section(
    "Family",
    "Manage members under this profile.",
    `<form class='data-form' id='memberForm'><label><span>Name</span><input name='name' required /></label><label><span>Relation</span><input name='relation' required /></label><button class='submit-button'>Add member</button></form>`,
    listWrap("Members", state.members.length, state.members.map((member) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(member.name)}</h4><div class='meta-line'><span>${app.esc(member.relation)}</span></div></div><div class='member-badge'>${member.isPrimary ? "Primary" : "Member"}</div></div>${member.isPrimary ? "" : `<button class='delete-button' data-member='${member.id}' type='button'>Delete</button>`}</article>`).join(""))
  );
  app.$("#memberForm").onsubmit = async (event) => {
    event.preventDefault();
    await api("/api/members", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
    await loadDashboard();
  };
  contentEl().querySelectorAll("[data-member]").forEach((button) => button.onclick = async () => {
    await api(`/api/members/${button.dataset.member}`, { method: "DELETE" });
    await loadDashboard();
  });
}
