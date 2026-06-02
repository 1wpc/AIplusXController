import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const state = {
  temperature: 27,
  coolingOn: null,
  controlMode: "manual",
  history: Array.from({ length: 28 }, () => 27),
  logs: [],
  lastMw: { MW0: null, MW20: null, MW21: null, MW22: null },
};

const els = {
  clock: document.querySelector("#clock"),
  linkStatus: document.querySelector("#linkStatus"),
  temperatureValue: document.querySelector("#temperatureValue"),
  rawMw0: document.querySelector("#rawMw0"),
  brokerValue: document.querySelector("#brokerValue"),
  deviceValue: document.querySelector("#deviceValue"),
  deviceInput: document.querySelector("#deviceInput"),
  saveDeviceBtn: document.querySelector("#saveDeviceBtn"),
  latencyValue: document.querySelector("#latencyValue"),
  stateValue: document.querySelector("#stateValue"),
  streamTemp: document.querySelector("#streamTemp"),
  systemLoad: document.querySelector("#systemLoad"),
  mw0: document.querySelector("#mw0"),
  mw20: document.querySelector("#mw20"),
  mw21: document.querySelector("#mw21"),
  mw22: document.querySelector("#mw22"),
  onThreshold: document.querySelector("#onThreshold"),
  offThreshold: document.querySelector("#offThreshold"),
  commandLog: document.querySelector("#commandLog"),
  sparkline: document.querySelector("#sparkline"),
  sceneCanvas: document.querySelector("#phoneScene"),
  agentState: document.querySelector("#agentState"),
  manualModeBtn: document.querySelector("#manualModeBtn"),
  autoOnceBtn: document.querySelector("#autoOnceBtn"),
  coolingOnBtn: document.querySelector("#coolingOnBtn"),
  coolingOffBtn: document.querySelector("#coolingOffBtn"),
  apiKeyStatus: document.querySelector("#apiKeyStatus"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  apiProviderSelect: document.querySelector("#apiProviderSelect"),
  apiBaseUrlInput: document.querySelector("#apiBaseUrlInput"),
  apiModelInput: document.querySelector("#apiModelInput"),
  saveApiKeyBtn: document.querySelector("#saveApiKeyBtn"),
  clearApiKeyBtn: document.querySelector("#clearApiKeyBtn"),
  chatLog: document.querySelector("#chatLog"),
  agentPrompt: document.querySelector("#agentPrompt"),
  sendAgentBtn: document.querySelector("#sendAgentBtn"),
};

const providerDefaults = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  doubao: {
    label: "豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260215",
  },
  custom: {
    label: "Custom",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
};

function roundedRectShape(width, height, radius) {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

function addPlanarUvs(geometry, width, height) {
  const position = geometry.attributes.position;
  const uvs = [];
  for (let i = 0; i < position.count; i += 1) {
    uvs.push(position.getX(i) / width + 0.5, position.getY(i) / height + 0.5);
  }
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
}

function roundedPlane(width, height, radius, material, curveSegments = 32) {
  const geometry = new THREE.ShapeGeometry(roundedRectShape(width, height, radius), curveSegments);
  addPlanarUvs(geometry, width, height);
  return new THREE.Mesh(geometry, material);
}

function timestamp() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function appendChatMessage(role, message, meta = "") {
  if (!els.chatLog) return null;
  const item = document.createElement("li");
  item.className = `chat-message ${role}`;
  item.innerHTML = `
    <span>${escapeHtml(meta || timestamp())}</span>
    <p>${escapeHtml(message)}</p>
  `;
  els.chatLog.appendChild(item);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  return { item, body: item.querySelector("p") };
}

function addLog(message, tone = "cyan") {
  state.logs.unshift({ time: timestamp(), message, tone });
  state.logs = state.logs.slice(0, 8);
  if (!els.commandLog) {
    return;
  }
  els.commandLog.innerHTML = state.logs
    .map((entry) => `<li><span>${entry.time}</span><b class="${entry.tone === "red" ? "error" : ""}">${entry.message}</b></li>`)
    .join("");
}

function setLoading(button, loading) {
  if (!button) return;
  const manualLocked = state.controlMode === "auto" && (button === els.coolingOnBtn || button === els.coolingOffBtn);
  button.disabled = loading || manualLocked;
  button.style.opacity = loading ? "0.55" : "";
}

function applyControlMode(mode) {
  state.controlMode = mode;
  const isAuto = mode === "auto";
  els.agentState.textContent = isAuto ? "AUTO" : "MANUAL";
  els.manualModeBtn.classList.toggle("active", !isAuto);
  els.autoOnceBtn.classList.toggle("active", isAuto);
  els.coolingOnBtn.disabled = isAuto;
  els.coolingOffBtn.disabled = isAuto;
}

async function command(action, text = "") {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((button) => setLoading(button, true));
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, text }),
    });
    const data = await response.json();
    addLog(data.message || "命令完成", data.ok ? "cyan" : "red");
    if (data.status) {
      applyStatus(data.status);
    }
  } catch (error) {
    addLog(`命令失败: ${error.message}`, "red");
  } finally {
    buttons.forEach((button) => setLoading(button, false));
  }
}

