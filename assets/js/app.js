/**
 * app.js — Dashboard application entry point
 *
 * Loads api.js + auth.js before this file on index.html.
 * On login.html only auth.js (and api.js) are needed — this file is also
 * included there but exits immediately when #app is absent.
 *
 * Architecture
 * ------------
 * - state        : single source of truth ({ projects, stats, isLoading, error })
 * - render()     : full declarative re-render from state (no partial patching)
 * - CRUD helpers : call API action → refetch getDashboard → render()
 * - Event wiring : delegated listeners on document + specific element bindings
 */

"use strict";

/* =========================================================================
   STATE
   ========================================================================= */
var state = {
  projects  : [],
  stats     : { total: 0, completed: 0, inProgress: 0, avgProgress: 0 },
  isLoading : true,
  error     : null,
  // UI state
  filterSearch   : "",
  filterStatus   : "all",
  filterPriority : "all",
  collapsedRows  : {},   // { [projectId]: true }  — details rows collapsed
  useMock        : false // true when WEB_APP_URL is not configured
};

/* =========================================================================
   SYNC STATE — local-first queue flushed every 5 min or on button press
   ========================================================================= */
var pendingOps    = [];   // [{action, payload, tempId?}]
var isSyncing     = false;
var lastSyncedAt  = null;
var autoSyncId    = null;
var SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

/* =========================================================================
   GUARD — exit on login page (auth.js handles that page's logic)
   ========================================================================= */
(function () {
  if (!document.getElementById("app")) return; // not the dashboard page
  init();
})();

/* =========================================================================
   INIT
   ========================================================================= */
async function init() {
  // Auth guard — redirect to login if no valid token
  requireAuth();

  // Load scripts that should have been included before app.js
  // (api.js / auth.js are separate <script> tags)

  // Wire static UI elements that don't change on re-render
  wireStaticUI();

  // Show header username
  var user = getStoredUser();
  var headerUsername = document.getElementById("header-username");
  var btnLogout      = document.getElementById("btn-logout");
  if (user && headerUsername) {
    headerUsername.textContent = user.username;
    headerUsername.classList.remove("hidden");
  }
  if (btnLogout) btnLogout.classList.remove("hidden");

  // Load data
  await loadDashboard();

  startAutoSync();
  updateSyncUI();
}

/* =========================================================================
   DATA LOADING
   ========================================================================= */

/**
 * loadDashboard()
 * Fetches getDashboard from the API (or falls back to mock data).
 * Updates state and calls render().
 */
async function loadDashboard(quiet) {
  if (!quiet) setLoading(true, "Loading dashboard…");

  try {
    var data = await call("getDashboard");
    state.projects  = data.projects || [];
    state.stats     = data.stats    || { total: 0, completed: 0, inProgress: 0, avgProgress: 0 };
    state.error     = null;
    state.useMock   = false;
  } catch (err) {
    if (err.message === "WEB_APP_URL not configured") {
      // Use embedded mock data from the <script id="mock-data"> block
      loadMockData();
    } else if (isAuthError(err)) {
      // Token rejected — go back to login
      showAuthGuard();
      return;
    } else {
      state.error = err.message || "Failed to load dashboard";
    }
  }

  setLoading(false);
  render();
}

function loadMockData() {
  var mockEl = document.getElementById("mock-data");
  if (mockEl) {
    try {
      var mock = JSON.parse(mockEl.textContent);
      state.projects = mock.projects || [];
      state.stats    = mock.stats    || { total: 0, completed: 0, inProgress: 0, avgProgress: 0 };
      state.error    = null;
      state.useMock  = true;
    } catch (e) {
      state.error = "Failed to parse mock data";
    }
  }
}

function isAuthError(err) {
  var msg = (err.message || "").toLowerCase();
  return msg.indexOf("unauthorized") !== -1 ||
         msg.indexOf("invalid token") !== -1 ||
         msg.indexOf("session") !== -1 ||
         msg.indexOf("expired") !== -1;
}

/* =========================================================================
   LOADING / ERROR UI HELPERS
   ========================================================================= */

function setLoading(isLoading, msg) {
  state.isLoading = isLoading;
  var overlay = document.getElementById("loading-overlay");
  var loadMsg = document.getElementById("loading-message");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !isLoading);
  if (msg && loadMsg) loadMsg.textContent = msg;
}

function showAuthGuard() {
  setLoading(false);
  var guard = document.getElementById("auth-guard");
  if (guard) guard.classList.remove("hidden");
  setTimeout(function () { logout(); }, 1500);
}

function showGlobalError(msg) {
  var banner = document.getElementById("global-error-banner");
  var text   = document.getElementById("global-error-text");
  if (!banner || !text) return;
  text.textContent = msg;
  banner.classList.remove("hidden");
  clearTimeout(showGlobalError._timer);
  showGlobalError._timer = setTimeout(function () {
    banner.classList.add("hidden");
  }, 5000);
}

function showGlobalSuccess(msg) {
  var banner = document.getElementById("global-success-banner");
  var text   = document.getElementById("global-success-text");
  if (!banner || !text) return;
  text.textContent = msg;
  banner.classList.remove("hidden");
  clearTimeout(showGlobalSuccess._timer);
  showGlobalSuccess._timer = setTimeout(function () {
    banner.classList.add("hidden");
  }, 3000);
}

/* =========================================================================
   RENDER — full declarative re-render
   ========================================================================= */

function render() {
  var appEl = document.getElementById("app");
  if (!appEl) return;
  appEl.classList.remove("hidden");

  renderStats();
  renderProjectCards();
  renderDetailsTable();

  if (state.error) {
    showGlobalError(state.error);
  }
}

