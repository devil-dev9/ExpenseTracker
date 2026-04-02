export function renderGoalsSection(app) {
  const { state, section, listWrap, date, money, totalGoal, goalProgress, renderGoalCharts, api, loadDashboard, contentEl, labelMonth } = app;
  const defaultMemberId = state.members.find((item) => item.isPrimary)?.id || state.members[0]?.id || "";
  section(
    "Goals",
    "Set savings goals and update their progress cleanly.",
    `<form class='data-form' id='goalForm'><label><span>Name</span><input name='name' required /></label><label><span>Target amount</span><input name='targetAmount' type='number' min='0' step='0.01' required /></label><label><span>Target date</span><input name='targetDate' type='date' required /></label><label><span>Notes</span><textarea name='notes'></textarea></label><button class='submit-button'>Save goal</button></form>`,
    listWrap("Goals", state.goals.length, state.goals.map((goal) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(goal.name)}</h4><div class='meta-line'><span>${date(goal.targetDate)}</span><span>${app.esc(goal.notes || "")}</span></div></div><div class='amount-pill'>${money(totalGoal(goal))} / ${money(goal.targetAmount)}</div></div><div class='progress-bar'><div class='progress-value' style='width:${goalProgress(goal)}%'></div></div><form class='inline-form' data-goal='${goal.id}'><input name='memberId' type='hidden' value='${defaultMemberId}' /><div class='inline-grid'><label><span>Add amount</span><input name='amount' type='number' min='0' step='0.01' required /></label><label><span>Month</span><input name='month' type='month' value='${state.month}' required /></label></div><label><span>Note</span><input name='note' placeholder='Example: Monthly savings update' required /></label><button class='submit-button'>Update progress</button></form><div class='contribution-list'>${goal.contributions.map((item) => `<div class='sub-card'><div class='entry-topline'><div><div class='meta-line'><span>${labelMonth(item.month)}</span><span>${app.esc(item.note)}</span></div></div><div class='amount-pill'>${money(item.amount)}</div></div><button class='delete-button' data-contrib='${goal.id}:${item.id}' type='button'>Delete update</button></div>`).join("")}</div><div class='entry-actions'><button class='delete-button' data-goal='${goal.id}' type='button'>Delete goal</button></div></article>`).join("")),
    renderGoalCharts()
  );
  app.$("#goalForm").onsubmit = async (event) => {
    event.preventDefault();
    await api("/api/goals", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
    await loadDashboard();
  };
  contentEl().querySelectorAll("form[data-goal]").forEach((form) => form.onsubmit = async (event) => {
    event.preventDefault();
    await api(`/api/goals/${form.dataset.goal}/contributions`, { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
    await loadDashboard();
  });
  contentEl().querySelectorAll("[data-contrib]").forEach((button) => button.onclick = async () => {
    const [goalId, contributionId] = button.dataset.contrib.split(":");
    await api(`/api/goals/${goalId}/contributions/${contributionId}`, { method: "DELETE" });
    await loadDashboard();
  });
  contentEl().querySelectorAll("[data-goal]").forEach((button) => button.onclick = async () => {
    await api(`/api/goals/${button.dataset.goal}`, { method: "DELETE" });
    await loadDashboard();
  });
}
