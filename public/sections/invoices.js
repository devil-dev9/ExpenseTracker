const invoiceFooter = {
  notesLabel: "Notes",
  notesText: "Thanks for your business.",
  termsLabel: "Terms & Conditions",
  termsText: "Supply meant for export under LUT without payment of IGST. Place of Supply: Outside India"
};

let editingInvoiceId = null;

export function renderInvoicesSection(app) {
  const activeInvoice = app.state.invoices.find((invoice) => String(invoice.id) === String(editingInvoiceId));
  const defaultDate = activeInvoice?.invoiceDate || app.today();
  const defaultInvoiceNumber = activeInvoice?.invoiceNumber || app.suggestedInvoiceNumber(defaultDate);
  app.section(
    "Invoices",
    "Create and manage invoices using your saved account details.",
    `<form class='data-form' id='invoiceForm'><label><span>Invoice number</span><input name='invoiceNumber' value='${app.esc(defaultInvoiceNumber)}' data-auto='${activeInvoice ? "0" : "1"}' required /></label><label><span>Date</span><input name='invoiceDate' type='date' value='${defaultDate}' required /></label><label><span>Bill To</span><textarea name='billTo' required>${app.esc(activeInvoice?.billTo || "")}</textarea></label><label><span>Ship To</span><textarea name='shipTo' required>${app.esc(activeInvoice?.shipTo || "")}</textarea></label><div class='sub-card'><div class='list-header'><h3>Items</h3><button class='ghost-button' id='addItem' type='button'>Add item</button></div><div class='data-list' id='itemEditor'>${renderItemRows(activeInvoice?.items)}</div></div><div class='entry-actions'><button class='submit-button'>${activeInvoice ? "Update invoice" : "Save invoice"}</button>${activeInvoice ? "<button class='ghost-button' id='cancelInvoiceEdit' type='button'>Cancel edit</button>" : ""}</div></form>`,
    app.listWrap("Invoices", app.state.invoices.length, app.state.invoices.map((invoice) => `<article class='entry-card'><div class='entry-topline'><div><h4 class='entry-title'>${app.esc(invoice.invoiceNumber)}</h4><div class='meta-line'><span>${app.date(invoice.invoiceDate)}</span><span>${app.esc((invoice.billTo || "").split("\n")[0] || "Invoice")}</span></div></div><div class='amount-pill'>${app.money(invoice.total)}</div></div><div class='entry-actions'><button class='ghost-button' data-view='${invoice.id}' type='button'>View</button><button class='ghost-button' data-edit='${invoice.id}' type='button'>Edit</button><button class='ghost-button' data-pdf='${invoice.id}' type='button'>Download PDF</button><button class='ghost-button' data-html='${invoice.id}' type='button'>Download HTML</button><button class='delete-button' data-invoice='${invoice.id}' type='button'>Delete</button></div></article>`).join("")),
    app.renderInvoiceCharts()
  );
  app.$("#addItem").onclick = () => app.$("#itemEditor").insertAdjacentHTML("beforeend", itemRow());
  if (app.$("#cancelInvoiceEdit")) {
    app.$("#cancelInvoiceEdit").onclick = () => {
      editingInvoiceId = null;
      renderInvoicesSection(app);
    };
  }
  const invoiceNumberInput = app.$("#invoiceForm [name='invoiceNumber']");
  const invoiceDateInput = app.$("#invoiceForm [name='invoiceDate']");
  invoiceNumberInput.oninput = () => {
    invoiceNumberInput.dataset.auto = invoiceNumberInput.value === app.suggestedInvoiceNumber(invoiceDateInput.value) ? "1" : "0";
  };
  invoiceDateInput.onchange = () => {
    if (invoiceNumberInput.dataset.auto === "1") {
      invoiceNumberInput.value = app.suggestedInvoiceNumber(invoiceDateInput.value);
    }
  };
  app.$("#invoiceForm").onsubmit = (event) => saveInvoice(event, app);
  bindInvoiceButtons(app);
}

