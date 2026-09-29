/* ==========================================================================
   K'STARKOM DIGITAL TWIN — HIGH-END INDUSTRIAL SCADA SYSTEM ENGINE
   Plain JS (ES6+), connects cleanly to all FastAPI endpoints.
   No ML/backend logic modified.
   ========================================================================== */

const POLL_INTERVAL_MS = 1500;
const MAX_CHART_POINTS = 40;

// State Cache
let currentState = null;
let selectedJointId = "J1";
let audioAlarmEnabled = false;
let audioContext = null;
let lastAlertCount = 0;
let lastCriticalAlertTime = 0;
let modelMetadata = null;

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function fmtPct(x, decimals = 1) {
  if (x === null || x === undefined || isNaN(x)) return "--";
  return (Number(x) * 100).toFixed(decimals) + "%";
}

function fmtNum(x, digits = 1) {
  if (x === null || x === undefined || isNaN(x)) return "--";
  return Number(x).toFixed(digits);
}

function getHealthTier(health) {
  if (health >= 80) return "healthy";
  if (health >= 50) return "warning";
  return "critical";
}

function getHealthColorHex(tier) {
  switch (tier) {
    case "healthy": return "#00e676";
    case "warning": return "#ffb703";
    case "critical": return "#ff0055";
    default: return "#00f0ff";
  }
}

// ---------------------------------------------------------------------------
// SCADA Audio Alarm Synthesizer (Web Audio API)
// ---------------------------------------------------------------------------
function playScadaBeep(frequency = 880, type = "sine", duration = 0.15) {
  if (!audioAlarmEnabled) return;
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, audioContext.currentTime);
    gain.gain.setValueAtTime(0.12, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + duration);
  } catch (e) {
    console.warn("Audio synth warning:", e);
  }
}

function triggerAlarmSound(severity) {
  if (!audioAlarmEnabled) return;
  const now = Date.now();
  if (severity === "CRITICAL" && now - lastCriticalAlertTime > 4000) {
    lastCriticalAlertTime = now;
    playScadaBeep(920, "sawtooth", 0.2);
    setTimeout(() => playScadaBeep(640, "sawtooth", 0.25), 180);
  } else if (severity === "WARNING" && now - lastCriticalAlertTime > 6000) {
    playScadaBeep(600, "sine", 0.12);
  }
}

// ---------------------------------------------------------------------------
// Circular Radial Gauges Update
// ---------------------------------------------------------------------------
function updateRadialBar(elementId, textId, pctValue, colorHex) {
  const circle = $(elementId);
  const text = $(textId);
  if (!circle) return;

  const radius = 34;
  const circumference = 2 * Math.PI * radius; // ~213.6
  const offset = circumference - (Math.max(0, Math.min(100, pctValue)) / 100) * circumference;

  circle.style.strokeDasharray = `${circumference}`;
  circle.style.strokeDashoffset = `${offset}`;
  if (colorHex) circle.style.stroke = colorHex;
  if (text) text.textContent = `${Math.round(pctValue)}%`;
}

// ---------------------------------------------------------------------------
// Real-Time Mini Sparklines (Ultra-fast Canvas Renderer)
// ---------------------------------------------------------------------------
const sparklineBuffers = {
  speed: [],
  load: [],
  temp: [],
  vib: [],
  current: [],
};

function pushSparklinePoint(key, value) {
  const buf = sparklineBuffers[key];
  if (!buf) return;
  buf.push(value);
  if (buf.length > 25) buf.shift();
  renderSparkline(key);
}

