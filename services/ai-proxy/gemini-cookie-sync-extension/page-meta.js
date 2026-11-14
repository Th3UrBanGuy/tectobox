/**
 * Gemini Cookie Sync — Gemini tab + page metadata (Phase 6).
 * Split from popup.js; loaded after cookies.js. Classic script.
 */

function getActiveGeminiAccount(tabs) {
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url || "");
      if (url.hostname !== "gemini.google.com") continue;
      const match = url.pathname.match(/^\/u\/(\d+)(?:\/|$)/);
      return match ? match[1] : null;
    } catch {
      // Ignore malformed or unavailable URLs.
    }
  }
  return null;
}

function chooseGeminiTab(tabs) {
  return tabs.find((tab) => tab.active) || tabs[0] || null;
}

async function readGeminiPageMetadata(tabs) {
  const tab = chooseGeminiTab(tabs);
  if (!tab?.id) {
    return {
      xsrfToken: null,
      geminiBl: null,
      source: null,
      error: "Open gemini.google.com in a tab, sign in, then refresh the page."
    };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const wiz = globalThis.WIZ_global_data || {};
        const html = document.documentElement?.innerHTML || "";

        const decode = (value) => {
          if (!value) return null;
          try {
            return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
          } catch {
            return value
              .replace(/\\u003d/gi, "=")
              .replace(/\\u0026/gi, "&")
              .replace(/\\u003c/gi, "<")
              .replace(/\\u003e/gi, ">");
          }
        };

        const regexValue = (name) => {
          const patterns = [
            new RegExp(`"${name}"\\s*:\\s*"([^"\\n]+)"`),
            new RegExp(`\\\\"${name}\\\\"\\s*:\\s*\\\\"([^"\\n]+)\\\\"`)
          ];
          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) return decode(match[1]);
          }
          return null;
        };

        let resourceBl = null;
        try {
          const resources = performance.getEntriesByType("resource");
          for (const entry of resources) {
            if (!entry?.name?.includes("gemini.google.com")) continue;
            const url = new URL(entry.name);
            const bl = url.searchParams.get("bl");
            if (bl) {
              resourceBl = bl;
              break;
            }
          }
        } catch {
          // Ignore performance API failures.
        }

        const xsrfToken = wiz.SNlM0e || regexValue("SNlM0e");
        const geminiBl = wiz.cfb2h || resourceBl || regexValue("cfb2h");

        let source = null;
        if (wiz.SNlM0e || wiz.cfb2h) source = "WIZ_global_data";
        else if (resourceBl) source = "performance";
        else if (xsrfToken || geminiBl) source = "page-html";

        return {
          xsrfToken: xsrfToken || null,
          geminiBl: geminiBl || null,
          source,
          url: location.href
        };
      }
    });

    return result?.[0]?.result || {
      xsrfToken: null,
      geminiBl: null,
      source: null,
      error: "Failed to read Gemini page data."
    };
  } catch (error) {
    return {
      xsrfToken: null,
      geminiBl: null,
      source: null,
      error: error?.message || String(error)
    };
  }
}
