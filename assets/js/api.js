/**
 * api.js — Low-level transport layer
 *
 * CONFIG.WEB_APP_URL  must be replaced with the deployed Apps Script URL
 * after running "Deploy > New deployment" in the Google Apps Script editor.
 *
 * HOW TO CONFIGURE:
 *   Open this file and replace the string "PASTE_AFTER_DEPLOY" with the
 *   actual Web App URL, e.g.:
 *   "https://script.google.com/macros/s/AKfycb.../exec"
 */

var CONFIG = {
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbw4mDX7c8mVP5ftw9Vor-oIVwGfvuC0yDUtdKs9Cc_6uwjdPlfsCeI30Hc0fsO9vnvX9Q/exec"
};

/**
 * call(action, payload)
 *
 * - getDashboard uses GET  : appends ?action=getDashboard&token=... to the URL
 * - all other actions use POST : body is JSON string, Content-Type text/plain;charset=utf-8
 *
 * The token is auto-attached from localStorage (key "kpi_token").
 * Throws an Error if the server returns { ok: false, error: "..." }.
 *
 * @param {string} action   - One of the action names defined in API_CONTRACT.md
 * @param {Object} [payload] - Request body fields (token is merged in automatically)
 * @returns {Promise<*>}    - Resolves with the `data` field of the server response
 */
async function call(action, payload) {
  var url = CONFIG.WEB_APP_URL;
  if (!url || url === "PASTE_AFTER_DEPLOY") {
    // Fall through to mock — app.js handles offline/mock mode.
    throw new Error("WEB_APP_URL not configured");
  }

  var token = localStorage.getItem("kpi_token") || "";
  var response;

  if (action === "getDashboard") {
    // GET request — parameters go in the query string
    var qs = "action=getDashboard&token=" + encodeURIComponent(token);
    response = await fetch(url + "?" + qs, {
      method: "GET"
    });
  } else {
    // POST request — body is a plain JSON string (avoids CORS preflight)
    // Merge order: action+localStorage-token first, then payload last so that
    // an explicit token in payload (e.g. logout() passes the token before clearing
    // localStorage) is not overwritten by the now-empty localStorage value.
    var body = Object.assign({}, { token: token, action: action }, payload || {});
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    });
  }

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " from server");
  }

  var json;
  try {
    json = await response.json();
  } catch (e) {
    throw new Error("Invalid JSON from server");
  }

  if (json.ok === false) {
    throw new Error(json.error || "Server returned an error");
  }

  return json.data;
}