async function loadSettings() {
  try {
    const response = await fetch("/api/settings");
    const data = await response.json();
    if (data.provider) els.apiProviderSelect.value = data.provider;
    if (data.base_url) els.apiBaseUrlInput.value = data.base_url;
    if (data.model) els.apiModelInput.value = data.model;
    const providerLabel = providerDefaults[els.apiProviderSelect.value]?.label || "AI";
    els.apiKeyStatus.textContent = data.has_api_key ? `${providerLabel} READY` : "LOCAL RULES";
    els.apiKeyStatus.classList.toggle("error", !data.has_api_key);
  } catch (error) {
    els.apiKeyStatus.textContent = "CONFIG ERR";
    els.apiKeyStatus.classList.add("error");
    addLog(`API 配置读取失败: ${error.message}`, "red");
  }
}

async function loadConnectionSettings() {
  try {
    const response = await fetch("/api/connection-settings");
    const data = await response.json();
    if (data.device) {
      els.deviceInput.value = data.device;
      els.deviceInput.dataset.lastSaved = data.device;
    }
    if (data.broker) els.brokerValue.textContent = data.broker;
  } catch (error) {
    addLog(`连接配置读取失败: ${error.message}`, "red");
  }
}

async function saveDevice() {
  const device = els.deviceInput.value.trim();
  if (!device) {
    addLog("Device 号不能为空", "red");
    return;
  }
  setLoading(els.saveDeviceBtn, true);
  try {
    const response = await fetch("/api/connection-settings/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.message || "Device 保存失败");
    els.deviceInput.value = data.device || device;
    els.deviceInput.dataset.lastSaved = els.deviceInput.value;
    if (data.broker) els.brokerValue.textContent = data.broker;
    addLog(data.message || `Device 已保存为 ${device}`);
    refreshStatus();
  } catch (error) {
    addLog(`Device 保存失败: ${error.message}`, "red");
  } finally {
    setLoading(els.saveDeviceBtn, false);
  }
}

async function saveApiKey(clear = false) {
  setLoading(els.saveApiKeyBtn, true);
  setLoading(els.clearApiKeyBtn, true);
  try {
    const response = await fetch("/api/settings/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: clear ? "" : els.apiKeyInput.value.trim(),
        provider: els.apiProviderSelect.value,
        base_url: els.apiBaseUrlInput.value.trim(),
        model: els.apiModelInput.value.trim(),
      }),
    });
    const data = await response.json();
    els.apiKeyInput.value = "";
    const providerLabel = providerDefaults[els.apiProviderSelect.value]?.label || "AI";
    els.apiKeyStatus.textContent = data.has_api_key ? `${providerLabel} READY` : "LOCAL RULES";
    els.apiKeyStatus.classList.toggle("error", !data.has_api_key);
    addLog(data.has_api_key ? `${providerLabel} API Key 已本地保存` : "API Key 已从本地清除");
  } catch (error) {
    addLog(`API Key 配置失败: ${error.message}`, "red");
  } finally {
    setLoading(els.saveApiKeyBtn, false);
    setLoading(els.clearApiKeyBtn, false);
  }
}

function applyProviderDefaults(provider) {
  const defaults = providerDefaults[provider] || providerDefaults.custom;
  els.apiBaseUrlInput.value = defaults.baseUrl;
  els.apiModelInput.value = defaults.model;
}

async function sendAgentMessage() {
  const message = els.agentPrompt.value.trim();
  if (!message) return;
  appendChatMessage("user", message, "YOU");
  const reply = appendChatMessage("agent pending", "AI 正在分析指令", "AI");
  els.agentPrompt.value = "";
  setLoading(els.sendAgentBtn, true);
  try {
    const response = await fetch("/api/ai-agent/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!response.body) throw new Error("浏览器不支持流式读取");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let started = false;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "wait" && !started && reply?.body) {
          reply.body.textContent = event.message || "AI 正在分析指令";
        }
        if (event.type === "delta" && reply?.body) {
          if (!started) {
            started = true;
            reply.item.classList.remove("pending");
            reply.body.textContent = "";
          }
          reply.body.textContent += event.text || "";
          els.chatLog.scrollTop = els.chatLog.scrollHeight;
        }
        if (event.type === "done") {
          if (!started && reply?.item && reply?.body) {
            reply.item.classList.remove("pending");
            reply.body.textContent = "AIagent 没有返回内容";
          }
          if (reply?.item && event.ok === false) reply.item.classList.add("error");
          addLog(`AIagent: ${event.intent || "unknown"}`, event.ok ? "cyan" : "red");
          if (event.status) applyStatus(event.status);
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (reply?.item && reply?.body) {
      reply.item.classList.remove("pending", "agent");
      reply.item.classList.add("error");
      reply.body.textContent = `请求失败: ${error.message}`;
    } else {
      appendChatMessage("error", `请求失败: ${error.message}`, "ERROR");
    }
    addLog(`AIagent 请求失败: ${error.message}`, "red");
  } finally {
    setLoading(els.sendAgentBtn, false);
  }
}

function applyStatus(data, latency = null) {
  if (!data.ok) {
    els.linkStatus.textContent = "MQTT ERROR";
    els.linkStatus.classList.add("error");
    els.stateValue.textContent = "ERROR";
    els.stateValue.classList.add("error");
    if (data.error) addLog(data.error, "red");
    return;
  }

  els.linkStatus.textContent = "MQTT SYNC";
  if (data.mock) els.linkStatus.textContent = "MOCK SYNC";
  if (data.stale) els.linkStatus.textContent = "STALE DATA";
  els.linkStatus.classList.remove("error");
  els.stateValue.textContent = "CONNECTED";
  els.stateValue.classList.remove("error");
  els.brokerValue.textContent = data.broker;
  els.deviceInput.value = data.device;
  els.deviceInput.dataset.lastSaved = data.device;
  els.onThreshold.textContent = Number(data.thresholds.on).toFixed(1);
  els.offThreshold.textContent = Number(data.thresholds.off).toFixed(1);
  if (latency !== null) els.latencyValue.textContent = `${latency} ms`;

  if (typeof data.temperature_c === "number") {
    state.temperature = data.temperature_c;
    state.history.push(data.temperature_c);
    state.history = state.history.slice(-44);
    const raw = Math.round(data.temperature_c * 100);
    state.lastMw.MW0 = raw;
    els.temperatureValue.textContent = data.temperature_c.toFixed(1);
    els.rawMw0.textContent = raw;
    els.mw0.textContent = raw;
    els.streamTemp.textContent = `${data.temperature_c.toFixed(1)}°C`;
  }

  if (typeof data.cooling_on === "boolean") {
    state.coolingOn = data.cooling_on;
    state.lastMw.MW20 = data.cooling_on ? 1 : 0;
  }

  if (data.registers) {
    state.lastMw.MW0 = data.registers.MW0 ?? state.lastMw.MW0;
    state.lastMw.MW20 = data.registers.MW20 ?? state.lastMw.MW20;
    state.lastMw.MW21 = data.registers.MW21 ?? state.lastMw.MW21;
    state.lastMw.MW22 = data.registers.MW22 ?? state.lastMw.MW22;
    if (data.registers.MW21 !== undefined) {
      applyControlMode(Number(data.registers.MW21) === 1 ? "auto" : "manual");
    }
  }

  els.mw20.textContent = state.lastMw.MW20 ?? "--";
  els.mw21.textContent = state.lastMw.MW21 ?? "--";
  els.mw22.textContent = state.lastMw.MW22 ?? "--";
  drawSparkline();
}

async function refreshStatus() {
  const started = performance.now();
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    applyStatus(data, Math.round(performance.now() - started));
  } catch (error) {
    addLog(`状态读取失败: ${error.message}`, "red");
  }
}

