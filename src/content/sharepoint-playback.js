(() => {
  if (globalThis.__tabVaultSharePointLifecycleInstalled) {
    return;
  }

  globalThis.__tabVaultSharePointLifecycleInstalled = true;

  let observedVideo = null;
  let cleanup = null;

  function send(event, video) {
    chrome.runtime.sendMessage({
      type: "TABVAULT_SHAREPOINT_MEDIA_EVENT",
      event,
      media: {
        currentTime: Number(video?.currentTime || 0),
        duration: Number.isFinite(video?.duration) ? video.duration : null,
        paused: Boolean(video?.paused),
        ended: Boolean(video?.ended),
        readyState: Number(video?.readyState || 0)
      }
    }).catch(() => {});
  }

  function attach(video) {
    if (!video || video === observedVideo) {
      return;
    }

    if (cleanup) {
      cleanup();
    }

    observedVideo = video;

    const handlers = {
      play: () => send("play", video),
      playing: () => send("playing", video),
      pause: () => send(video.ended ? "ended" : "pause", video),
      ended: () => send("ended", video),
      loadedmetadata: () => send("metadata", video)
    };

    for (const [name, handler] of Object.entries(handlers)) {
      video.addEventListener(name, handler);
    }

    cleanup = () => {
      for (const [name, handler] of Object.entries(handlers)) {
        video.removeEventListener(name, handler);
      }
    };

    send("state", video);
  }

  function findBestVideo() {
    const videos = [...document.querySelectorAll("video")];
    if (!videos.length) {
      return null;
    }

    return videos
      .map((video) => ({
        video,
        area: Math.max(1, video.clientWidth) * Math.max(1, video.clientHeight)
      }))
      .sort((a, b) => b.area - a.area)[0].video;
  }

  function scan() {
    attach(findBestVideo());
  }

  scan();

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TABVAULT_GET_MEDIA_STATE") {
      return false;
    }

    scan();

    if (!observedVideo) {
      sendResponse({ ok: true, media: null });
      return false;
    }

    sendResponse({
      ok: true,
      media: {
        currentTime: Number(observedVideo.currentTime || 0),
        duration: Number.isFinite(observedVideo.duration) ? observedVideo.duration : null,
        paused: Boolean(observedVideo.paused),
        ended: Boolean(observedVideo.ended),
        readyState: Number(observedVideo.readyState || 0)
      }
    });

    return false;
  });
})();
