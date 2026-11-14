/**
 * Gemini Cookie Sync — popup UI (DOM refs, status, inspection, buttons)
 * (Phase 6). Split from popup.js; loaded LAST — it depends on every other
 * split file (constants, cookies, page-meta, export). Classic script.
 */

const statusEl = document.getElementById("status");
const exportButton = document.getElementById("export");
const inspectButton = document.getElementById("inspect");
const openButton = document.getElementById("open");

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function buildInspection() {
  const [cookies, tabs] = await Promise.all([
    readGoogleCookies(),
    chrome.tabs.query({ url: "https://gemini.google.com/*" })
  ]);

  const selected = selectBestCookies(cookies);
  const validation = validateSelection(selected);
  const legacyPresent = listPresent(selected, LEGACY_COOKIES);
  const legacyMissing = LEGACY_COOKIES.filter((name) => !selected.has(name));
  const available = summarizeAvailable(cookies);
  const authUser = getActiveGeminiAccount(tabs);
  const pageMetadata = await readGeminiPageMetadata(tabs);

  return {
    cookies,
    selected,
    validation,
    legacyPresent,
    legacyMissing,
    available,
    authUser,
    pageMetadata
  };
}

function inspectionMessage(info) {
  const {
    cookies,
    selected,
    validation,
    legacyPresent,
    legacyMissing,
    available,
    authUser,
    pageMetadata
  } = info;

  const lines = [
    `Found ${cookies.length} cookie(s) across Google domains.`,
    "",
    `SAPISID: ${selected.has("SAPISID") ? "present" : "missing"}`,
    `Session cookie: ${validation.sessionCookie || "missing"}`,
    `XSRF / SNlM0e: ${pageMetadata.xsrfToken ? "present" : "missing"}`,
    `gemini_bl / cfb2h: ${pageMetadata.geminiBl ? "present" : "missing"}`,
    `auth_user: ${authUser ?? "default account"}`,
    `Page data source: ${pageMetadata.source || "unavailable"}`,
    "",
    `Legacy present: ${legacyPresent.join(", ") || "none"}`,
    `Legacy not visible to the extension: ${legacyMissing.join(", ") || "none"}`,
    "",
    `Available for export: ${available.join(", ") || "none"}`
  ];

  if (pageMetadata.error) {
    lines.push("", `Page note: ${pageMetadata.error}`);
  }

  if (validation.valid && pageMetadata.xsrfToken) {
    lines.push("", "Session and XSRF are ready for export.");
  } else if (validation.valid) {
    lines.push("", "Cookies are ready, but XSRF is missing. Open Gemini, refresh the page, then inspect again.");
  } else {
    lines.push("", "Session is incomplete: SAPISID and one of __Secure-1PSID, __Secure-3PSID, or SID are required.");
  }

  return lines.join("\n");
}

openButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: "https://gemini.google.com/app" });
});

inspectButton.addEventListener("click", async () => {
  inspectButton.disabled = true;
  setStatus("Inspecting session and page data…");

  try {
    const info = await buildInspection();
    const ready = info.validation.valid && Boolean(info.pageMetadata.xsrfToken);
    setStatus(inspectionMessage(info), ready ? "ok" : "warn");
  } catch (error) {
    setStatus(error?.message || String(error), "warn");
  } finally {
    inspectButton.disabled = false;
  }
});

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  setStatus("Reading cookies and XSRF…");

  try {
    const info = await buildInspection();

    if (!info.validation.valid || !info.pageMetadata.xsrfToken) {
      throw new Error(inspectionMessage(info));
    }

    const cookieString = buildCookieString(info);
    const payload = {
      cookie: cookieString,
      sapisid: info.selected.get("SAPISID").value,
      auth_user: info.authUser,
      xsrf_token: info.pageMetadata.xsrfToken,
      gemini_bl: info.pageMetadata.geminiBl
    };

    await downloadJson("gemini-auth.json", payload);

    const exportedNames = EXPORT_ORDER.filter((name) => info.selected.has(name));
    setStatus(
      `Created gemini-auth.json with ${exportedNames.length} cookie(s) and XSRF.\n\n` +
      `Session cookie: ${info.validation.sessionCookie}\n` +
      `XSRF: present\n` +
      `gemini_bl: ${info.pageMetadata.geminiBl ? "present" : "not present — current server setting will remain"}\n` +
      `auth_user: ${info.authUser ?? "null"}\n\n` +
      "Move the file into gemini-web2api and do not share it or commit it to Git.",
      "ok"
    );
  } catch (error) {
    setStatus(error?.message || String(error), "warn");
  } finally {
    exportButton.disabled = false;
  }
});