function drawSparkline() {
  const canvas = els.sparkline;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0,217,255,.16)";
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 22) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 10; y < h; y += 22) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const min = 20;
  const max = 40;
  ctx.strokeStyle = "#ff3148";
  ctx.lineWidth = 2;
  ctx.beginPath();
  state.history.forEach((value, index) => {
    const x = (index / Math.max(1, state.history.length - 1)) * w;
    const y = h - ((value - min) / (max - min)) * h;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function updateClock() {
  const now = new Date();
  els.clock.textContent = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  els.systemLoad.textContent = `${Math.round(10 + Math.abs(Math.sin(now.getTime() / 4000)) * 18)}%`;
}

function makeGlowTexture({ inner = "#fff6ff", mid = "#ff3048", outer = "rgba(255,48,72,0)" } = {}) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.22, mid);
  gradient.addColorStop(0.56, "rgba(255,48,72,.34)");
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeHeatmapTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 1100;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return { canvas, ctx: canvas.getContext("2d"), texture };
}

function makeBackThermalTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 960;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return { canvas, ctx: canvas.getContext("2d"), texture };
}

function paintBackThermalTexture(target, heat, t) {
  const { canvas, ctx, texture } = target;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w * (0.52 + Math.sin(t * 0.45) * 0.025);
  const cy = h * (0.52 + Math.cos(t * 0.38) * 0.035);
  const rx = w * (0.34 + heat * 0.08);
  const ry = h * (0.28 + heat * 0.08);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.sin(t * 0.22) * 0.08);
  ctx.scale(1, ry / rx);
  const blob = ctx.createRadialGradient(0, 0, rx * 0.06, 0, 0, rx);
  blob.addColorStop(0, `rgba(255, 32, 48, ${0.7 + heat * 0.16})`);
  blob.addColorStop(0.32, `rgba(255, 196, 36, ${0.62 + heat * 0.12})`);
  blob.addColorStop(0.62, `rgba(70, 255, 118, ${0.48 + heat * 0.08})`);
  blob.addColorStop(0.86, "rgba(10, 208, 112, 0.18)");
  blob.addColorStop(1, "rgba(10, 208, 112, 0)");
  ctx.fillStyle = blob;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, rx, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const hotX = w * (0.42 + Math.sin(t * 0.8) * 0.035);
  const hotY = h * (0.55 + Math.cos(t * 0.6) * 0.025);
  const hot = ctx.createRadialGradient(hotX, hotY, 4, hotX, hotY, w * (0.12 + heat * 0.06));
  hot.addColorStop(0, `rgba(255, 245, 195, ${0.7 + heat * 0.18})`);
  hot.addColorStop(0.34, `rgba(255, 56, 42, ${0.42 + heat * 0.18})`);
  hot.addColorStop(1, "rgba(255, 56, 42, 0)");
  ctx.fillStyle = hot;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.11)";
  ctx.lineWidth = 1.4;
  for (let y = h * 0.18; y < h * 0.85; y += 68) {
    ctx.beginPath();
    ctx.moveTo(w * 0.16, y + Math.sin(t + y * 0.01) * 3);
    ctx.lineTo(w * 0.84, y - 12 + Math.cos(t + y * 0.01) * 3);
    ctx.stroke();
  }

  texture.needsUpdate = true;
}

