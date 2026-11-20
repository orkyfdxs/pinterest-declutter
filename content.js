/* Pinterest Declutter - content script
 *
 * How it works
 * ------------
 * 1. Every feature in PD_DEFAULTS becomes a class on <html> when it is ON:
 *      <html class="pd-on pd-f-promoted pd-f-navCreate ...">
 * 2. This script finds clutter and *tags* it with  data-pd-hide="<feature>".
 * 3. content.css hides  html.pd-f-<feature> [data-pd-hide~="<feature>"].
 * So flipping a toggle in the popup only swaps a class: instant, no reload.
 *
 * Pinterest class names are obfuscated and change constantly, so everything
 * below keys off aria-labels, hrefs, data-test-id and visible English text.
 * If something stops being hidden, edit the CONFIG block below (see README).
 */
(() => {
  "use strict";

  // ======================= CONFIG: tweak selectors here =======================
  const CONFIG = {
    // A pin card in any masonry grid. First match (outermost first) wins.
    gridItem: [
      "[data-grid-item]",
      'div[role="listitem"]',
      '[data-test-id="pinWrapper"]',
      '[data-test-id="pin"]',
    ],

    // Left-rail icons. Matched by aria-label/title PREFIX (lowercase) or href path.
    nav: [
      { feature: "navExplore", labels: ["explore", "today", "ideas"],
        hrefs: [/^\/ideas(\/|$)/, /^\/today(\/|$)/, /^\/explore(\/|$)/] },
      { feature: "navCreate", labels: ["create"],
        hrefs: [/^\/pin-creation-tool/, /^\/pin-builder/, /^\/idea-pin-builder/] },
      { feature: "navNotifications", labels: ["notifications", "updates"],
        hrefs: [/^\/notifications/] },
      { feature: "navMessages", labels: ["messages", "inbox"],
        hrefs: [/^\/messages/, /^\/inbox/] },
      { feature: "navSettings", labels: ["settings"],
        hrefs: [/^\/settings/] },
    ],
    // The rail is the strip of icons on the far left. Only icons whose left edge is
    // within this many px of the window edge are touched, so the profile page's
    // own "Create" button etc. are left alone.
    railMaxLeft: 110,

    // The board tab row on the home feed (All | Branding | ...).
    boardTabs: ['[role="tablist"]', '[data-test-id*="board-tab" i]',
      '[data-test-id*="feed-tab" i]', '[data-test-id*="home-tab" i]'],

    // Visible-text rules. Each text node whose trimmed text matches is acted on.
    text: {
      promotedBadge: /^(promoted|promoted by.*|sponsored|ad)$/i,
      shopBadge: /^(shop|shop now|shop the look|shop similar|shop this .*|shopping .*|shop ideas.*|products?)$/i,
      price: /^[$€£₹¥]\s?\d[\d.,]*$/, // $24.99, ₹1,299 ...
      boardSuggestions: /^board suggestions$/i,
      moreIdeasHeading: /^(more to explore|more ideas|more like this|explore related|related interests|you might also like|more from .*|similar ideas)$/i,
      moreIdeasTab: /^more ideas$/i,
      // Your saved page: the title marks the page; the rest is the account block.
      savedHeading: /^your saved ideas$/i,
      accountButton: /^(share profile|edit profile)$/i,
      followers: /^[\d.,]+\s*[km]?\s*followers?\b/i,
      // Never hide a block that holds one of these controls (Pins | Boards tabs, toolbar).
      keepControls: /^(pins|boards|group|create|created|saved|sort|filter)$/i,
    },

    // Things that are hidden straight from a data-test-id (attribute contains).
    testIds: {
      promoted: ["promoted", "sponsored"],
      shopping: ["shopping", "shop-the-look", "product-pin", "shop-tab"],
      moreIdeas: ["related-pins", "relatedpins", "more-ideas"],
    },
  };
  // ===========================================================================

  const DEFAULTS = globalThis.PD_DEFAULTS || { enabled: true };
  // Hide switches only (booleans).
  const FEATURES = Object.keys(DEFAULTS).filter((k) => k !== "enabled" && typeof DEFAULTS[k] === "boolean");
  // Always look <html> up fresh: Pinterest may rebuild it while loading.
  const html = () => document.documentElement;
  let settings = { ...DEFAULTS };
  const on = (f) => !!settings.enabled && !!settings[f];

  // ---------- page-level state, kept on <html> ----------
  // Pinterest resets <html>'s attributes during load, which used to wipe these
  // markers (and with them all hiding) until the extension was reloaded. So they
  // are now re-checked constantly and restored the moment they go missing.
  let lastPath = null;
  let retired = false;
  let attrObserver = null;
  let contentObserver = null;
  let watchedRoot = null;
  const intervals = [];

  // If the extension is reloaded, the background script injects a fresh copy into
  // open tabs. Each copy stamps its id on <html> when it starts, so the newest one
  // owns the page; an older copy that sees a *different* id retires. A *missing*
  // id just means the page wiped it, so the owner stamps it back.
  const INSTANCE = Math.random().toString(36).slice(2);

  function claimOrRetire() {
    const cur = html().getAttribute("data-pd-instance");
    if (cur && cur !== INSTANCE) return false;
    if (!cur) html().setAttribute("data-pd-instance", INSTANCE);
    return true;
  }

  function applyClasses() {
    const cl = html().classList;
    cl.toggle("pd-on", !!settings.enabled);
    for (const f of FEATURES) cl.toggle("pd-f-" + f, on(f));
    const p = location.pathname;
    cl.toggle("pd-p-home", p === "/" || p.startsWith("/homefeed"));
    cl.toggle("pd-p-pin", p.startsWith("/pin/"));
  }

  function updatePath() {
    const p = location.pathname;
    if (p === lastPath) return false;
    lastPath = p;
    applyClasses();
    return true;
  }

  // Same rules as content.css, injected as a <style> too: the browser strips
  // manifest CSS from open tabs when an extension reloads, and pages can drop it.
  const STYLE_ID = "pd-core-style";
  // savedHeader is collapsed to zero height, not display:none: Pinterest's
  // boards grid measures that header and breaks if it vanishes.
  const COLLAPSE = "height:0!important;min-height:0!important;margin:0!important;" +
    "padding-top:0!important;padding-bottom:0!important;overflow:hidden!important;visibility:hidden!important";
  const STYLE_TEXT = FEATURES.map((f) => f === "boardTabs"
    ? `html.pd-f-boardTabs.pd-p-home [data-pd-hide~="boardTabs"]{display:none!important}`
    : f === "savedHeader"
      ? `html.pd-f-savedHeader [data-pd-hide~="savedHeader"]{${COLLAPSE}}`
      : `html.pd-f-${f} [data-pd-hide~="${f}"]{display:none!important}`).join("\n");

  function ensureStyle() {
    // Wait for <head>: a <style> stuck directly under <html> before the page's
    // own <head> can make React's hydration bail out and rebuild the document.
    // Until then the manifest's content.css does the hiding on its own.
    if (!document.head) return;
    let st = document.getElementById(STYLE_ID);
    if (!st) {
      st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = STYLE_TEXT;
    }
    const parent = document.head || html();
    if (st.parentNode !== parent) parent.appendChild(st);
  }

  // Put everything back if anything was wiped. Cheap and idempotent: classList
  // toggles that change nothing don't touch the DOM.
  function ensurePage() {
    if (retired) return false;
    if (!claimOrRetire()) { retire(); return false; }
    applyClasses();
    ensureStyle();
    return true;
  }

  html().setAttribute("data-pd-instance", INSTANCE); // newest copy takes over
  ensurePage();
  lastPath = location.pathname;

  // ---------- helpers ----------
  // During a full scan, every (element, feature) we tag is recorded here, so
  // tags that no longer apply (React reused the card for a different pin) can be removed.
  let confirmed = null;

  // ---------- safety net: never hide the pin you opened ----------
  // On a /pin/ page, any block holding the opened pin is off-limits to every
  // rule. The pin is recognised by its title (h1), Pinterest's closeup ids, the
  // page's og:image, or a full-size image (/736x/, /originals/; related pins
  // load small /236x/ or /474x/ versions).
  const OPENED_SEL = "h1, [data-test-id*='closeup' i], [data-test-id*='visual-content' i], [data-test-id*='pin-detail' i]";
  function holdsOpenedPin(el) {
    if (!html().classList.contains("pd-p-pin") || !el.querySelector) return false;
    if (el.matches(OPENED_SEL) || el.querySelector(OPENED_SEL)) return true;
    const og = (document.querySelector('meta[property="og:image"]') || {}).content || "";
    const ogFile = og.split("?")[0].split("/").pop();
    for (const img of el.querySelectorAll("img")) {
      const src = (img.currentSrc || img.src || "").split("?")[0];
      if (ogFile && src.endsWith("/" + ogFile)) return true;
      if (/\/(736x|originals|1200x)\//.test(src)) return true;
    }
    return false;
  }

  // Un-hide anything that turned out to hold the opened pin (e.g. tagged
  // before the pin's image had loaded).
  function protectOpenedPin() {
    if (!html().classList.contains("pd-p-pin")) return;
    for (const el of document.querySelectorAll("[data-pd-hide]")) {
      if (holdsOpenedPin(el)) el.removeAttribute("data-pd-hide");
    }
  }

  function tag(el, feature) {
    if (!el || el === document.body || el === html()) return;
    if (holdsOpenedPin(el)) return;
    if (confirmed) {
      let s = confirmed.get(el);
      if (!s) confirmed.set(el, (s = new Set()));
      s.add(feature);
    }
    const cur = el.getAttribute("data-pd-hide");
    if (!cur) { el.setAttribute("data-pd-hide", feature); return; }
    if (!cur.split(" ").includes(feature)) el.setAttribute("data-pd-hide", cur + " " + feature);
  }

  function untag(el, feature) {
    const left = (el.getAttribute("data-pd-hide") || "").split(" ").filter((t) => t && t !== feature);
    if (left.length) el.setAttribute("data-pd-hide", left.join(" "));
    else el.removeAttribute("data-pd-hide");
  }

  // querySelectorAll that also tests the root itself.
  function qsa(scope, sel) {
    const out = [...scope.querySelectorAll(sel)];
    if (scope.matches && scope.matches(sel)) out.unshift(scope);
    return out;
  }

  // Climb through single-child wrapper divs so we hide the whole slot, not just the icon.
  function outerWrapper(el) {
    let node = el;
    while (node.parentElement && node.parentElement !== document.body &&
           node.parentElement.childElementCount === 1 &&
           !node.parentElement.matches("nav, [role=navigation], main, header")) {
      node = node.parentElement;
    }
    return node;
  }

  // Rail version: keep climbing while the parent holds no *other* clickable thing,
  // so decorations that sit next to the icon (the red notification dot) go too.
  const CLICKABLE = "a[href], button, [role='button'], [role='link']";
  function railSlot(el) {
    let node = outerWrapper(el);
    while (node.parentElement && node.parentElement !== document.body &&
           !node.parentElement.matches("nav, [role=navigation], main, header") &&
           node.parentElement.querySelectorAll(CLICKABLE).length <= 1) {
      node = node.parentElement;
    }
    return node;
  }

  function gridItemOf(el) {
    for (const sel of CONFIG.gridItem) {
      const hit = el.closest(sel);
      if (hit) return hit;
    }
    return null;
  }

  // From a heading, climb to the biggest ancestor that is still "just this section".
  // A section starts at its heading: if the parent holds content *before* the
  // heading (a button, image, link or other heading), the parent is bigger than the section.
  function hasContentBefore(parent, node) {
    const first = parent.querySelector("a[href], button, img, video, h1, h2, h3, h4, [role='heading']");
    return !!first && !node.contains(first) &&
      !!(node.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  function sectionOf(heading, guard, maxHeight = Infinity) {
    let node = heading;
    while (node.parentElement && node.parentElement !== document.body &&
           !node.parentElement.matches("main, #__PWS_ROOT__, #__PWS_ROOT__ > div") &&
           !hasContentBefore(node.parentElement, node) &&
           !guard(node.parentElement) &&
           node.parentElement.getBoundingClientRect().height <= maxHeight) {
      node = node.parentElement;
    }
    return node;
  }

  const textIs = (el, re) => re.test((el.textContent || "").trim());

  // ---------- scanners (each takes the subtree to look in) ----------
  const NAV_FEATURES = CONFIG.nav.map((r) => r.feature);

  function inRail(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.width < 140 && r.left < CONFIG.railMaxLeft;
  }

  function scanNav(scope) {
    if (!NAV_FEATURES.some(on)) return;
    for (const el of qsa(scope, "a[href], button, [role='button'], [role='link']")) {
      if (el.hasAttribute("data-pd-hide")) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
      const path = el.tagName === "A" ? (el.pathname || "") : "";
      const rule = CONFIG.nav.find((r) =>
        (label && r.labels.some((l) => label.startsWith(l))) ||
        (path && r.hrefs.some((h) => h.test(path))));
      if (!rule || !on(rule.feature) || !inRail(el)) continue;
      tag(railSlot(el), rule.feature);
    }
  }

  function scanBoardTabs() {
    if (!on("boardTabs") || !html().classList.contains("pd-p-home")) return;
    let found = false;
    for (const sel of CONFIG.boardTabs) {
      for (const el of document.querySelectorAll(sel)) {
        if (inRail(el)) continue;
        tag(outerWrapper(el), "boardTabs");
        found = true;
      }
    }
    if (found) return;
    // Fallback: a clickable whose text is exactly "All" near the top of the page.
    for (const el of document.querySelectorAll("a, button, [role='tab'], [role='button']")) {
      if ((el.textContent || "").trim() !== "All") continue;
      const r = el.getBoundingClientRect();
      if (r.top > 300 || r.height === 0) continue;
      let row = el;
      while (row.parentElement && row.parentElement.childElementCount === 1) row = row.parentElement;
      row = row.parentElement;
      if (row && row.childElementCount >= 2 && row !== document.body) tag(outerWrapper(row), "boardTabs");
    }
  }

  function scanTestIds(scope) {
    for (const [feature, ids] of Object.entries(CONFIG.testIds)) {
      if (!on(feature)) continue;
      const sel = ids.map((id) => `[data-test-id*="${id}" i]`).join(",");
      for (const el of qsa(scope, sel)) tag(gridItemOf(el) || el, feature);
    }
  }

  // Guards stop sectionOf() from climbing into the main content.
  // A link to one of your boards looks like /<user>/<board>/ (not /<user>/_saved/).
  const isBoardLink = (a) => /^\/[^/]+\/[^/_][^/]*\/?$/.test(a.pathname || "");
  const profileGuard = (el) =>
    !!el.querySelector("h1, [role='tablist']") ||
    /\d+\s*pins?/i.test(el.textContent || "") ||            // "8 Pins" (or "8Pins" across spans)
    /your saved ideas/i.test(el.textContent || "") ||
    [...el.querySelectorAll("a[href]")].some(isBoardLink) ||  // your boards grid
    el.querySelectorAll(CLICKABLE).length > 12;              // too big to be one section

  const closeupGuard = (el) =>
    !!el.querySelector("h1, [data-test-id*='closeup' i], [data-test-id*='visual-content' i], video") ||
    [...el.querySelectorAll("img")].some((img) => img.getBoundingClientRect().width > 400);

  const genericGuard = (el) =>
    !!el.querySelector("h1, [role='tablist']") ||
    el.querySelectorAll(CONFIG.gridItem.join(",")).length > 12 ||
    el.querySelectorAll("h2, h3, [role='heading']").length > 1;

  // ---------- "Your saved ideas" page header ----------
  // Hides the page title and your account block (avatar, name, followers,
  // Share profile). Each anchor climbs to the biggest wrapper that still holds
  // none of the things to keep: the Pins/Boards tabs, the toolbar, board links, pins.
  const ownText = (el) => (el.textContent || "").trim();
  const headerGuard = (el) =>
    el === document.body || el.matches("main, #__PWS_ROOT__") ||
    !!el.querySelector("[role='tablist'], [data-grid-item]") ||
    [...el.querySelectorAll("a[href]")].some(isBoardLink) ||
    [...el.querySelectorAll(CLICKABLE)].some((c) => CONFIG.text.keepControls.test(ownText(c)));

  function headerBlock(node) {
    while (node.parentElement && !headerGuard(node.parentElement)) node = node.parentElement;
    return node;
  }

  function scanSavedHeader() {
    if (!on("savedHeader") || html().classList.contains("pd-p-pin")) return;
    const T = CONFIG.text;
    const heads = [...document.querySelectorAll("h1, h2, [role='heading']")]
      .filter((h) => T.savedHeading.test(ownText(h)));
    if (!heads.length) return; // not your saved page
    const anchors = [...heads];
    for (const el of document.querySelectorAll(CLICKABLE)) {
      if (T.accountButton.test(ownText(el))) anchors.push(el);
    }
    // "0 followers · 4 following": the smallest element whose text starts that way
    for (const el of document.querySelectorAll("div, span")) {
      if (el.childElementCount <= 3 && T.followers.test(ownText(el)) && ownText(el).length < 60) {
        anchors.push(el);
        break;
      }
    }
    for (const a of anchors) {
      if (headerGuard(a)) continue;
      tag(headerBlock(a), "savedHeader");
    }
  }

  function scanText(scope, full) {
    const T = CONFIG.text;
    const want = { promoted: on("promoted"), shopping: on("shopping"),
      boardSuggestions: on("boardSuggestions"), moreIdeas: on("moreIdeas") };
    if (!Object.values(want).some(Boolean)) return;
    const onPin = html().classList.contains("pd-p-pin");
    const start = scope.nodeType === 1 ? scope : scope.parentElement;
    if (!start) return;
    const walker = document.createTreeWalker(start,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
          if (/^(SCRIPT|STYLE|NOSCRIPT|SVG)$/i.test(node.tagName)) return NodeFilter.FILTER_REJECT;
          // Incremental scans skip already-hidden subtrees; full scans re-check them.
          if (!full && node.hasAttribute("data-pd-hide")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        },
      });
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!t || t.length > 40) continue;
      const el = n.parentElement;
      if (!el) continue;

      if (want.promoted && T.promotedBadge.test(t)) {
        const item = gridItemOf(el);
        if (item) { tag(item, "promoted"); continue; }
      }

      if (want.shopping && (T.shopBadge.test(t) || T.price.test(t))) {
        const item = gridItemOf(el);
        if (item) { tag(item, "shopping"); continue; }
        if (T.shopBadge.test(t)) {
          const clickable = el.closest("a, button, [role='tab']");
          if (clickable && textIs(clickable, T.shopBadge)) {
            tag(outerWrapper(clickable), "shopping");
          } else if (el.closest("h2,h3,h4,[role='heading']")) {
            tag(sectionOf(el, onPin ? closeupGuard : genericGuard, window.innerHeight * 0.9), "shopping");
          }
          continue;
        }
      }

      if (want.boardSuggestions && T.boardSuggestions.test(t)) {
        tag(sectionOf(el, profileGuard), "boardSuggestions");
        continue;
      }

      if (want.moreIdeas && T.moreIdeasTab.test(t)) {
        const clickable = el.closest("a, button, [role='tab']");
        if (clickable) { tag(outerWrapper(clickable), "moreIdeas"); continue; }
      }
      if (want.moreIdeas && onPin && T.moreIdeasHeading.test(t)) {
        const sec = sectionOf(el, closeupGuard);
        tag(sec, "moreIdeas");
        // If the guard stopped early, also hide the grid that follows the heading.
        for (let sib = sec.nextElementSibling; sib; sib = sib.nextElementSibling) {
          // ...unless that grid also holds the pin you opened (see scanPinGrid)
          if (sib.querySelector(CONFIG.gridItem.join(",")) &&
              ![...sib.querySelectorAll("[data-grid-item]")].some(isCloseupItem)) tag(sib, "moreIdeas");
        }
      }
    }
  }

  // ---------- related pins on a /pin/ page ----------
  // Pinterest may put the pin you opened *inside* the same masonry grid as the
  // related pins (as a wide first card). Hiding every grid card then blanks the
  // page, so each card is checked and the opened pin is always kept.
  // Widths come from the inline style Pinterest sets, which stays readable
  // even after a card is hidden.
  const CLOSEUP_SEL = "h1, [data-test-id*='closeup' i], [data-test-id*='visual-content' i], " +
    "[data-test-id*='pin-detail' i], [data-test-id*='description' i], textarea, [role='textbox']";
  const styleWidth = (el) => parseFloat(el.style.width) || 0;
  let pinGridMedian = 0;

  function isCloseupItem(item) {
    if (item.querySelector(CLOSEUP_SEL) || holdsOpenedPin(item)) return true;
    const w = styleWidth(item);
    return !!(pinGridMedian && w > pinGridMedian * 1.6); // spans several columns
  }

  function scanPinGrid() {
    if (!on("moreIdeas") || !html().classList.contains("pd-p-pin")) return;
    const items = [...document.querySelectorAll("[data-grid-item]")];
    const widths = items.map(styleWidth).filter(Boolean).sort((a, b) => a - b);
    pinGridMedian = widths[Math.floor(widths.length / 2)] || 0;
    for (const item of items) {
      if (isCloseupItem(item)) untag(item, "moreIdeas");
      else tag(item, "moreIdeas");
    }
  }

  function scanPinOverlays(scope) {
    if (!on("pinOverlays")) return;
    // The footer row under a pin card = smallest ancestor of its "..." button
    // that doesn't contain the pin image, and sits below the image.
    const sel = CONFIG.gridItem[0] + "," + CONFIG.gridItem[1];
    const items = new Set(qsa(scope, sel));
    const up = scope.nodeType === 1 && scope.closest && scope.closest(sel);
    if (up) items.add(up);
    for (const item of items) {
      const img = item.querySelector("img, video");
      if (!img) continue;
      const imgBottom = img.getBoundingClientRect().bottom;
      for (const btn of item.querySelectorAll("button[aria-label], [role='button'][aria-label]")) {
        if (!/more|options|actions/i.test(btn.getAttribute("aria-label"))) continue;
        let node = btn;
        while (node.parentElement && node.parentElement !== item &&
               !node.parentElement.querySelector("img, video")) {
          node = node.parentElement;
        }
        const r = node.getBoundingClientRect();
        if (r.height > 0 && r.top >= imgBottom - 4) tag(node, "pinOverlays");
      }
    }
  }

  // Tags re-derived on every full scan and dropped when no longer valid:
  // recycled pin cards, and sections whose surroundings loaded after we tagged
  // them (e.g. your boards grid arriving after "Board suggestions").
  const REVALIDATE = ["promoted", "shopping", "boardSuggestions", "moreIdeas", "savedHeader"];

  // ---------- run loop ----------
  // Work is batched into requestAnimationFrame, which runs *before* the browser
  // paints. New clutter is therefore hidden before it is ever drawn: no flash.
  const pending = new Set();
  let needFull = true;
  let raf = 0;
  let rafFallback = 0;

  function schedule(full) {
    if (full) needFull = true;
    if (raf) return;
    raf = requestAnimationFrame(run);
    // rAF never fires while a tab is in the background, so a timer makes sure
    // queued work still runs there (and can't get stuck behind a lost frame).
    clearTimeout(rafFallback);
    rafFallback = setTimeout(() => {
      if (raf) { cancelAnimationFrame(raf); run(); }
    }, 300);
  }

  const SECTION_TAGS = '[data-pd-hide~="boardSuggestions"], [data-pd-hide~="moreIdeas"], [data-pd-hide~="shopping"]';

  function run() {
    raf = 0;
    if (!document.body) return;
    if (!ensurePage()) return;
    watchPage(); // re-attach if Pinterest swapped out <html>/<body>
    // New content arriving inside a hidden section (e.g. your boards loading in
    // after "Board suggestions" was hidden) => recompute sections right now.
    for (const n of pending) {
      if (n.isConnected && n.parentElement && n.parentElement.closest(SECTION_TAGS)) { needFull = true; break; }
    }
    const full = updatePath() || needFull;
    needFull = false;

    let scopes;
    if (full) {
      scopes = [document.body];
    } else {
      // Drop roots that are detached or inside another pending root.
      scopes = [...pending].filter((n) => n.isConnected &&
        ![...pending].some((o) => o !== n && o.contains(n)));
    }
    pending.clear();
    if (!scopes.length) return;

    if (full) confirmed = new Map();
    for (const scope of scopes) {
      try { scanNav(scope); } catch (e) { console.debug("[pd] nav", e); }
      try { scanTestIds(scope); } catch (e) { console.debug("[pd] testids", e); }
      try { scanText(scope, full); } catch (e) { console.debug("[pd] text", e); }
      try { scanPinOverlays(scope); } catch (e) { console.debug("[pd] overlays", e); }
    }
    try { scanBoardTabs(); } catch (e) { console.debug("[pd] tabs", e); }
    try { scanSavedHeader(); } catch (e) { console.debug("[pd] saved header", e); }
    try { scanPinGrid(); } catch (e) { console.debug("[pd] pin grid", e); }
    try { protectOpenedPin(); } catch (e) { console.debug("[pd] protect", e); }

    if (full) {
      for (const f of REVALIDATE) {
        if (!on(f)) continue;
        for (const el of document.querySelectorAll(`[data-pd-hide~="${f}"]`)) {
          const s = confirmed.get(el);
          if (!s || !s.has(f)) untag(el, f);
        }
      }
      confirmed = null;
    }
  }

  // Two observers:
  //  * attrObserver watches <html>'s own attributes and repairs our classes /
  //    instance id synchronously, before the browser paints. It starts right
  //    away at document_start, which is when Pinterest does its reset.
  //  * contentObserver watches the whole document for new nodes / text.
  function onContent(records) {
    for (const r of records) {
      if (r.type === "characterData") {
        if (r.target.parentElement) pending.add(r.target.parentElement);
      } else {
        for (const node of r.addedNodes) {
          if (node.nodeType === 1) pending.add(node);
          else if (node.nodeType === 3 && node.parentElement) pending.add(node.parentElement);
        }
      }
    }
    if (!document.getElementById(STYLE_ID)) ensureStyle(); // our <style> got removed
    if (pending.size) schedule(false);
  }

  function watchPage() {
    const r = html();
    if (retired || !r || r === watchedRoot) return;
    watchedRoot = r;
    if (attrObserver) attrObserver.disconnect();
    if (contentObserver) contentObserver.disconnect();
    attrObserver = new MutationObserver(() => { ensurePage(); });
    attrObserver.observe(r, { attributes: true, attributeFilter: ["class", "data-pd-instance"] });
    contentObserver = new MutationObserver(onContent);
    contentObserver.observe(r, { childList: true, subtree: true, characterData: true });
    ensurePage();
    schedule(true);
  }

  function retire() {
    retired = true;
    if (attrObserver) attrObserver.disconnect();
    if (contentObserver) contentObserver.disconnect();
    intervals.forEach(clearInterval);
    intervals.length = 0;
  }

  // Start guarding <html> immediately, before Pinterest's scripts run.
  watchPage();

  function start() {
    run();
    // SPA route changes: react immediately where the Navigation API exists,
    // with a cheap path poll as a fallback.
    try { window.navigation.addEventListener("currententrychange", () => schedule(true)); } catch (_) {}
    window.addEventListener("popstate", () => schedule(true));
    intervals.push(setInterval(() => { if (location.pathname !== lastPath) schedule(true); }, 250));

    // Safety net: things laid out late (rail icons need a size before they
    // count as "in the rail") or text that changed in place get caught here.
    intervals.push(setInterval(() => schedule(true), 1500));
    console.info("[Pinterest Declutter] active");
    window.addEventListener("load", () => schedule(true));
    window.addEventListener("resize", () => schedule(true));
  }

  // Load saved toggles (declared last so schedule() above already exists).
  try {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      settings = { ...DEFAULTS, ...s };
      applyClasses();
      schedule(true);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
      applyClasses();
      schedule(true); // a feature that was off hasn't been scanned for yet
    });
    // The popup asks "are you running here?" to detect tabs that need a refresh.
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (!msg || msg.type !== "pd-status" || retired) return;
      // The background script pings on every load / tab switch: use it as a
      // nudge to repair the page and rescan right now.
      if (document.body) { needFull = true; run(); } else ensurePage();
      const counts = {};
      for (const el of document.querySelectorAll("[data-pd-hide]")) {
        for (const f of el.getAttribute("data-pd-hide").split(" ")) if (on(f)) counts[f] = (counts[f] || 0) + 1;
      }
      reply({ ok: true, counts });
    });
  } catch (e) {
    // storage unavailable (test harness, or extension reloaded under this tab)
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