/* ----- Stats cards --------------------------------------------------- */
function renderStats() {
  var s = state.stats;
  setTextById("stat-total",        String(s.total));
  setTextById("stat-completed",    String(s.completed));
  setTextById("stat-in-progress",  String(s.inProgress));
  setTextById("stat-avg-progress", String(s.avgProgress) + "%");
}

/* ----- Project cards grid -------------------------------------------- */
function renderProjectCards() {
  var grid     = document.getElementById("project-cards-grid");
  var emptyEl  = document.getElementById("project-cards-empty");
  var template = document.getElementById("tpl-project-card");
  if (!grid || !template) return;

  // Filter
  var projects = filteredProjects();

  // Clear existing cards
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  if (projects.length === 0) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("hidden");

  projects.forEach(function (project) {
    var clone = document.importNode(template.content, true);
    var card  = clone.querySelector(".project-card");

    // data attribute
    card.dataset.projectId = project.id;

    // Title (textContent — safe)
    var titleEl = clone.querySelector(".project-card-title");
    if (titleEl) titleEl.textContent = project.title;

    // Description
    var descEl = clone.querySelector(".project-card-description");
    if (descEl) descEl.textContent = project.description || "";

    // Status badge
    var statusBadge = clone.querySelector(".project-card-status-badge");
    if (statusBadge) {
      statusBadge.textContent = formatStatus(project.status);
      applyStatusClass(statusBadge, project.status);
    }

    // Priority badge
    var priorityBadge = clone.querySelector(".project-card-priority-badge");
    if (priorityBadge) {
      priorityBadge.textContent = capitalize(project.priority);
      applyPriorityClass(priorityBadge, project.priority);
    }

    // Progress
    var pct = project.progress || 0;
    var pctEl  = clone.querySelector(".project-card-progress-pct");
    var barEl  = clone.querySelector(".project-card-progress-bar");
    if (pctEl)  pctEl.textContent   = pct + "%";
    if (barEl)  barEl.style.width   = pct + "%";

    // Dates
    var createdEl = clone.querySelector(".project-card-created-at");
    var updatedEl = clone.querySelector(".project-card-updated-at");
    if (createdEl) createdEl.textContent = formatDate(project.createdAt);
    if (updatedEl) updatedEl.textContent = formatDate(project.updatedAt);

    // Delete button data attributes
    var delBtn = clone.querySelector("[data-action='delete-project']");
    if (delBtn) delBtn.dataset.projectId = project.id;

    // Click on card body (not delete btn) → open edit modal
    card.addEventListener("click", function (e) {
      if (e.target.closest("[data-action='delete-project']")) return;
      openEditProjectModal(project.id);
    });

    grid.appendChild(clone);
  });
}

/* ----- Details table ------------------------------------------------- */
function renderDetailsTable() {
  var body    = document.getElementById("details-table-body");
  var emptyEl = document.getElementById("details-table-empty");
  var projTpl = document.getElementById("tpl-details-project-row");
  var taskTpl = document.getElementById("tpl-details-task-row");
  if (!body || !projTpl || !taskTpl) return;

  // Use ALL projects in the details table (not filtered by search/priority/status)
  var projects = state.projects;

  while (body.firstChild) body.removeChild(body.firstChild);

  if (projects.length === 0) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    return;
  }
  if (emptyEl) emptyEl.classList.add("hidden");

  projects.forEach(function (project) {
    var pClone = document.importNode(projTpl.content, true);
    var rowEl  = pClone.querySelector(".details-project-row");
    rowEl.dataset.projectId = project.id;

    // Set all data-project-id attributes inside the row
    rowEl.querySelectorAll("[data-project-id]").forEach(function (el) {
      el.dataset.projectId = project.id;
    });

    // Project title
    var titleEl = pClone.querySelector(".details-project-title");
    if (titleEl) titleEl.textContent = project.title;

    // Progress
    var pct    = project.progress || 0;
    var pctEl  = pClone.querySelector(".details-project-progress-pct");
    var barEl  = pClone.querySelector(".details-project-progress-bar");
    if (pctEl) pctEl.textContent = pct + "%";
    if (barEl) barEl.style.width = pct + "%";

    // Completed checkbox (checked when 100%)
    var checkEl = pClone.querySelector(".details-project-completed-check");
    if (checkEl) checkEl.checked = project.status === "completed";

    // Collapsed state
    var taskRowsEl = pClone.querySelector(".details-task-rows");
    if (state.collapsedRows[project.id] && taskRowsEl) {
      taskRowsEl.classList.add("hidden");
    }

    // Chevron rotation for collapsed state
    var chevronEl = pClone.querySelector(".chevron-down");
    if (chevronEl && state.collapsedRows[project.id]) {
      chevronEl.style.transform = "rotate(-90deg)";
    }

    // Render task rows
    var addTaskTrigger = pClone.querySelector(".details-add-task-trigger");
    var tasks = project.tasks || [];
    tasks.forEach(function (task) {
      var tClone = document.importNode(taskTpl.content, true);
      var tRow   = tClone.querySelector(".details-task-row");
      tRow.dataset.taskId = task.id;

      // Set all data-task-id attributes
      tRow.querySelectorAll("[data-task-id]").forEach(function (el) {
        el.dataset.taskId = task.id;
      });
      // Set all data-project-id attributes inside task row
      tRow.querySelectorAll("[data-project-id]").forEach(function (el) {
        el.dataset.projectId = project.id;
      });

      // Task title
      var taskTitleEl = tClone.querySelector(".task-title");
      if (taskTitleEl) taskTitleEl.textContent = task.title;

      // Checkbox
      var cbEl = tClone.querySelector(".task-completed-checkbox");
      if (cbEl) {
        cbEl.checked           = task.completed;
        cbEl.dataset.taskId    = task.id;
        cbEl.dataset.projectId = project.id;
      }

      // Task progress (100 or 0 per task)
      var tPctEl = tClone.querySelector(".task-progress-pct");
      var tBarEl = tClone.querySelector(".task-progress-bar");
      var tPct   = task.completed ? 100 : 0;
      if (tPctEl) tPctEl.textContent = tPct + "%";
      if (tBarEl) tBarEl.style.width = tPct + "%";

      // Delete button
      var delBtn = tClone.querySelector("[data-action='delete-task']");
      if (delBtn) {
        delBtn.dataset.taskId    = task.id;
        delBtn.dataset.projectId = project.id;
      }

      if (taskRowsEl && addTaskTrigger) {
        taskRowsEl.insertBefore(tClone, addTaskTrigger);
      }
    });

    body.appendChild(pClone);
  });
}