function paintHeatmapTexture(target, heat, t) {
  const { canvas, ctx, texture } = target;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, `rgba(${120 + heat * 90}, 18, 28, .92)`);
  base.addColorStop(0.32, `rgba(${190 + heat * 45}, 18, 32, .96)`);
  base.addColorStop(0.7, `rgba(${255}, 42, 56, .96)`);
  base.addColorStop(1, "rgba(120, 12, 24, .92)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 4; i += 1) {
    const y = h * (0.2 + i * 0.18) + Math.sin(t * 0.8 + i) * 18;
    const radiusX = w * (0.55 + heat * 0.25 + i * 0.08);
    const radiusY = h * (0.12 + heat * 0.05);
    const band = ctx.createRadialGradient(w * 0.48, y, 20, w * 0.48, y, radiusX);
    band.addColorStop(0, `rgba(255, 82, 96, ${0.22 + heat * 0.13})`);
    band.addColorStop(0.55, `rgba(255, 49, 72, ${0.12 + heat * 0.07})`);
    band.addColorStop(1, "rgba(255,49,72,0)");
    ctx.save();
    ctx.scale(1, radiusY / radiusX);
    ctx.fillStyle = band;
    ctx.fillRect(-w, (y - radiusX) / (radiusY / radiusX), w * 3, (radiusX * 2) / (radiusY / radiusX));
    ctx.restore();
  }

  const cx = w * (0.5 + Math.sin(t * 0.65) * 0.035);
  const cy = h * (0.56 + Math.cos(t * 0.5) * 0.03);
  const coreRadius = w * (0.18 + heat * 0.18);
  const core = ctx.createRadialGradient(cx, cy, 6, cx, cy, coreRadius);
  core.addColorStop(0, "rgba(255,255,255,.98)");
  core.addColorStop(0.22, "rgba(255,245,255,.92)");
  core.addColorStop(0.46, `rgba(255,86,98,${0.62 + heat * 0.15})`);
  core.addColorStop(1, "rgba(255,49,72,0)");
  ctx.save();
  ctx.scale(1.22, 0.62);
  ctx.fillStyle = core;
  ctx.fillRect(-w, (cy - coreRadius) / 0.62, w * 3, (coreRadius * 2) / 0.62);
  ctx.restore();

  ctx.strokeStyle = "rgba(255,130,140,.18)";
  ctx.lineWidth = 2;
  for (let x = 58; x < w; x += 58) {
    ctx.beginPath();
    ctx.moveTo(x + Math.sin(t + x * 0.01) * 4, 0);
    ctx.lineTo(x - 20 + Math.cos(t + x * 0.01) * 4, h);
    ctx.stroke();
  }
  for (let y = 65; y < h; y += 72) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(t + y * 0.01) * 5);
    ctx.lineTo(w, y - 32 + Math.cos(t + y * 0.01) * 5);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, 82 + heat * 42, 40 + heat * 18, 0, 0, Math.PI * 2);
  ctx.fill();

  texture.needsUpdate = true;
}