function renderSparkline(key) {
  const canvas = $(`sparkline-${key}`);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 160;
  const height = canvas.clientHeight || 28;
  canvas.width = width;
  canvas.height = height;

  const data = sparklineBuffers[key];
  if (data.length < 2) return;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  ctx.clearRect(0, 0, width, height);

  // Gradient fill under the curve
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, "rgba(0, 240, 255, 0.25)");
  grad.addColorStop(1, "rgba(0, 240, 255, 0.0)");

  ctx.beginPath();
  data.forEach((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * (height - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.strokeStyle = "#00f0ff";
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Chart.js Setup for Dual-Channel Oscilloscopes
// ---------------------------------------------------------------------------
const scadaChartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: {
      display: true,
      position: "top",
      align: "end",
      labels: {
        color: "#94a3b8",
        font: { family: "JetBrains Mono", size: 10 },
        boxWidth: 8,
        boxHeight: 8,
      },
    },
    tooltip: {
      backgroundColor: "rgba(10, 15, 22, 0.95)",
      borderColor: "#22354e",
      borderWidth: 1,
      titleFont: { family: "JetBrains Mono", size: 11 },
      bodyFont: { family: "JetBrains Mono", size: 11 },
    },
  },
  scales: {
    x: {
      display: false,
      grid: { display: false },
    },
    y: {
      position: "left",
      ticks: {
        color: "#64748b",
        font: { family: "JetBrains Mono", size: 9 },
      },
      grid: { color: "rgba(34, 53, 78, 0.35)" },
    },
    y1: {
      position: "right",
      display: true,
      grid: { drawOnChartArea: false },
      ticks: {
        color: "#64748b",
        font: { family: "JetBrains Mono", size: 9 },
      },
    },
  },
  elements: {
    point: { radius: 0, hitRadius: 8, hoverRadius: 4 },
    line: { tension: 0.3, borderWidth: 2 },
  },
};

let chartTempCurrent, chartVibLoad, chartHealthRisk;

function initOscilloscopeCharts() {
  // Chart 1: Temp & Current
  const ctx1 = $("chart-temp-current").getContext("2d");
  chartTempCurrent = new Chart(ctx1, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Temp (°C)",
          data: [],
          borderColor: "#ffb703",
          backgroundColor: "rgba(255, 183, 3, 0.1)",
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Current (A)",
          data: [],
          borderColor: "#ffd166",
          backgroundColor: "transparent",
          borderDash: [3, 3],
          yAxisID: "y1",
        },
      ],
    },
    options: scadaChartOptions,
  });

  // Chart 2: Vibration & Load
  const ctx2 = $("chart-vib-load").getContext("2d");
  chartVibLoad = new Chart(ctx2, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Vibration (m/s²)",
          data: [],
          borderColor: "#ff0055",
          backgroundColor: "rgba(255, 0, 85, 0.12)",
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Load (kg)",
          data: [],
          borderColor: "#00f0ff",
          backgroundColor: "transparent",
          borderDash: [3, 3],
          yAxisID: "y1",
        },
      ],
    },
    options: scadaChartOptions,
  });

  // Chart 3: Health & Risk
  const ctx3 = $("chart-health-risk").getContext("2d");
  chartHealthRisk = new Chart(ctx3, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Health Index (%)",
          data: [],
          borderColor: "#00e676",
          backgroundColor: "rgba(0, 230, 118, 0.12)",
          fill: true,
          yAxisID: "y",
        },
        {
          label: "Failure Risk (%)",
          data: [],
          borderColor: "#ff0055",
          backgroundColor: "transparent",
          yAxisID: "y1",
        },
      ],
    },
    options: scadaChartOptions,
  });
}

function pushChartTriplet(timeLabel, temp, current, vib, load, health, risk) {
  const charts = [
    { chart: chartTempCurrent, v1: temp, v2: current },
    { chart: chartVibLoad, v1: vib, v2: load },
    { chart: chartHealthRisk, v1: health, v2: risk * 100 },
  ];

  charts.forEach(({ chart, v1, v2 }) => {
    if (!chart) return;
    chart.data.labels.push(timeLabel);
    chart.data.datasets[0].data.push(v1);
    chart.data.datasets[1].data.push(v2);
    if (chart.data.labels.length > MAX_CHART_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
      chart.data.datasets[1].data.shift();
    }
    chart.update("none");
  });

  // Update chart header text
  $("head-val-temp-current").textContent = `${fmtNum(temp, 1)}°C / ${fmtNum(current, 2)}A`;
  $("head-val-vib-load").textContent = `${fmtNum(vib, 2)}m/s² / ${fmtNum(load, 0)}kg`;
  $("head-val-health-risk").textContent = `${fmtNum(health, 0)}% / ${fmtPct(risk, 0)}`;
}

// ---------------------------------------------------------------------------
// High-Definition Vector SCADA Digital Twin Rendering
// ---------------------------------------------------------------------------
function initSchematicStaticDetails() {
  const idlersGroup = $("idlers-group");
  if (!idlersGroup) return;

  // Render 14 troughing & return idler assemblies along gantry (x=160 to x=840)
  let idlerHtml = "";
  for (let x = 180; x <= 820; x += 55) {
    // Upper Carry Idler (Troughing set of 3)
    idlerHtml += `
      <g transform="translate(${x}, 148)">
        <rect x="-14" y="-3" width="28" height="6" rx="2" fill="#253549" stroke="#33475d" stroke-width="1"/>
        <circle cx="0" cy="0" r="4" fill="#00f0ff" opacity="0.8"/>
        <line x1="0" y1="3" x2="0" y2="12" stroke="#253549" stroke-width="2"/>
      </g>
      <!-- Lower Return Idler -->
      <g transform="translate(${x}, 202)">
        <rect x="-12" y="-2" width="24" height="4" rx="1" fill="#1b2532" stroke="#2a3c52" stroke-width="1"/>
        <circle cx="0" cy="0" r="3" fill="#64748b"/>
        <line x1="0" y1="2" x2="0" y2="8" stroke="#1c2838" stroke-width="2"/>
      </g>
    `;
  }
  idlersGroup.innerHTML = idlerHtml;

  // Render Ore payload particles on carry deck
  const oreGroup = $("ore-particles");
  if (oreGroup) {
    let oreHtml = "";
    for (let x = 145; x <= 855; x += 18) {
      const h = 4 + (x % 5);
      oreHtml += `<polygon points="${x-8},134 ${x},${134-h} ${x+8},134"/>`;
    }
    oreGroup.innerHTML = oreHtml;
  }
}

