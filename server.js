const compression = require("compression");
const express = require("express");
const helmet = require("helmet");
const http = require("http");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Server } = require("socket.io");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const COUPLE_PIN = typeof process.env.COUPLE_PIN === "string" ? process.env.COUPLE_PIN.trim() : "";
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const APP_ROOT = __dirname;
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const STORAGE_DIR = path.join(APP_ROOT, "storage");
const STATE_FILE = path.join(STORAGE_DIR, "state.json");
const ROLE_NAMES = ["Me", "My Love"];
const MAX_MESSAGES = 500;
const STALE_ROLE_MS = 1000 * 60 * 60 * 24 * 14;
const AUTH_WINDOW_MS = 1000 * 60 * 10;
const AUTH_LOCKOUT_MS = 1000 * 60 * 10;
const MAX_FAILED_PIN_ATTEMPTS = 8;
const NO_STORE_EXTENSIONS = new Set([".html", ".css", ".js", ".webmanifest"]);

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
  return Object.fromEntries(ROLE_NAMES.map((role) => [role, emptyLocationState()]));
}

const defaultState = {
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
  clients: {}
};

let appState = structuredClone(defaultState);
let saveQueue = Promise.resolve();
const connectedSockets = new Map();
const failedPinAttempts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sanitizeMessageText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\r\n/g, "\n").trim();
}

function sanitizePin(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function clampNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function clampNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseYouTubeVideoId(input) {
  if (typeof input !== "string") {
    return null;
  }

  const rawValue = input.trim();
  if (!rawValue) {
    return null;
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(rawValue)) {
    return rawValue;
  }

  const normalizedValue =
    rawValue.startsWith("http://") || rawValue.startsWith("https://")
      ? rawValue
      : `https://${rawValue}`;

  try {
    const parsedUrl = new URL(normalizedValue);
    const hostname = parsedUrl.hostname.replace(/^www\./, "");

    if (hostname === "youtu.be") {
      const shortId = parsedUrl.pathname.split("/").filter(Boolean)[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(shortId) ? shortId : null;
    }

    const watchId = parsedUrl.searchParams.get("v");
    if (/^[a-zA-Z0-9_-]{11}$/.test(watchId || "")) {
      return watchId;
    }

    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
    const embeddedId =
      pathParts[0] === "embed" || pathParts[0] === "shorts" ? pathParts[1] : null;

    return /^[a-zA-Z0-9_-]{11}$/.test(embeddedId || "") ? embeddedId : null;
  } catch {
    return null;
  }
}

async function ensureStateFile() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

function normalizeState(rawState) {
  const messages = Array.isArray(rawState?.messages)
    ? rawState.messages
        .map((message) => ({
          id: typeof message?.id === "string" ? message.id : randomUUID(),
          sender: ROLE_NAMES.includes(message?.sender) ? message.sender : "Me",
          text: sanitizeMessageText(message?.text),
          createdAt:
            typeof message?.createdAt === "string" ? message.createdAt : nowIso()
        }))
        .filter((message) => message.text)
        .slice(-MAX_MESSAGES)
    : [];

  const videoId = parseYouTubeVideoId(rawState?.video?.url || rawState?.video?.videoId || "");

  const video = {
    url: videoId ? canonicalYouTubeUrl(videoId) : "",
    videoId: videoId || "",
    currentTime: clampNumber(rawState?.video?.currentTime, 0),
    isPlaying: Boolean(rawState?.video?.isPlaying),
    updatedAt:
      typeof rawState?.video?.updatedAt === "string" ? rawState.video.updatedAt : null,
    changedBy: ROLE_NAMES.includes(rawState?.video?.changedBy)
      ? rawState.video.changedBy
      : null
  };

  const normalizedLocations = emptyLocationMap();
  const rawLocations =
    rawState?.locations && typeof rawState.locations === "object"
      ? rawState.locations
      : rawState?.location && ROLE_NAMES.includes(rawState.location.changedBy)
        ? { [rawState.location.changedBy]: rawState.location }
        : {};

  for (const role of ROLE_NAMES) {
    const rawLocation = rawLocations?.[role];
    const latitude = clampNullableNumber(rawLocation?.latitude);
    const longitude = clampNullableNumber(rawLocation?.longitude);
    const accuracy = clampNullableNumber(rawLocation?.accuracy);
    const hasValidCoordinates =
      latitude !== null &&
      longitude !== null &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180;

    normalizedLocations[role] = {
      isSharing: Boolean(rawLocation?.isSharing) && hasValidCoordinates,
      latitude: hasValidCoordinates ? latitude : null,
      longitude: hasValidCoordinates ? longitude : null,
      accuracy: hasValidCoordinates && accuracy !== null && accuracy >= 0 ? accuracy : null,
      updatedAt:
        typeof rawLocation?.updatedAt === "string" ? rawLocation.updatedAt : null,
      changedBy: role
    };
  }

  const clients = {};
  const rawClients = rawState?.clients && typeof rawState.clients === "object" ? rawState.clients : {};

  for (const [clientId, details] of Object.entries(rawClients)) {
    if (!clientId || typeof clientId !== "string" || !ROLE_NAMES.includes(details?.role)) {
      continue;
    }

    clients[clientId] = {
      role: details.role,
      lastSeen: typeof details.lastSeen === "string" ? details.lastSeen : nowIso()
    };
  }

  return {
    messages,
    video,
    locations: normalizedLocations,
    clients
  };
}

async function loadState() {
  await ensureStateFile();

  try {
    const rawContents = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(rawContents);
    appState = normalizeState(parsed);
  } catch (error) {
    console.error("Failed to load app state, resetting to defaults.", error);
    appState = structuredClone(defaultState);
    await queueStateSave();
  }
}

function queueStateSave() {
  const snapshot = JSON.stringify(appState, null, 2);

  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      const tempFile = `${STATE_FILE}.tmp`;
      await fs.writeFile(tempFile, snapshot, "utf8");
      await fs.rename(tempFile, STATE_FILE);
    })
    .catch((error) => {
      console.error("Failed to persist app state.", error);
    });

  return saveQueue;
}