/* =========================================================================
   FILTER HELPERS
   ========================================================================= */

function filteredProjects() {
  return state.projects.filter(function (p) {
    var searchMatch = !state.filterSearch ||
      p.title.toLowerCase().indexOf(state.filterSearch.toLowerCase()) !== -1 ||
      (p.description || "").toLowerCase().indexOf(state.filterSearch.toLowerCase()) !== -1;
    var statusMatch   = state.filterStatus   === "all" || p.status   === state.filterStatus;
    var priorityMatch = state.filterPriority === "all" || p.priority === state.filterPriority;
    return searchMatch && statusMatch && priorityMatch;
  });
}

/* =========================================================================
   CRUD OPERATIONS
   Each mutates via API then refetches getDashboard (matches use-progressions.ts)
   ========================================================================= */

async function addProject(formData) {
  if (state.useMock) {
    var newProject = Object.assign({}, formData, {
      id        : "mock-" + Date.now(),
      progress  : 0,
      tasks     : [],
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString()
    });
    state.projects.push(newProject);
    recalculateMockStats();
    render();
    return;
  }
  // Local-first: apply immediately, queue API call
  var tempId = "local-proj-" + Date.now();
  state.projects.push(Object.assign({}, formData, {
    id        : tempId,
    progress  : 0,
    tasks     : [],
    createdAt : new Date().toISOString(),
    updatedAt : new Date().toISOString()
  }));
  recalculateMockStats();
  render();
  enqueuePendingOp({ action: "createProject", payload: formData, tempId: tempId });
}

async function updateProject(id, formData) {
  if (state.useMock) {
    var idx = state.projects.findIndex(function (p) { return p.id === id; });
    if (idx !== -1) {
      state.projects[idx] = Object.assign({}, state.projects[idx], formData, {
        updatedAt: new Date().toISOString()
      });
      recalculateMockStats();
      render();
    }
    return;
  }
  // Local-first
  var idx = state.projects.findIndex(function (p) { return p.id === id; });
  if (idx !== -1) {
    state.projects[idx] = Object.assign({}, state.projects[idx], formData, {
      updatedAt: new Date().toISOString()
    });
    recalculateMockStats();
    render();
  }
  enqueuePendingOp({ action: "updateProject", payload: Object.assign({ id: id }, formData) });
}

async function deleteProject(id) {
  if (state.useMock) {
    state.projects = state.projects.filter(function (p) { return p.id !== id; });
    recalculateMockStats();
    render();
    return;
  }
  // Local-first: remove immediately
  state.projects = state.projects.filter(function (p) { return p.id !== id; });
  recalculateMockStats();
  render();
  // If project was never synced, cancel its pending ops instead of queuing a delete
  if (id.indexOf("local-proj-") === 0) {
    pendingOps = pendingOps.filter(function (op) {
      return !(op.tempId === id ||
               (op.payload && (op.payload.id === id || op.payload.projectId === id)));
    });
    updateSyncUI();
    return;
  }
  enqueuePendingOp({ action: "deleteProject", payload: { id: id } });
}

async function addTask(projectId, title) {
  if (state.useMock) {
    var proj = state.projects.find(function (p) { return p.id === projectId; });
    if (proj) {
      proj.tasks = proj.tasks || [];
      proj.tasks.push({
        id        : "task-" + Date.now(),
        projectId : projectId,
        title     : title,
        completed : false,
        createdAt : new Date().toISOString(),
        updatedAt : new Date().toISOString()
      });
      recomputeMockProjectProgress(proj);
      recalculateMockStats();
      render();
    }
    return;
  }
  // Local-first
  var proj = state.projects.find(function (p) { return p.id === projectId; });
  if (proj) {
    var tempTaskId = "local-task-" + Date.now();
    proj.tasks = proj.tasks || [];
    proj.tasks.push({
      id        : tempTaskId,
      projectId : projectId,
      title     : title,
      completed : false,
      createdAt : new Date().toISOString(),
      updatedAt : new Date().toISOString()
    });
    recomputeMockProjectProgress(proj);
    recalculateMockStats();
    render();
    enqueuePendingOp({ action: "createTask", payload: { projectId: projectId, title: title }, tempId: tempTaskId });
  }
}

async function updateTask(id, projectId, data) {
  if (state.useMock) {
    var proj = state.projects.find(function (p) { return p.id === projectId; });
    if (proj) {
      var task = (proj.tasks || []).find(function (t) { return t.id === id; });
      if (task) {
        Object.assign(task, data, { updatedAt: new Date().toISOString() });
        recomputeMockProjectProgress(proj);
        recalculateMockStats();
        render();
      }
    }
    return;
  }
  // Local-first
  var proj = state.projects.find(function (p) { return p.id === projectId; });
  if (proj) {
    var task = (proj.tasks || []).find(function (t) { return t.id === id; });
    if (task) {
      Object.assign(task, data, { updatedAt: new Date().toISOString() });
      recomputeMockProjectProgress(proj);
      recalculateMockStats();
      render();
    }
  }
  enqueuePendingOp({ action: "updateTask", payload: Object.assign({ id: id }, data) });
}