function renderDigitalTwinSchematic(state) {
  const comp = state.components || {};
  const joints = state.joints || [];
  const speed = state.speed || 120;
  const temp = state.temperature || 40;

  // 1. Sync Belt & Pulley Speeds to live speed
  const speedFactor = Math.max(0.2, speed / 120);
  const animDuration = (1.2 / speedFactor).toFixed(2);
  const spinDuration = (2.5 / speedFactor).toFixed(2);

  document.querySelectorAll(".belt-path-active").forEach((el) => {
    el.style.animationDuration = `${animDuration}s`;
  });

  const headSpokes = $("head-spokes");
  if (headSpokes) headSpokes.style.animationDuration = `${spinDuration}s`;
  const tailSpokes = $("tail-spokes");
  if (tailSpokes) tailSpokes.style.animationDuration = `${spinDuration}s`;

  // 2. Component Colors
  const motorTier = getHealthTier(comp["Motor"]?.health ?? 100);
  const headTier = getHealthTier(comp["Drive Pulley"]?.health ?? 100);
  const tailTier = getHealthTier(comp["Tail Pulley"]?.health ?? 100);

  const motorBox = $("motor-body-box");
  if (motorBox) motorBox.style.stroke = getHealthColorHex(motorTier);

  const headDrum = $("head-drum-rim");
  if (headDrum) headDrum.style.stroke = getHealthColorHex(headTier);

  const tailDrum = $("tail-drum-rim");
  if (tailDrum) tailDrum.style.stroke = getHealthColorHex(tailTier);

  // Motor Thermal Glow
  const thermalGlow = $("motor-thermal-glow");
  if (thermalGlow) {
    if (temp > 50) {
      const opacity = Math.min(0.9, (temp - 50) / 25);
      thermalGlow.style.opacity = `${opacity}`;
    } else {
      thermalGlow.style.opacity = "0";
    }
  }

  // 3. Render Joint Splice Beacons J1-J5
  // Map physical position (0-80m) to SVG X coordinate (130-870px, span = 740px)
  const jointsLayer = $("joints-svg-layer");
  if (jointsLayer) {
    const beaconsHtml = joints.map((j) => {
      const normPos = Math.max(0, Math.min(80, j.position)) / 80;
      const x = 130 + normPos * 740;
      const tier = j.severity === "Low" ? "healthy" : j.severity === "Medium" ? "warning" : "critical";
      const color = getHealthColorHex(tier);
      const isSelected = j.joint_id === selectedJointId;

      return `
        <g class="joint-beacon" data-joint-id="${j.joint_id}" transform="translate(${x}, 140)" onclick="selectJoint('${j.joint_id}')">
          <!-- Pulse Halo -->
          <circle class="beacon-pulse" cx="0" cy="0" r="14" fill="${color}" opacity="0.3"/>
          <!-- Splice Seam on Belt -->
          <line x1="0" y1="-8" x2="0" y2="8" stroke="${color}" stroke-width="4"/>
          <!-- Marker Circle -->
          <circle cx="0" cy="0" r="7" fill="#06090e" stroke="${color}" stroke-width="2.5"/>
          <circle cx="0" cy="0" r="3" fill="${color}"/>
          <!-- Selection Ring -->
          ${isSelected ? `<circle cx="0" cy="0" r="16" fill="none" stroke="#00f0ff" stroke-width="2" stroke-dasharray="3 3"/>` : ""}
          <!-- ID Label -->
          <rect x="-18" y="-30" width="36" height="16" rx="2" fill="#090e17" stroke="${isSelected ? "#00f0ff" : "#172334"}" stroke-width="1.2"/>
          <text x="0" y="-18" text-anchor="middle" fill="${color}" font-size="10" font-family="JetBrains Mono" font-weight="700">${j.joint_id}</text>
          <!-- Distance Text -->
          <text x="0" y="24" text-anchor="middle" fill="#64748b" font-size="9" font-family="JetBrains Mono">${j.position}m</text>
        </g>
      `;
    }).join("");
    jointsLayer.innerHTML = beaconsHtml;
  }
}

// ---------------------------------------------------------------------------
// Sub-Assemblies Grid & Selected Joint Inspector
// ---------------------------------------------------------------------------
function renderComponents(state) {
  const container = $("components-container");
  if (!container) return;
  const comps = state.components || {};

  container.innerHTML = Object.entries(comps).map(([name, info]) => {
    const health = info.health;
    const tier = getHealthTier(health);
    const color = getHealthColorHex(tier);
    return `
      <div class="component-card">
        <div class="component-head">
          <span class="component-name">${name.toUpperCase()}</span>
          <span class="component-health-num" style="color:${color};">${health.toFixed(1)}%</span>
        </div>
        <div class="component-bar-wrap">
          <div class="component-bar-fill" style="width:${health}%; background:${color};"></div>
        </div>
      </div>
    `;
  }).join("");
}