async function saveInvoice(event, app) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.clientName = (body.billTo || "").split("\n")[0] || "Customer";
  body.clientAddress = body.billTo || "";
  body.clientEmail = "";
  body.dueDate = body.invoiceDate;
  body.sellerGstin = app.state.profile.gstin || "";
  body.items = Array.from(document.querySelectorAll("[data-item-row]")).map((row) => {
    const quantity = Number(row.querySelector("[name='quantity']").value || 0);
    const rate = Number(row.querySelector("[name='rate']").value || 0);
    const igst = Number(row.querySelector("[name='igst']").value || 0);
    const base = quantity * rate;
    return {
      description: row.querySelector("[name='description']").value,
      hsnSac: row.querySelector("[name='hsnSac']").value,
      quantity,
      rate,
      igst,
      amount: base + (base * igst / 100)
    };
  }).filter((item) => item.description);
  body.subtotal = body.items.reduce((sum, item) => sum + (item.quantity * item.rate), 0);
  body.taxAmount = body.items.reduce((sum, item) => sum + ((item.quantity * item.rate) * (item.igst / 100)), 0);
  body.taxRate = 0;
  body.total = body.items.reduce((sum, item) => sum + item.amount, 0);
  await app.api(editingInvoiceId ? `/api/invoices/${editingInvoiceId}` : "/api/invoices", { method: editingInvoiceId ? "PUT" : "POST", body });
  editingInvoiceId = null;
  await app.loadDashboard();
}

function bindInvoiceButtons(app) {
  app.contentEl().querySelectorAll("[data-invoice]").forEach((button) => button.onclick = async () => {
    if (String(editingInvoiceId) === button.dataset.invoice) editingInvoiceId = null;
    await app.api(`/api/invoices/${button.dataset.invoice}`, { method: "DELETE" });
    await app.loadDashboard();
  });
  app.contentEl().querySelectorAll("[data-view]").forEach((button) => button.onclick = () => {
    const invoice = app.state.invoices.find((item) => String(item.id) === button.dataset.view);
    if (!invoice) return;
    app.openModal(
      `Invoice ${app.esc(invoice.invoiceNumber)}`,
      `<div class='invoice-preview-actions'><button class='ghost-button' id='modalPrintInvoice' type='button'>Print / PDF</button><button class='ghost-button' id='modalEditInvoice' type='button'>Edit invoice</button></div><iframe class='invoice-preview-frame' title='Invoice preview' srcdoc="${escapeAttribute(invoiceHtml(app, invoice))}"></iframe>`
    );
    app.$("#modalPrintInvoice").onclick = () => app.printInvoice(invoice);
    app.$("#modalEditInvoice").onclick = () => {
      editingInvoiceId = invoice.id;
      app.closeModal();
      renderInvoicesSection(app);
    };
  });
  app.contentEl().querySelectorAll("[data-edit]").forEach((button) => button.onclick = () => {
    editingInvoiceId = button.dataset.edit;
    renderInvoicesSection(app);
  });
  app.contentEl().querySelectorAll("[data-pdf]").forEach((button) => button.onclick = () => app.printInvoice(app.state.invoices.find((item) => String(item.id) === button.dataset.pdf)));
  app.contentEl().querySelectorAll("[data-html]").forEach((button) => button.onclick = () => app.downloadHtml(app.state.invoices.find((item) => String(item.id) === button.dataset.html)));
}

function renderItemRows(items = []) {
  const rows = Array.isArray(items) && items.length ? items : [null];
  return rows.map((item) => itemRow(item)).join("");
}

function itemRow(item = null) {
  return `<div class='sub-card' data-item-row='1'><div class='inline-grid'><label><span>Item & Description</span><input name='description' value='${escapeValue(item?.description)}' required /></label><label><span>HSN/SAC</span><input name='hsnSac' value='${escapeValue(item?.hsnSac)}' /></label><label><span>Qty</span><input name='quantity' type='number' min='0' step='1' value='${item?.quantity ?? 1}' required /></label><label><span>Rate</span><input name='rate' type='number' min='0' step='0.01' value='${item?.rate ?? 0}' required /></label><label><span>IGST (%)</span><input name='igst' type='number' min='0' step='0.01' value='${item?.igst ?? 0}' required /></label></div></div>`;
}

