/**
 * auth.js — Authentication helpers
 *
 * Token storage keys:
 *   "kpi_token"   — the session token string
 *   "kpi_expiry"  — token expiry as epoch-ms (number stored as string)
 *   "kpi_user"    — JSON-serialised {username, role}
 */

var AUTH_TOKEN_KEY  = "kpi_token";
var AUTH_EXPIRY_KEY = "kpi_expiry";
var AUTH_USER_KEY   = "kpi_user";

/**
 * getStoredToken()
 * Returns the token string or null if absent / expired.
 */
function getStoredToken() {
  var token  = localStorage.getItem(AUTH_TOKEN_KEY);
  var expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
  if (!token) return null;
  if (expiry && Date.now() > Number(expiry)) {
    clearAuth();
    return null;
  }
  return token;
}

/**
 * getStoredUser()
 * Returns the stored {username, role} object or null.
 */
function getStoredUser() {
  var raw = localStorage.getItem(AUTH_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * clearAuth()
 * Removes all auth-related items from localStorage.
 */
function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EXPIRY_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

/**
 * requireAuth()
 * Call at the top of any protected page.
 * Redirects to login.html if no valid token is present.
 */
function requireAuth() {
  if (!getStoredToken()) {
    window.location.replace("login.html");
  }
}

/**
 * login(username, password)
 * Calls the API login action, stores the token + expiry + user,
 * then redirects to index.html.
 * Throws on failure so the caller can display the error.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<void>}
 */
async function login(username, password) {
  // call() is defined in api.js which is loaded before this file on login.html
  var data = await call("login", { username: username, password: password });
  // data = { token, expiry, user: { username, role } }
  localStorage.setItem(AUTH_TOKEN_KEY,  data.token);
  localStorage.setItem(AUTH_EXPIRY_KEY, String(data.expiry));
  localStorage.setItem(AUTH_USER_KEY,   JSON.stringify(data.user));
  window.location.replace("index.html");
}

/**
 * logout()
 * Calls the server logout action (best-effort), clears local storage,
 * then redirects to login.html.
 */
async function logout() {
  var token = getStoredToken();
  clearAuth();
  if (token) {
    try {
      await call("logout", { token: token });
    } catch (e) {
      // ignore — we already cleared locally
    }
  }
  window.location.replace("login.html");
}

/* -----------------------------------------------------------------------
   Login page wiring
   Only runs when #form-login is present (i.e. on login.html).
----------------------------------------------------------------------- */
(function wireLoginForm() {
  var form = document.getElementById("form-login");
  if (!form) return; // not on login page

  // If already authenticated, skip straight to the dashboard
  if (getStoredToken()) {
    window.location.replace("index.html");
    return;
  }

  var usernameInput   = document.getElementById("login-username");
  var passwordInput   = document.getElementById("login-password");
  var submitBtn       = document.getElementById("login-submit-btn");
  var submitLabel     = document.getElementById("login-submit-label");
  var spinner         = document.getElementById("login-spinner");
  var errorBanner     = document.getElementById("login-error-banner");
  var errorText       = document.getElementById("login-error-text");
  var usernameError   = document.getElementById("login-username-error");
  var passwordError   = document.getElementById("login-password-error");
  var togglePwdBtn    = document.getElementById("login-toggle-password");
  var iconEye         = document.getElementById("icon-eye");
  var iconEyeOff      = document.getElementById("icon-eye-off");

  // Password visibility toggle
  if (togglePwdBtn) {
    togglePwdBtn.addEventListener("click", function () {
      var isPassword = passwordInput.type === "password";
      passwordInput.type = isPassword ? "text" : "password";
      if (iconEye)    iconEye.classList.toggle("hidden", isPassword);
      if (iconEyeOff) iconEyeOff.classList.toggle("hidden", !isPassword);
    });
  }

  function setFormDisabled(disabled) {
    usernameInput.disabled = disabled;
    passwordInput.disabled = disabled;
    submitBtn.disabled     = disabled;
    if (spinner)     spinner.classList.toggle("hidden", !disabled);
    if (submitLabel) submitLabel.textContent = disabled ? "Signing in…" : "Sign in";
  }

  function showError(msg) {
    if (errorBanner) errorBanner.classList.remove("hidden");
    if (errorText)   errorText.textContent = msg;
  }

  function clearErrors() {
    if (errorBanner)   errorBanner.classList.add("hidden");
    if (errorText)     errorText.textContent = "";
    if (usernameError) { usernameError.classList.add("hidden"); usernameError.textContent = ""; }
    if (passwordError) { passwordError.classList.add("hidden"); passwordError.textContent = ""; }
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearErrors();

    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    var valid    = true;

    if (!username) {
      if (usernameError) { usernameError.textContent = "Username is required."; usernameError.classList.remove("hidden"); }
      valid = false;
    }
    if (!password) {
      if (passwordError) { passwordError.textContent = "Password is required."; passwordError.classList.remove("hidden"); }
      valid = false;
    }
    if (!valid) return;

    setFormDisabled(true);
    try {
      await login(username, password);
      // login() redirects on success — code below only runs on failure
    } catch (err) {
      setFormDisabled(false);
      showError(err.message || "Login failed. Please try again.");
    }
  });
})();