function makeArcLine(radiusX, radiusY, start, end, color, opacity, z = 0) {
  const points = [];
  const steps = 160;
  for (let i = 0; i <= steps; i += 1) {
    const p = i / steps;
    const angle = start + (end - start) * p;
    points.push(new THREE.Vector3(Math.cos(angle) * radiusX, Math.sin(angle) * radiusY, z));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
}

function initThreeScene() {
  const canvas = els.sceneCanvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0.2, 0.28, 8.8);

  const group = new THREE.Group();
  group.rotation.set(-0.08, -0.44, -0.018);
  group.position.y = -0.1;
  scene.add(group);

  const ambient = new THREE.AmbientLight(0x6aeaff, 0.42);
  scene.add(ambient);
  const redLight = new THREE.PointLight(0xff3148, 10, 10);
  redLight.position.set(0.2, 0.1, 2.2);
  scene.add(redLight);
  const cyanLight = new THREE.PointLight(0x00d9ff, 4.5, 9);
  cyanLight.position.set(-2.9, -1.6, 2.4);
  scene.add(cyanLight);

  const bodyShape = roundedRectShape(2.52, 5.18, 0.38);
  const phoneBody = new THREE.Mesh(
    new THREE.ExtrudeGeometry(bodyShape, {
      depth: 0.48,
      bevelEnabled: true,
      bevelSize: 0.055,
      bevelThickness: 0.07,
      bevelSegments: 12,
      curveSegments: 32,
    }),
    new THREE.MeshPhysicalMaterial({
      color: 0x10151e,
      metalness: 0.82,
      roughness: 0.18,
      clearcoat: 0.9,
      emissive: 0x04131a,
      emissiveIntensity: 0.35,
    }),
  );
  phoneBody.position.z = -0.24;
  phoneBody.castShadow = false;
  group.add(phoneBody);

  const backGlass = roundedPlane(
    2.36,
    5.02,
    0.32,
    new THREE.MeshPhysicalMaterial({
      color: 0x080b11,
      roughness: 0.08,
      metalness: 0.15,
      clearcoat: 1,
      transparent: true,
      opacity: 0.38,
    }),
  );
  backGlass.position.z = -0.255;
  group.add(backGlass);

  const heatmap = makeHeatmapTexture();
  const bezel = roundedPlane(
    2.18,
    4.74,
    0.28,
    new THREE.MeshBasicMaterial({
      color: 0x030407,
      transparent: true,
      opacity: 0.98,
    }),
  );
  bezel.position.z = 0.19;
  group.add(bezel);

  const glass = roundedPlane(
    2.02,
    4.54,
    0.23,
    new THREE.MeshPhysicalMaterial({
      color: 0x05080d,
      metalness: 0.05,
      roughness: 0.03,
      clearcoat: 1,
      transmission: 0.2,
      transparent: true,
      opacity: 0.92,
    }),
  );
  glass.position.z = 0.208;
  group.add(glass);

  const screen = roundedPlane(
    1.9,
    4.33,
    0.2,
    new THREE.MeshBasicMaterial({
      map: heatmap.texture,
      transparent: true,
      opacity: 0.76,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    36,
  );
  screen.position.z = 0.224;
  group.add(screen);

  const glassSheen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 4.4),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glassSheen.position.set(-0.55, 0.05, 0.238);
  glassSheen.rotation.z = -0.12;
  group.add(glassSheen);

  const dynamicIsland = roundedPlane(
    0.72,
    0.18,
    0.09,
    new THREE.MeshBasicMaterial({
      color: 0x010204,
      transparent: true,
      opacity: 1,
    }),
  );
  dynamicIsland.position.set(0, 2.02, 0.252);
  group.add(dynamicIsland);

  const earpiece = roundedPlane(
    0.32,
    0.026,
    0.013,
    new THREE.MeshBasicMaterial({
      color: 0x0bdcff,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    }),
  );
  earpiece.position.set(0, 2.02, 0.258);
  group.add(earpiece);

  const frontCamera = new THREE.Mesh(
    new THREE.CircleGeometry(0.035, 24),
    new THREE.MeshBasicMaterial({
      color: 0x06151d,
      transparent: true,
      opacity: 0.95,
    }),
  );
  frontCamera.position.set(0.22, 2.02, 0.26);
  group.add(frontCamera);

  const homeIndicator = roundedPlane(
    0.52,
    0.035,
    0.018,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
    }),
  );
  homeIndicator.position.set(0, -2.06, 0.256);
  group.add(homeIndicator);

  const cameraIsland = roundedPlane(
    0.68,
    0.68,
    0.16,
    new THREE.MeshPhysicalMaterial({
      color: 0x171c24,
      metalness: 0.65,
      roughness: 0.18,
      clearcoat: 1,
      transparent: true,
      opacity: 0.82,
    }),
  );
  cameraIsland.position.set(-0.62, 1.78, -0.31);
  group.add(cameraIsland);

  [
    [-0.76, 1.91],
    [-0.5, 1.91],
    [-0.63, 1.64],
  ].forEach(([x, y]) => {
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.105, 0.105, 0.045, 36),
      new THREE.MeshPhysicalMaterial({
        color: 0x05070a,
        metalness: 0.3,
        roughness: 0.05,
        clearcoat: 1,
        emissive: 0x00152a,
        emissiveIntensity: 0.2,
      }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(x, y, -0.34);
    group.add(lens);
    const lensGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.052, 24),
      new THREE.MeshBasicMaterial({ color: 0x00d9ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending }),
    );
    lensGlow.position.set(x - 0.012, y + 0.01, -0.366);
    group.add(lensGlow);
  });

  const sideMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x1a1720,
    metalness: 0.9,
    roughness: 0.18,
    emissive: 0x001219,
    emissiveIntensity: 0.4,
  });
  [
    { x: -1.31, y: 1.22, h: 0.5 },
    { x: -1.31, y: 0.5, h: 0.4 },
    { x: 1.31, y: 0.94, h: 0.66 },
  ].forEach((button) => {
    const buttonMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, button.h, 0.16), sideMaterial);
    buttonMesh.position.set(button.x, button.y, 0.02);
    group.add(buttonMesh);
  });

  const rim = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      roundedRectShape(2.56, 5.22, 0.4).getPoints(160).map((point) => new THREE.Vector3(point.x, point.y, 0.266)),
    ),
    new THREE.LineBasicMaterial({ color: 0x00d9ff, transparent: true, opacity: 0.5 }),
  );
  group.add(rim);

  const glowTexture = makeGlowTexture();
  const whiteGlowTexture = makeGlowTexture({ inner: "#ffffff", mid: "rgba(255,244,255,.82)" });
  const heatLayers = [];
  for (let i = 0; i < 8; i += 1) {
    const layer = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 1, 1),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: i % 2 ? 0xff3148 : 0xff1429,
        transparent: true,
        opacity: 0.22 - i * 0.016,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    layer.position.set(0, -0.05, 0.19 + i * 0.008);
    group.add(layer);
    heatLayers.push(layer);
  }

  const hotCore = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: whiteGlowTexture,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  hotCore.position.set(0, -0.25, 0.24);
  group.add(hotCore);

  const gridMaterial = new THREE.LineBasicMaterial({ color: 0xff5968, transparent: true, opacity: 0.32 });
  const grid = new THREE.Group();
  for (let x = -0.92; x <= 0.96; x += 0.18) {
    const points = [new THREE.Vector3(x, -2.08, 0.226), new THREE.Vector3(x - 0.18, 2.08, 0.226)];
    grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), gridMaterial));
  }
  for (let y = -2.05; y <= 2.1; y += 0.26) {
    const points = [new THREE.Vector3(-0.95, y, 0.226), new THREE.Vector3(0.95, y - 0.08, 0.226)];
    grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), gridMaterial));
  }
  group.add(grid);

  const bay = new THREE.Group();
  scene.add(bay);
  const baseRings = [];
  for (let i = 0; i < 5; i += 1) {
    const ring = makeArcLine(2.05 + i * 0.26, 0.36 + i * 0.035, 0, Math.PI * 2, 0x00d9ff, 0.42 - i * 0.05, 0);
    ring.position.y = -2.15 - i * 0.025;
    ring.position.z = 0.1;
    bay.add(ring);
    baseRings.push(ring);
  }
  for (let i = 0; i < 4; i += 1) {
    const arc = makeArcLine(4.8 + i * 0.35, 3.7 + i * 0.18, Math.PI * 0.82, Math.PI * 1.24, 0x00d9ff, 0.7 - i * 0.12, -0.6);
    arc.position.x = -3.2 - i * 0.12;
    arc.position.y = -0.2 - i * 0.08;
    bay.add(arc);
  }

  const particles = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      color: 0xff3148,
      size: 0.045,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const particleCount = 150;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleSeeds = [];
  for (let i = 0; i < particleCount; i += 1) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 7.4;
    particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 4.9;
    particlePositions[i * 3 + 2] = -0.6 + Math.random() * 1.9;
    particleSeeds.push(Math.random() * 100);
  }
  particles.geometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  scene.add(particles);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  function animate(time) {
    const t = time / 1000;
    const normalizedHeat = THREE.MathUtils.clamp((state.temperature - 18) / 24, 0.12, 1.45);
    paintHeatmapTexture(heatmap, normalizedHeat, t);
    group.rotation.y = -0.44 + Math.sin(t * 0.48) * 0.09;
    group.rotation.x = -0.08 + Math.sin(t * 0.32) * 0.02;
    group.position.y = Math.sin(t * 0.8) * 0.08;
    redLight.intensity = 5 + normalizedHeat * 9 + Math.sin(t * 4) * 0.75;
    screen.material.opacity = 0.82 + normalizedHeat * 0.12;
    glassSheen.position.x = -0.68 + ((t * 0.18) % 1.4);
    hotCore.scale.set(0.62 + normalizedHeat * 1.05, 0.34 + normalizedHeat * 0.45, 1);
    hotCore.material.opacity = 0.6 + normalizedHeat * 0.34;
    heatLayers.forEach((layer, index) => {
      const pulse = 1 + Math.sin(t * (1.15 + index * 0.08) + index * 0.9) * 0.09;
      const heatScale = normalizedHeat * (1 + index * 0.16);
      layer.scale.set((1.25 + heatScale * 1.7 + index * 0.28) * pulse, (0.62 + heatScale * 0.82 + index * 0.1) * pulse, 1);
      layer.material.opacity = Math.max(0.035, 0.16 + normalizedHeat * 0.16 - index * 0.022);
      layer.rotation.z = Math.sin(t * 0.3 + index) * 0.12;
    });
    bay.rotation.z = Math.sin(t * 0.16) * 0.015;
    baseRings.forEach((ring, index) => {
      ring.scale.x = 1 + Math.sin(t * 1.4 + index) * 0.025;
      ring.material.opacity = 0.25 + Math.sin(t * 1.8 + index) * 0.08;
    });
    const positions = particles.geometry.attributes.position.array;
    for (let i = 0; i < particleCount; i += 1) {
      const yIndex = i * 3 + 1;
      const xIndex = i * 3;
      positions[yIndex] += 0.006 + normalizedHeat * 0.006 + (particleSeeds[i] % 0.004);
      positions[xIndex] += Math.sin(t + particleSeeds[i]) * 0.0009;
      if (positions[yIndex] > 2.55) {
        positions[yIndex] = -2.55;
        positions[xIndex] = (Math.random() - 0.5) * 7.4;
      }
    }
    particles.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

function initModelScene() {
  const canvas = els.sceneCanvas;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0.22, 0.22, 9.7);

  const rig = new THREE.Group();
  rig.rotation.set(-0.08, -0.42, -0.015);
  rig.position.y = 0.18;
  scene.add(rig);
  let targetRotationX = -0.08;
  let targetRotationY = -0.42;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartRotationX = targetRotationX;
  let dragStartRotationY = targetRotationY;
  const pointer = {
    active: false,
    x: 0,
    y: 0,
    sceneX: 0,
    sceneY: 0,
  };

  const modelRoot = new THREE.Group();
  rig.add(modelRoot);

  const ambient = new THREE.HemisphereLight(0x95edff, 0x23080d, 1.35);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(2.5, 3.2, 4.2);
  scene.add(keyLight);

  const cyanLight = new THREE.PointLight(0x00d9ff, 8, 9);
  cyanLight.position.set(-2.7, -1.6, 2.4);
  scene.add(cyanLight);

  const redLight = new THREE.PointLight(0xff3148, 12, 10);
  redLight.position.set(0.3, 0.1, 2.4);
  scene.add(redLight);

  const fallbackPhone = new THREE.Group();
  fallbackPhone.visible = true;
  modelRoot.add(fallbackPhone);
  const fallbackBody = new THREE.Mesh(
    new THREE.BoxGeometry(2.05, 4.45, 0.34, 6, 16, 3),
    new THREE.MeshPhysicalMaterial({
      color: 0x111820,
      metalness: 0.8,
      roughness: 0.18,
      clearcoat: 1,
      emissive: 0x001117,
      emissiveIntensity: 0.25,
    }),
  );
  fallbackPhone.add(fallbackBody);
  const fallbackScreen = roundedPlane(
    1.76,
    4.05,
    0.18,
    new THREE.MeshBasicMaterial({ color: 0x05070a }),
  );
  fallbackScreen.position.z = 0.19;
  fallbackPhone.add(fallbackScreen);

  const backThermal = makeBackThermalTexture();
  const thermalPatch = roundedPlane(
    1.48,
    3.18,
    0.2,
    new THREE.MeshBasicMaterial({
      map: backThermal.texture,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    36,
  );
  thermalPatch.position.set(0.12, -0.28, 0.012);
  thermalPatch.renderOrder = 6;
  fallbackPhone.add(thermalPatch);
  let thermalPatchBaseScale = 1;

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/gltf/");
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.load(
    "/static/assets/phone.glb",
    (gltf) => {
      fallbackPhone.visible = false;
      const model = gltf.scene;
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = false;
        object.receiveShadow = false;
        if (object.material) {
          object.material = object.material.clone();
          object.material.envMapIntensity = 1.4;
          object.material.needsUpdate = true;
        }
      });

      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      model.position.sub(center);
      const scale = 4.05 / Math.max(size.x, size.y, size.z);
      model.scale.setScalar(scale);
      model.rotation.set(0, 0, 0);
      modelRoot.add(model);

      const normalizedBox = new THREE.Box3().setFromObject(modelRoot);
      const normalizedSize = new THREE.Vector3();
      normalizedBox.getSize(normalizedSize);
      if (normalizedSize.x > normalizedSize.y) {
        model.rotation.z = Math.PI / 2;
      }
      thermalPatchBaseScale = 1 / scale;
      thermalPatch.position.set(0.12 / scale, -0.28 / scale, 0.022 / scale);
      thermalPatch.rotation.set(0, 0, 0);
      thermalPatch.scale.setScalar(thermalPatchBaseScale);
      model.add(thermalPatch);
      addLog("真实 GLB 手机模型已载入");
    },
    undefined,
    (error) => {
      addLog(`手机模型载入失败，使用备用模型: ${error.message || error}`, "red");
    },
  );

  const bay = new THREE.Group();
  scene.add(bay);
  const baseRings = [];
  for (let i = 0; i < 5; i += 1) {
    const arc = makeArcLine(4.9 + i * 0.32, 3.7 + i * 0.16, Math.PI * 0.82, Math.PI * 1.24, 0x00d9ff, 0.76 - i * 0.1, -0.7);
    arc.position.x = -3.25 - i * 0.1;
    arc.position.y = -0.18 - i * 0.07;
    bay.add(arc);
  }

  const particleCount = 170;
  const positions = new Float32Array(particleCount * 3);
  const basePositions = new Float32Array(particleCount * 3);
  const velocities = new Float32Array(particleCount * 3);
  const orbitPhases = new Float32Array(particleCount);
  const orbitSpeeds = new Float32Array(particleCount);
  const orbitLanes = new Float32Array(particleCount);
  const seeds = [];
  for (let i = 0; i < particleCount; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 7.5;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 5;
    positions[i * 3 + 2] = -0.8 + Math.random() * 2.1;
    basePositions[i * 3] = positions[i * 3];
    basePositions[i * 3 + 1] = positions[i * 3 + 1];
    basePositions[i * 3 + 2] = positions[i * 3 + 2];
    velocities[i * 3] = (Math.random() - 0.5) * 0.0024;
    velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.0024;
    velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.0012;
    const seed = Math.random() * 100;
    seeds.push(seed);
    orbitPhases[i] = seed * Math.PI * 2;
    orbitSpeeds[i] = 2.4 + Math.random() * 1.65;
    orbitLanes[i] = Math.random();
  }
  const particles = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({
      color: 0xff3148,
      size: 0.045,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const particleHotColor = new THREE.Color(0xff3148);
  const particleCoolingColor = new THREE.Color(0x20e8ff);
  scene.add(particles);

  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerenter", () => {
    pointer.active = true;
  });
  canvas.addEventListener("pointerleave", () => {
    pointer.active = false;
    isDragging = false;
    canvas.style.cursor = "grab";
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = (event.clientY - rect.top) / rect.height;
    pointer.sceneX = (pointer.x - 0.5) * 5.2;
    pointer.sceneY = (0.5 - pointer.y) * 3.7;

    if (!isDragging) return;
    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    targetRotationY = dragStartRotationY + dx * 0.006;
    targetRotationX = THREE.MathUtils.clamp(dragStartRotationX + dy * 0.004, -0.42, 0.24);
  });
  canvas.addEventListener("pointerdown", (event) => {
    isDragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartRotationX = targetRotationX;
    dragStartRotationY = targetRotationY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("pointerup", (event) => {
    isDragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.style.cursor = "grab";
  });

  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / Math.max(1, rect.height);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();
  let lastFrameTime = 0;

  function animate(time) {
    const t = time / 1000;
    const delta = lastFrameTime ? Math.min(0.033, Math.max(0.001, t - lastFrameTime)) : 0.016;
    lastFrameTime = t;
    const heat = THREE.MathUtils.clamp((state.temperature - 18) / 24, 0.12, 1.45);
    paintBackThermalTexture(backThermal, heat, t);

    if (!isDragging) {
      targetRotationY += Math.sin(t * 0.45) * 0.0008;
      targetRotationX += Math.sin(t * 0.35) * 0.00018;
    }
    rig.rotation.y += (targetRotationY - rig.rotation.y) * 0.08;
    rig.rotation.x += (targetRotationX - rig.rotation.x) * 0.08;
    rig.position.y = 0.18 + Math.sin(t * 0.76) * 0.04;

    redLight.intensity = 3 + heat * 4 + Math.sin(t * 4) * 0.35;
    thermalPatch.material.opacity = 0.74 + heat * 0.14;
    thermalPatch.scale.setScalar(thermalPatchBaseScale * (0.98 + heat * 0.018 + Math.sin(t * 1.2) * 0.003));
    baseRings.forEach((ring, index) => {
      ring.scale.x = 1 + Math.sin(t * 1.4 + index) * 0.025;
      ring.material.opacity = 0.24 + Math.sin(t * 1.8 + index) * 0.08;
    });

    const attr = particles.geometry.attributes.position;
    const coolingActive = state.coolingOn === true;
    particles.material.color.lerp(coolingActive ? particleCoolingColor : particleHotColor, 0.08);
    particles.material.size += ((coolingActive ? 0.058 : 0.045) - particles.material.size) * 0.08;
    particles.material.opacity += ((coolingActive ? 0.98 : 0.82) - particles.material.opacity) * 0.08;
    for (let i = 0; i < particleCount; i += 1) {
      const xIndex = i * 3;
      const yIndex = i * 3 + 1;
      const zIndex = i * 3 + 2;
      const seed = seeds[i];
      const homeX = basePositions[xIndex] + Math.sin(t * 0.17 + seed) * 0.18;
      const homeY = basePositions[yIndex] + Math.cos(t * 0.13 + seed * 0.7) * 0.16;
      const homeZ = basePositions[zIndex] + Math.sin(t * 0.11 + seed * 0.4) * 0.08;
      let targetX = homeX;
      let targetY = homeY;
      let targetZ = homeZ;
      if (coolingActive) {
        const lane = orbitLanes[i];
        orbitPhases[i] += orbitSpeeds[i] * (1 + heat * 0.16 + lane * 0.16) * delta;
        const angle = orbitPhases[i];
        const radius = 1.55 + lane * 0.88;
        targetX = Math.cos(angle) * radius;
        targetY = Math.sin(seed * 2.31 + angle * (0.28 + lane * 0.08)) * 2.08;
        targetZ = Math.sin(angle) * 0.82 + 0.18;
        attr.array[xIndex] += (targetX - attr.array[xIndex]) * 0.14;
        attr.array[yIndex] += (targetY - attr.array[yIndex]) * 0.14;
        attr.array[zIndex] += (targetZ - attr.array[zIndex]) * 0.14;
        continue;
      }
      if (pointer.active) {
        const dx = attr.array[xIndex] - pointer.sceneX;
        const dy = attr.array[yIndex] - pointer.sceneY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const pull = Math.max(0, 1 - distance / 2.6);
        targetX = homeX * (1 - pull * 0.72) + pointer.sceneX * pull * 0.72;
        targetY = homeY * (1 - pull * 0.72) + pointer.sceneY * pull * 0.72;
        targetZ = homeZ + pull * 0.55;
      }
      attr.array[xIndex] += (targetX - attr.array[xIndex]) * 0.018 + velocities[xIndex];
      attr.array[yIndex] += (targetY - attr.array[yIndex]) * 0.018 + velocities[yIndex];
      attr.array[zIndex] += (targetZ - attr.array[zIndex]) * 0.018 + velocities[zIndex];

      if (attr.array[xIndex] > 3.85 || attr.array[xIndex] < -3.85) velocities[xIndex] *= -1;
      if (attr.array[yIndex] > 2.6 || attr.array[yIndex] < -2.6) velocities[yIndex] *= -1;
      if (attr.array[zIndex] > 1.4 || attr.array[zIndex] < -0.9) velocities[zIndex] *= -1;
    }
    attr.needsUpdate = true;

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

document.querySelector("#coolingOnBtn").addEventListener("click", () => {
  if (state.controlMode === "auto") return;
  state.coolingOn = true;
  state.lastMw.MW21 = 0;
  state.lastMw.MW20 = 1;
  state.lastMw.MW22 = 1;
  command("manual-on");
});
document.querySelector("#coolingOffBtn").addEventListener("click", () => {
  if (state.controlMode === "auto") return;
  state.coolingOn = false;
  state.lastMw.MW21 = 0;
  state.lastMw.MW22 = 0;
  state.lastMw.MW20 = 0;
  command("manual-off");
});
document.querySelector("#autoOnceBtn").addEventListener("click", () => {
  applyControlMode("auto");
  state.lastMw.MW21 = 1;
  command("auto-once");
});
document.querySelector("#manualModeBtn").addEventListener("click", () => {
  applyControlMode("manual");
  state.lastMw.MW21 = 0;
  command("manual-mode");
});
els.saveApiKeyBtn.addEventListener("click", () => saveApiKey(false));
els.clearApiKeyBtn.addEventListener("click", () => saveApiKey(true));
els.saveDeviceBtn.addEventListener("click", saveDevice);
els.deviceInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveDevice();
});
els.apiProviderSelect.addEventListener("change", () => applyProviderDefaults(els.apiProviderSelect.value));
els.sendAgentBtn.addEventListener("click", sendAgentMessage);
els.agentPrompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    sendAgentMessage();
  }
});
document.querySelector("#clearLogBtn").addEventListener("click", () => {
  state.logs = [];
  els.commandLog.innerHTML = "";
});

setInterval(updateClock, 1000);
setInterval(refreshStatus, 3000);
updateClock();
drawSparkline();
initModelScene();
applyControlMode("manual");
loadSettings();
loadConnectionSettings();
refreshStatus();
appendChatMessage("agent", "我可以读取温度、打开或关闭散热器，也可以按阈值自动判断一次。", "AI");
addLog("Web 中控台已启动");
