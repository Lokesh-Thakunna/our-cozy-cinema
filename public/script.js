const ROLE_ORDER = ["Me", "My Love"];
const STORAGE_KEY = "love-sync-client-id";
const PIN_STORAGE_KEY = "love-sync-access-pin";
const SEEK_DRIFT_SECONDS = 2.6;
const SEEK_COOLDOWN_MS = 1800;
const REMOTE_GUARD_MS = 1500;
const PROGRESS_INTERVAL_MS = 5000;
const WATCHER_INTERVAL_MS = 1000;

const dom = {
  appShell: document.querySelector(".app-shell"),
  connectionStatus: document.getElementById("connectionStatus"),
  roleBadge: document.getElementById("roleBadge"),
  presenceStrip: document.getElementById("presenceStrip"),
  messages: document.getElementById("messages"),
  chatForm: document.getElementById("chatForm"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  chatError: document.getElementById("chatError"),
  videoForm: document.getElementById("videoForm"),
  videoUrlInput: document.getElementById("videoUrlInput"),
  videoButton: document.getElementById("videoButton"),
  videoError: document.getElementById("videoError"),
  playerPlaceholder: document.getElementById("playerPlaceholder"),
  currentVideoLink: document.getElementById("currentVideoLink"),
  savedProgress: document.getElementById("savedProgress"),
  lastUpdated: document.getElementById("lastUpdated"),
  installButton: document.getElementById("installButton"),
  authPanel: document.getElementById("authPanel"),
  authForm: document.getElementById("authForm"),
  pinInput: document.getElementById("pinInput"),
  pinButton: document.getElementById("pinButton"),
  authError: document.getElementById("authError"),
  authMessage: document.getElementById("authMessage"),
  toast: document.getElementById("toast")
};

const state = {
  clientId: getOrCreateClientId(),
  accessPin: loadStoredPin(),
  pinRequired: false,
  hasJoined: false,
  role: null,
  readOnly: false,
  connectedRoles: [],
  messages: [],
  video: {
    url: "",
    videoId: "",
    currentTime: 0,
    isPlaying: false,
    updatedAt: null,
    changedBy: null
  },
  player: null,
  playerReady: false,
  youtubeReady: false,
  pendingInstallPrompt: null,
  suppressPlayerEventsUntil: 0,
  lastPlaybackSample: null,
  lastSeekSentAt: 0,
  lastProgressSentAt: 0,
  watchTimer: null,
  lastCommandSignature: ""
};

const socket = io({
  autoConnect: false,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  timeout: 10000
});

loadYouTubeApi();
registerServiceWorker();
setupInstallPrompt();
bindUi();
renderRole();
renderPresence();
renderMessages();
updateVideoDetails();
applyReadonlyState();
void initializeApp();

socket.on("connect", () => {
  updateConnectionStatus(false, "Opening our little world...");
  joinSession();
});

socket.on("disconnect", () => {
  updateConnectionStatus(false, state.hasJoined ? "Finding our way back..." : "Away for a moment");
});

socket.on("connect_error", () => {
  updateConnectionStatus(false, "Trying to find you again...");
  if (!state.hasJoined) {
    setAuthError("I couldn't reach our space right now. Check the link and try again.");
  }
  showToast("Trying to bring our space back online...");
});

socket.on("session:state", async (payload) => {
  state.hasJoined = true;
  state.role = payload.role || null;
  state.readOnly = Boolean(payload.readOnly);
  state.connectedRoles = Array.isArray(payload.connectedRoles) ? payload.connectedRoles : [];
  state.messages = Array.isArray(payload.messages) ? payload.messages : [];
  state.video = sanitizeVideoPayload(payload.video);

  if (state.pinRequired && state.accessPin) {
    storeAccessPin(state.accessPin);
  }

  clearAuthError();
  renderAuthGate();
  updateConnectionStatus(true);
  renderRole();
  renderPresence();
  renderMessages();
  updateVideoDetails();
  applyReadonlyState();
  await applyVideoState(state.video, { forceLoad: true });
});

socket.on("presence:update", (payload) => {
  state.connectedRoles = Array.isArray(payload) ? payload : [];
  renderPresence();
});

socket.on("chat:new", (message) => {
  const incoming = sanitizeMessage(message);
  if (!incoming.text) {
    return;
  }

  state.messages.push(incoming);
  state.messages = state.messages.slice(-500);
  appendMessage(incoming, true);
});

socket.on("video:changed", async (payload) => {
  state.video = sanitizeVideoPayload(payload);
  updateVideoDetails();
  clearVideoError();
  showToast(`${state.video.changedBy || "Your love"} picked something new for us.`);
  await applyVideoState(state.video, { forceLoad: true });
});

socket.on("video:synced", async (payload) => {
  state.video = sanitizeVideoPayload(payload);
  updateVideoDetails();
  await applyVideoState(state.video, { forceLoad: false });
});

async function initializeApp() {
  try {
    await loadAppConfig();
  } catch (error) {
    console.error("Failed to load app config.", error);
    state.pinRequired = true;
    updateConnectionStatus(false, "Our space is resting");
    setAuthError("I couldn't reach our space right now. Refresh once the app is back online.");
    renderAuthGate();
    return;
  }

  renderAuthGate();

  if (state.pinRequired && !state.accessPin) {
    updateConnectionStatus(false, "Enter our secret PIN");
    dom.pinInput.focus();
    return;
  }

  connectSocket();
}

async function loadAppConfig() {
  const response = await fetch("/app-config", {
    cache: "no-store",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Unexpected config status: ${response.status}`);
  }

  const payload = await response.json();
  state.pinRequired = Boolean(payload?.pinRequired);

  dom.authMessage.textContent = state.pinRequired
    ? "Enter our private PIN so this little place stays just between us."
    : "This space is open right now. Add a COUPLE_PIN before sharing it publicly.";
}

function bindUi() {
  dom.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitAccessPin();
  });

  dom.pinInput.addEventListener("input", () => {
    if (dom.pinInput.value.length > 0) {
      clearAuthError();
    }
  });

  dom.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });

  dom.videoForm.addEventListener("submit", (event) => {
    event.preventDefault();
    changeVideo();
  });

  dom.messageInput.addEventListener("input", () => {
    if (dom.messageInput.value.length > 0) {
      clearChatError();
    }
  });

  dom.videoUrlInput.addEventListener("input", () => {
    if (dom.videoUrlInput.value.length > 0) {
      clearVideoError();
    }
  });

  dom.installButton.addEventListener("click", async () => {
    if (!state.pendingInstallPrompt) {
      return;
    }

    state.pendingInstallPrompt.prompt();
    const result = await state.pendingInstallPrompt.userChoice;
    if (result.outcome !== "dismissed") {
      showToast("Saved close. Our little world is now one tap away.");
    }

    state.pendingInstallPrompt = null;
    dom.installButton.classList.add("hidden");
  });
}

function connectSocket() {
  if (socket.connected) {
    joinSession();
    return;
  }

  socket.connect();
}

function joinSession() {
  socket.emit(
    "session:join",
    {
      clientId: state.clientId,
      pin: state.accessPin
    },
    (response) => {
      dom.pinButton.disabled = false;

      if (!response?.ok) {
        state.hasJoined = false;
        state.role = null;
        state.readOnly = false;
        state.connectedRoles = [];
        clearStoredPin();

        if (response?.pinRequired) {
          state.pinRequired = true;
          state.accessPin = "";
          dom.pinInput.value = "";
        }

        renderAuthGate();
        renderRole();
        renderPresence();
        applyReadonlyState();
        updateConnectionStatus(
          false,
          response?.pinRequired ? "Our secret PIN is needed" : "Couldn't enter our space"
        );
        setAuthError(response?.error || "I couldn't open our little space.");
        dom.pinInput.focus();
      }
    }
  );
}

function submitAccessPin() {
  clearAuthError();

  const pin = dom.pinInput.value.trim();
  if (!pin) {
    setAuthError("Enter our secret PIN first.");
    return;
  }

  state.accessPin = pin;
  dom.pinButton.disabled = true;
  updateConnectionStatus(false, "Wrapping this space around us...");
  connectSocket();
}

function loadStoredPin() {
  return window.localStorage.getItem(PIN_STORAGE_KEY) || "";
}

function storeAccessPin(pin) {
  window.localStorage.setItem(PIN_STORAGE_KEY, pin);
}

function clearStoredPin() {
  window.localStorage.removeItem(PIN_STORAGE_KEY);
}

function renderAuthGate() {
  const shouldShow = state.pinRequired && !state.hasJoined;
  dom.authPanel.classList.toggle("hidden", !shouldShow);
  dom.appShell.classList.toggle("locked", shouldShow);
  dom.pinInput.value = shouldShow ? state.accessPin : "";
}

function getOrCreateClientId() {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  window.localStorage.setItem(STORAGE_KEY, nextId);
  return nextId;
}

function sanitizeMessage(message) {
  return {
    id: typeof message?.id === "string" ? message.id : `message-${Date.now()}`,
    sender: ROLE_ORDER.includes(message?.sender) ? message.sender : "Me",
    text: typeof message?.text === "string" ? message.text.trim() : "",
    createdAt: typeof message?.createdAt === "string" ? message.createdAt : new Date().toISOString()
  };
}

function sanitizeVideoPayload(video) {
  const currentTime = Number(video?.currentTime);

  return {
    url: typeof video?.url === "string" ? video.url : "",
    videoId: extractVideoId(video?.videoId || video?.url || ""),
    currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
    isPlaying: Boolean(video?.isPlaying),
    updatedAt: typeof video?.updatedAt === "string" ? video.updatedAt : null,
    changedBy: ROLE_ORDER.includes(video?.changedBy) ? video.changedBy : null,
    action: typeof video?.action === "string" ? video.action : null
  };
}

function renderRole() {
  if (state.pinRequired && !state.hasJoined) {
    dom.roleBadge.textContent = "Just-us mode locked";
    return;
  }

  if (state.readOnly || !state.role) {
    dom.roleBadge.textContent = "Soft guest mode";
    return;
  }

  dom.roleBadge.textContent = `Here as ${state.role}`;
}

function renderPresence() {
  const fragment = document.createDocumentFragment();

  ROLE_ORDER.forEach((role) => {
    const info =
      state.connectedRoles.find((item) => item.role === role) || { role, online: false };
    const chip = document.createElement("div");
    chip.className = `presence-chip ${info.online ? "online" : "offline"}`;
    chip.textContent = info.online ? `${role} is here with you` : `${role} is away for a bit`;
    fragment.appendChild(chip);
  });

  dom.presenceStrip.replaceChildren(fragment);
}

function renderMessages() {
  dom.messages.innerHTML = "";

  if (state.messages.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "message other";
    emptyState.dataset.emptyState = "true";
    emptyState.innerHTML = `
      <div class="message-meta">Words of Affirmation</div>
      <div class="message-bubble">Your sweet little notes will start collecting here as soon as one of you says something lovely.</div>
    `;
    dom.messages.appendChild(emptyState);
    return;
  }

  state.messages.forEach((message) => appendMessage(message, false));
  scrollMessagesToBottom();
}

function appendMessage(rawMessage, shouldScroll) {
  const message = sanitizeMessage(rawMessage);

  if (!message.text) {
    return;
  }

  const emptyState = dom.messages.querySelector('[data-empty-state="true"]');
  if (emptyState) {
    emptyState.remove();
  }

  const messageElement = document.createElement("article");
  messageElement.className = `message ${message.sender === state.role ? "own" : "other"}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.sender} · ${formatTimestamp(message.createdAt)}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.text;

  messageElement.append(meta, bubble);
  dom.messages.appendChild(messageElement);

  if (shouldScroll) {
    scrollMessagesToBottom();
  }
}

function scrollMessagesToBottom() {
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function sendMessage() {
  clearChatError();

  if (state.readOnly) {
    setChatError("This browser can only look on softly right now because both places are already paired.");
    return;
  }

  const text = dom.messageInput.value.trim();
  if (!text) {
    setChatError("Write a little love note before sending it.");
    return;
  }

  dom.sendButton.disabled = true;

  socket.emit("chat:send", { text }, (response) => {
    dom.sendButton.disabled = false;

    if (!response?.ok) {
      setChatError(response?.error || "Your note couldn't be sent right now.");
      return;
    }

    dom.messageInput.value = "";
    dom.messageInput.focus();
  });
}

function changeVideo() {
  clearVideoError();

  if (state.readOnly) {
    setVideoError("This browser can only watch right now because both places are already paired.");
    return;
  }

  const url = dom.videoUrlInput.value.trim();
  if (!url) {
    setVideoError("Paste our YouTube link first.");
    return;
  }

  dom.videoButton.disabled = true;

  socket.emit("video:change", { url }, (response) => {
    dom.videoButton.disabled = false;

    if (!response?.ok) {
      setVideoError(response?.error || "Our video couldn't be loaded just yet.");
      return;
    }

    dom.videoUrlInput.value = "";
    showToast("Our movie is ready for both of us.");
  });
}

function updateConnectionStatus(isOnline, fallbackText) {
  dom.connectionStatus.classList.remove("status-pill-online", "status-pill-offline");

  if (isOnline) {
    dom.connectionStatus.textContent = "Together live";
    dom.connectionStatus.classList.add("status-pill-online");
    return;
  }

  dom.connectionStatus.textContent = fallbackText || "Away for a moment";
  dom.connectionStatus.classList.add("status-pill-offline");
}

function updateVideoDetails() {
  const hasVideo = Boolean(state.video.videoId);

  dom.savedProgress.textContent = formatDuration(state.video.currentTime || 0);
  dom.currentVideoLink.textContent = hasVideo
    ? state.video.url
    : "Our next little watch date is waiting";
  dom.currentVideoLink.href = hasVideo ? state.video.url : "#";
  dom.currentVideoLink.setAttribute("aria-disabled", String(!hasVideo));
  dom.lastUpdated.textContent = hasVideo
    ? `${state.video.changedBy || "Someone sweet"} changed it ${formatTimestamp(state.video.updatedAt)}`
    : "Waiting for our next watch-together moment...";

  dom.playerPlaceholder.classList.toggle("hidden", hasVideo);
}

function applyReadonlyState() {
  const disabled = state.readOnly || (state.pinRequired && !state.hasJoined);

  dom.messageInput.disabled = disabled;
  dom.sendButton.disabled = disabled;
  dom.videoUrlInput.disabled = disabled;
  dom.videoButton.disabled = disabled;

  if (state.readOnly && state.hasJoined) {
    showToast("Both places are already paired, so this browser can only watch along.");
  }
}

function loadYouTubeApi() {
  if (document.querySelector('script[data-youtube-api="true"]')) {
    return;
  }

  const script = document.createElement("script");
  script.src = "https://www.youtube.com/iframe_api";
  script.async = true;
  script.dataset.youtubeApi = "true";
  document.head.appendChild(script);

  window.onYouTubeIframeAPIReady = () => {
    state.youtubeReady = true;
    if (state.video.videoId) {
      void applyVideoState(state.video, { forceLoad: true });
    }
  };
}

async function ensurePlayer(videoId) {
  if (!videoId) {
    return null;
  }

  await waitForYouTubeApi();

  if (state.player) {
    return state.player;
  }

  state.player = new YT.Player("player", {
    videoId,
    playerVars: {
      autoplay: 0,
      controls: 1,
      playsinline: 1,
      rel: 0,
      origin: window.location.origin
    },
    events: {
      onReady: () => {
        state.playerReady = true;
        beginWatchingPlayer();
      },
      onStateChange: handlePlayerStateChange,
      onError: handlePlayerError
    }
  });

  return new Promise((resolve) => {
    const resolvePlayer = () => {
      if (state.playerReady) {
        resolve(state.player);
      } else {
        window.setTimeout(resolvePlayer, 120);
      }
    };

    resolvePlayer();
  });
}

function waitForYouTubeApi() {
  if (state.youtubeReady && window.YT?.Player) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const waitLoop = () => {
      if (state.youtubeReady && window.YT?.Player) {
        resolve();
        return;
      }

      window.setTimeout(waitLoop, 120);
    };

    waitLoop();
  });
}

async function applyVideoState(video, options = {}) {
  const cleanVideo = sanitizeVideoPayload(video);
  state.video = cleanVideo;
  updateVideoDetails();

  if (!cleanVideo.videoId) {
    return;
  }

  const player = await ensurePlayer(cleanVideo.videoId);
  if (!player) {
    return;
  }

  const playerState = safePlayerState();
  const currentPlayerVideoId =
    typeof player.getVideoData === "function" ? player.getVideoData().video_id : "";
  const shouldLoadNewVideo = options.forceLoad || currentPlayerVideoId !== cleanVideo.videoId;
  const shouldSeek = Math.abs(safePlayerTime() - cleanVideo.currentTime) > 1.4;

  guardPlayerEvents();
  state.lastPlaybackSample = null;

  if (shouldLoadNewVideo) {
    if (cleanVideo.isPlaying) {
      player.loadVideoById({
        videoId: cleanVideo.videoId,
        startSeconds: cleanVideo.currentTime || 0
      });
    } else {
      player.cueVideoById({
        videoId: cleanVideo.videoId,
        startSeconds: cleanVideo.currentTime || 0
      });
    }
    return;
  }

  if (shouldSeek) {
    player.seekTo(cleanVideo.currentTime || 0, true);
  }

  if (cleanVideo.isPlaying && playerState !== YT.PlayerState.PLAYING) {
    player.playVideo();
  }

  if (!cleanVideo.isPlaying && playerState === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  }
}

function beginWatchingPlayer() {
  if (state.watchTimer) {
    return;
  }

  state.watchTimer = window.setInterval(() => {
    if (!state.playerReady || !state.video.videoId || Date.now() < state.suppressPlayerEventsUntil) {
      return;
    }

    const currentTime = safePlayerTime();
    const playerState = safePlayerState();
    const isPlaying = playerState === YT.PlayerState.PLAYING;
    const now = Date.now();

    if (state.lastPlaybackSample) {
      const elapsedSeconds = (now - state.lastPlaybackSample.timestamp) / 1000;
      const expectedDelta = state.lastPlaybackSample.isPlaying ? elapsedSeconds : 0;
      const actualDelta = currentTime - state.lastPlaybackSample.time;
      const drift = Math.abs(actualDelta - expectedDelta);

      if (drift > SEEK_DRIFT_SECONDS && now - state.lastSeekSentAt > SEEK_COOLDOWN_MS) {
        emitVideoSync("seek", currentTime, isPlaying);
        state.lastSeekSentAt = now;
      }
    }

    if (now - state.lastProgressSentAt >= PROGRESS_INTERVAL_MS) {
      socket.emit("video:progress", {
        videoId: state.video.videoId,
        currentTime,
        isPlaying
      });
      state.lastProgressSentAt = now;
    }

    state.lastPlaybackSample = {
      time: currentTime,
      timestamp: now,
      isPlaying
    };

    dom.savedProgress.textContent = formatDuration(currentTime);
  }, WATCHER_INTERVAL_MS);
}

function handlePlayerStateChange(event) {
  if (!state.playerReady || !state.video.videoId || Date.now() < state.suppressPlayerEventsUntil) {
    return;
  }

  if (state.readOnly) {
    guardPlayerEvents();
    if (event.data === YT.PlayerState.PLAYING) {
      state.player.pauseVideo();
    }
    return;
  }

  if (event.data === YT.PlayerState.PLAYING) {
    emitVideoSync("play", safePlayerTime(), true);
  }

  if (event.data === YT.PlayerState.PAUSED) {
    emitVideoSync("pause", safePlayerTime(), false);
  }

  if (event.data === YT.PlayerState.ENDED) {
    emitVideoSync("pause", safePlayerTime(), false);
  }
}

function handlePlayerError(event) {
  const messages = {
    2: "That YouTube link doesn't look quite right.",
    5: "This browser couldn't play our video.",
    100: "That video isn't available anymore.",
    101: "This video can't be embedded here.",
    150: "This video can't be embedded here."
  };

  setVideoError(messages[event.data] || "Our video couldn't be played right now.");
}

function emitVideoSync(action, currentTime, isPlaying) {
  if (state.readOnly || !state.video.videoId) {
    return;
  }

  const roundedTime = Math.round(currentTime * 10) / 10;
  const signature = `${action}:${roundedTime}:${isPlaying}`;

  if (signature === state.lastCommandSignature) {
    return;
  }

  state.lastCommandSignature = signature;
  state.video.currentTime = roundedTime;
  state.video.isPlaying = isPlaying;
  updateVideoDetails();

  socket.emit("video:sync", {
    action,
    videoId: state.video.videoId,
    currentTime: roundedTime,
    isPlaying
  });

  window.setTimeout(() => {
    if (state.lastCommandSignature === signature) {
      state.lastCommandSignature = "";
    }
  }, 600);
}

function guardPlayerEvents() {
  state.suppressPlayerEventsUntil = Date.now() + REMOTE_GUARD_MS;
}

function safePlayerTime() {
  if (!state.playerReady || !state.player || typeof state.player.getCurrentTime !== "function") {
    return state.video.currentTime || 0;
  }

  const time = state.player.getCurrentTime();
  return Number.isFinite(time) && time >= 0 ? time : 0;
}

function safePlayerState() {
  if (!state.playerReady || !state.player || typeof state.player.getPlayerState !== "function") {
    return -1;
  }

  return state.player.getPlayerState();
}

function setAuthError(message) {
  dom.authError.textContent = message;
}

function clearAuthError() {
  dom.authError.textContent = "";
}

function setChatError(message) {
  dom.chatError.textContent = message;
}

function clearChatError() {
  dom.chatError.textContent = "";
}

function setVideoError(message) {
  dom.videoError.textContent = message;
}

function clearVideoError() {
  dom.videoError.textContent = "";
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.pendingInstallPrompt = event;
    dom.installButton.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    state.pendingInstallPrompt = null;
    dom.installButton.classList.add("hidden");
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch (error) {
      console.error("Service worker registration failed.", error);
    }
  });
}

function showToast(message) {
  dom.toast.hidden = false;
  dom.toast.textContent = message;

  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, 2800);
}

function extractVideoId(input) {
  if (typeof input !== "string") {
    return "";
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const normalized =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    const parsedUrl = new URL(normalized);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");

    if (hostname === "youtu.be") {
      return parsedUrl.pathname.split("/").filter(Boolean)[0] || "";
    }

    if (parsedUrl.searchParams.get("v")) {
      return parsedUrl.searchParams.get("v") || "";
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments[0] === "shorts" || segments[0] === "embed") {
      return segments[1] || "";
    }
  } catch {
    return "";
  }

  return "";
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimestamp(isoValue) {
  if (!isoValue) {
    return "just now";
  }

  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return "just now";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(parsed);
}