function getConnectedRoles() {
  const roles = new Set();

  for (const socketInfo of connectedSockets.values()) {
    if (socketInfo.role) {
      roles.add(socketInfo.role);
    }
  }

  return ROLE_NAMES.map((role) => ({
    role,
    online: roles.has(role)
  }));
}

function isRoleConnected(role) {
  if (!role) {
    return false;
  }

  return Array.from(connectedSockets.values()).some((socketInfo) => socketInfo.role === role);
}

function releaseDuplicateRoleBindings(role, keepClientId) {
  for (const [clientId, details] of Object.entries(appState.clients)) {
    if (clientId !== keepClientId && details.role === role) {
      delete appState.clients[clientId];
    }
  }
}

function assignRole(clientId) {
  if (!clientId) {
    return { role: null, readOnly: true };
  }

  const existing = appState.clients[clientId];
  if (existing && ROLE_NAMES.includes(existing.role)) {
    existing.lastSeen = nowIso();
    releaseDuplicateRoleBindings(existing.role, clientId);
    return { role: existing.role, readOnly: false };
  }

  const usedRoles = new Set(Object.values(appState.clients).map((client) => client.role));
  const openRole = ROLE_NAMES.find((role) => !usedRoles.has(role));

  if (openRole) {
    appState.clients[clientId] = {
      role: openRole,
      lastSeen: nowIso()
    };
    releaseDuplicateRoleBindings(openRole, clientId);
    return { role: openRole, readOnly: false };
  }

  const inactiveCandidates = Object.entries(appState.clients)
    .filter(([storedClientId, details]) => {
      const lastSeenMs = Number(new Date(details.lastSeen));
      const roleIsConnected = Array.from(connectedSockets.values()).some(
        (socketInfo) => socketInfo.role === details.role
      );

      return (
        storedClientId !== clientId &&
        !roleIsConnected &&
        Number.isFinite(lastSeenMs) &&
        Date.now() - lastSeenMs > STALE_ROLE_MS
      );
    })
    .sort((first, second) => {
      const firstSeen = Number(new Date(first[1].lastSeen));
      const secondSeen = Number(new Date(second[1].lastSeen));
      return firstSeen - secondSeen;
    });

  if (inactiveCandidates.length > 0) {
    const [staleClientId, staleDetails] = inactiveCandidates[0];
    delete appState.clients[staleClientId];
    appState.clients[clientId] = {
      role: staleDetails.role,
      lastSeen: nowIso()
    };
    releaseDuplicateRoleBindings(staleDetails.role, clientId);
    return { role: staleDetails.role, readOnly: false };
  }

  return { role: null, readOnly: true };
}