async function deleteTask(id, projectId) {
  if (state.useMock) {
    var proj = state.projects.find(function (p) { return p.id === projectId; });
    if (proj) {
      proj.tasks = (proj.tasks || []).filter(function (t) { return t.id !== id; });
      recomputeMockProjectProgress(proj);
      recalculateMockStats();
      render();
    }
    return;
  }
  // Local-first: remove immediately
  var proj = state.projects.find(function (p) { return p.id === projectId; });
  if (proj) {
    proj.tasks = (proj.tasks || []).filter(function (t) { return t.id !== id; });
    recomputeMockProjectProgress(proj);
    recalculateMockStats();
    render();
  }
  // If task was never synced, cancel its pending ops instead of queuing a delete
  if (id.indexOf("local-task-") === 0) {
    pendingOps = pendingOps.filter(function (op) {
      return !(op.tempId === id || (op.payload && op.payload.id === id));
    });
    updateSyncUI();
    return;
  }
  enqueuePendingOp({ action: "deleteTask", payload: { id: id } });
}

/* =========================================================================
   MOCK DATA — local recompute helpers (mirrors API_CONTRACT.md rules)
   ========================================================================= */

function recomputeMockProjectProgress(project) {
  var tasks     = project.tasks || [];
  var total     = tasks.length;
  var completed = tasks.filter(function (t) { return t.completed; }).length;
  project.progress = total === 0 ? 0 : Math.round(completed / total * 100);

  // Status recompute (only when project has tasks)
  if (total > 0) {
    if (completed === 0)     project.status = "not-started";
    else if (completed === total) project.status = "completed";
    else                     project.status = "in-progress";
  }
}

function recalculateMockStats() {
  var projects   = state.projects;
  var total      = projects.length;
  var completed  = projects.filter(function (p) { return p.status === "completed"; }).length;
  var inProgress = projects.filter(function (p) { return p.status === "in-progress"; }).length;
  var avgProgress = total === 0 ? 0 :
    Math.round(projects.reduce(function (sum, p) { return sum + (p.progress || 0); }, 0) / total);
  state.stats = { total: total, completed: completed, inProgress: inProgress, avgProgress: avgProgress };
}

/* =========================================================================
   SYNC ENGINE — local-first queue, flush every 5 min or on button press
   ========================================================================= */

function enqueuePendingOp(op) {
  // For updates, replace any existing op for the same entity so rapid
  // check → uncheck collapses to a single final-state write.
  if (op.action === "updateTask" || op.action === "updateProject") {
    var entityId = op.payload && op.payload.id;
    for (var i = 0; i < pendingOps.length; i++) {
      if (pendingOps[i].action === op.action && pendingOps[i].payload && pendingOps[i].payload.id === entityId) {
        // Merge fields (not wholesale replace) so editing different fields of
        // the same entity — e.g. rename then tick complete — both survive.
        // Same field twice still collapses to the latest value.
        pendingOps[i].payload = Object.assign({}, pendingOps[i].payload, op.payload);
        updateSyncUI();
        return;
      }
    }
  }
  pendingOps.push(op);
  updateSyncUI();
}

function startAutoSync() {
  if (autoSyncId) clearInterval(autoSyncId);
  autoSyncId = setInterval(function () {
    if (!state.useMock && !isSyncing) syncNow();
  }, SYNC_INTERVAL);

  // Refresh "last synced X ago" text every 30 s
  setInterval(function () {
    if (lastSyncedAt) updateSyncUI();
  }, 30000);
}

async function syncNow() {
  if (state.useMock) return;
  if (isSyncing) return;
  if (pendingOps.length === 0) {
    // Nothing pending — just reconcile with server quietly
    await loadDashboard(true);
    lastSyncedAt = new Date();
    updateSyncUI();
    return;
  }

  isSyncing = true;
  updateSyncUI();

  var opsToProcess = pendingOps.slice();
  pendingOps = [];

  // Split into creates (must be sequential — we need real IDs to remap) and
  // everything else (updates/deletes — independent, can run in parallel).
  var creates = opsToProcess.filter(function (op) {
    return op.action === "createProject" || op.action === "createTask";
  });
  var rest = opsToProcess.filter(function (op) {
    return op.action !== "createProject" && op.action !== "createTask";
  });
  var failed = [];

  try {
    // 1. Creates — sequential so each real ID is available before the next
    for (var i = 0; i < creates.length; i++) {
      var op = creates[i];
      try {
        var result = await call(op.action, op.payload);
        if (op.tempId && result && result.id) {
          remapTempId(creates, i + 1, op.tempId, result.id);
          remapTempId(rest, 0, op.tempId, result.id);
          remapTempId(pendingOps, 0, op.tempId, result.id);
          remapTempIdInState(op.tempId, result.id);
        }
      } catch (createErr) {
        failed.push(op);
        // Drop any rest ops that depend on this unresolved temp ID
        if (op.tempId) {
          rest = rest.filter(function (o) {
            return !(o.payload && (o.payload.id === op.tempId || o.payload.projectId === op.tempId));
          });
        }
      }
    }

    // 2. Updates / deletes — fire in parallel
    var settled = await Promise.allSettled(rest.map(function (op) {
      return call(op.action, op.payload);
    }));
    settled.forEach(function (outcome, idx) {
      if (outcome.status === "rejected") failed.push(rest[idx]);
    });

    if (failed.length > 0) {
      pendingOps = failed.concat(pendingOps);
      showGlobalError(failed.length + " change(s) failed to sync — will retry");
    }

    // Reconcile with server (quiet — no loading overlay)
    await loadDashboard(true);
    lastSyncedAt = new Date();
    if (failed.length === 0) showGlobalSuccess("All changes synced successfully");
  } catch (err) {
    // Unexpected failure — restore everything
    pendingOps = opsToProcess.concat(pendingOps);
    showGlobalError("Sync failed: " + (err.message || "Unknown error"));
  } finally {
    isSyncing = false;
    updateSyncUI();
  }
}

