(() => {
  const D = globalThis.PD_DEFAULTS;
  const groupsEl = document.getElementById("groups");
  const master = document.getElementById("enabled");
  const inputs = {};

  for (const [title, items] of globalThis.PD_GROUPS) {
    const sec = document.createElement("section");
    const h = document.createElement("h2");
    h.textContent = title;
    sec.append(h);
    for (const [key, label, hint, choices] of items) {
      const row = document.createElement(choices ? "div" : "label");
      row.className = "row" + (choices ? " choice" : "");
      row.innerHTML = '<div><div class="t"></div><div class="h"></div></div>';
      row.querySelector(".t").textContent = label;
      row.querySelector(".h").textContent = hint;
      if (choices) {
        // Segmented picker, e.g. pins per row: Auto | 3 | 4 | 5
        const seg = document.createElement("div");
        seg.className = "seg";
        seg.setAttribute("role", "radiogroup");
        seg.setAttribute("aria-label", label);
        const buttons = choices.map(([value, text]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = text;
          b.setAttribute("role", "radio");
          b.addEventListener("click", () => { chrome.storage.sync.set({ [key]: value }); set(value); });
          seg.append(b);
          return [value, b];
        });
        const set = (v) => {
          for (const [value, b] of buttons) b.setAttribute("aria-checked", String(value === v));
        };
        inputs[key] = set;
        row.append(seg);
      } else {
        row.insertAdjacentHTML("beforeend",
          '<span class="switch"><input type="checkbox"><span class="slider"></span></span>');
        const input = row.querySelector("input");
        input.addEventListener("change", () => chrome.storage.sync.set({ [key]: input.checked }));
        inputs[key] = (v) => { input.checked = !!v; };
      }
      sec.append(row);
    }
    groupsEl.append(sec);
  }

  function render(s) {
    master.checked = !!s.enabled;
    groupsEl.classList.toggle("off", !s.enabled);
    for (const [k, set] of Object.entries(inputs)) set(s[k]);
  }

  master.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: master.checked });
    groupsEl.classList.toggle("off", !master.checked);
  });

  document.getElementById("reset").addEventListener("click", () => {
    chrome.storage.sync.set(D, () => render(D));
  });

  chrome.storage.sync.get(D, render);

  // Is the extension actually running in the current tab?
  const statusEl = document.getElementById("status");
  function showStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status " + cls;
    statusEl.hidden = false;
  }
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab || !/^https?:\/\/([^/]+\.)?pinterest\./.test(tab.url || "")) return;
      chrome.tabs.sendMessage(tab.id, { type: "pd-status" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          showStatus("Not running in this tab. Refresh the Pinterest page.", "warn");
          return;
        }
        const n = Object.values(res.counts).reduce((a, b) => a + b, 0);
        showStatus(`✓ Active on this tab · ${n} item${n === 1 ? "" : "s"} hidden`, "ok");
      });
    });
  } catch (e) { /* not in an extension context */ }
})();
