function classifySource(url = "") {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return { type: "generic", label: "Generic tab" };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (
    host === "teams.microsoft.com" ||
    host.endsWith(".teams.microsoft.com")
  ) {
    return { type: "teams", label: "Microsoft Teams" };
  }

  if (
    host.endsWith(".sharepoint.com") ||
    path.includes("/stream.aspx")
  ) {
    return { type: "sharepoint", label: "SharePoint / Stream" };
  }

  return { type: "generic", label: "Generic tab" };
}

async function init() {
  const sourceType = document.getElementById("sourceType");
  const pageTitle = document.getElementById("pageTitle");
  const pageUrl = document.getElementById("pageUrl");

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  const source = classifySource(tab?.url);

  sourceType.textContent = source.label;
  sourceType.dataset.sourceType = source.type;
  pageTitle.textContent = tab?.title || "Untitled tab";
  pageUrl.textContent = tab?.url || "URL unavailable";
}

init().catch((error) => {
  document.getElementById("sourceType").textContent = "Unable to inspect tab";
  document.getElementById("pageTitle").textContent = error.message;
});