function remapTempId(ops, startIdx, tempId, realId) {
  for (var i = startIdx; i < ops.length; i++) {
    var op = ops[i];
    if (op.tempId === tempId) op.tempId = realId;
    if (op.payload) {
      if (op.payload.id === tempId)        op.payload.id        = realId;
      if (op.payload.projectId === tempId) op.payload.projectId = realId;
    }
  }
}

function remapTempIdInState(tempId, realId) {
  state.projects.forEach(function (p) {
    if (p.id === tempId) p.id = realId;
    (p.tasks || []).forEach(function (t) {
      if (t.id === tempId)        t.id        = realId;
      if (t.projectId === tempId) t.projectId = realId;
    });
  });
}

function updateSyncUI() {
  var btn     = document.getElementById("btn-sync");
  var spinner = document.getElementById("sync-spinner");
  var icon    = document.getElementById("sync-icon");
  var label   = document.getElementById("sync-label");
  var badge   = document.getElementById("sync-badge");
  var status  = document.getElementById("sync-status");
  if (!btn) return;

  if (state.useMock) {
    btn.classList.add("hidden");
    if (status) status.classList.add("hidden");
    return;
  }

  btn.classList.remove("hidden");

  if (isSyncing) {
    btn.disabled = true;
    if (spinner) spinner.classList.remove("hidden");
    if (icon)    icon.classList.add("hidden");
    if (label)   label.textContent = "Syncing…";
    if (badge)   badge.classList.add("hidden");
  } else {
    btn.disabled = false;
    if (spinner) spinner.classList.add("hidden");
    if (icon)    icon.classList.remove("hidden");
    if (label)   label.textContent = "Sync Data";

    var count = pendingOps.length;
    if (count > 0 && badge) {
      badge.textContent = count > 9 ? "9+" : String(count);
      badge.classList.remove("hidden");
    } else if (badge) {
      badge.classList.add("hidden");
    }
  }

  if (status) {
    if (isSyncing) {
      status.textContent = "Syncing…";
      status.classList.remove("hidden");
    } else if (lastSyncedAt) {
      status.textContent = "Synced " + formatTimeAgo(lastSyncedAt);
      status.classList.remove("hidden");
    } else if (pendingOps.length > 0) {
      status.textContent = "Unsaved changes";
      status.classList.remove("hidden");
    } else {
      status.classList.add("hidden");
    }
  }
}

/* =========================================================================
   MODAL — Add / Edit Project
   ========================================================================= */

function openAddProjectModal() {
  setModalMode("add");
  showModal("modal-project-form");
  focusProjectTitle();
}

function openEditProjectModal(projectId) {
  var project = state.projects.find(function (p) { return p.id === projectId; });
  if (!project) return;
  setModalMode("edit", project);
  showModal("modal-project-form");
  focusProjectTitle();
}

function focusProjectTitle() {
  // rAF so focus lands after the panel is laid out / animating in.
  requestAnimationFrame(function () {
    var t = document.getElementById("form-project-title");
    if (t) t.focus();
  });
}

function setModalMode(mode, project) {
  var titleEl    = document.getElementById("modal-form-title");
  var subtitleEl = document.getElementById("modal-form-subtitle");
  var labelEl    = document.getElementById("modal-form-submit-label");
  var idField    = document.getElementById("form-project-id");
  var titleField = document.getElementById("form-project-title");
  var descField  = document.getElementById("form-project-description");
  var statusSel  = document.getElementById("form-project-status");
  var prioritySel= document.getElementById("form-project-priority");
  var errEl      = document.getElementById("form-project-error");
  var titleErrEl = document.getElementById("form-title-error");

  // Clear errors
  if (errEl)      { errEl.classList.add("hidden");      errEl.textContent = ""; }
  if (titleErrEl) { titleErrEl.classList.add("hidden"); titleErrEl.textContent = ""; }

  if (mode === "add") {
    if (titleEl)    titleEl.textContent    = "Add New Project";
    if (subtitleEl) subtitleEl.textContent = "Create a new KPI project to track";
    if (labelEl)    labelEl.textContent    = "Add Project";
    if (idField)    idField.value          = "";
    if (titleField) titleField.value       = "";
    if (descField)  descField.value        = "";
    if (statusSel)  statusSel.value        = "not-started";
    if (prioritySel)prioritySel.value      = "medium";
  } else {
    if (titleEl)    titleEl.textContent    = "Edit Project";
    if (subtitleEl) subtitleEl.textContent = "Update project details";
    if (labelEl)    labelEl.textContent    = "Save Changes";
    if (idField)    idField.value          = project.id;
    if (titleField) titleField.value       = project.title;
    if (descField)  descField.value        = project.description || "";
    if (statusSel)  statusSel.value        = project.status;
    if (prioritySel)prioritySel.value      = project.priority;
  }
}

function showModal(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.add("flex");
}

function hideModal(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("flex");
}

/* =========================================================================
   DELETE CONFIRM DIALOG
   ========================================================================= */

function openDeleteDialog(projectId) {
  var project = state.projects.find(function (p) { return p.id === projectId; });
  if (!project) return;

  setDeleteDialog({
    type      : "project",
    title     : "Delete Project",
    name      : project.title,
    extra     : " This will also delete all associated tasks.",
    projectId : projectId,
    taskId    : ""
  });
  showModal("dialog-delete-confirm");
}

