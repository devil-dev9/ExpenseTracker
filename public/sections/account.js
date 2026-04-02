export function renderAccountSection(app) {
  const { state, $, api, loadDashboard, logout, showLoggedOut, openAddUserModal, openUsersModal, openRequestsModal, msg } = app;
  const canEdit = state.accountMode === "edit";
  const action = state.accountAction;
  const actionPanel = action === "password"
    ? `<form class='data-form' id='pinForm'><label><span>Current passcode</span><input name='currentPin' type='password' maxlength='6' required /></label><label><span>New 6-digit passcode</span><input name='newPin' type='password' maxlength='6' required /></label><button class='submit-button'>Update passcode</button><p class='auth-message' id='pinMessage'></p></form>`
    : action === "logout"
      ? `<div class='sub-card'><div class='list-header'><h3>Logout</h3><span class='list-count'>Session</span></div><p class='month-copy'>Sign out from this device.</p><div class='entry-actions'><button class='ghost-button' id='confirmLogout' type='button'>Logout now</button></div></div>`
      : action === "delete"
        ? `<form class='data-form' id='deleteInlineForm'><p class='month-copy'>Enter your passcode to permanently delete this profile and all related data.</p><label><span>Passcode</span><input name='passcode' type='password' maxlength='6' required /></label><button class='delete-button' type='submit'>Delete profile</button><p class='auth-message' id='deleteProfileMessage'></p></form>`
        : `<div class='sub-card'><div class='list-header'><h3>Actions</h3><span class='list-count'>Hidden until selected</span></div><p class='month-copy'>Choose Change passcode, Logout, or Delete profile when you need it.</p></div>`;
  const adminPanel = state.user.role === "admin"
    ? `<div class='sub-card'><div class='list-header'><h3>Admin</h3><span class='list-count'>Enabled here</span></div><div class='entry-actions'><button class='ghost-button' id='accountAdminAdd' type='button'>Add user</button><button class='ghost-button' id='accountAdminUsers' type='button'>View users</button><button class='ghost-button' id='accountAdminRequests' type='button'>View requests</button></div><p class='auth-message' id='adminMessage'></p></div>`
    : "";

  $("#accountPageContent").innerHTML = `<section class='section-card account-page'><div class='section-head'><div><p class='section-kicker'>Account</p><h2>${state.user.role === "admin" ? "Account and admin" : "Account"}</h2></div><p class='section-description'>A dedicated page for your profile and security controls.</p></div><div class='account-layout'><div class='account-main'><div class='sub-card'><div class='list-header'><h3>Profile</h3><span class='list-count'>${canEdit ? "Editing" : "Read only"}</span></div><div class='profile-readout'><div><span class='field-label'>Name</span><strong>${app.esc(state.profile.name || "-")}</strong></div><div><span class='field-label'>Email</span><strong>${app.esc(state.profile.email || "-")}</strong></div><div><span class='field-label'>Phone</span><strong>${app.esc(state.user.phone || "-")}</strong></div><div><span class='field-label'>Address</span><strong>${app.esc(state.profile.address || "-")}</strong></div><div><span class='field-label'>GSTIN</span><strong>${app.esc(state.profile.gstin || "-")}</strong></div></div><div class='entry-actions'><button class='ghost-button' id='accountEditToggle' type='button'>${canEdit ? "Cancel edit" : "Edit profile"}</button></div></div>${canEdit ? `<form class='data-form' id='profileForm'><label><span>Name</span><input name='name' value='${app.esc(state.profile.name || "")}' required /></label><label><span>Email</span><input name='email' type='email' value='${app.esc(state.profile.email || "")}' required /></label><label><span>Phone number</span><input value='${app.esc(state.user.phone || "")}' readonly /></label><label><span>Address</span><textarea name='address'>${app.esc(state.profile.address || "")}</textarea></label><label><span>GSTIN</span><input name='gstin' value='${app.esc(state.profile.gstin || "")}' /></label><button class='submit-button'>Save profile</button><p class='auth-message' id='profileMessage'></p></form>` : ""}</div><div class='account-side'><div class='sub-card'><div class='list-header'><h3>Security</h3><span class='list-count'>Select to open</span></div><div class='entry-actions'><button class='ghost-button' id='showPasswordAction' type='button'>Change passcode</button><button class='ghost-button' id='showLogoutAction' type='button'>Logout</button><button class='delete-button' id='showDeleteAction' type='button'>Delete profile</button></div></div>${adminPanel}${actionPanel}</div></div></section>`;

  $("#accountEditToggle").onclick = () => {
    state.accountMode = canEdit ? "view" : "edit";
    renderAccountSection(app);
  };
  $("#showPasswordAction").onclick = () => {
    state.accountAction = "password";
    renderAccountSection(app);
  };
  $("#showLogoutAction").onclick = () => {
    state.accountAction = "logout";
    renderAccountSection(app);
  };
  $("#showDeleteAction").onclick = () => {
    state.accountAction = "delete";
    renderAccountSection(app);
  };

  if ($("#profileForm")) {
    $("#profileForm").onsubmit = async (event) => {
      event.preventDefault();
      await api("/api/account/profile", { method: "PUT", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
      state.accountMode = "view";
      await loadDashboard();
      state.page = "account";
      app.renderAppView();
    };
  }

  if ($("#pinForm")) {
    $("#pinForm").onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/account/change-pin", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
        msg("#pinMessage", "Passcode updated.");
      } catch (error) {
        msg("#pinMessage", error.message);
      }
    };
  }

  if ($("#confirmLogout")) {
    $("#confirmLogout").onclick = logout;
  }

  if ($("#deleteInlineForm")) {
    $("#deleteInlineForm").onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("/api/account/delete", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget).entries()) });
        state.user = null;
        showLoggedOut();
      } catch (error) {
        msg("#deleteProfileMessage", error.message);
      }
    };
  }

  if (state.user.role === "admin") {
    if ($("#accountAdminAdd")) $("#accountAdminAdd").onclick = openAddUserModal;
    if ($("#accountAdminUsers")) $("#accountAdminUsers").onclick = openUsersModal;
    if ($("#accountAdminRequests")) $("#accountAdminRequests").onclick = openRequestsModal;
  }
}
