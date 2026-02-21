/**
 * ╔══════════════════════════════════════════════════════╗
 * ║         SAFEZONE — BACKEND SERVER (Node.js)          ║
 * ║  Women Safety Automated Check-in & Rescue System     ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * FLOW:
 *  1. User registers + sets check-in interval (e.g. every 30 min)
 *  2. Server schedules timed notification → emits "checkin_ping" via WebSocket
 *  3. If user clicks OK  → reset, schedule next ping  ✅
 *  4. If grace period expires → IVR Call #1 (simulated)
 *  5. If Call #1 unanswered  → IVR Call #2 (15s gap)
 *  6. If Call #2 unanswered  → IVR Call #3 (15s gap)
 *  7. If ≥2 calls missed     → DISPATCH RESCUE TEAM + broadcast live location
 *
 * Tech: Express + Socket.IO + UUID
 * Run:  npm install && node server.js
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuid } = require("uuid");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
// Serve the frontend HTML directly from this directory
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "safezone-fronend-server.html"));
});

// ─── In-Memory Store ────────────────────────────────────────────────────────
// sessions: Map<userId, SessionObject>
const sessions = new Map();
// timers:   Map<userId, { key: timeoutId }>
const timers = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Cancel all active timers for a user */
function clearTimers(userId, ...keys) {
  const t = timers.get(userId) || {};
  (keys.length ? keys : Object.keys(t)).forEach(k => {
    if (t[k]) { clearTimeout(t[k]); clearInterval(t[k]); delete t[k]; }
  });
  timers.set(userId, t);
}

/** Emit a real-time event to the user's socket */
function emit(userId, event, data = {}) {
  const s = sessions.get(userId);
  if (s?.socketId) {
    io.to(s.socketId).emit(event, { ...data, ts: new Date().toISOString() });
  }
}

/** Add an entry to the user's activity log and push to frontend */
function addLog(userId, type, message, extra = {}) {
  const s = sessions.get(userId);
  if (!s) return;
  const entry = { id: uuid(), type, message, ts: new Date().toISOString(), ...extra };
  s.log.unshift(entry);
  if (s.log.length > 100) s.log.pop();
  emit(userId, "log_entry", entry);
  console.log(`[${userId}] [${type}] ${message}`);
}

// ─── Core Engine ────────────────────────────────────────────────────────────

/** Schedule the next check-in ping after the configured interval */
function scheduleNextCheckin(userId) {
  const s = sessions.get(userId);
  if (!s || !s.enabled) return;

  const delayMs = s.intervalMinutes * 60 * 1000;
  addLog(userId, "SCHEDULE", `Next check-in in ${s.intervalMinutes} min`);

  const t = setTimeout(() => triggerCheckin(userId), delayMs);
  timers.set(userId, { ...timers.get(userId), checkin: t });
}

/** Fire a check-in notification and start the grace countdown */
function triggerCheckin(userId) {
  const s = sessions.get(userId);
  if (!s || !s.enabled) return;

  s.currentCheckin = {
    id: uuid(),
    startedAt: new Date().toISOString(),
    responded: false,
    ivrRound: 0,
    missedCalls: 0,
  };
  s.stats.totalCheckins++;
  s.stats.pending++;

  addLog(userId, "CHECKIN", `Notification sent — user has ${s.graceSeconds}s to respond`);

  // Push notification to frontend
  emit(userId, "checkin_ping", {
    checkinId: s.currentCheckin.id,
    graceSeconds: s.graceSeconds,
    message: "Safety check-in! Tap I'M SAFE within the countdown.",
  });

  // Grace countdown: if no response → start IVR
  const grace = setTimeout(() => {
    const s2 = sessions.get(userId);
    if (!s2?.currentCheckin || s2.currentCheckin.responded) return;
    s2.stats.missedCheckins++;
    s2.stats.pending = Math.max(0, s2.stats.pending - 1);
    addLog(userId, "GRACE_EXPIRED", "Grace period elapsed — initiating IVR call sequence");
    emit(userId, "grace_expired", { checkinId: s2.currentCheckin.id });
    startIVR(userId, 1);
  }, s.graceSeconds * 1000);

  timers.set(userId, { ...timers.get(userId), grace });
}

/** Place IVR call number `n` (1, 2, or 3) */
function startIVR(userId, n) {
  const s = sessions.get(userId);
  if (!s || !s.currentCheckin || s.currentCheckin.responded) return;

  s.currentCheckin.ivrRound = n;
  addLog(userId, "IVR_CALL", `📞 IVR Call #${n} → ${s.phone}`, { callNumber: n });

  emit(userId, "ivr_call", {
    callNumber: n,
    phone: s.phone,
    ringSeconds: 15,
  });

  // Each call rings for 15 seconds
  const ringTimer = setTimeout(() => {
    const s2 = sessions.get(userId);
    if (!s2?.currentCheckin || s2.currentCheckin.responded) return;

    s2.currentCheckin.missedCalls++;
    addLog(userId, "IVR_MISSED", `📵 Call #${n} not answered (missed: ${s2.currentCheckin.missedCalls}/3)`, { callNumber: n, missedCalls: s2.currentCheckin.missedCalls });
    emit(userId, "ivr_missed", { callNumber: n, missedCalls: s2.currentCheckin.missedCalls });

    if (n < 3) {
      // Wait 10s before placing next call
      const gap = setTimeout(() => startIVR(userId, n + 1), 10000);
      timers.set(userId, { ...timers.get(userId), [`gap${n}`]: gap });
      addLog(userId, "IVR_GAP", `Waiting 10s before Call #${n + 1}…`);
      emit(userId, "ivr_gap", { nextCall: n + 1, gapSeconds: 10 });
    } else {
      // All 3 calls done — evaluate
      evaluateAndDispatch(userId);
    }
  }, 15000);

  timers.set(userId, { ...timers.get(userId), [`ivr${n}`]: ringTimer });
}