function selectJoint(jointId) {
  selectedJointId = jointId;
  if (currentState) {
    renderJointInspector(currentState);
    renderDigitalTwinSchematic(currentState);
    highlightJointTableRow();
  }
}

function resetSelectedJoint() {
  selectedJointId = "J1";
  if (currentState) {
    renderJointInspector(currentState);
    renderDigitalTwinSchematic(currentState);
    highlightJointTableRow();
  }
}

function renderJointInspector(state) {
  const joints = state.joints || [];
  const joint = joints.find((j) => j.joint_id === selectedJointId) || joints[0];
  if (!joint) return;

  $("inspector-joint-title").textContent = `JOINT ${joint.joint_id} // CHAINAGE TELEMETRY`;
  $("insp-position").textContent = `${joint.position.toFixed(1)} METERS`;

  const tier = joint.severity === "Low" ? "healthy" : joint.severity === "Medium" ? "warning" : "critical";
  const color = getHealthColorHex(tier);

  const inspHealth = $("insp-health");
  inspHealth.textContent = `${joint.health.toFixed(1)}%`;
  inspHealth.style.color = color;

  $("insp-damage").textContent = (joint.damage || "Normal").toUpperCase();
  $("insp-risk").textContent = `${(joint.risk * 100).toFixed(1)}%`;

  const inspSource = $("insp-source");
  inspSource.textContent = joint.source === "vision" ? "AI VISION PIPELINE (YOLO)" : "IN-LINE SENSOR ESTIMATION";
  inspSource.style.color = joint.source === "vision" ? "var(--cyan-neon)" : "var(--text-main)";

  // Hook button to open vision modal for this joint
  const btn = $("btn-insp-test-vision");
  if (btn) {
    btn.onclick = () => {
      openModal("modal-vision");
      const sel = $("sel-vision-joint");
      if (sel) sel.value = joint.joint_id;
    };
  }
}

// ---------------------------------------------------------------------------
// Belt Joint Monitoring Table
// ---------------------------------------------------------------------------
function renderJointsTable(state) {
  const tbody = $("joint-table-body");
  if (!tbody) return;
  const joints = state.joints || [];

  tbody.innerHTML = joints.map((j) => {
    const isSelected = j.joint_id === selectedJointId;
    const tier = j.severity === "Low" ? "healthy" : j.severity === "Medium" ? "warning" : "critical";
    const statusLabel = j.severity === "Low" ? "NOMINAL" : j.severity === "Medium" ? "WARN WEAR" : "CRITICAL RUPTURE";
    const statusClass = j.severity === "Low" ? "nominal" : j.severity === "Medium" ? "elevated" : "critical";
    const color = getHealthColorHex(tier);

    return `
      <tr class="${isSelected ? "selected-joint" : ""}" onclick="selectJoint('${j.joint_id}')" style="cursor:pointer;">
        <td>
          <span class="joint-id-badge">
            <span class="status-dot ${tier}"></span>
            ${j.joint_id}
          </span>
        </td>
        <td>${j.position.toFixed(1)} m</td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="color:${color}; font-weight:700; width:45px;">${j.health.toFixed(1)}%</span>
            <div style="flex:1; height:4px; background:var(--border-subtle); border-radius:2px; max-width:70px;">
              <div style="width:${j.health}%; height:100%; background:${color}; border-radius:2px;"></div>
            </div>
          </div>
        </td>
        <td><span class="damage-type-pill">${j.damage}</span></td>
        <td>${(j.risk * 100).toFixed(1)}%</td>
        <td><span style="font-size:11px; color:${j.source === "vision" ? "var(--cyan-neon)" : "var(--text-muted)"}">${j.source.toUpperCase()}</span></td>
        <td><span class="kpi-status-tag ${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="action-cell-btn" onclick="event.stopPropagation(); triggerJointVisionModal('${j.joint_id}')">
            SIMULATE VISION
          </button>
        </td>
      </tr>
    `;
  }).join("");

  const js = state.joints_summary || {};
  $("joints-summary-stats").textContent = `5 JOINTS: ${js.healthy || 0} HEALTHY · ${js.warning || 0} WARNING · ${js.critical || 0} CRITICAL`;
}

function highlightJointTableRow() {
  document.querySelectorAll(".scada-table tbody tr").forEach((row) => {
    const badge = row.querySelector(".joint-id-badge");
    if (badge && badge.textContent.includes(selectedJointId)) {
      row.classList.add("selected-joint");
    } else {
      row.classList.remove("selected-joint");
    }
  });
}

function triggerJointVisionModal(jointId) {
  selectJoint(jointId);
  openModal("modal-vision");
  const sel = $("sel-vision-joint");
  if (sel) sel.value = jointId;
}