function escapeValue(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function invoiceHtml(app, invoice) {
  const sellerLines = [
    app.state.profile.name || "",
    ...String(app.state.profile.address || "").split(/\r?\n/).filter(Boolean),
    app.state.user.phone || "",
    app.state.profile.email || ""
  ].filter(Boolean);
  const sellerGstin = invoice.sellerGstin || app.state.profile.gstin || "";
  return `<!doctype html><html><head><meta charset='utf-8' /><title>${app.esc(invoice.invoiceNumber)}</title><style>body{font-family:Arial,sans-serif;color:#202124;padding:24px} .sheet{border:1.5px solid #2d2d2d} .row{display:grid;grid-template-columns:1.15fr 0.85fr} .cell{padding:12px 14px;border-right:1px solid #2d2d2d;border-bottom:1px solid #2d2d2d} .row .cell:last-child{border-right:0} .brand h1{margin:0 0 6px;font-size:24px;letter-spacing:.04em} .brand p,.meta p,.party p,.footer p{margin:3px 0;font-size:13px;line-height:1.4;white-space:pre-line} .meta strong,.party strong,.footer strong{display:block;margin-bottom:6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase} table{width:100%;border-collapse:collapse} th,td{border-right:1px solid #2d2d2d;border-bottom:1px solid #2d2d2d;padding:10px 8px;font-size:13px;vertical-align:top} th:last-child,td:last-child{border-right:0} thead th{background:#f3ede5;text-transform:uppercase;font-size:11px;letter-spacing:.08em} .money{text-align:right;white-space:nowrap} .totals{margin-left:auto;width:320px;border-left:1px solid #2d2d2d;border-right:1px solid #2d2d2d;border-bottom:1px solid #2d2d2d} .totals div{display:flex;justify-content:space-between;padding:10px 12px;border-top:1px solid #2d2d2d;font-size:13px} .totals div:first-child{border-top:0} .totals strong{font-size:15px} .footer{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #2d2d2d;padding:14px;gap:18px;font-size:12px;line-height:1.5}</style></head><body><section class='sheet'><div class='row'><div class='cell brand'><h1>${app.esc(app.state.profile.name || "Business Name")}</h1><p>${sellerLines.slice(1).map((line) => app.esc(line)).join("<br />")}</p>${sellerGstin ? `<p><strong>GSTIN</strong> ${app.esc(sellerGstin)}</p>` : ""}</div><div class='cell meta'><strong>Invoice</strong><p><b>Invoice Number:</b> ${app.esc(invoice.invoiceNumber)}</p><p><b>Date:</b> ${app.date(invoice.invoiceDate)}</p></div></div><div class='row'><div class='cell party'><strong>Bill To</strong><p>${app.esc(invoice.billTo || invoice.clientAddress || "")}</p></div><div class='cell party'><strong>Ship To</strong><p>${app.esc(invoice.shipTo || "")}</p></div></div><table><thead><tr><th style='width:34px'>#</th><th>Item & Description</th><th style='width:92px'>HSN/SAC</th><th style='width:70px'>Qty</th><th style='width:100px'>Rate</th><th style='width:92px'>IGST</th><th style='width:120px'>Amount</th></tr></thead><tbody>${invoice.items.map((item, index) => `<tr><td>${index + 1}</td><td>${app.esc(item.description)}</td><td>${app.esc(item.hsnSac || "")}</td><td>${item.quantity}</td><td class='money'>${app.money(item.rate)}</td><td class='money'>${Number(item.igst || 0).toFixed(2)}%</td><td class='money'>${app.money(item.amount)}</td></tr>`).join("")}</tbody></table><div class='totals'><div><span>Taxable Value</span><span>${app.money(invoice.subtotal)}</span></div><div><span>IGST</span><span>${app.money(invoice.taxAmount)}</span></div><div><strong>Total</strong><strong>${app.money(invoice.total)}</strong></div></div><div class='footer'><div><strong>${app.esc(invoiceFooter.notesLabel)}</strong><p>${app.esc(invoiceFooter.notesText)}</p></div><div><strong>${app.esc(invoiceFooter.termsLabel)}</strong><p>${app.esc(invoiceFooter.termsText)}</p></div></div></section></body></html>`;
}
