/**
 * JustFYI Popup Script
 * Shows rating for current site, alternatives, and submission form.
 */

const STATUS_MAP = {
  0: { label: "Out of scope",     icon: "block",         css: "status-default", labelCss: "" },
  1: { label: "Free",             icon: "check_circle",  css: "status-free",    labelCss: "label-free" },
  2: { label: "Free with limits", icon: "bolt",          css: "status-limits",  labelCss: "label-limits" },
  3: { label: "Paid",             icon: "attach_money",  css: "status-paid",    labelCss: "label-paid" },
};
const UNRATED = { label: "Unrated", icon: "help", css: "status-unrated", labelCss: "" };

// Rating flags rendered below the main status. Driven by boolean fields
// on the rating object so we can extend without adding `if` branches.
const RATING_FLAGS = [
  { key: "os",  icon: "code",      text: "Open source" },
  { key: "lg",  icon: "lock",      text: "Requires login" },
  { key: "sb",  icon: "autorenew", text: "Subscription" },
  { key: "ab",  icon: "skull",     text: "Abandoned" },
  { key: "rec", icon: "thumb_up",  text: "Recommended" },
];

function svgIcon(name, className = "icon") {
  return `<svg class="${className}"><use href="#i-${name}"/></svg>`;
}

// Snapshot of the form values that match the current rating at the time
// the form was prefilled. The submit handler compares against this to
// block no-op submissions that would only waste reviewer time.
let currentSnapshot = null;

document.addEventListener("DOMContentLoaded", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab || !tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) {
    document.getElementById("not-applicable").classList.remove("hidden");
    return;
  }

  chrome.runtime.sendMessage({ type: "getRating", url: tab.url }, (response) => {
    if (!response) return;

    const { rating, domain, allRatings } = response;
    const displayEl = document.getElementById("domain-display");
    displayEl.textContent = rating?.n ? `${rating.n} · ${domain}` : domain;

    if (rating && rating.s !== 0) {
      showRating(rating, allRatings);
    } else if (rating && rating.s === 0) {
      document.getElementById("not-applicable").classList.remove("hidden");
      // Also allow the user to disagree and submit a real category for this site.
      showSubmitForm(rating);
    } else {
      showSubmitForm();
    }
  });

  setupSubmitForm();
  setupCategoryDropdown();
  setupNewsletterToggle();
  setupNewsletterForm();
});