function openDeleteTaskDialog(taskId, projectId) {
  var project = state.projects.find(function (p) { return p.id === projectId; });
  var task    = project && (project.tasks || []).find(function (t) { return t.id === taskId; });
  if (!task) return;

  setDeleteDialog({
    type      : "task",
    title     : "Delete Task",
    name      : task.title,
    extra     : "",
    projectId : projectId,
    taskId    : taskId
  });
  showModal("dialog-delete-confirm");
}

/**
 * setDeleteDialog(opts)
 * Populates the shared delete-confirm dialog for either a project or a task.
 * opts = { type, title, name, extra, projectId, taskId }
 */
function setDeleteDialog(opts) {
  var titleEl = document.getElementById("dialog-delete-title");
  var nameEl  = document.getElementById("dialog-delete-name");
  var extraEl = document.getElementById("dialog-delete-extra");
  var typeEl  = document.getElementById("dialog-delete-type");
  var pidEl   = document.getElementById("dialog-delete-project-id");
  var tidEl   = document.getElementById("dialog-delete-task-id");
  var errEl   = document.getElementById("dialog-delete-error");

  if (titleEl) titleEl.textContent = opts.title;
  if (nameEl)  nameEl.textContent  = opts.name;        // safe — textContent
  if (extraEl) extraEl.textContent = opts.extra || "";
  if (typeEl)  typeEl.value        = opts.type;
  if (pidEl)   pidEl.value         = opts.projectId || "";
  if (tidEl)   tidEl.value         = opts.taskId || "";
  if (errEl)   { errEl.classList.add("hidden"); errEl.textContent = ""; }
}

/* =========================================================================
   EVENT DELEGATION — document-level click handler
   ========================================================================= */

