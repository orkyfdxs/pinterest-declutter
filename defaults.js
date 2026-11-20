// Shared by content.js and popup.js.
// true = hide that thing. Change a default here, then reload the extension.
globalThis.PD_DEFAULTS = {
  enabled: true,

  // Left icon rail (Home and Boards are never touched)
  navExplore: true,
  navCreate: true,
  navNotifications: true,
  navMessages: true,
  navSettings: true,

  // Home feed
  boardTabs: false, // the "All | Branding | abstract/unusual ..." row above the feed
  promoted: true,
  shopping: true,

  // Profile / boards
  boardSuggestions: true,
  savedHeader: true, // "Your saved ideas" title + your name / followers / Share profile

  // Pin pages + pin cards
  moreIdeas: true,
  pinOverlays: false, // title + "..." under every pin card
};

// Popup layout: [groupTitle, [[key, label, hint, choices?], ...]]
// Rows with `choices` ([[value, label], ...]) render as a segmented picker, others as a switch.
globalThis.PD_GROUPS = [
  ["Left sidebar", [
    ["navExplore", "Explore", "Compass / Today / Ideas"],
    ["navCreate", "Create (+)", "Pin creation tool"],
    ["navNotifications", "Notifications", "Bell icon"],
    ["navMessages", "Messages", "Chat bubble icon"],
    ["navSettings", "Settings", "Gear at the bottom (still in avatar menu)"],
  ]],
  ["Home feed", [
    ["boardTabs", "Board tab row", "All | Branding | ... above the feed"],
    ["promoted", "Promoted pins", "Ads / Sponsored pins"],
    ["shopping", "Shopping", "Shop badges, product pins, Shop sections"],
  ]],
  ["Boards", [
    ["savedHeader", "Page header", "“Your saved ideas”, your name, followers"],
    ["boardSuggestions", "Board suggestions", "Section under your boards"],
  ]],
  ["Pins", [
    ["moreIdeas", "More ideas / related", "Related grid on pin pages"],
    ["pinOverlays", "Pin titles + ⋯", "Text row under each pin card"],
  ]],
];
