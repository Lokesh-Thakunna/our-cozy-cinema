const ROLE_ORDER = ["Me", "My Love"];
const STORAGE_KEY = "love-sync-client-id";
const PIN_STORAGE_KEY = "love-sync-access-pin";
const SEEK_DRIFT_SECONDS = 2.6;
const SEEK_COOLDOWN_MS = 1800;
const REMOTE_GUARD_MS = 1500;
const PROGRESS_INTERVAL_MS = 5000;
const WATCHER_INTERVAL_MS = 1000;
const LOCATION_WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 10000,
  timeout: 15000
};

function emptyLocationState(changedBy = null, updatedAt = null) {
  return {
    isSharing: false,
    latitude: null,
    longitude: null,
    accuracy: null,
    updatedAt,
    changedBy
  };
}

function emptyLocationMap() {
  return Object.fromEntries(ROLE_ORDER.map((role) => [role, emptyLocationState(role)]));
}

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
  shareLocationButton: document.getElementById("shareLocationButton"),
  stopLocationButton: document.getElementById("stopLocationButton"),
  yourLocationStatus: document.getElementById("yourLocationStatus"),
  yourLocationSummary: document.getElementById("yourLocationSummary"),
  yourLocationLink: document.getElementById("yourLocationLink"),
  partnerLocationStatus: document.getElementById("partnerLocationStatus"),
  partnerLocationSummary: document.getElementById("partnerLocationSummary"),
  partnerLocationLink: document.getElementById("partnerLocationLink"),
  locationError: document.getElementById("locationError"),
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
  locations: emptyLocationMap(),
  player: null,
  playerReady: false,
  youtubeReady: false,
  pendingInstallPrompt: null,
  suppressPlayerEventsUntil: 0,
  lastPlaybackSample: null,
  lastSeekSentAt: 0,
  lastProgressSentAt: 0,
  watchTimer: null,
  lastCommandSignature: "",
  locationWatchId: null,
  latestPosition: null
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
renderLocation();
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
  state.locations = sanitizeLocationsPayload(payload.locations);

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
  renderLocation();
  applyReadonlyState();

  if (state.locationWatchId !== null && state.latestPosition && !state.readOnly) {
    sharePosition(state.latestPosition, { quiet: true });
  }

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

