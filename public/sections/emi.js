export function renderEmiSection(app) {
  const { state, renderCollection, memberOptions, member, daySuffix, labelMonth, emiWarning, money, api, loadDashboard, isEmiPaidForMonth } = app;
  return renderCollection(
    "EMI",
    state.emis.filter((item) => item.endMonth >= state.month),
    `<form class='data-form' id='emiForm'><label><span>Name</span><input name='name' required /></label><label><span>Amount</span><input name='amount' type='number' min='0' step='0.01' required /></label><label><span>Member</span><select name='memberId'>${memberOptions()}</select></label><label><span>EMI date</span><input name='emiDay' type='number' min='1' max='31' required /></label><label><span>End month</span><input name='endMonth' type='month' value='${state.month}' required /></label><label><span>Notes</span><textarea name='notes'></textarea></label><button class='submit-button'>Save EMI</button></form>`,
    (item) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(item.name)}</h4><div class='meta-line'><span>${member(item.memberId)}</span><span>Due every month on ${item.emiDay}${daySuffix(item.emiDay)}</span><span>Until ${labelMonth(item.endMonth)}</span></div>${isEmiPaidForMonth(item, state.month) ? `<div class='member-badge'>Paid for ${app.esc(labelMonth(state.month))}</div>` : emiWarning(item) ? `<div class='member-badge'>${app.esc(emiWarning(item))}</div>` : ""}</div><div class='amount-pill'>${money(item.amount)}</div></div><div class='entry-actions'><button class='ghost-button' data-emi-paid='${item.id}' type='button'>${isEmiPaidForMonth(item, state.month) ? "Mark unpaid" : "Mark paid"}</button><button class='delete-button' data-del='${item.id}' data-kind='emis'>Delete</button></div></article>`,
    async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      body.startMonth = state.month;
      await api("/api/emis", { method: "POST", body });
      await loadDashboard();
    },
    {
      description: `Track EMI that must be paid during ${labelMonth(state.month)} from the month's planned salary pool.`,
      chart: app.renderEmiCharts()
    }
  );
}