/** After all IVR calls: dispatch rescue if ≥2 missed */
function evaluateAndDispatch(userId) {
  const s = sessions.get(userId);
  if (!s?.currentCheckin) return;

  const missed = s.currentCheckin.missedCalls;
  addLog(userId, "EVALUATE", `${missed}/3 calls missed — evaluating rescue threshold`);
  emit(userId, "evaluate", { missed, threshold: 2 });

  if (missed >= 2) {
    dispatchRescue(userId);
  } else {
    addLog(userId, "RESUME", "Threshold not reached — monitoring resumed normally");
    emit(userId, "monitor_resumed", { message: "All ok. Monitoring resumes." });
    scheduleNextCheckin(userId);
  }
}

/** Dispatch rescue team + start live location broadcast */
function dispatchRescue(userId) {
  const s = sessions.get(userId);
  if (!s) return;

  const incident = {
    id: uuid(),
    userId,
    location: s.lastLocation,
    phone: s.phone,
    contacts: s.emergencyContacts,
    missedCalls: s.currentCheckin.missedCalls,
    dispatchedAt: new Date().toISOString(),
    status: "DISPATCHED",
    unit: {
      name: "Women Safety Squad — Alpha Unit",
      badge: "WSS-A-2024",
      eta: "4 minutes",
      distance: "1.1 km",
      contact: "100",
    },
  };

  s.stats.rescueDispatches++;
  s.activeIncident = incident;

  addLog(userId, "RESCUE", `🚨 RESCUE DISPATCHED → ${s.lastLocation.address}`, incident);
  emit(userId, "rescue_dispatched", { incident });

  // Notify all emergency contacts (simulated)
  s.emergencyContacts.forEach(c => {
    addLog(userId, "SMS_SENT", `📱 Alert SMS → ${c.name} (${c.phone})`);
    emit(userId, "sms_sent", { contact: c, location: s.lastLocation });
  });

  // Live location broadcast every 10s until resolved
  const broadcast = setInterval(() => {
    const s2 = sessions.get(userId);
    if (!s2?.activeIncident) { clearInterval(broadcast); return; }
    emit(userId, "location_broadcast", { location: s2.lastLocation, incidentId: incident.id });
  }, 10000);
  timers.set(userId, { ...timers.get(userId), broadcast });
}

// ─── REST API ────────────────────────────────────────────────────────────────

/** POST /api/register  — create or update a user session */
app.post("/api/register", (req, res) => {
  const { userId, name, phone, emergencyContacts, location } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const existing = sessions.get(userId) || {};
  sessions.set(userId, {
    ...existing,
    userId,
    name: name || existing.name || "User",
    phone: phone || existing.phone || "+91-0000000000",
    emergencyContacts: emergencyContacts || existing.emergencyContacts || [],
    enabled: existing.enabled || false,
    intervalMinutes: existing.intervalMinutes || 30,
    graceSeconds: existing.graceSeconds || 60,
    lastLocation: location || existing.lastLocation || { lat: 9.9312, lng: 76.2673, address: "Marine Drive, Ernakulam" },
    currentCheckin: null,
    activeIncident: null,
    log: existing.log || [],
    stats: existing.stats || { totalCheckins: 0, missedCheckins: 0, rescueDispatches: 0, pending: 0 },
    socketId: existing.socketId || null,
  });

  res.json({ success: true, session: safe(sessions.get(userId)) });
});

/** POST /api/checkin/enable */
app.post("/api/checkin/enable", (req, res) => {
  const { userId, intervalMinutes, graceSeconds } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found. Register first." });

  clearTimers(userId);
  s.enabled = true;
  s.intervalMinutes = intervalMinutes || s.intervalMinutes || 30;
  s.graceSeconds = graceSeconds || s.graceSeconds || 60;
  s.currentCheckin = null;
  s.activeIncident = null;

  addLog(userId, "ENABLED", `Monitor ON — interval: ${s.intervalMinutes}m, grace: ${s.graceSeconds}s`);
  emit(userId, "monitor_enabled", { intervalMinutes: s.intervalMinutes, graceSeconds: s.graceSeconds });
  scheduleNextCheckin(userId);

  res.json({ success: true, message: "Monitor enabled", session: safe(s) });
});

