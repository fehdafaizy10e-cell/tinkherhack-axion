let checkTimer;
let intervalMinutes;
let userId = "user001";

function startMonitoring() {
  intervalMinutes = document.getElementById("interval").value;

  fetch("http://localhost:5000/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, interval: intervalMinutes })
  });

  startTimer();
  alert("Safety monitoring enabled");
}

function startTimer() {
  clearTimeout(checkTimer);

  checkTimer = setTimeout(() => {
    document.getElementById("alertBox").classList.remove("hidden");

    setTimeout(triggerEscalation, 30000); // 30s response window
  }, intervalMinutes * 60000);
}

function confirmOK() {
  fetch("http://localhost:5000/ok", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId })
  });

  document.getElementById("alertBox").classList.add("hidden");
  startTimer();
  alert("Status safe. Timer reset.");
}

function resetTimer() {
  document.getElementById("alertBox").classList.add("hidden");
  startTimer();
  alert("Timer reset manually");
}

function makeEmergencyCall() {
  window.location.href = "tel:112"; // emergency number
}

function triggerEscalation() {
  navigator.geolocation.getCurrentPosition(pos => {
    fetch("http://localhost:5000/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude
      })
    });
  });
}