// ---------------------------------------------------------------------------
// Alarms & Prescriptive Maintenance Console
// ---------------------------------------------------------------------------
function renderAlarmsAndPrescription(state) {
  // 1. Annunciator Tiles
  const vibAlarm = $("tile-vib-alarm");
  if (vibAlarm) {
    const active = state.vibration > 3.0;
    vibAlarm.className = `annunciator-tile ${active ? "active-alarm" : ""}`;
    if (active) triggerAlarmSound("WARNING");
  }

  const tempAlarm = $("tile-temp-alarm");
  if (tempAlarm) {
    const active = state.temperature > 55.0;
    tempAlarm.className = `annunciator-tile ${active ? "active-alarm" : ""}`;
    if (active) triggerAlarmSound("WARNING");
  }

  const currAlarm = $("tile-curr-alarm");
  if (currAlarm) {
    const active = state.current > 12.0;
    currAlarm.className = `annunciator-tile ${active ? "active-alarm" : ""}`;
    if (active) triggerAlarmSound("WARNING");
  }

  const riskAlarm = $("tile-risk-alarm");
  if (riskAlarm) {
    const active = state.risk >= 0.6;
    riskAlarm.className = `annunciator-tile ${active ? "active-alarm" : ""}`;
    if (active) triggerAlarmSound("CRITICAL");
  }

  const slipAlarm = $("tile-slip-alarm");
  if (slipAlarm) {
    const active = state.predicted_fault === "Belt Slippage";
    slipAlarm.className = `annunciator-tile ${active ? "active-alarm" : ""}`;
  }

  const jointAlarm = $("tile-joint-alarm");
  if (jointAlarm) {
    const hasCritJoint = (state.joints || []).some((j) => j.severity === "High");
    jointAlarm.className = `annunciator-tile ${hasCritJoint ? "active-alarm" : ""}`;
    if (hasCritJoint) triggerAlarmSound("CRITICAL");
  }

  // 2. Alarm Event Stream
  const list = $("alarm-history-list");
  if (list) {
    const alerts = state.alerts || [];
    const timeStr = new Date(state.last_update || Date.now()).toLocaleTimeString();
    list.innerHTML = alerts.map((a) => {
      const icon = a.severity === "CRITICAL" ? "⛔" : a.severity === "WARNING" ? "⚠" : "✓";
      return `
        <li class="alarm-row ${a.severity}">
          <span class="alarm-message">
            <span>${icon}</span>
            <span>${a.message}</span>
          </span>
          <span class="alarm-time">${timeStr}</span>
        </li>
      `;
    }).join("");
  }

  // 3. Recommended Action
  $("pm-recommended-action").textContent = state.recommended_action || "CONTINUE CONTINUOUS CONDITION MONITORING.";

  // 4. Contributing Signals Tag List
  const expl = state.explanation || {};
  const signalsList = $("signals-tag-list");
  if (signalsList) {
    signalsList.innerHTML = (expl.contributing_signals || []).map((s) => `
      <span class="signal-chip">${s}</span>
    `).join("");
  }

  $("explanation-indication").textContent = expl.possible_indication || "No significant abnormality detected";
  $("pm-risk-method").textContent = `Risk calculation: ${state.risk_method || "1 - confidence"}`;
}