/** POST /api/checkin/disable */
app.post("/api/checkin/disable", (req, res) => {
  const { userId } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  clearTimers(userId);
  s.enabled = false;
  s.currentCheckin = null;
  s.activeIncident = null;

  addLog(userId, "DISABLED", "Monitor stopped by user");
  emit(userId, "monitor_disabled", {});
  res.json({ success: true });
});

/** POST /api/checkin/respond  — user tapped "I'm Safe" */
app.post("/api/checkin/respond", (req, res) => {
  const { userId, checkinId } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  const c = s.currentCheckin;
  if (!c || c.responded) return res.status(400).json({ error: "No active check-in" });
  if (c.id !== checkinId) return res.status(400).json({ error: "Check-in ID mismatch" });

  c.responded = true;
  c.respondedAt = new Date().toISOString();
  s.stats.pending = Math.max(0, s.stats.pending - 1);

  clearTimers(userId, "grace", "ivr1", "ivr2", "ivr3", "gap1", "gap2");
  addLog(userId, "RESPONDED", "✅ User confirmed safe via notification");
  emit(userId, "checkin_ok", { message: "Safety confirmed! Next check-in scheduled." });

  scheduleNextCheckin(userId);
  res.json({ success: true, message: "Safety confirmed. Next check-in scheduled." });
});

/** POST /api/ivr/respond  — user answered an IVR call */
app.post("/api/ivr/respond", (req, res) => {
  const { userId, callNumber } = req.body;
  const s = sessions.get(userId);
  if (!s?.currentCheckin) return res.status(404).json({ error: "No active check-in" });

  const c = s.currentCheckin;
  if (c.responded) return res.status(400).json({ error: "Already responded" });

  clearTimers(userId, `ivr${callNumber}`, `gap${callNumber}`, "gap1", "gap2");
  c.responded = true;
  c.respondedAt = new Date().toISOString();

  addLog(userId, "IVR_OK", `✅ User answered IVR Call #${callNumber} — confirmed safe`, { callNumber });
  emit(userId, "ivr_answered", { callNumber, message: "Call answered — you are confirmed safe!" });

  scheduleNextCheckin(userId);
  res.json({ success: true, message: "IVR responded. Safe confirmed." });
});

/** POST /api/location/update  — push latest GPS coordinates */
app.post("/api/location/update", (req, res) => {
  const { userId, lat, lng, address } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  s.lastLocation = { lat, lng, address: address || s.lastLocation.address, updatedAt: new Date().toISOString() };
  res.json({ success: true });
});

/** POST /api/incident/resolve  — mark incident closed */
app.post("/api/incident/resolve", (req, res) => {
  const { userId, incidentId } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  if (s.activeIncident?.id === incidentId) {
    clearTimers(userId, "broadcast");
    s.activeIncident.status = "RESOLVED";
    s.activeIncident.resolvedAt = new Date().toISOString();
    s.activeIncident = null;
    s.currentCheckin = null;

    addLog(userId, "RESOLVED", "Incident resolved. User confirmed safe. Monitoring resumed.");
    emit(userId, "incident_resolved", { message: "Incident resolved. Stay safe!" });
    scheduleNextCheckin(userId);
  }
  res.json({ success: true });
});

/** GET /api/session/:userId  — get current state */
app.get("/api/session/:userId", (req, res) => {
  const s = sessions.get(req.params.userId);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json(safe(s));
});

/** POST /api/dev/demo  — fast demo mode (5s interval, 10s grace) */
app.post("/api/dev/demo", (req, res) => {
  const { userId } = req.body;
  const s = sessions.get(userId);
  if (!s) return res.status(404).json({ error: "Session not found" });

  clearTimers(userId);
  s.enabled = true;
  s.intervalMinutes = 5 / 60;   // 5 seconds
  s.graceSeconds = 10;
  s.currentCheckin = null;
  s.activeIncident = null;

  addLog(userId, "DEMO", "⚡ DEMO MODE: 5s interval, 10s grace, 15s IVR ring");
  emit(userId, "monitor_enabled", { intervalMinutes: s.intervalMinutes, graceSeconds: s.graceSeconds, demo: true });
  scheduleNextCheckin(userId);

  res.json({ success: true, message: "Demo mode: check-in fires in 5 seconds!" });
});

// ─── WebSocket ───────────────────────────────────────────────────────────────
io.on("connection", socket => {
  console.log("🔌 Socket connected:", socket.id);

  socket.on("register_socket", userId => {
    const s = sessions.get(userId);
    if (s) {
      s.socketId = socket.id;
      console.log(`🔗 Socket ${socket.id} → user ${userId}`);
      socket.emit("socket_registered", { userId });
    }
  });

  socket.on("disconnect", () => {
    for (const [uid, s] of sessions.entries()) {
      if (s.socketId === socket.id) s.socketId = null;
    }
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// ─── Strip socket ID before sending to client ─────────────────────────────
function safe(s) {
  const { socketId, ...rest } = s;
  return rest;
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`\n🛡  SafeZone Backend: http://localhost:${PORT}`);
  console.log(`   Frontend served at same URL\n`);
});