function buildSessionPayload(role, readOnly) {
  return {
    role,
    readOnly,
    roles: ROLE_NAMES,
    connectedRoles: getConnectedRoles(),
    messages: appState.messages,
    video: appState.video,
    locations: appState.locations
  };
}

function buildVideoPayload() {
  return {
    url: appState.video.url,
    videoId: appState.video.videoId,
    currentTime: clampNumber(appState.video.currentTime, 0),
    isPlaying: Boolean(appState.video.isPlaying),
    updatedAt: appState.video.updatedAt,
    changedBy: appState.video.changedBy
  };
}

function buildLocationPayload() {
  return Object.fromEntries(
    ROLE_NAMES.map((role) => [
      role,
      {
        isSharing: Boolean(appState.locations[role]?.isSharing),
        latitude: appState.locations[role]?.latitude ?? null,
        longitude: appState.locations[role]?.longitude ?? null,
        accuracy: appState.locations[role]?.accuracy ?? null,
        updatedAt: appState.locations[role]?.updatedAt ?? null,
        changedBy: role
      }
    ])
  );
}

function canControl(socket) {
  return Boolean(socket?.data?.role) && !socket?.data?.readOnly;
}

function getSocketIp(socket) {
  const forwardedHeader = socket?.handshake?.headers?.["x-forwarded-for"];

  if (typeof forwardedHeader === "string" && forwardedHeader.trim()) {
    return forwardedHeader.split(",")[0].trim();
  }

  return socket?.handshake?.address || "unknown";
}

function validatePinAttempt(pin, socket) {
  if (!COUPLE_PIN) {
    return { ok: true };
  }

  const ipAddress = getSocketIp(socket);
  const currentTime = Date.now();
  const record = failedPinAttempts.get(ipAddress);

  if (record?.lockedUntil && currentTime < record.lockedUntil) {
    const remainingMinutes = Math.max(1, Math.ceil((record.lockedUntil - currentTime) / 60000));
    return {
      ok: false,
      error: `Too many wrong PIN tries. Come back in ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} and try again.`
    };
  }

  if (pin === COUPLE_PIN) {
    failedPinAttempts.delete(ipAddress);
    return { ok: true };
  }

  const recentAttempts = Array.isArray(record?.attempts)
    ? record.attempts.filter((attempt) => currentTime - attempt < AUTH_WINDOW_MS)
    : [];
  recentAttempts.push(currentTime);

  const nextRecord = {
    attempts: recentAttempts,
    lockedUntil: recentAttempts.length >= MAX_FAILED_PIN_ATTEMPTS ? currentTime + AUTH_LOCKOUT_MS : 0
  };

  failedPinAttempts.set(ipAddress, nextRecord);

  if (nextRecord.lockedUntil) {
    return {
      ok: false,
      error: "Too many wrong PIN tries. Our space is temporarily locked for 10 minutes."
    };
  }

  return {
    ok: false,
    error: "That secret PIN doesn't match."
  };
}