// ---------------------------------------------------------------------------
// Main State Render Loop
// ---------------------------------------------------------------------------
function renderState(state) {
  currentState = state;

  // 1. KPI Strip
  const healthScore = state.health_score ?? 100;
  $("val-health").textContent = fmtNum(healthScore, 0);
  const healthTier = getHealthTier(healthScore);
  const healthColor = getHealthColorHex(healthTier);
  updateRadialBar("radial-health", "radial-health-val", healthScore, healthColor);

  const tagHealth = $("tag-health");
  tagHealth.textContent = healthTier === "healthy" ? "OPTIMAL STATUS" : healthTier === "warning" ? "DEGRADED HEALTH" : "CRITICAL RISK";
  tagHealth.className = `kpi-status-tag ${healthTier === "healthy" ? "nominal" : healthTier === "warning" ? "elevated" : "critical"}`;

  // Failure Risk
  const risk = state.risk ?? 0;
  const riskPct = risk * 100;
  const riskTier = risk >= 0.6 ? "critical" : risk >= 0.3 ? "warning" : "healthy";
  const riskColor = getHealthColorHex(riskTier);
  $("val-risk").textContent = riskTier === "critical" ? "HIGH" : riskTier === "warning" ? "MED" : "LOW";
  $("unit-risk-pct").textContent = `(${fmtPct(risk, 1)})`;
  updateRadialBar("radial-risk", "radial-risk-val", riskPct, riskColor);

  const tagRisk = $("tag-risk");
  tagRisk.textContent = `RISK: ${riskTier.toUpperCase()}`;
  tagRisk.className = `kpi-status-tag ${riskTier === "healthy" ? "nominal" : riskTier === "warning" ? "elevated" : "critical"}`;

  // Fault Annunciator
  $("val-fault").textContent = state.predicted_fault || "NORMAL OPERATION";
  $("tag-fault-class").textContent = `CLASS ${state.fault_class !== null && state.fault_class !== undefined ? state.fault_class : "--"}`;
  const faultIconMap = {
    "Ball Bearing Fault": "⚙️",
    "Belt Slippage": "⚡",
    "Central Shaft Fault": "🔩",
    "Drive Motor Fault": "⚡",
    "Idler Roller Fault": "🛞",
    "Pulley Fault": "🔄",
  };
  if ($("icon-fault-type")) $("icon-fault-type").textContent = faultIconMap[state.predicted_fault] || "⬢";

  // Confidence
  const confPct = (state.confidence ?? 0) * 100;
  $("val-confidence").textContent = fmtNum(confPct, 1);
  updateRadialBar("radial-conf", "radial-conf-val", confPct, "#00f0ff");

  // 2. Sensor Strip
  const speed = state.speed ?? 0;
  const load = state.load ?? 0;
  const temp = state.temperature ?? 0;
  const vib = state.vibration ?? 0;
  const current = state.current ?? 0;

  $("val-s-speed").textContent = fmtNum(speed, 0);
  $("gauge-bar-speed").style.width = `${Math.min(100, (speed / 160) * 100)}%`;
  pushSparklinePoint("speed", speed);

  $("val-s-load").textContent = fmtNum(load, 0);
  $("gauge-bar-load").style.width = `${Math.min(100, ((load - 300) / 500) * 100)}%`;
  pushSparklinePoint("load", load);

  $("val-s-temp").textContent = fmtNum(temp, 1);
  $("gauge-bar-temp").style.width = `${Math.min(100, ((temp - 20) / 60) * 100)}%`;
  pushSparklinePoint("temp", temp);

  $("val-s-vib").textContent = fmtNum(vib, 2);
  $("gauge-bar-vib").style.width = `${Math.min(100, (vib / 4.0) * 100)}%`;
  pushSparklinePoint("vib", vib);

  $("val-s-current").textContent = fmtNum(current, 2);
  $("gauge-bar-current").style.width = `${Math.min(100, (current / 16.0) * 100)}%`;
  pushSparklinePoint("current", current);

  // Sensor Delta Pills
  $("delta-speed").textContent = speed > 130 ? "HIGH" : speed < 110 ? "LOW" : "NOMINAL";
  $("delta-speed").style.color = (speed > 130 || speed < 110) ? "var(--amber-warn)" : "var(--text-muted)";

  $("delta-temp").textContent = temp > 55 ? "OVERHEAT" : temp > 46 ? "ELEVATED" : "NOMINAL";
  $("delta-temp").style.color = temp > 55 ? "var(--crimson-crit)" : temp > 46 ? "var(--amber-warn)" : "var(--text-muted)";

  $("delta-vib").textContent = vib > 3.0 ? "CRITICAL" : vib > 1.8 ? "WARN" : "NOMINAL";
  $("delta-vib").style.color = vib > 3.0 ? "var(--crimson-crit)" : vib > 1.8 ? "var(--amber-warn)" : "var(--text-muted)";

  $("delta-current").textContent = current > 12.0 ? "OVERLOAD" : current > 8.0 ? "HIGH" : "NOMINAL";
  $("delta-current").style.color = current > 12.0 ? "var(--crimson-crit)" : "var(--text-muted)";

  // 3. Vector Digital Twin
  renderDigitalTwinSchematic(state);

  // 4. Sub-Assemblies & Joint Inspector
  renderComponents(state);
  renderJointInspector(state);

  // 5. Joint Table
  renderJointsTable(state);

  // 6. Alarms & Prescriptive Maintenance
  renderAlarmsAndPrescription(state);

  // 7. Update Clock & Timestamps
  const timeStr = new Date(state.last_update || Date.now()).toLocaleTimeString();
  $("footer-update-time").textContent = `LAST TELEMETRY: ${timeStr} [CONV-001]`;

  // 8. Stream to Oscilloscope Charts
  pushChartTriplet(timeStr, temp, current, vib, load, healthScore, risk);

  // Update System Status Pill
  $("system-dot").className = "status-dot online";
  $("system-status-text").textContent = "TELEMETRY LINK: ONLINE";
}

// ---------------------------------------------------------------------------
// Polling Loop
// ---------------------------------------------------------------------------
async function pollConveyorState() {
  try {
    const res = await fetch("/api/conveyor");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderState(data);
  } catch (err) {
    console.error("SCADA Polling Error:", err);
    $("system-dot").className = "status-dot offline";
    $("system-status-text").textContent = "TELEMETRY LINK: OFFLINE / RECONNECTING";
  }
}

// ---------------------------------------------------------------------------
// Load Initial History For Charts
// ---------------------------------------------------------------------------
async function loadSensorHistory() {
  try {
    const res = await fetch("/api/sensors/history?n=30");
    if (!res.ok) return;
    const history = await res.json();
    if (!Array.isArray(history)) return;

    history.forEach((r) => {
      const time = new Date(r.timestamp || Date.now()).toLocaleTimeString();
      pushSparklinePoint("speed", r.speed);
      pushSparklinePoint("load", r.load);
      pushSparklinePoint("temp", r.temperature);
      pushSparklinePoint("vib", r.vibration);
      pushSparklinePoint("current", r.current);
    });
  } catch (err) {
    console.warn("Could not pre-load sensor history:", err);
  }
}

