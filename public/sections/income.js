export function renderIncomeSection(app) {
  const { state, renderCollection, memberOptions, member, date, labelMonth, money, api, loadDashboard } = app;
  return renderCollection(
    "Income",
    state.incomes.filter((item) => item.budgetMonth === state.month),
    `<form class='data-form' id='incomeForm'><label><span>Source</span><input name='source' value='Salary' required /></label><label><span>Amount</span><input name='amount' type='number' min='0' step='0.01' required /></label><label><span>Member</span><select name='memberId'>${memberOptions()}</select></label><label><span>Use for month</span><input name='budgetMonth' type='month' value='${state.month}' required /></label><label><span>Salary received on</span><input name='receivedDate' type='date' value='${app.salaryReceivedDateForMonth(state.month)}' required /></label><label><span>Notes</span><textarea name='notes'></textarea></label><button class='submit-button'>Save income</button></form>`,
    (item) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(item.source)}</h4><div class='meta-line'><span>${member(item.memberId)}</span><span>Received ${date(item.receivedDate)}</span><span>Used for ${labelMonth(item.budgetMonth)}</span></div></div><div class='amount-pill'>${money(item.amount)}</div></div><button class='delete-button' data-del='${item.id}' data-kind='incomes'>Delete</button></article>`,
    async (event) => {
      event.preventDefault();
      await api("/api/incomes", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
      await loadDashboard();
    },
    {
      description: `Add the income you want to track for ${labelMonth(state.month)}.`
    }
  );
}