async function startServer() {
  await loadState();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: true,
      methods: ["GET", "POST"]
    }
  });

  app.disable("x-powered-by");
  if (TRUST_PROXY) {
    app.set("trust proxy", true);
  }
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    })
  );
  app.use(compression());
  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ["html"],
      maxAge: 0,
      setHeaders: (response, filePath) => {
        const extension = path.extname(filePath).toLowerCase();

        if (filePath.endsWith(`${path.sep}sw.js`) || NO_STORE_EXTENSIONS.has(extension)) {
          response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          response.setHeader("Pragma", "no-cache");
          response.setHeader("Expires", "0");
          return;
        }

        response.setHeader("Cache-Control", "public, max-age=86400");
      }
    })
  );

  app.get("/app-config", (_request, response) => {
    response.json({
      pinRequired: Boolean(COUPLE_PIN),
      roles: ROLE_NAMES
    });
  });

  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      uptime: process.uptime(),
      connected: getConnectedRoles(),
      savedMessages: appState.messages.length,
      pinProtected: Boolean(COUPLE_PIN),
      locationSharing: Object.values(appState.locations).some((location) => location.isSharing)
    });
  });

  io.on("connection", (socket) => {
    socket.data.role = null;
    socket.data.clientId = null;
    socket.data.readOnly = true;

    socket.on("session:join", async (payload = {}, acknowledge) => {
      try {
        const providedPin = sanitizePin(payload.pin);
        const pinValidation = validatePinAttempt(providedPin, socket);

        if (!pinValidation.ok) {
          if (typeof acknowledge === "function") {
            acknowledge({
              ok: false,
              error: pinValidation.error,
              pinRequired: Boolean(COUPLE_PIN)
            });
          }
          return;
        }

        const clientId =
          typeof payload.clientId === "string" && payload.clientId.trim()
            ? payload.clientId.trim()
            : null;

        const { role, readOnly } = assignRole(clientId);

        socket.data.role = role;
        socket.data.clientId = clientId;
        socket.data.readOnly = readOnly;

        if (clientId) {
          connectedSockets.set(socket.id, {
            clientId,
            role
          });
        }

        if (clientId && role) {
          appState.clients[clientId] = {
            role,
            lastSeen: nowIso()
          };
          await queueStateSave();
        }

        socket.emit("session:state", buildSessionPayload(role, readOnly));
        io.emit("presence:update", getConnectedRoles());

        if (typeof acknowledge === "function") {
          acknowledge({ ok: true, role, readOnly });
        }
      } catch (error) {
        console.error("Failed during session join.", error);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: "I couldn't open our space right now." });
        }
      }
    });

    socket.on("chat:send", async (payload = {}, acknowledge) => {
      try {
        if (!canControl(socket)) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "Only your paired devices can send love notes from here." });
          }
          return;
        }

        const text = sanitizeMessageText(payload.text);
        if (!text) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "Your love note can't be empty." });
          }
          return;
        }

        if (text.length > 1000) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "That love note is a little too long." });
          }
          return;
        }

        const message = {
          id: randomUUID(),
          sender: socket.data.role,
          text,
          createdAt: nowIso()
        };

        appState.messages.push(message);
        appState.messages = appState.messages.slice(-MAX_MESSAGES);
        await queueStateSave();

        io.emit("chat:new", message);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: true, message });
        }
      } catch (error) {
        console.error("Failed to save chat message.", error);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: "Your love note couldn't be saved." });
        }
      }
    });

    socket.on("video:change", async (payload = {}, acknowledge) => {
      try {
        if (!canControl(socket)) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "Only your paired devices can choose the video here." });
          }
          return;
        }

        const videoId = parseYouTubeVideoId(payload.url);
        if (!videoId) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "That doesn't look like a valid YouTube link." });
          }
          return;
        }

        appState.video = {
          url: canonicalYouTubeUrl(videoId),
          videoId,
          currentTime: 0,
          isPlaying: false,
          updatedAt: nowIso(),
          changedBy: socket.data.role
        };

        await queueStateSave();
        io.emit("video:changed", buildVideoPayload());

        if (typeof acknowledge === "function") {
          acknowledge({ ok: true, video: buildVideoPayload() });
        }
      } catch (error) {
        console.error("Failed to change the video.", error);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: "I couldn't update our video right now." });
        }
      }
    });

    socket.on("video:sync", async (payload = {}, acknowledge) => {
      try {
        if (!canControl(socket)) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "Only your paired devices can control playback here." });
          }
          return;
        }

        const action = payload.action;
        if (!["play", "pause", "seek"].includes(action)) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "That playback action isn't supported here." });
          }
          return;
        }

        const incomingVideoId = parseYouTubeVideoId(payload.videoId || appState.video.videoId || "");
        if (!incomingVideoId) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "Our video hasn't been loaded yet." });
          }
          return;
        }

        appState.video.videoId = incomingVideoId;
        appState.video.url = canonicalYouTubeUrl(incomingVideoId);
        appState.video.currentTime = clampNumber(payload.currentTime, appState.video.currentTime);
        appState.video.isPlaying =
          action === "play" ? true : action === "pause" ? false : Boolean(payload.isPlaying);
        appState.video.updatedAt = nowIso();
        appState.video.changedBy = socket.data.role;

        await queueStateSave();

        socket.broadcast.emit("video:synced", {
          action,
          ...buildVideoPayload()
        });

        if (typeof acknowledge === "function") {
          acknowledge({ ok: true });
        }
      } catch (error) {
        console.error("Failed to sync video playback.", error);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: "I couldn't keep our playback in sync right now." });
        }
      }
    });

    socket.on("video:progress", async (payload = {}) => {
      try {
        if (!canControl(socket) || !appState.video.videoId) {
          return;
        }

        const incomingVideoId = parseYouTubeVideoId(payload.videoId || "");
        if (!incomingVideoId || incomingVideoId !== appState.video.videoId) {
          return;
        }

        appState.video.currentTime = clampNumber(payload.currentTime, appState.video.currentTime);
        appState.video.isPlaying = Boolean(payload.isPlaying);
        appState.video.updatedAt = nowIso();
        appState.video.changedBy = socket.data.role;

        await queueStateSave();
      } catch (error) {
        console.error("Failed to persist playback progress.", error);
      }
    });

    socket.on("location:update", async (payload = {}, acknowledge) => {
      try {
        if (!canControl(socket)) {
          if (typeof acknowledge === "function") {
            acknowledge({
              ok: false,
              error: "Only your paired devices can share live location from here."
            });
          }
          return;
        }

        if (!payload?.isSharing) {
          appState.locations[socket.data.role] = emptyLocationState(socket.data.role, nowIso());

          await queueStateSave();
          io.emit("location:updated", buildLocationPayload());

          if (typeof acknowledge === "function") {
            acknowledge({ ok: true, location: buildLocationPayload() });
          }
          return;
        }

        const latitude = clampNullableNumber(payload.latitude);
        const longitude = clampNullableNumber(payload.longitude);
        const accuracy = clampNullableNumber(payload.accuracy);
        const hasValidCoordinates =
          latitude !== null &&
          longitude !== null &&
          latitude >= -90 &&
          latitude <= 90 &&
          longitude >= -180 &&
          longitude <= 180;

        if (!hasValidCoordinates) {
          if (typeof acknowledge === "function") {
            acknowledge({ ok: false, error: "That live location update did not include valid coordinates." });
          }
          return;
        }

        appState.locations[socket.data.role] = {
          isSharing: true,
          latitude,
          longitude,
          accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
          updatedAt: nowIso(),
          changedBy: socket.data.role
        };

        await queueStateSave();
        io.emit("location:updated", buildLocationPayload());

        if (typeof acknowledge === "function") {
          acknowledge({ ok: true, location: buildLocationPayload() });
        }
      } catch (error) {
        console.error("Failed to update live location.", error);

        if (typeof acknowledge === "function") {
          acknowledge({ ok: false, error: "I couldn't update the live location right now." });
        }
      }
    });

    socket.on("disconnect", async () => {
      try {
        const clientId = socket.data.clientId;
        const role = socket.data.role;

        connectedSockets.delete(socket.id);

        if (clientId && role && appState.clients[clientId]) {
          appState.clients[clientId].lastSeen = nowIso();
          await queueStateSave();
        }

        if (
          role &&
          appState.locations[role]?.isSharing &&
          !isRoleConnected(role)
        ) {
          appState.locations[role] = emptyLocationState(role, nowIso());
          await queueStateSave();
          io.emit("location:updated", buildLocationPayload());
        }

        io.emit("presence:update", getConnectedRoles());
      } catch (error) {
        console.error("Failed during disconnect cleanup.", error);
      }
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Love sync app listening on http://0.0.0.0:${PORT}`);
    if (COUPLE_PIN) {
      console.log("Private PIN protection is enabled for remote access.");
    } else {
      console.warn("Warning: COUPLE_PIN is not set. Public deployment will not be protected.");
    }
  });
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

startServer().catch((error) => {
  console.error("Server failed to start.", error);
  process.exitCode = 1;
});