function setupCategoryDropdown() {
  const multi = document.getElementById("category-multi");
  const trigger = document.getElementById("category-trigger");
  const menu = document.getElementById("category-menu");
  const summary = document.getElementById("category-summary");
  if (!trigger || !menu) return;

  const options = [...menu.querySelectorAll(".multi-option")];

  function refreshSummary() {
    const selected = options.filter(o => o.getAttribute("aria-selected") === "true");
    if (selected.length === 0) {
      summary.textContent = "Select categories…";
      summary.classList.add("placeholder");
    } else {
      const labels = selected.map(o => o.textContent.trim());
      summary.textContent = selected.length <= 2
        ? labels.join(", ")
        : `${labels[0]} + ${selected.length - 1} more`;
      summary.classList.remove("placeholder");
    }
  }

  function setOpen(open) {
    menu.classList.toggle("hidden", !open);
    trigger.setAttribute("aria-expanded", String(open));
  }

  trigger.addEventListener("click", () => setOpen(menu.classList.contains("hidden")));
  for (const opt of options) {
    opt.addEventListener("click", () => {
      const was = opt.getAttribute("aria-selected") === "true";
      opt.setAttribute("aria-selected", String(!was));
      refreshSummary();
      updateSubmitButtonState();
    });
  }
  document.addEventListener("click", (e) => {
    if (!multi.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
  refreshSummary();
}

function showRating(rating, allRatings) {
  const section = document.getElementById("rating-section");
  section.classList.remove("hidden");

  const status = STATUS_MAP[rating.s] || UNRATED;

  const iconWrap = document.getElementById("rating-icon-wrap");
  iconWrap.className = "rating-icon-wrap " + status.css;
  document.getElementById("rating-icon-use").setAttribute("href", "#i-" + status.icon);
  document.getElementById("rating-label").textContent = status.label;

  // Build flags
  const flagsEl = document.getElementById("rating-flags");
  flagsEl.innerHTML = "";
  for (const f of RATING_FLAGS) {
    if (rating[f.key]) flagsEl.appendChild(createFlag(f.icon, f.text));
  }

  maybeShowDisclaimer(rating);

  // Show alternatives for tools with friction (paid / limited). Only
  // curated "rec" entries that cover ALL of this tool's categories —
  // so Signal (messaging + video calls) only surfaces alternatives
  // that are also messaging + video calls, not messaging-only apps.
  // `cat` can be a number (single) or an array (multi); normalise.
  const subjectCats = catsOf(rating);
  if (rating.s >= 2 && subjectCats.length) {
    const alternatives = allRatings.filter(r => {
      if (!r.rec || r.d === rating.d) return false;
      const altCats = catsOf(r);
      return subjectCats.every(c => altCats.includes(c));
    });
    if (alternatives.length) showAlternatives(alternatives);
  }

  showSubmitForm(rating);
}

function catsOf(r) {
  if (Array.isArray(r.cat)) return r.cat;
  if (typeof r.cat === "number") return [r.cat];
  return [];
}

function maybeShowDisclaimer(rating) {
  // Free VPNs typically monetize by selling browsing data. Flag any VPN (cat 13)
  // rated as free or free-with-limits.
  if (rating.cat === 13 && (rating.s === 1 || rating.s === 2)) {
    document.getElementById("disclaimer-text").textContent =
      "Free VPNs often monetize by selling your browsing data. Prefer a paid, audited no-logs providers.";
    document.getElementById("disclaimer-section").classList.remove("hidden");
  }
}

function createFlag(iconName, text) {
  const span = document.createElement("span");
  span.className = "flag";
  span.innerHTML = svgIcon(iconName) + " ";
  span.appendChild(document.createTextNode(text));
  return span;
}

function showAlternatives(alternatives) {
  const section = document.getElementById("alternatives-section");
  section.classList.remove("hidden");

  const list = document.getElementById("alternatives-list");
  for (const alt of alternatives) {
    list.appendChild(renderAlternative(alt));
  }
}

function renderAlternative(alt) {
  const altStatus = STATUS_MAP[alt.s] || UNRATED;

  const link = document.createElement("a");
  link.className = "alt-link";
  link.href = "https://" + alt.d;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const iconWrap = document.createElement("div");
  iconWrap.className = "alt-icon-wrap " + altStatus.css;
  iconWrap.innerHTML = svgIcon(altStatus.icon);
  link.appendChild(iconWrap);

  const nameSpan = document.createElement("span");
  nameSpan.className = "alt-name";
  nameSpan.textContent = alt.n || alt.d;
  link.appendChild(nameSpan);

  if (alt.os) {
    const chip = document.createElement("span");
    chip.className = "alt-os-chip";
    chip.textContent = "OS";
    chip.title = "Open source";
    link.appendChild(chip);
  }

  const statusSpan = document.createElement("span");
  statusSpan.className = "alt-status-label " + (altStatus.labelCss || "");
  statusSpan.textContent = altStatus.label;
  link.appendChild(statusSpan);

  const li = document.createElement("li");
  li.appendChild(link);
  return li;
}

// Two flows: unrated (no arg) keeps the form expanded with an "Rate this
// tool" title; update (rating passed) collapses it behind a trigger and —
// for in-scope ratings — prefills every field with the current values so
// the user edits rather than re-types.
function showSubmitForm(rating) {
  const section = document.getElementById("submit-section");
  section.classList.remove("hidden");
  if (rating === undefined) {
    currentSnapshot = null;
    return;
  }

  const toggle = document.getElementById("submit-toggle");
  const body = document.getElementById("submit-body");
  const expandIcon = document.getElementById("submit-expand-icon");
  document.getElementById("submit-title").classList.add("hidden");
  toggle.classList.remove("hidden");
  body.classList.add("hidden");
  toggle.addEventListener("click", () => {
    const willOpen = body.classList.contains("hidden");
    if (willOpen) collapseOther("submit");
    body.classList.toggle("hidden");
    expandIcon.classList.toggle("expanded", willOpen);
  });

  // Out-of-scope entries carry no category/flags worth prefilling, and
  // the user is contesting the verdict — start them with a blank form.
  if (rating.s === 0) {
    currentSnapshot = null;
    return;
  }

  document.getElementById("status-select").value = String(rating.s);
  setCategorySelection(catsOf(rating));
  document.getElementById("opensource-check").checked = !!rating.os;
  document.getElementById("login-check").checked = !!rating.lg;
  document.getElementById("abandoned-check").checked = !!rating.ab;
  document.getElementById("subscription-check").checked = !!rating.sb;

  currentSnapshot = snapshotForm();
  updateSubmitButtonState();
}

// When the form was prefilled with a current rating, keep the submit
// button in sync with whether anything has actually changed. Unchanged
// form → disabled button labelled "No changes yet"; otherwise enabled
// and labelled "Submit Rating". Does nothing on the unrated flow.
function updateSubmitButtonState() {
  if (!currentSnapshot) return;
  const btn = document.getElementById("submit-btn");
  if (!btn) return;
  const matches = snapshotForm() === currentSnapshot;
  btn.disabled = matches;
  btn.innerHTML = matches
    ? svgIcon("done", "icon btn-icon") + "No changes yet"
    : svgIcon("send", "icon btn-icon") + "Submit Rating";
}

function setCategorySelection(cats) {
  const options = [...document.querySelectorAll("#category-menu .multi-option")];
  const wanted = new Set(cats.map(Number));
  for (const opt of options) {
    const v = parseInt(opt.dataset.value, 10);
    opt.setAttribute("aria-selected", wanted.has(v) ? "true" : "false");
  }
  // Manually refresh the trigger summary since we bypassed the click handler.
  const summary = document.getElementById("category-summary");
  const selected = options.filter(o => o.getAttribute("aria-selected") === "true");
  if (selected.length === 0) {
    summary.textContent = "Select categories…";
    summary.classList.add("placeholder");
  } else {
    const labels = selected.map(o => o.textContent.trim());
    summary.textContent = selected.length <= 2
      ? labels.join(", ")
      : `${labels[0]} + ${selected.length - 1} more`;
    summary.classList.remove("placeholder");
  }
}

// Stable JSON snapshot of the submit form — used to detect a no-op update.
function snapshotForm() {
  const cats = [...document.querySelectorAll('#category-menu .multi-option[aria-selected="true"]')]
    .map(li => parseInt(li.dataset.value, 10))
    .sort((a, b) => a - b);
  return JSON.stringify({
    status: parseInt(document.getElementById("status-select").value, 10),
    categories: cats,
    openSource: document.getElementById("opensource-check").checked,
    login: document.getElementById("login-check").checked,
    abandoned: document.getElementById("abandoned-check").checked,
    subscription: document.getElementById("subscription-check").checked,
    note: document.getElementById("notes-input").value.trim(),
  });
}

// Mutual-exclusion for the two collapsible sections (submit / newsletter).
// Opening one collapses the other — but only when the other is actually
// collapsible. The submit section is only collapsible in the "Update rating"
// flow (toggle visible); in the unrated "Rate this tool" flow the form is
// always expanded and must stay that way even if the newsletter opens.
function collapseOther(openingId) {
  const others = ["submit", "newsletter"].filter((id) => id !== openingId);
  for (const id of others) {
    const toggle = document.getElementById(id + "-toggle");
    if (toggle && toggle.classList.contains("hidden")) continue;
    document.getElementById(id + "-body")?.classList.add("hidden");
    document.getElementById(id + "-expand-icon")?.classList.remove("expanded");
  }
}

function setupSubmitForm() {
  const form = document.getElementById("submit-form");
  // Keep the submit button in sync with the prefilled-snapshot diff.
  // `input` covers text fields; `change` covers checkboxes and selects.
  // Category chip clicks dispatch directly from setupCategoryDropdown.
  form.addEventListener("input", updateSubmitButtonState);
  form.addEventListener("change", updateSubmitButtonState);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const btn = document.getElementById("submit-btn");
    btn.disabled = true;
    btn.innerHTML = svgIcon("hourglass_empty", "icon btn-icon") + "Submitting...";

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const rawUrl = tabs[0]?.url || "";

    const status = parseInt(document.getElementById("status-select").value, 10);
    const categories = [...document.querySelectorAll('#category-menu .multi-option[aria-selected="true"]')]
      .map(li => parseInt(li.dataset.value, 10));
    // Require at least one category for in-scope submissions.
    if (status !== 0 && categories.length === 0) {
      const resultEl = document.getElementById("submit-result");
      resultEl.classList.remove("hidden");
      resultEl.className = "result-error";
      resultEl.innerHTML = svgIcon("warning") + "Pick at least one category.";
      btn.disabled = false;
      btn.innerHTML = svgIcon("send", "icon btn-icon") + "Submit Rating";
      return;
    }

    // Block no-op updates: if the form matches the current rating
    // (including the note), there's nothing for the reviewer to act on.
    if (currentSnapshot && snapshotForm() === currentSnapshot) {
      const resultEl = document.getElementById("submit-result");
      resultEl.classList.remove("hidden");
      resultEl.className = "result-error";
      resultEl.innerHTML = svgIcon("warning") + "Nothing to update — these match the current rating.";
      btn.disabled = false;
      btn.innerHTML = svgIcon("send", "icon btn-icon") + "Submit Rating";
      return;
    }

    const data = {
      domain: rawUrl,
      status,
      categories,
      openSource: document.getElementById("opensource-check").checked,
      login: document.getElementById("login-check").checked,
      abandoned: document.getElementById("abandoned-check").checked,
      subscription: document.getElementById("subscription-check").checked,
      note: document.getElementById("notes-input").value.trim(),
    };

    chrome.runtime.sendMessage({ type: "submitRating", data }, (response) => {
      const resultEl = document.getElementById("submit-result");
      resultEl.classList.remove("hidden");

      if (response && response.success) {
        resultEl.className = "result-success";
        resultEl.innerHTML = svgIcon("check_circle") + "Rating submitted! It will be reviewed shortly.";
        btn.innerHTML = svgIcon("done", "icon btn-icon") + "Submitted";
      } else {
        resultEl.className = "result-error";
        resultEl.innerHTML = svgIcon("warning") + (response?.error || "Failed to submit. Try again later.");
        btn.disabled = false;
        btn.innerHTML = svgIcon("send", "icon btn-icon") + "Submit Rating";
      }
    });
  });
}

function setupNewsletterToggle() {
  const trigger = document.getElementById("newsletter-toggle");
  const body = document.getElementById("newsletter-body");
  const expandIcon = document.getElementById("newsletter-expand-icon");

  if (!trigger || !body) return;

  trigger.addEventListener("click", () => {
    const willOpen = body.classList.contains("hidden");
    if (willOpen) collapseOther("newsletter");
    body.classList.toggle("hidden");
    if (expandIcon) expandIcon.classList.toggle("expanded", willOpen);
  });
}

function setupNewsletterForm() {
  const form = document.getElementById("newsletter-form");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("newsletter-email");
    const btn = form.querySelector("button[type='submit']");
    const resultEl = document.getElementById("newsletter-result");
    const email = input.value.trim();
    if (!email) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Subscribing…";

    chrome.runtime.sendMessage({ type: "subscribeEmail", email }, (response) => {
      resultEl.classList.remove("hidden");
      if (response && response.success) {
        resultEl.className = "result-success";
        resultEl.innerHTML = svgIcon("check_circle") + "Thanks — you're on the list.";
        input.value = "";
        btn.textContent = "Subscribed";
      } else {
        resultEl.className = "result-error";
        resultEl.innerHTML = svgIcon("warning") + (response?.error || "Failed to subscribe. Try again later.");
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });
}
