/**
 * Gemini Cookie Sync — export (cookie string + JSON download) (Phase 6).
 * Split from popup.js; loaded after page-meta.js. Classic script.
 * downloadJson calls setStatus, which lives in popup-ui.js (loaded last);
 * it is only invoked from a click handler, after all scripts have loaded.
 */

function buildCookieString(info) {
  return EXPORT_ORDER
    .filter((name) => info.selected.has(name))
    .map((name) => `${name}=${info.selected.get(name).value}`)
    .join("; ");
}

async function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename,
    saveAs: true,
    conflictAction: "uniquify"
  });

  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
