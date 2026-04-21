const API_BASE = "https://api.justfyi.app";

const form = document.getElementById("news-form");
const input = document.getElementById("news-email");
const msg = document.getElementById("news-msg");
const btn = form.querySelector("button");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = input.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    show("Please enter a valid email.", "err");
    return;
  }

  btn.disabled = true;
  msg.textContent = "";
  msg.className = "news-msg";

  try {
    const res = await fetch(`${API_BASE}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    show("Subscribed. Thanks!", "ok");
    form.reset();
  } catch (err) {
    show(err.message || "Something went wrong.", "err");
  } finally {
    btn.disabled = false;
  }
});

function show(text, kind) {
  msg.textContent = text;
  msg.className = "news-msg " + kind;
}