socket.on("location:updated", (payload) => {
  state.locations = sanitizeLocationsPayload(payload);
  renderLocation();
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

  dom.shareLocationButton.addEventListener("click", () => {
    void startLocationSharing();
  });

  dom.stopLocationButton.addEventListener("click", () => {
    stopLocationSharing();
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

function sanitizeLocationPayload(location, roleOverride = null) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  const accuracy = Number(location?.accuracy);
  const hasValidCoordinates =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  return {
    isSharing: Boolean(location?.isSharing) && hasValidCoordinates,
    latitude: hasValidCoordinates ? latitude : null,
    longitude: hasValidCoordinates ? longitude : null,
    accuracy: hasValidCoordinates && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
    updatedAt: typeof location?.updatedAt === "string" ? location.updatedAt : null,
    changedBy:
      ROLE_ORDER.includes(roleOverride) ? roleOverride : ROLE_ORDER.includes(location?.changedBy) ? location.changedBy : null
  };
}

function sanitizeLocationsPayload(locations) {
  const normalized = emptyLocationMap();

  for (const role of ROLE_ORDER) {
    normalized[role] = sanitizeLocationPayload(locations?.[role], role);
  }

  return normalized;
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

function renderLocation() {
  const otherRole =
    ROLE_ORDER.find((role) => role !== state.role) || (state.role === "My Love" ? "Me" : "My Love");
  const myCoordinates =
    state.role && state.locations[state.role]?.isSharing ? state.locations[state.role] : null;
  const partnerCoordinates = state.locations[otherRole]?.isSharing ? state.locations[otherRole] : null;
  const locationControlsDisabled = state.readOnly || (state.pinRequired && !state.hasJoined);

  dom.shareLocationButton.disabled = locationControlsDisabled || state.locationWatchId !== null;
  dom.stopLocationButton.disabled = locationControlsDisabled || state.locationWatchId === null;

  if (myCoordinates) {
    dom.yourLocationStatus.textContent = "Sharing your live location";
    dom.yourLocationSummary.textContent = `Updated ${formatTimestamp(myCoordinates.updatedAt)}${formatAccuracy(myCoordinates.accuracy)}.`;
    setLocationLink(dom.yourLocationLink, myCoordinates.latitude, myCoordinates.longitude, "Open your live pin");
  } else if (state.locationWatchId !== null) {
    dom.yourLocationStatus.textContent = "Finding your live pin";
    dom.yourLocationSummary.textContent = "Stay on this page for a moment while your location warms up.";
    setLocationLink(dom.yourLocationLink, null, null, "Open your live pin");
  } else {
    dom.yourLocationStatus.textContent = "Not sharing right now";
    dom.yourLocationSummary.textContent = "Turn it on whenever you want your person to know where you are.";
    setLocationLink(dom.yourLocationLink, null, null, "Open your live pin");
  }

  if (partnerCoordinates) {
    dom.partnerLocationStatus.textContent = `${otherRole} is sharing live`;
    dom.partnerLocationSummary.textContent = `Updated ${formatTimestamp(partnerCoordinates.updatedAt)}${formatAccuracy(partnerCoordinates.accuracy)}.`;
    setLocationLink(
      dom.partnerLocationLink,
      partnerCoordinates.latitude,
      partnerCoordinates.longitude,
      `Open ${otherRole}'s live pin`
    );
  } else {
    dom.partnerLocationStatus.textContent = "Waiting for a shared pin";
    dom.partnerLocationSummary.textContent = "If your person shares their live location, it will appear here.";
    setLocationLink(dom.partnerLocationLink, null, null, "Open their live pin");
  }
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
  meta.textContent = `${message.sender} - ${formatTimestamp(message.createdAt)}`;

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

async function startLocationSharing() {
  clearLocationError();

  if (state.readOnly) {
    setLocationError("This browser can only look on softly right now because both places are already paired.");
    return;
  }

  if (!("geolocation" in navigator)) {
    setLocationError("This browser does not support live location sharing.");
    return;
  }

  if (state.locationWatchId !== null) {
    showToast("Your live pin is already being shared.");
    return;
  }

  dom.shareLocationButton.disabled = true;
  dom.yourLocationStatus.textContent = "Finding your live pin";
  dom.yourLocationSummary.textContent = "Stay on this page for a moment while your location warms up.";

  state.locationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      state.latestPosition = position;
      sharePosition(position);
    },
    (error) => {
      stopLocationSharing({ quiet: true });
      setLocationError(mapLocationError(error));
    },
    LOCATION_WATCH_OPTIONS
  );

  renderLocation();
}

function stopLocationSharing(options = {}) {
  const { skipServer = false, quiet = false } = options;
  const shouldEmitStop =
    !skipServer &&
    state.hasJoined &&
    !state.readOnly &&
    (state.locationWatchId !== null ||
      (state.role && state.locations[state.role]?.isSharing));

  if (state.locationWatchId !== null) {
    navigator.geolocation.clearWatch(state.locationWatchId);
    state.locationWatchId = null;
  }

  if (state.role) {
    state.locations[state.role] = sanitizeLocationPayload({
      isSharing: false,
      updatedAt: new Date().toISOString(),
      changedBy: state.role
    }, state.role);
  }

  renderLocation();

  if (shouldEmitStop) {
    socket.emit("location:update", { isSharing: false }, (response) => {
      if (!response?.ok) {
        setLocationError(response?.error || "I couldn't stop the live location right now.");
        return;
      }

      if (!quiet) {
        showToast("Your live pin is private again.");
      }
    });
    return;
  }

  if (!quiet) {
    showToast("Your live pin is private again.");
  }
}

function sharePosition(position, options = {}) {
  const { quiet = false } = options;
  const payload = {
    isSharing: true,
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy
  };
  const wasAlreadySharing = Boolean(state.role && state.locations[state.role]?.isSharing);

  if (state.role) {
    state.locations[state.role] = sanitizeLocationPayload({
      ...payload,
      updatedAt: new Date().toISOString(),
      changedBy: state.role
    }, state.role);
  }
  renderLocation();
  clearLocationError();

  socket.emit("location:update", payload, (response) => {
    if (!response?.ok) {
      setLocationError(response?.error || "I couldn't update your live pin right now.");
      return;
    }

    state.locations = sanitizeLocationsPayload(response.location);
    renderLocation();

    if (!quiet && !wasAlreadySharing) {
      showToast("Your live pin is now being shared.");
    }
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
  dom.shareLocationButton.disabled = disabled;
  dom.stopLocationButton.disabled = disabled || state.locationWatchId === null;

  if (state.readOnly && state.hasJoined) {
    showToast("Both places are already paired, so this browser can only watch along.");
  }

  renderLocation();
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

function setLocationError(message) {
  dom.locationError.textContent = message;
}

function clearLocationError() {
  dom.locationError.textContent = "";
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
      let hasRefreshedForNewWorker = false;
      const activateWaitingWorker = (worker) => {
        if (worker) {
          worker.postMessage({ type: "SKIP_WAITING" });
        }
      };

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (hasRefreshedForNewWorker) {
          return;
        }

        hasRefreshedForNewWorker = true;
        window.location.reload();
      });

      const registration = await navigator.serviceWorker.register("/sw.js");
      await registration.update();

      if (registration.waiting) {
        activateWaitingWorker(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installingWorker = registration.installing;
        if (!installingWorker) {
          return;
        }

        installingWorker.addEventListener("statechange", () => {
          if (
            installingWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            activateWaitingWorker(installingWorker);
          }
        });
      });
    } catch (error) {
      console.error("Service worker registration failed.", error);
    }
  });
}

window.addEventListener("beforeunload", () => {
  if (state.locationWatchId !== null) {
    navigator.geolocation.clearWatch(state.locationWatchId);
  }
});

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

function setLocationLink(linkElement, latitude, longitude, label) {
  linkElement.textContent = label;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    linkElement.classList.add("hidden");
    linkElement.href = "#";
    return;
  }

  linkElement.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
  linkElement.classList.remove("hidden");
}

function mapLocationError(error) {
  if (!error || typeof error.code !== "number") {
    return "I couldn't read your live location right now.";
  }

  if (error.code === 1) {
    return "Location permission was denied, so I could not share your live pin.";
  }

  if (error.code === 2) {
    return "Your location is unavailable right now. Try again in a moment.";
  }

  if (error.code === 3) {
    return "Location lookup took too long. Try again where your signal is a little stronger.";
  }

  return "I couldn't read your live location right now.";
}

function formatAccuracy(accuracy) {
  if (!Number.isFinite(accuracy) || accuracy <= 0) {
    return "";
  }

  return ` with about ${Math.round(accuracy)}m accuracy`;
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