function wireStaticUI() {
  // Delegated clicks
  document.addEventListener("click", handleDelegatedClick);

  // Project form submit
  var formProject = document.getElementById("form-project");
  if (formProject) formProject.addEventListener("submit", handleProjectFormSubmit);

  // Filters
  var filterSearch   = document.getElementById("filter-search");
  var filterStatus   = document.getElementById("filter-status");
  var filterPriority = document.getElementById("filter-priority");
  if (filterSearch) {
    filterSearch.addEventListener("input", function () {
      state.filterSearch = this.value;
      renderProjectCards();
    });
  }
  if (filterStatus) {
    filterStatus.addEventListener("change", function () {
      state.filterStatus = this.value;
      renderProjectCards();
    });
  }
  if (filterPriority) {
    filterPriority.addEventListener("change", function () {
      state.filterPriority = this.value;
      renderProjectCards();
    });
  }

  // Logout button — show a loading state while the logout API call is in
  // flight. logout() ends by redirecting to login.html, so the spinner stays
  // visible right up until the page navigates away (no need to reset it).
  var btnLogout = document.getElementById("btn-logout");
  if (btnLogout) btnLogout.addEventListener("click", function () {
    if (btnLogout.disabled) return; // ignore double-clicks
    btnLogout.disabled = true;
    var spinner = document.getElementById("logout-spinner");
    var label   = document.getElementById("logout-label");
    if (spinner) spinner.classList.remove("hidden");
    if (label)   label.textContent = "Logging out…";
    logout();
  });

  // Sync button
  var btnSync = document.getElementById("btn-sync");
  if (btnSync) btnSync.addEventListener("click", function () { syncNow(); });

  // Warn before unload when there are unsaved changes
  window.addEventListener("beforeunload", function (e) {
    if (pendingOps.length > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function handleDelegatedClick(e) {
  var target = e.target;

  // -------------------------------------------------------------------
  // Add Project buttons (two of them: toolbar + details header)
  // -------------------------------------------------------------------
  if (target.id === "btn-add-project" || target.closest("#btn-add-project") ||
      target.id === "btn-details-new-project" || target.closest("#btn-details-new-project")) {
    openAddProjectModal();
    return;
  }

  // -------------------------------------------------------------------
  // Modal / dialog close actions
  // -------------------------------------------------------------------
  var action = target.dataset.action || (target.closest("[data-action]") && target.closest("[data-action]").dataset.action);

  if (action === "close-modal-form") {
    hideModal("modal-project-form");
    return;
  }
  if (action === "close-dialog-delete") {
    hideModal("dialog-delete-confirm");
    return;
  }

  // Clicking the modal backdrop closes it
  if (target.classList.contains("modal-backdrop")) {
    hideModal("modal-project-form");
    return;
  }
  if (target.classList.contains("dialog-backdrop")) {
    hideModal("dialog-delete-confirm");
    return;
  }

  // -------------------------------------------------------------------
  // Delete project (card delete button)
  // -------------------------------------------------------------------
  var delProjectBtn = target.closest("[data-action='delete-project']");
  if (delProjectBtn) {
    e.stopPropagation();
    openDeleteDialog(delProjectBtn.dataset.projectId);
    return;
  }

  // -------------------------------------------------------------------
  // Confirm delete
  // -------------------------------------------------------------------
  if (action === "confirm-delete") {
    handleConfirmDelete();
    return;
  }

  // -------------------------------------------------------------------
  // Toggle details row (expand / collapse)
  // -------------------------------------------------------------------
  var toggleRowEl = target.closest("[data-action='toggle-project-row']");
  if (toggleRowEl) {
    var pid = toggleRowEl.dataset.projectId;
    state.collapsedRows[pid] = !state.collapsedRows[pid];
    // Find the task rows container and toggle visibility
    var detailsRow = document.querySelector(".details-project-row[data-project-id='" + pid + "']");
    if (detailsRow) {
      var taskRowsEl = detailsRow.querySelector(".details-task-rows");
      var chevronEl  = detailsRow.querySelector(".chevron-down");
      if (taskRowsEl) taskRowsEl.classList.toggle("hidden", !!state.collapsedRows[pid]);
      if (chevronEl)  chevronEl.style.transform = state.collapsedRows[pid] ? "rotate(-90deg)" : "";
    }
    return;
  }

  // -------------------------------------------------------------------
  // Show add-task input
  // -------------------------------------------------------------------
  var showAddTaskBtn = target.closest("[data-action='show-add-task-input']");
  if (showAddTaskBtn) {
    var apid = showAddTaskBtn.dataset.projectId;
    var detRow = document.querySelector(".details-project-row[data-project-id='" + apid + "']");
    if (detRow) {
      var trigger = detRow.querySelector(".details-add-task-trigger");
      if (trigger) {
        var addBtn   = trigger.querySelector(".details-add-task-btn");
        var addForm  = trigger.querySelector(".details-add-task-form");
        var addInput = trigger.querySelector(".details-new-task-input");
        if (addBtn)   addBtn.classList.add("hidden");
        if (addForm)  addForm.classList.remove("hidden");
        if (addInput) addInput.focus();
      }
    }
    return;
  }

  // -------------------------------------------------------------------
  // Confirm add task
  // -------------------------------------------------------------------
  var confirmAddBtn = target.closest("[data-action='confirm-add-task']");
  if (confirmAddBtn) {
    handleConfirmAddTask(confirmAddBtn.dataset.projectId);
    return;
  }

  // -------------------------------------------------------------------
  // Cancel add task
  // -------------------------------------------------------------------
  var cancelAddBtn = target.closest("[data-action='cancel-add-task']");
  if (cancelAddBtn) {
    var capid  = cancelAddBtn.dataset.projectId;
    var caDetRow = document.querySelector(".details-project-row[data-project-id='" + capid + "']");
    if (caDetRow) {
      var caTrigger = caDetRow.querySelector(".details-add-task-trigger");
      if (caTrigger) {
        var caAddBtn  = caTrigger.querySelector(".details-add-task-btn");
        var caAddForm = caTrigger.querySelector(".details-add-task-form");
        var caInput   = caTrigger.querySelector(".details-new-task-input");
        if (caAddBtn)  caAddBtn.classList.remove("hidden");
        if (caAddForm) caAddForm.classList.add("hidden");
        if (caInput)   caInput.value = "";
      }
    }
    return;
  }

  // -------------------------------------------------------------------
  // Edit (rename) task — tap the title cell to turn it into an input
  // -------------------------------------------------------------------
  var editTaskCell = target.closest("[data-action='edit-task']");
  if (editTaskCell) {
    startEditTask(editTaskCell);
    return;
  }

  // -------------------------------------------------------------------
  // Delete task
  // -------------------------------------------------------------------
  var delTaskBtn = target.closest("[data-action='delete-task']");
  if (delTaskBtn) {
    e.stopPropagation();
    openDeleteTaskDialog(delTaskBtn.dataset.taskId, delTaskBtn.dataset.projectId);
    return;
  }

  // -------------------------------------------------------------------
  // Toggle task complete (checkbox — also fires change, handled separately)
  // -------------------------------------------------------------------
}

/* =========================================================================
   KEYBOARD — Enter key on new-task-input
   ========================================================================= */
document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var input = e.target.closest(".details-new-task-input");
  if (!input) return;
  e.preventDefault();
  handleConfirmAddTask(input.dataset.projectId);
});

/* =========================================================================
   CHANGE — task checkbox
   ========================================================================= */
document.addEventListener("change", function (e) {
  var cb = e.target.closest(".task-completed-checkbox");
  if (!cb) return;
  handleToggleTask(cb.dataset.taskId, cb.dataset.projectId, cb.checked);
});

/* =========================================================================
   INLINE TASK RENAME — Enter commits, Escape reverts, blur commits
   ========================================================================= */
document.addEventListener("keydown", function (e) {
  var input = e.target.closest && e.target.closest(".task-title-input");
  if (!input) return;
  if (e.key === "Enter") {
    e.preventDefault();
    input.blur();                 // commit through the focusout handler
  } else if (e.key === "Escape") {
    e.preventDefault();
    input._cancelled = true;      // tell focusout to revert, not save
    input.blur();
  }
});

document.addEventListener("focusout", function (e) {
  var input = e.target.closest && e.target.closest(".task-title-input");
  if (!input) return;
  if (input._cancelled) {
    input._cancelled = false;
    cancelEditTask(input);
  } else {
    saveEditTask(input);
  }
});

/* =========================================================================
   KEYBOARD — Escape closes an open modal / dialog
   ========================================================================= */
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  var dialog = document.getElementById("dialog-delete-confirm");
  if (dialog && !dialog.classList.contains("hidden")) { hideModal("dialog-delete-confirm"); return; }
  var modal = document.getElementById("modal-project-form");
  if (modal && !modal.classList.contains("hidden")) { hideModal("modal-project-form"); return; }
});

/* =========================================================================
   ACTION HANDLERS
   ========================================================================= */

