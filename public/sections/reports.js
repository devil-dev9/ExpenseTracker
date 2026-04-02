export function renderReportsSection(app) {
  const { state, section, listWrap } = app;
  section(
    "Reports",
    "Download the selected spending month cleanly.",
    `<div class='data-form'><button class='submit-button' id='csvBtn' type='button'>Download Excel CSV</button><button class='secondary-button' id='pdfBtn' type='button'>Download / Print PDF</button></div>`,
    listWrap("Member summary", (state.report?.memberLines || []).length, (state.report?.memberLines || []).map((line) => `<article class='entry-card'><div class='meta-line'><span>${app.esc(line)}</span></div></article>`).join(""))
  );
  app.$("#csvBtn").onclick = app.downloadReportCsv;
  app.$("#pdfBtn").onclick = app.printReport;
}
