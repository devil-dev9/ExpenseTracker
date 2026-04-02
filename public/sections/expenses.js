export function renderExpenseSection(app) {
  const { state, renderCollection, memberOptions, member, date, money, api, loadDashboard, labelMonth } = app;
  return renderCollection(
    "Expenses",
    state.expenses.filter((item) => item.budgetMonth === state.month),
    `<form class='data-form' id='expenseForm'><label><span>Name</span><input name='name' required /></label><label><span>Amount</span><input name='amount' type='number' min='0' step='0.01' required /></label><label><span>Member</span><select name='memberId'>${memberOptions()}</select></label><label><span>Category</span><select name='category'><option>Needs</option><option>Lifestyle</option><option>Transport</option><option>Health</option><option>Utilities</option><option>Other</option></select></label><label><span>Spending month</span><input name='budgetMonth' type='month' value='${state.month}' required /></label><label><span>Expense date</span><input name='expenseDate' type='date' value='${app.today()}' required /></label><label><span>Notes</span><textarea name='notes'></textarea></label><button class='submit-button'>Save expense</button></form>`,
    (item) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(item.name)}</h4><div class='meta-line'><span>${member(item.memberId)}</span><span>${app.esc(item.category)}</span><span>${date(item.expenseDate)}</span></div></div><div class='amount-pill'>${money(item.amount)}</div></div><button class='delete-button' data-del='${item.id}' data-kind='expenses'>Delete</button></article>`,
    async (event) => {
      event.preventDefault();
      await api("/api/expenses", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
      await loadDashboard();
    },
    {
      description: `Capture the expenses actually paid from the ${labelMonth(state.month)} budget.`,
      chart: app.renderExpenseCharts()
    }
  );
}
