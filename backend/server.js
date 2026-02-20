const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

let users = {};

// Start monitoring
app.post("/start", (req, res) => {
  const { userId, interval } = req.body;
  users[userId] = { interval, missedCalls: 0 };
  res.send("Monitoring started");
});

// User OK
app.post("/ok", (req, res) => {
  const { userId } = req.body;
  users[userId].missedCalls = 0;
  res.send("User safe");
});

// Location + escalation
app.post("/location", (req, res) => {
  const { userId, lat, lng } = req.body;

  console.log("📍 Location:", lat, lng);
  ivrCall(userId);

  res.send("Escalation started");
});

function ivrCall(userId) {
  users[userId].missedCalls++;
  console.log(`📞 IVR Call ${users[userId].missedCalls} to ${userId}`);

  if (users[userId].missedCalls >= 2) {
    console.log("🚨 RESCUE TEAM ALERTED with live location");
  }
}

app.listen(5000, () => {
  console.log("Backend running on port 5000");
});