async function handleProjectFormSubmit(e) {
  e.preventDefault();
  var idField     = document.getElementById("form-project-id");
  var titleField  = document.getElementById("form-project-title");
  var descField   = document.getElementById("form-project-description");
  var statusSel   = document.getElementById("form-project-status");
  var prioritySel = document.getElementById("form-project-priority");
  var errEl       = document.getElementById("form-project-error");
  var titleErrEl  = document.getElementById("form-title-error");
  var spinner     = document.getElementById("modal-form-submit-spinner");
  var submitBtn   = document.getElementById("modal-form-submit-btn");

  // Clear errors
  if (errEl)      { errEl.classList.add("hidden");      errEl.textContent = ""; }
  if (titleErrEl) { titleErrEl.classList.add("hidden"); titleErrEl.textContent = ""; }

  var title = titleField ? titleField.value.trim() : "";
  if (!title) {
    if (titleErrEl) { titleErrEl.textContent = "Title is required."; titleErrEl.classList.remove("hidden"); }
    return;
  }

  var formData = {
    title      : title,
    description: descField   ? descField.value.trim()  : "",
    status     : statusSel   ? statusSel.value          : "not-started",
    priority   : prioritySel ? prioritySel.value        : "medium"
  };

  var projectId = idField ? idField.value : "";
  var isEdit    = !!projectId;

  // Disable form
  if (spinner)   spinner.classList.remove("hidden");
  if (submitBtn) submitBtn.disabled = true;

  try {
    if (isEdit) {
      await updateProject(projectId, formData);
    } else {
      await addProject(formData);
    }
    hideModal("modal-project-form");
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Save failed."; errEl.classList.remove("hidden"); }
  } finally {
    if (spinner)   spinner.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function handleConfirmDelete() {
  var typeEl     = document.getElementById("dialog-delete-type");
  var pidEl      = document.getElementById("dialog-delete-project-id");
  var tidEl      = document.getElementById("dialog-delete-task-id");
  var errEl      = document.getElementById("dialog-delete-error");
  var spinner    = document.getElementById("dialog-delete-spinner");
  var confirmBtn = document.getElementById("dialog-delete-confirm-btn");

  var type      = typeEl ? typeEl.value : "project";
  var projectId = pidEl ? pidEl.value : "";
  var taskId    = tidEl ? tidEl.value : "";
  if (type === "task" ? !taskId : !projectId) return;

  if (errEl) { errEl.classList.add("hidden"); errEl.textContent = ""; }
  if (spinner)    spinner.classList.remove("hidden");
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    if (type === "task") {
      await deleteTask(taskId, projectId);
    } else {
      await deleteProject(projectId);
    }
    hideModal("dialog-delete-confirm");
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Delete failed."; errEl.classList.remove("hidden"); }
  } finally {
    if (spinner)    spinner.classList.add("hidden");
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

/* ----- Inline task rename -------------------------------------------- */

function startEditTask(cellEl) {
  var span  = cellEl.querySelector(".task-title");
  var input = cellEl.querySelector(".task-title-input");
  if (!span || !input) return;
  if (!input.classList.contains("hidden")) return; // already editing this row
  input.value = span.textContent;
  span.classList.add("hidden");
  input.classList.remove("hidden");
  input.focus();
  input.select();
}

function saveEditTask(input) {
  var cell = input.closest("[data-action='edit-task']");
  var span = cell ? cell.querySelector(".task-title") : null;
  var original = span ? span.textContent : "";
  var newTitle = input.value.trim();

  // Leave edit mode visually (a successful save re-renders over this anyway).
  input.classList.add("hidden");
  if (span) span.classList.remove("hidden");

  if (!newTitle || newTitle === original) return; // empty or unchanged → keep
  updateTask(input.dataset.taskId, input.dataset.projectId, { title: newTitle });
}

function cancelEditTask(input) {
  var cell = input.closest("[data-action='edit-task']");
  var span = cell ? cell.querySelector(".task-title") : null;
  input.classList.add("hidden");
  if (span) span.classList.remove("hidden");
}

async function handleConfirmAddTask(projectId) {
  if (!projectId) return;
  var detRow = document.querySelector(".details-project-row[data-project-id='" + projectId + "']");
  if (!detRow) return;
  var trigger = detRow.querySelector(".details-add-task-trigger");
  if (!trigger) return;
  var addInput  = trigger.querySelector(".details-new-task-input");
  var title = addInput ? addInput.value.trim() : "";
  if (!title) { if (addInput) addInput.focus(); return; }

  try {
    await addTask(projectId, title);
    // render() will rebuild the DOM
  } catch (err) {
    showGlobalError(err.message || "Failed to add task");
  }
}

async function handleToggleTask(taskId, projectId, completed) {
  try {
    await updateTask(taskId, projectId, { completed: completed });
  } catch (err) {
    showGlobalError(err.message || "Failed to update task");
    render(); // revert checkbox visually
  }
}

/* =========================================================================
   UTILITY HELPERS
   ========================================================================= */

function setTextById(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatDate(isoString) {
  if (!isoString) return "—";
  try {
    var d = new Date(isoString);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch (e) { return isoString; }
}

function formatStatus(status) {
  var map = {
    "not-started" : "Not Started",
    "in-progress" : "In Progress",
    "completed"   : "Completed",
    "on-hold"     : "On Hold"
  };
  return map[status] || capitalize(status);
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function applyStatusClass(el, status) {
  el.className = el.className.replace(/\bbg-\S+\b/g, "").replace(/\btext-\S+\b/g, "").trim();
  var map = {
    "not-started" : "bg-slate-100 text-slate-600",
    "in-progress" : "bg-amber-100 text-amber-700",
    "completed"   : "bg-emerald-100 text-emerald-700",
    "on-hold"     : "bg-red-100 text-red-700"
  };
  var classes = (map[status] || "bg-slate-100 text-slate-600").split(" ");
  classes.forEach(function (c) { el.classList.add(c); });
}

function formatTimeAgo(date) {
  var diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60)   return "just now";
  if (diffSec < 3600) return Math.floor(diffSec / 60) + "m ago";
  return Math.floor(diffSec / 3600) + "h ago";
}

function applyPriorityClass(el, priority) {
  el.className = el.className.replace(/\bbg-\S+\b/g, "").replace(/\btext-\S+\b/g, "").trim();
  var map = {
    "high"   : "bg-red-100 text-red-700",
    "medium" : "bg-amber-100 text-amber-700",
    "low"    : "bg-slate-100 text-slate-600"
  };
  var classes = (map[priority] || "bg-slate-100 text-slate-600").split(" ");
  classes.forEach(function (c) { el.classList.add(c); });
}