// ---------------------------------------------------------------------------
// Simulator Mode Control (POST /api/simulator/mode)
// ---------------------------------------------------------------------------
function setupSimulatorModeButtons() {
  const modes = ["NORMAL", "WARNING", "FAULT"];
  modes.forEach((mode) => {
    const btn = $(`mode-btn-${mode.toLowerCase()}`);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      modes.forEach((m) => {
        const b = $(`mode-btn-${m.toLowerCase()}`);
        if (b) b.classList.remove("active");
      });
      btn.classList.add("active");

      try {
        await fetch("/api/simulator/mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        playScadaBeep(520, "sine", 0.08);
      } catch (err) {
        console.error("Failed to set simulator mode:", err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// What-If ML Inference Lab (POST /api/predict)
// ---------------------------------------------------------------------------
function setupWhatIfLab() {
  const speed = $("rng-whatif-speed");
  const load = $("rng-whatif-load");
  const temp = $("rng-whatif-temp");
  const vib = $("rng-whatif-vib");
  const current = $("rng-whatif-current");

  const updateLabels = () => {
    $("lbl-whatif-speed").textContent = `${fmtNum(speed.value, 1)} RPM`;
    $("lbl-whatif-load").textContent = `${fmtNum(load.value, 0)} KG`;
    $("lbl-whatif-temp").textContent = `${fmtNum(temp.value, 1)} °C`;
    $("lbl-whatif-vib").textContent = `${fmtNum(vib.value, 2)} m/s²`;
    $("lbl-whatif-current").textContent = `${fmtNum(current.value, 2)} A`;
  };

  [speed, load, temp, vib, current].forEach((input) => {
    input.addEventListener("input", updateLabels);
  });

  $("btn-run-whatif").addEventListener("click", async () => {
    const payload = {
      speed: parseFloat(speed.value),
      load: parseFloat(load.value),
      temperature: parseFloat(temp.value),
      vibration: parseFloat(vib.value),
      current: parseFloat(current.value),
    };

    $("btn-run-whatif").textContent = "RUNNING XGBOOST INFERENCE...";
    try {
      const res = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Inference returned HTTP ${res.status}`);
      const result = await res.json();

      $("whatif-result-card").style.display = "block";
      $("whatif-fault-name").textContent = result.predicted_fault;
      $("whatif-risk-val").textContent = fmtPct(result.risk);

      const probaList = $("whatif-proba-list");
      probaList.innerHTML = Object.entries(result.class_probabilities || {}).map(([cName, prob]) => {
        const pct = (prob * 100).toFixed(1);
        const isPredicted = cName === result.predicted_fault;
        const barColor = isPredicted ? "var(--cyan-neon)" : "#3b82f6";
        return `
          <li class="proba-row">
            <div class="proba-meta">
              <span style="color:${isPredicted ? "var(--cyan-neon)" : "var(--text-muted)"}; font-weight:${isPredicted ? "700" : "400"}">${cName}</span>
              <span style="color:${isPredicted ? "var(--cyan-neon)" : "var(--text-dim)"}">${pct}%</span>
            </div>
            <div class="proba-bar-track">
              <div class="proba-bar-fill" style="width:${pct}%; background:${barColor};"></div>
            </div>
          </li>
        `;
      }).join("");

      playScadaBeep(780, "sine", 0.1);
    } catch (err) {
      alert(`Inference failed: ${err.message}`);
    } finally {
      $("btn-run-whatif").textContent = "RUN XGBOOST INFERENCE PIPELINE";
    }
  });
}

function loadWhatifPreset(type) {
  const speed = $("rng-whatif-speed");
  const load = $("rng-whatif-load");
  const temp = $("rng-whatif-temp");
  const vib = $("rng-whatif-vib");
  const current = $("rng-whatif-current");

  if (type === "normal") {
    speed.value = 120.8;
    load.value = 506.7;
    temp.value = 41.6;
    vib.value = 0.86;
    current.value = 3.43;
  } else if (type === "vibration") {
    speed.value = 122.0;
    load.value = 520.0;
    temp.value = 46.5;
    vib.value = 2.85;
    current.value = 6.2;
  } else if (type === "overload") {
    speed.value = 108.0;
    load.value = 740.0;
    temp.value = 52.0;
    vib.value = 1.65;
    current.value = 11.8;
  } else if (type === "thermal") {
    speed.value = 121.0;
    load.value = 515.0;
    temp.value = 68.4;
    vib.value = 1.95;
    current.value = 8.6;
  }

  // Dispatch input event to update label texts
  speed.dispatchEvent(new Event("input"));
  playScadaBeep(640, "sine", 0.05);
}

// ---------------------------------------------------------------------------
// AI Vision Joint Damage Injector (POST /api/vision/joint)
// ---------------------------------------------------------------------------
function setupVisionSimulator() {
  const sevSlider = $("rng-vision-severity");
  if (sevSlider) {
    sevSlider.addEventListener("input", () => {
      $("lbl-vision-severity").textContent = `${sevSlider.value} (${(sevSlider.value * 100).toFixed(0)}%)`;
    });
  }

  const btnPush = $("btn-push-vision");
  if (btnPush) {
    btnPush.addEventListener("click", async () => {
      const jointId = $("sel-vision-joint").value;
      const damageType = $("sel-vision-damage").value;
      const severity = parseFloat(sevSlider.value);

      btnPush.textContent = "TRANSMITTING TELEMETRY...";
      try {
        const res = await fetch("/api/vision/joint", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            joint_id: jointId,
            damage_type: damageType,
            severity,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const feedback = $("vision-feedback-card");
        feedback.style.display = "block";
        feedback.textContent = `✓ Vision Telemetry Accepted: Joint ${data.joint_id} set to "${data.damage}" with ${(data.risk * 100).toFixed(0)}% Rupture Risk.`;

        selectJoint(jointId);
        pollConveyorState();
        playScadaBeep(880, "sine", 0.12);

        setTimeout(() => {
          closeModal("modal-vision");
          feedback.style.display = "none";
        }, 1500);
      } catch (err) {
        alert(`Failed to push vision telemetry: ${err.message}`);
      } finally {
        btnPush.textContent = "TRANSMIT VISION TELEMETRY TO DIGITAL TWIN";
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Model Dossier (GET /api/model)
// ---------------------------------------------------------------------------
async function loadModelDossier() {
  try {
    const res = await fetch("/api/model");
    if (!res.ok) return;
    modelMetadata = await res.json();

    $("model-pill-text").textContent = `${modelMetadata.model_type.toUpperCase()} (${(modelMetadata.accuracy * 100).toFixed(2)}% ACC)`;
    $("dossier-model-type").textContent = `${modelMetadata.model_name} (${modelMetadata.model_type})`;
    $("dossier-accuracy").textContent = `${(modelMetadata.accuracy * 100).toFixed(2)}% Test Accuracy`;
    $("dossier-train-samples").textContent = `${modelMetadata.training_samples} Samples`;
    $("dossier-test-samples").textContent = `${modelMetadata.test_samples} Samples`;
    $("dossier-features").textContent = `${modelMetadata.total_features} Features (${modelMetadata.original_features} Raw + ${modelMetadata.engineered_features} Rolling)`;
  } catch (err) {
    console.warn("Model metadata could not be fetched:", err);
  }
}

// ---------------------------------------------------------------------------
// Modals & UI Controls
// ---------------------------------------------------------------------------
function openModal(id) {
  const modal = $(id);
  if (modal) modal.classList.add("open");
  playScadaBeep(600, "sine", 0.05);
}

function closeModal(id) {
  const modal = $(id);
  if (modal) modal.classList.remove("open");
}

// Close modal when clicking on backdrop outside modal container
window.addEventListener("click", (e) => {
  if (e.target.classList && e.target.classList.contains("scada-modal-backdrop")) {
    e.target.classList.remove("open");
  }
});

// Acknowledge All Alarms
$("btn-ack-alarms")?.addEventListener("click", () => {
  document.querySelectorAll(".annunciator-tile").forEach((t) => t.classList.remove("active-alarm"));
  playScadaBeep(440, "sine", 0.1);
});

// Audio Alarm Toggle Button
$("btn-audio-alarm")?.addEventListener("click", () => {
  audioAlarmEnabled = !audioAlarmEnabled;
  $("btn-audio-alarm").classList.toggle("active", audioAlarmEnabled);
  if (audioAlarmEnabled) {
    playScadaBeep(880, "sine", 0.1);
  }
});

// Fullscreen Toggle Button
$("btn-fullscreen")?.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

// Clock Tick
function startScadaClock() {
  const updateClock = () => {
    const now = new Date();
    const utcHours = String(now.getUTCHours()).padStart(2, "0");
    const utcMins = String(now.getUTCMinutes()).padStart(2, "0");
    const utcSecs = String(now.getUTCSeconds()).padStart(2, "0");
    $("clock-utc").textContent = `${utcHours}:${utcMins}:${utcSecs} UTC`;
  };
  updateClock();
  setInterval(updateClock, 1000);
}

// ---------------------------------------------------------------------------
// System Initialization
// ---------------------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  initSchematicStaticDetails();
  initOscilloscopeCharts();
  setupSimulatorModeButtons();
  setupWhatIfLab();
  setupVisionSimulator();
  loadModelDossier();
  startScadaClock();
  loadSensorHistory();

  // Initial poll + repeat every 1.5s
  pollConveyorState();
  setInterval(pollConveyorState, POLL_INTERVAL_MS);
});

// Explicit window bindings for inline HTML handlers
window.openModal = openModal;
window.closeModal = closeModal;
window.loadWhatifPreset = loadWhatifPreset;
window.resetSelectedJoint = resetSelectedJoint;
window.selectJoint = selectJoint;
window.triggerJointVisionModal = triggerJointVisionModal;
