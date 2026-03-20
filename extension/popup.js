/**
 * JustFYI Popup Script
 * Shows rating for current site, alternatives, and submission form.
 */

const STATUS_MAP = {
  0: { label: "Out of scope",     icon: "block",         css: "status-default" },
  1: { label: "Free",             icon: "check_circle",  css: "status-free" },
  2: { label: "Free with limits", icon: "bolt",          css: "status-limits" },
  3: { label: "Paid",             icon: "attach_money",  css: "status-paid" },
};
const UNRATED = { label: "Unrated", icon: "help", css: "status-unrated" };

function svgIcon(name, className = "icon") {
  return `<svg class="${className}"><use href="#i-${name}"/></svg>`;
}

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
      showSubmitForm(null, rating.s);
    } else {
      showSubmitForm(domain);
    }
  });

  setupSubmitForm();
  setupNewsletterToggle();
  setupNewsletterForm();
});

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

  if (rating.os) {
    flagsEl.appendChild(createFlag("code", "Open source"));
  }
  if (rating.lg) {
    flagsEl.appendChild(createFlag("lock", "Requires login"));
  }
  if (rating.ab) {
    flagsEl.appendChild(createFlag("skull", "Abandoned"));
  }
  if (rating.rec) {
    flagsEl.appendChild(createFlag("thumb_up", "Recommended"));
  }

  maybeShowDisclaimer(rating);

  // Show alternatives if tool has issues (status >= 2) and has a category
  if (rating.s >= 2 && rating.cat) {
    const alternatives = allRatings.filter(
      (r) =>
        r.rec &&                  // curated recommendation
        r.cat === rating.cat &&   // same category
        r.d !== rating.d          // not the same tool
    );

    if (alternatives.length > 0) {
      showAlternatives(alternatives);
    }
  }

  showSubmitForm(null, rating.s);
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
  alternatives.forEach((alt) => {
    const li = document.createElement("li");

    const altStatus = STATUS_MAP[alt.s] || UNRATED;

    const link = document.createElement("a");
    link.className = "alt-link";
    link.href = "https://" + alt.d;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const iconWrap = document.createElement("div");
    iconWrap.className = "alt-icon-wrap " + altStatus.css;
    iconWrap.innerHTML = svgIcon(altStatus.icon);

    const nameSpan = document.createElement("span");
    nameSpan.className = "alt-name";
    nameSpan.textContent = alt.n || alt.d;

    let osChip = null;
    if (alt.os) {
      osChip = document.createElement("span");
      osChip.className = "alt-os-chip";
      osChip.textContent = "OS";
      osChip.title = "Open source";
    }

    const statusSpan = document.createElement("span");
    statusSpan.className = "alt-status-label";
    const labelCss = alt.s === 1 ? "label-free"
      : alt.s === 2 ? "label-limits"
      : alt.s === 3 ? "label-paid"
      : "";
    if (labelCss) statusSpan.classList.add(labelCss);
    statusSpan.textContent = altStatus.label;

    link.appendChild(iconWrap);
    link.appendChild(nameSpan);
    if (osChip) link.appendChild(osChip);
    link.appendChild(statusSpan);
    li.appendChild(link);
    list.appendChild(li);
  });
}

function showSubmitForm(domain, currentStatus) {
  const section = document.getElementById("submit-section");
  const toggle = document.getElementById("submit-toggle");
  const body = document.getElementById("submit-body");
  const expandIcon = document.getElementById("submit-expand-icon");
  section.classList.remove("hidden");

  if (currentStatus !== undefined) {
    // Update flow — collapse behind a trigger so the form doesn't dominate the popup;
    // trigger's own label is "Update rating" so hide the redundant h3.
    document.getElementById("submit-title").classList.add("hidden");
    toggle.classList.remove("hidden");
    body.classList.add("hidden");
    toggle.addEventListener("click", () => {
      const willOpen = body.classList.contains("hidden");
      if (willOpen) collapseOther("submit");
      body.classList.toggle("hidden");
      expandIcon.classList.toggle("expanded", willOpen);
    });
  }
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
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const btn = document.getElementById("submit-btn");
    btn.disabled = true;
    btn.innerHTML = svgIcon("hourglass_empty", "icon btn-icon") + "Submitting...";

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const rawUrl = tabs[0]?.url || "";

    const data = {
      domain: rawUrl,
      status: parseInt(document.getElementById("status-select").value, 10),
      category: parseInt(document.getElementById("category-select").value, 10) || null,
      openSource: document.getElementById("opensource-check").checked,
      login: document.getElementById("login-check").checked,
      abandoned: document.getElementById("abandoned-check").checked,
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
