(function(){
  "use strict";

  // ---- Settings ----
  const {
    SETTINGS = {},
    APP_VERSION = "v0.90",
    EMAIL_DOMAIN = "us.navy.mil",
    AUTO_SAVE_MS = 400,
    POLL_MS = 5000,
    ABBREV_MAX = 3,
    HIGHLIGHTS = { mine:"#2e7d32", others:"#1f3a93" }
  } = window.AppConfig || {};

  // ---- Shorthands ----
  const { $, $$, pad2, escapeHtml } = window.DOMUtils || {};

  if (typeof $ !== "function" || typeof $$ !== "function" || typeof pad2 !== "function" || typeof escapeHtml !== "function") {
    throw new Error("DOMUtils helpers not initialized");
  }



// Crew Details defaults (top-level; used during initial state)
function mkCrewDetailsDefaults(){
return {
shifts: [
{ turnover:"", mc:"", tc:"", uac:"", sc:"", mpo1:"", mpo2:"" },
{ turnover:"", mc:"", tc:"", uac:"", sc:"", mpo1:"", mpo2:"" },
{ turnover:"", mc:"", tc:"", uac:"", sc:"", mpo1:"", mpo2:"" },
{ turnover:"", mc:"", tc:"", uac:"", sc:"", mpo1:"", mpo2:"" }
]
};
}

  
  // ---- TACREP numbering helpers ----
function getPrefixFromColumnName(columnName){
  const col = document.querySelector(`.column[data-column="${CSS.escape(columnName)}"]`);
  const dl = col?.dataset.letter || columnName[0] || "I";
  return dl.toUpperCase(); // "I", "E", "AIS", etc.
}
function getPrefixFromCode(code){
  return String(code||"").startsWith("AIS") ? "AIS" : String(code||"")[0]?.toUpperCase() || "I";
}
function collectUsedNumbers(prefix){
  // ACTIVE columns only (exclude Deleted/History/Correlations)
  const badges = Array.from(document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .item .badge'));
  const used = new Set();
  for(const b of badges){
    const c = b.textContent.trim();
    if(prefix === "AIS"){
      const m = c.match(/^AIS(\d+)$/);
      if(m) used.add(Number(m[1]));
    } else {
      const m = c.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
      if(m) used.add(Number(m[1]));
    }
  }
  return used;
}
function lowestAvailable(prefix){
  const used = collectUsedNumbers(prefix);
  let n = blockStartNum || 1;  // Start from block start number
  while(used.has(n)) n++;
  return n;
}
function nextHighest(prefix){
  const used = collectUsedNumbers(prefix);
  let max = 0;
  for(const v of used) if(v > max) max = v;
  return max + 1;
}

  // ---- State ----
  let useFS = false, memoryMode = true, fileHandle = null, lastKnownMod = 0;
  let blockStartNum = null, crewPosition = "", dirty = false, isSaving = false, pendingResave = false;
let callsign = "";
let missionNumber = "";
  let crewDetails = mkCrewDetailsDefaults();
let reportedFlag = false; // form-level flag synced with #reportedBtn

  const columnNextNumber = { India:null, Echo:null, AIS:null, Alpha:null, November:null, Golf:null };
  let deletedSetLocal = new Set();
  let suggestions = [];
  let tacrepFormatPrefs = loadTacrepFormatPrefs();
  let exportCsvUrl = null;
  let pendingMode = null;
  let selecting = false;
  const selectedCodes = new Set();

const ALLOWED_ABBREV_FIELDS = ["time","vesselType","sensor","position","course","speed","trackNumber","minVesselLen","systemOrPlatform","emitterName","activityOrFunction","frequency","additionalInfo"];
const TACREP_TYPES = ["India","Echo","AIS","Alpha","November","Golf","Other"];
const DEFAULT_TACREP_FIELD_ORDER = {
  Echo: ["callsign","timeHHMM","systemOrPlatform","emitterName","activityOrFunction","frequency","position","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  India: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  AIS: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  Alpha: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  November: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  Golf: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"],
  Other: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo","reported"]
};
const TACREP_FIELD_DEFS = {
  callsign: {
    label: "Callsign",
    settingsLabel: "Callsign",
    getValue: () => (typeof callsign === "string" ? callsign : "")
  },
  timeHHMM: {
    label: "Time",
    settingsLabel: "Time (Zulu)",
    getValue: payload => (payload && payload.timeHHMM ? `${payload.timeHHMM}Z` : "")
  },
  position: {
    label: "Pos",
    settingsLabel: "Position",
    getValue: payload => {
      try { return buildPosDisplay(payload || {}); } catch { return ""; }
    }
  },
  systemOrPlatform: {
    label: "System/Platform",
    settingsLabel: "System or Platform",
    getValue: payload => (payload?.systemOrPlatform || "")
  },
  emitterName: {
    label: "Emitter",
    settingsLabel: "Emitter Name",
    getValue: payload => (payload?.emitterName || "")
  },
  activityOrFunction: {
    label: "Activity/Function",
    settingsLabel: "Activity or Function",
    getValue: payload => (payload?.activityOrFunction || "")
  },
  frequency: {
    label: "Frequency",
    settingsLabel: "Frequency",
    getValue: payload => (payload?.frequency || "")
  },
  vesselType: {
    label: "Vessel",
    settingsLabel: "Vessel Type",
    getValue: payload => (payload?.vesselType || "")
  },
  sensor: {
    label: "Sensor",
    settingsLabel: "Sensor",
    getValue: payload => (payload?.sensor || "")
  },
  course: {
    label: "Course",
    settingsLabel: "Course",
    getValue: payload => (payload?.course || "")
  },
  speed: {
    label: "Speed",
    settingsLabel: "Speed",
    getValue: payload => (payload?.speed || "")
  },
  trackNumber: {
    label: "Track",
    settingsLabel: "Track Number",
    getValue: payload => (payload?.trackNumber || "")
  },
  minVesselLen: {
    label: "MinLen",
    settingsLabel: "Min Vessel Length",
    getValue: payload => (payload?.minVesselLen || "")
  },
  additionalInfo: {
    label: "Info",
    settingsLabel: "Additional Info",
    getValue: payload => (payload?.info || "")
  },
  reported: {
    label: "Reported",
    settingsLabel: "Reported",
    getValue: payload => (typeof payload?.reported === "boolean" ? (payload.reported ? "REPORTED" : "UNREPORTED") : "")
  }
};
const TACREP_FORMAT_STORAGE_KEY = "wf_tacrep_format_v1";

function defaultFieldsForType(type){
  const base = DEFAULT_TACREP_FIELD_ORDER[type] || DEFAULT_TACREP_FIELD_ORDER.Other;
  return Array.isArray(base) ? base.slice() : [];
}

function sanitizeFieldList(type, list){
  const allowed = defaultFieldsForType(type);
  if (!allowed.length) return [];
  const incoming = Array.isArray(list) ? list : [];
  const filtered = [];
  incoming.forEach(key => {
    if (allowed.includes(key) && !filtered.includes(key)) filtered.push(key);
  });
  allowed.forEach(key => {
    if (!filtered.includes(key)) filtered.push(key);
  });
  return filtered;
}

function loadTacrepFormatPrefs(){
  try {
    const raw = localStorage.getItem(TACREP_FORMAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    Object.keys(parsed).forEach(type => {
      out[type] = sanitizeFieldList(type, parsed[type]);
    });
    return out;
  } catch {
    return {};
  }
}

function saveTacrepFormatPrefs(){
  try {
    localStorage.setItem(TACREP_FORMAT_STORAGE_KEY, JSON.stringify(tacrepFormatPrefs));
  } catch {}
}

function getTacrepFieldOrder(type){
  const key = TACREP_TYPES.includes(type) ? type : "Other";
  const current = tacrepFormatPrefs[key];
  if (Array.isArray(current)) return sanitizeFieldList(key, current);
  return defaultFieldsForType(key);
}

function setTacrepFieldOrder(type, order){
  const key = TACREP_TYPES.includes(type) ? type : "Other";
  tacrepFormatPrefs = {
    ...tacrepFormatPrefs,
    [key]: sanitizeFieldList(key, order)
  };
  saveTacrepFormatPrefs();
}

function resetTacrepFormatPrefs(){
  tacrepFormatPrefs = {};
  saveTacrepFormatPrefs();
}

function tacrepTypeFromCode(code){
  if (!code) return "Other";
  const str = String(code).trim();
  if (str.toUpperCase().startsWith("AIS")) return "AIS";
  const first = str[0] ? str[0].toUpperCase() : "";
  return ({ I:"India", E:"Echo", A:"Alpha", N:"November", G:"Golf" }[first]) || "Other";
}

function tacrepFieldDefsForSettings(type){
  const allowed = defaultFieldsForType(type);
  return allowed
    .map(key => ({ key, def: TACREP_FIELD_DEFS[key] }))
    .filter(entry => entry.def);
}

function collectTacrepFields(type, payload){
  const order = getTacrepFieldOrder(type);
  const entries = [];
  order.forEach(key => {
    const def = TACREP_FIELD_DEFS[key];
    if (!def || typeof def.getValue !== "function") return;
    let raw;
    try {
      raw = def.getValue(payload || {});
    } catch {
      raw = "";
    }
    if (raw === undefined || raw === null) return;
    const str = String(raw).trim();
    if (!str) return;
    entries.push({
      key,
      label: def.label || key,
      settingsLabel: def.settingsLabel || def.label || key,
      value: str
    });
  });
  return entries;
}

function getTacrepFieldValues(type, payload){
  const order = getTacrepFieldOrder(type);
  return order.map(key => {
    const def = TACREP_FIELD_DEFS[key];
    if (!def || typeof def.getValue !== "function") return "";
    try {
      const raw = def.getValue(payload || {});
      if (raw === undefined || raw === null) return "";
      return String(raw).trim();
    } catch {
      return "";
    }
  });
}

function getTacrepFieldLabels(type, forSettings = false){
  const order = getTacrepFieldOrder(type);
  return order.map(key => {
    const def = TACREP_FIELD_DEFS[key];
    if (!def) return key;
    if (forSettings) return def.settingsLabel || def.label || key;
    return def.label || key;
  });
}

function buildTacrepFormatModal(){
  const container = document.getElementById("tacrepFormatContainer");
  if (!container) return;
  container.innerHTML = "";

  TACREP_TYPES.forEach(type => {
    const allowed = defaultFieldsForType(type);
    if (!allowed.length) return;

    const block = document.createElement("div");
    block.className = "tacrep-format-block";
    block.dataset.type = type;

    const title = document.createElement("h4");
    title.className = "tacrep-format-heading";
    title.textContent = type;
    block.appendChild(title);

    const row = document.createElement("div");
    row.className = "tacrep-format-row";

    const order = getTacrepFieldOrder(type);
    order.forEach((key, idx) => {
      if (!allowed.includes(key)) return;
      const def = TACREP_FIELD_DEFS[key];
      if (!def) return;

      const fieldEl = document.createElement("div");
      fieldEl.className = "tacrep-format-field";
      fieldEl.dataset.key = key;

      const label = document.createElement("span");
      label.className = "tacrep-format-label";
      label.textContent = def.settingsLabel || def.label || key;
      fieldEl.appendChild(label);

      const controls = document.createElement("div");
      controls.className = "tacrep-format-controls";

      const makeBtn = (dir, text, disabled) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tacrep-format-btn";
        btn.dataset.dir = String(dir);
        btn.textContent = text;
        if (disabled) btn.disabled = true;
        return btn;
      };

      controls.appendChild(makeBtn(-1, "<", idx === 0));
      controls.appendChild(makeBtn(1, ">", idx === order.length - 1));

      fieldEl.appendChild(controls);
      row.appendChild(fieldEl);
    });

    block.appendChild(row);
    container.appendChild(block);
  });
}

function refreshAllTacrepDetails(){
  document.querySelectorAll('.column[data-column] .item').forEach(item => {
    if (item?.querySelector('.badge[data-code]')) {
      renderTacrepDetailsInto(item);
    }
  });
}

function handleTacrepFormatClick(e){
  const btn = e.target && e.target.closest(".tacrep-format-btn");
  if (!btn) return;
  const dir = Number(btn.dataset.dir);
  if (!dir) return;
  const fieldEl = btn.closest(".tacrep-format-field");
  const block = btn.closest(".tacrep-format-block");
  if (!fieldEl || !block) return;

  const type = block.dataset.type || "Other";
  const key = fieldEl.dataset.key;
  if (!key) return;

  const order = getTacrepFieldOrder(type);
  const idx = order.indexOf(key);
  if (idx === -1) return;
  const swapIdx = idx + dir;
  if (swapIdx < 0 || swapIdx >= order.length) return;

  const updated = order.slice();
  [updated[idx], updated[swapIdx]] = [updated[swapIdx], updated[idx]];
  setTacrepFieldOrder(type, updated);
  buildTacrepFormatModal();
  refreshAllTacrepDetails();
}

  
  let abbrevPrefs = loadAbbrevPrefs();

  // ---- Cached nodes ----
  const landing=$("#landing"), app=$("#app"), banner=$("#banner"), fileStatus=$("#fileStatus");
  const downloadJsonBtn=$("#downloadJsonBtn");
  const correlationBtn=$("#correlationBtn");
  const correlationCancelBtn=$("#correlationCancelBtn");
  const selectHint=$("#selectHint");
  const entryModal=$("#entryModal");
  const entryForm=$("#entryForm");
// --- OVERWRITE-ON-EDIT PATCH (prevents "Edit TACREP" from creating a new one) ---
(function installEditOverwriteBehavior(){
const form = document.getElementById("entryForm");
if (!form) return;

function readTacrepFromForm(){
const get = (id)=> (document.getElementById(id)?.value || "").trim();

// Normalize numeric-only fields
const hhmm   = get("timeZuluInput").replace(/\D/g,"").slice(0,4);
const course = get("course").replace(/\D/g,"").slice(0,3);
const speed  = get("speed").replace(/[^0-9.]/g,"");
const minLen = get("minVesselLen").replace(/\D/g,"");

// DMS fields (keep as strings; validation handled elsewhere in app)
const latDeg = get("latDeg").replace(/\D/g,"");
const latMin = get("latMin").replace(/\D/g,"");
const latSec = get("latSec").replace(/\D/g,"").slice(0,2);
const latDecSecStr = get("latDecSec").replace(/\D/g,"").slice(0,2);
const latHem = get("latHem") || "N";

const lonDeg = get("lonDeg").replace(/\D/g,"");
const lonMin = get("lonMin").replace(/\D/g,"");
const lonSec = get("lonSec").replace(/\D/g,"").slice(0,2);
const lonDecSecStr = get("lonDecSec").replace(/\D/g,"").slice(0,2);
const lonHem = get("lonHem") || "E";

// Build legacy decimal-minutes strings for compatibility with existing exporters
function toDecMinStr(minStr, secStr, decSecStr){
  const mm = Number(minStr||"0");
  const ss = Number(secStr||"0");
  const ds = Number(("0."+(decSecStr||"0")).slice(0,4)); // up to 2 dec-sec digits honored
  const total = mm + (ss + ds)/60;
  const whole = Math.floor(total);
  const frac  = total - whole;
  return String(Math.round(frac*1e8)).padStart(8,"0").replace(/0+$/,"");
}
const latDecMinStr = toDecMinStr(latMin, latSec, latDecSecStr);
const lonDecMinStr = toDecMinStr(lonMin, lonSec, lonDecSecStr);

return {
timeHHMM: hhmm,

// Echo-specific (present for all; blank for non-Echo)
systemOrPlatform: get("echoSystem"),
emitterName: get("echoEmitter"),
activityOrFunction: get("echoActivity"),
frequency: (() => {
const num = get("echoFreq").replace(/[^0-9.]/g,"");
const unit = (document.getElementById("echoFreqUnit")?.value || "MHz");
return num ? `${num} ${unit}` : "";

})(),

// Standard fields (used by India/others; hidden for Echo via UI)
vesselType: get("vesselType"),
sensor: get("sensor"),

// Position (DMS + compatibility fields)
latDeg, latMin, latSec, latDecSecStr, latDecMinStr, latHem,
lonDeg, lonMin, lonSec, lonDecSecStr, lonDecMinStr, lonHem,

course,
speed,
trackNumber: get("trackNumber"),
minVesselLen: minLen,

info: get("additionalInfo"),
reported: !!(typeof reportedFlag === "boolean" ? reportedFlag : false)
};


}

function overwriteExistingTacrep(code, newFields){
// Locate existing (active boards only, not Deleted/History/Correlations)
const badge = document.querySelector(
  `.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge[data-code="${CSS.escape(code)}"]`
);

const item = badge ? badge.closest(".item") : null;
if (!item) return false;

// Merge payload, preserve immutable fields if present
const existing = (()=>{ try{ return JSON.parse(item.dataset.payload||"{}"); }catch{ return {}; }})();
const merged = {
  ...existing,
  ...newFields,
  code: code,
  createdBy: existing.createdBy || (window.crewPosition || ""),
  createdAt: existing.createdAt || Date.now(),
  lastModified: Date.now()
};

// Persist data payload
item.dataset.payload = JSON.stringify(merged);

// Update header badge and creator text (leave badge text == code)
if (badge) {
  badge.textContent = merged.code || "";
  badge.setAttribute("data-code", merged.code || "");
}

// CRITICAL FIX: Update the creator line with abbreviations
if (item._renderAbbrev) {
  item._renderAbbrev();
}

  // Update the expanded details view - handled automatically by MutationObserver when dataset.payload changes
  // (Removed direct call to prevent race condition with observer)

// Visual reported state on the tile (if any class is used elsewhere)
item.classList.toggle("reported", !!merged.reported);

return true;
}

// Capture-phase submit handler: if editing, overwrite instead of allowing "create new"
form.addEventListener("submit", async function(e){
const editingCode = (document.getElementById("editingCode")?.value || "").trim();
if (!editingCode) return; // not editing -> let existing handler create new

// We are editing: prevent any other submit handlers from running
e.preventDefault();
if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

try {
  // Build updated fields from the form and overwrite in place
  const updated = readTacrepFromForm();
  // Ensure code remains exactly the same
  updated.code = editingCode;

  const ok = overwriteExistingTacrep(editingCode, updated);

  // Persist and show feedback
  if (ok) {
    dirty = true;
    await syncAndSave();
    showBanner("TACREP updated.");
  } else {
    showBanner("Unable to locate existing TACREP to update.");
  }
} catch(err) {
  console.error("TACREP edit error:", err);
  showBanner("Edit failed. Check console.");
} finally {
  // Always close modal AFTER save completes (or on error)
  closeForm();
}

}, true);
})();
// --- END OVERWRITE-ON-EDIT PATCH ---
// --- ECHO FIELDS: CAPTURE ON SUBMIT + MERGE ON CARD INSERT ---
(function(){
  let pendingEcho = null; // { snapshot, expiresAt }

  function snapshotEchoFromForm(){
    const get = id => (document.getElementById(id)?.value || "").trim();
    const freqNum  = get("echoFreq").replace(/[^0-9.]/g,"");
    const freqUnit = (document.getElementById("echoFreqUnit")?.value || "MHz");
    return {
      systemOrPlatform:   get("echoSystem"),
      emitterName:        get("echoEmitter"),
      activityOrFunction: get("echoActivity"),
      frequency:          freqNum ? `${freqNum} ${freqUnit}` : "",
      timeHHMM:           get("timeZuluInput").replace(/\D/g,"").slice(0,4),
      info:               get("additionalInfo"),
      reported:           !!window.reportedFlag
    };
  }

  // On submit of NEW Echo TACREP, take a snapshot
  const form = document.getElementById("entryForm");
  if (form) {
    form.addEventListener("submit", (e)=>{
      const editingCode = (document.getElementById("editingCode")?.value || "").trim();
      const colName = (document.getElementById("targetColumn")?.value || "");
      if (editingCode || colName !== "Echo") return; // edits are handled elsewhere
      pendingEcho = { snapshot: snapshotEchoFromForm(), expiresAt: Date.now() + 5000 };
    }, true); // capture is fine
  }

  // When a new card appears, merge the pending Echo fields into its payload
  const board = document.getElementById("board");
  if (!board) return;

  function tryMergeEchoInto(item){
    if (!pendingEcho || Date.now() > pendingEcho.expiresAt) { pendingEcho = null; return; }

    const colEl = item.closest('.column');
    if (!colEl || colEl.dataset.column !== "Echo") return;

    const badge = item.querySelector('.badge[data-code]');
    if (!badge) return; // not a TACREP tile

    // Merge snapshot into existing payload
    let p = {};
    try { p = JSON.parse(item.dataset.payload || "{}"); } catch {}
    const merged = { ...p, ...pendingEcho.snapshot };
    item.dataset.payload = JSON.stringify(merged);

    // If user expanded immediately, re-render details now
    if (item.classList.contains('expanded')) {
      renderTacrepDetailsInto(item, merged);
    }

    // one-shot merge
    pendingEcho = null;
  }

  // Observe new items being added anywhere under #board
  const mo = new MutationObserver(muts=>{
    muts.forEach(m=>{
      if (m.addedNodes) {
        m.addedNodes.forEach(n=>{
          if (n.nodeType !== 1) return;
          if (n.classList?.contains('item')) tryMergeEchoInto(n);
          n.querySelectorAll?.('.item').forEach(tryMergeEchoInto);
        });
      }
    });
  });
  mo.observe(board, { childList: true, subtree: true });
})();


  // ---- Time helpers ----
  const isValidDate = d => d instanceof Date && !isNaN(d.getTime());
  const fmtTimeUTC = d => isValidDate(d) ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z` : "—";
  const fmtTZ = (d, tz) => isValidDate(d) ? new Intl.DateTimeFormat(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:tz}).format(d) : "—";
  const fmtDateNoYearUTC = d => isValidDate(d) ? new Intl.DateTimeFormat(undefined, {month:'short',day:'2-digit',timeZone:'UTC'}).format(d) : "—";
  function tickClocks(){
    const now=new Date();
    $("#dateLocal").textContent=fmtDateNoYearUTC(now);
    $("#timeZulu").textContent=fmtTimeUTC(now);
    $("#timeEST").textContent=fmtTZ(now,"America/New_York");
    $("#timePST").textContent=fmtTZ(now,"America/Los_Angeles");
  }

  // ---- UI helpers ----
function openExportPreview(){
function td(s){ return `<td>${String(s ?? "")}</td>`; }

const groups = new Map(); // type -> { headers, rows }
document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]):not([data-column="MissionDetails"]):not([data-column="MissionTimeline"]) .item').forEach(it=>{
try{
const p = JSON.parse(it.dataset.payload || "{}");
if(!p || !p.code) return; // only export real TACREPs

  const t = tacrepTypeFromCode(p.code);
  const labels = getTacrepFieldLabels(t, true);
  const headers = ["Code"].concat(labels, ["CreatedBy","CreatedAt"]);
  const row = [p.code || ""]
    .concat(getTacrepFieldValues(t, p))
    .concat([
      p.createdBy || "",
      p.createdAt ? new Date(p.createdAt).toISOString() : ""
    ]);

  if (!groups.has(t)) groups.set(t, { headers, rows: [] });
  const bucket = groups.get(t);
  bucket.headers = headers;
  bucket.rows.push(row);
}catch{}


});

// Build Mission Timeline rows (defensive)
const timelineHeader = ["","Time","Type","Airfield","Lat","Lon","Altitude","CreatedBy","CreatedAt"];
const timelineRows = [];

// Safely obtain timeline entries even if gatherStateFromDOM is missing
const timelineItems = (function(){
  try {
    const s = (typeof gatherStateFromDOM === "function") ? gatherStateFromDOM() : null;
    if (s && Array.isArray(s.missionTimeline)) return s.missionTimeline;
  } catch {}
  // Fallback: read from DOM
  return Array.from(document.querySelectorAll("#missionTimelineItems .item")).map(el => {
    try { return JSON.parse(el.dataset.payload || "{}"); } catch { return {}; }
  });
})();

timelineItems.forEach(p=>{
  const lat = (p.latDeg && p.latMin)
    ? `${p.latDeg}° ${p.latMin}' ${(p.latSec ? String(p.latSec).padStart(2,"0") : "00")}${p.latDecSecStr ? '.' + p.latDecSecStr : ''}" ${p.latHem || ''}`
    : "";

  const lon = (p.lonDeg && p.lonMin)
    ? `${p.lonDeg}° ${p.lonMin}' ${(p.lonSec ? String(p.lonSec).padStart(2,"0") : "00")}${p.lonDecSecStr ? '.' + p.lonDecSecStr : ''}" ${p.lonHem || ''}`
    : "";

  timelineRows.push([
    p.timeHHMM||"",
    p.type||"",
    p.airfield||"",
    lat,
    lon,
    p.altitude||"",
    p.createdBy||"",
    p.createdAt ? new Date(p.createdAt).toISOString() : ""
  ]);
});


// Render grouped TACREP preview tables
  // Render Mission Details preview (new table)
const metaBody = document.getElementById("exportBodyMissionMeta");
if (metaBody) {
metaBody.innerHTML = "";
const r1 = document.createElement("tr");
r1.innerHTML = td("Callsign") + td(typeof callsign === "string" ? callsign : "");
metaBody.appendChild(r1);

const r2 = document.createElement("tr");
r2.innerHTML = td("Mission Number") + td(typeof missionNumber === "string" ? missionNumber : "");
metaBody.appendChild(r2);
}

const crewBody = document.getElementById("exportBodyCrewDetails");
if (crewBody) {
  crewBody.innerHTML = "";
  const shifts = (crewDetails && Array.isArray(crewDetails.shifts)) ? crewDetails.shifts : [];
  const labels = ["Shift 1","Shift 2","Shift 3","Shift 4"];
  shifts.forEach((s, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = [
      labels[idx] || `Shift ${idx+1}`,
      s?.turnover || "",
      s?.mc || "",
      s?.tc || "",
      s?.uac || "",
      s?.sc || "",
      s?.mpo1 || "",
      s?.mpo2 || ""
    ].map(td).join("");
    crewBody.appendChild(tr);
  });
}

const container = document.getElementById("exportTacrepsGrouped");
if (container) container.innerHTML = "";
const ORDER = ["India","Echo","AIS","Alpha","November","Golf","Other"];
const ordered = ORDER.filter(t => groups.has(t));
const remaining = Array.from(groups.keys()).filter(t => !ORDER.includes(t));
const allTypes = ordered.concat(remaining);

if (container){
allTypes.forEach(t=>{
const { headers, rows } = groups.get(t);
const h = document.createElement("h5");
h.style.margin = "10px 0 6px";
h.textContent = t;
const tbl = document.createElement("table");
tbl.className = "tbl";
const thead = document.createElement("thead");
const trh = document.createElement("tr");
headers.forEach(hc => {
const th = document.createElement("th");
th.textContent = hc;
trh.appendChild(th);
});
thead.appendChild(trh);
const tbody = document.createElement("tbody");
rows.forEach(r=>{
const tr = document.createElement("tr");
tr.innerHTML = r.map(td).join("");
tbody.appendChild(tr);
});
tbl.appendChild(thead);
tbl.appendChild(tbody);
container.appendChild(h);
container.appendChild(tbl);
});
}

// Render Mission Timeline preview (existing table body)
const $t2 = document.getElementById("exportBodyTimeline");
if ($t2) $t2.innerHTML = "";
if ($t2){
timelineRows.forEach(r=>{
const tr = document.createElement("tr");
tr.innerHTML = r.map(td).join("");
$t2.appendChild(tr);
});
}

// Build CSV exactly like the Excel picture
const allCsvRows = [];

/* MissionDetails — title row, then two key/value rows (no BlockStart here) */
allCsvRows.push(["MissionDetails"]);
allCsvRows.push(["","Callsign", typeof callsign === "string" ? callsign : ""]);
allCsvRows.push(["","MissionNumber", typeof missionNumber === "string" ? missionNumber : ""]);
allCsvRows.push([]);

/* Crew Details — title row, then header starting in column B */
allCsvRows.push(["Crew Details"]);
allCsvRows.push(["","","Turnover","MC","TC","UAC","SC","MPO1","MPO2"]);
( (crewDetails && Array.isArray(crewDetails.shifts)) ? crewDetails.shifts : [] )
  .forEach((s, idx) => {
    const label = ["Shift 1","Shift 2","Shift 3","Shift 4"][idx] || `Shift ${idx+1}`;
    allCsvRows.push([
      "",
      label,
      s?.turnover || "",
      s?.mc || "",
      s?.tc || "",
      s?.uac || "",
      s?.sc || "",
      s?.mpo1 || "",
      s?.mpo2 || ""
    ]);
  });
allCsvRows.push([]);

/* Tacreps — add a top-level title row, then each type as its own section */
allCsvRows.push(["Tacreps"]);
allTypes.forEach(t => {
  const { headers, rows } = groups.get(t);
 allCsvRows.push([t]);                         // keep section title in column A
allCsvRows.push([""].concat(headers));        // headers start in column B
rows.forEach(r => allCsvRows.push([""].concat(r))); // data start in column B

  allCsvRows.push([]);          // spacer between type sections
});

/* MissionTimeline — title row, then header row (not combined) */
allCsvRows.push(["MissionTimeline"]);
allCsvRows.push(timelineHeader);
timelineRows.forEach(r => allCsvRows.push(r));

/* (the csv = ... code that follows stays the same) */

const csv = allCsvRows
  .map(row =>
    row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")
  )
  .join("\n");


// Prepare download URL
if (exportCsvUrl){ try{ URL.revokeObjectURL(exportCsvUrl); }catch{} }
const blob = new Blob([csv], { type:"text/csv" });
exportCsvUrl = URL.createObjectURL(blob);

// Wire modal buttons
const modal = document.getElementById("exportModal");
const btnClose = document.getElementById("exportCloseBtn");
const btnDl = document.getElementById("exportDownloadBtn");
if (btnDl){
btnDl.onclick = ()=>{
const a = document.createElement("a");
a.href = exportCsvUrl;
a.download = "warfighter_export.csv";
a.click();
};
}
if (btnClose){
btnClose.onclick = ()=>{
if (exportCsvUrl){ try{ URL.revokeObjectURL(exportCsvUrl); }catch{} exportCsvUrl = null; }
closeModal(modal);
};
}
openModal(modal);
}



  function openModal(m){ if(!m) return; m.style.display="flex"; m.setAttribute("aria-hidden","false"); }
  function closeModal(m){ if(!m) return; m.style.display="none"; m.setAttribute("aria-hidden","true"); }
  function showBanner(msg){ banner.textContent=msg; banner.style.display="block"; setTimeout(()=>{ banner.style.display="none"; },1600); }
function setAppEnabled(on){
  // === TACREP form open/close helpers (fixes "+" click freeze) ===
function setReportedBtn(on){
  const btn = document.getElementById("reportedBtn");
  if (!btn) return;
  reportedFlag = !!on;
  btn.textContent = reportedFlag ? "REPORTED" : "UNREPORTED";
  btn.className = reportedFlag ? "btn-reported" : "btn-secondary";
  btn.style.fontWeight = "bold";
}

// Fill the modal from an existing payload (edit mode)
function fillEntryFormFromPayload(p){
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.value = v==null ? "" : String(v); };

  set("timeZuluInput", p.timeHHMM || "");
  // Standard fields
  set("vesselType", p.vesselType);
  set("sensor", p.sensor);
  set("course", p.course);
  set("speed", p.speed);
  set("trackNumber", p.trackNumber);
  set("minVesselLen", p.minVesselLen);
  set("additionalInfo", p.info);

  // Echo-only fields
  set("echoSystem", p.systemOrPlatform);
  set("echoEmitter", p.emitterName);
  set("echoActivity", p.activityOrFunction);
  if (p.frequency){
    const m = String(p.frequency).match(/^([\d.]+)\s*(\S+)?$/);
    if (m){
      set("echoFreq", m[1]);
      const u = document.getElementById("echoFreqUnit");
      if (u && m[2]) u.value = m[2];
    } else {
      set("echoFreq", p.frequency);
    }
  } else {
    set("echoFreq", "");
  }

  // DMS position
  set("latDeg", p.latDeg); set("latMin", p.latMin); set("latSec", p.latSec); set("latDecSec", p.latDecSecStr);
  if (p.latHem) document.getElementById("latHem").value = p.latHem;
  set("lonDeg", p.lonDeg); set("lonMin", p.lonMin); set("lonSec", p.lonSec); set("lonDecSec", p.lonDecSecStr);
  if (p.lonHem) document.getElementById("lonHem").value = p.lonHem;

  setReportedBtn(!!p.reported);
}

function resetEntryForm(){
  const form = document.getElementById("entryForm");
  if (form) form.reset();
  setReportedBtn(false);
  // Clear hidden edit fields
  const num = document.getElementById("codeNumber");
  if (num) num.value = "";
  const pre = document.getElementById("codePrefix");
  if (pre) pre.value = "";
  const ed = document.getElementById("editingCode");
  if (ed) ed.value = "";
}

// Main open function used by "+" and by the edit/correct/update flow.
function openForm(columnName, existingPayload /* can be null */){
  const modal = document.getElementById("entryModal");
  const title = document.getElementById("modalTitle");
  const targetCol = document.getElementById("targetColumn");
  if (!modal || !title || !targetCol) return;

  // Reset then set context
  resetEntryForm();
  targetCol.value = columnName || "";

  // Show edit header bits if editing
  const editing = !!(existingPayload && existingPayload.code);
  const codeRow = document.getElementById("codeEditRow");
  const codePrefix = document.getElementById("codePrefix");
  const codeNumber = document.getElementById("codeNumber");
  const editingCode = document.getElementById("editingCode");

  if (editing){
    if (editingCode) editingCode.value = existingPayload.code;
    if (codeRow) codeRow.style.display = "block";
    const prefix = getPrefixFromCode(existingPayload.code);
    const number = (existingPayload.code || "").replace(/^\D+/,"");
    if (codePrefix) codePrefix.value = prefix || "";
    if (codeNumber) codeNumber.value = number || "";
    title.textContent = `Edit TACREP ${existingPayload.code}`;
    fillEntryFormFromPayload(existingPayload);
  } else {
    if (codeRow) codeRow.style.display = "none";
    title.textContent = `New TACREP (${columnName})`;
  }

  // Echo vs. others visibility handled by existing MutationObserver when modal opens
  openModal(modal);
}

// Close + clean up helper
function closeForm(){
  const modal = document.getElementById("entryModal");
  if (!modal) return;
  resetEntryForm();
  closeModal(modal);
}
  // Keep Add buttons clickable (we gate in the click handler if Block Start isn't set)
  $$(".add-btn").forEach(b=> b.disabled = false);
  // Only gate starting correlations
  $("#correlationBtn").disabled = !on;
}


function openCrewDetailsModal(){
  // fill fields from state
  const s = crewDetails.shifts;
  const set = (id, v)=> { const el = document.getElementById(id); if (el) el.value = v || ""; };
  set("cd_s1_turn", s[0]?.turnover); set("cd_s1_mc", s[0]?.mc); set("cd_s1_tc", s[0]?.tc); set("cd_s1_uac", s[0]?.uac); set("cd_s1_sc", s[0]?.sc); set("cd_s1_mpo1", s[0]?.mpo1); set("cd_s1_mpo2", s[0]?.mpo2);
set("cd_s2_turn", s[1]?.turnover); set("cd_s2_mc", s[1]?.mc); set("cd_s2_tc", s[1]?.tc); set("cd_s2_uac", s[1]?.uac); set("cd_s2_sc", s[1]?.sc); set("cd_s2_mpo1", s[1]?.mpo1); set("cd_s2_mpo2", s[1]?.mpo2);
set("cd_s3_turn", s[2]?.turnover); set("cd_s3_mc", s[2]?.mc); set("cd_s3_tc", s[2]?.tc); set("cd_s3_uac", s[2]?.uac); set("cd_s3_sc", s[2]?.sc); set("cd_s3_mpo1", s[2]?.mpo1); set("cd_s3_mpo2", s[2]?.mpo2);
set("cd_s4_turn", s[3]?.turnover); set("cd_s4_mc", s[3]?.mc); set("cd_s4_tc", s[3]?.tc); set("cd_s4_uac", s[3]?.uac); set("cd_s4_sc", s[3]?.sc); set("cd_s4_mpo1", s[3]?.mpo1); set("cd_s4_mpo2", s[3]?.mpo2);

  openModal($("#crewDetailsModal"));
}

function onCrewDetailsSave(){
  const get = id => (document.getElementById(id)?.value || "").trim();
  crewDetails = {
    shifts: [
  { turnover:get("cd_s1_turn"), mc:get("cd_s1_mc"), tc:get("cd_s1_tc"), uac:get("cd_s1_uac"), sc:get("cd_s1_sc"), mpo1:get("cd_s1_mpo1"), mpo2:get("cd_s1_mpo2") },
  { turnover:get("cd_s2_turn"), mc:get("cd_s2_mc"), tc:get("cd_s2_tc"), uac:get("cd_s2_uac"), sc:get("cd_s2_sc"), mpo1:get("cd_s2_mpo1"), mpo2:get("cd_s2_mpo2") },
  { turnover:get("cd_s3_turn"), mc:get("cd_s3_mc"), tc:get("cd_s3_tc"), uac:get("cd_s3_uac"), sc:get("cd_s3_sc"), mpo1:get("cd_s3_mpo1"), mpo2:get("cd_s3_mpo2") },
  { turnover:get("cd_s4_turn"), mc:get("cd_s4_mc"), tc:get("cd_s4_tc"), uac:get("cd_s4_uac"), sc:get("cd_s4_sc"), mpo1:get("cd_s4_mpo1"), mpo2:get("cd_s4_mpo2") }
]

  };
  fillCrewDetailsTileFromState();
dirty = true;
requestAutoSyncSave(true);
closeModal($("#crewDetailsModal"));
showBanner("Crew details saved.")
}


  function enableIfReady(){ const ready=Number.isInteger(blockStartNum) && !!(crewPosition||"").trim(); setAppEnabled(ready); }
  function fillCrewDetailsTileFromState(){
const s = (crewDetails && Array.isArray(crewDetails.shifts)) ? crewDetails.shifts : [];
const set = (id, v)=>{ const el=document.getElementById(id); if(el) el.value = v || ""; };
// Meta fields
const bsEl = document.getElementById("md_blockStart");
if (bsEl) bsEl.value = Number.isInteger(blockStartNum) ? String(blockStartNum) : "";
const mnEl = document.getElementById("md_missionNumber");
    const csEl = document.getElementById("md_callsign");
if (csEl) csEl.value = callsign || "";
if (mnEl) mnEl.value = missionNumber || "";
// Shift rows
set("md_cd_s1_turn", s[0]?.turnover); set("md_cd_s1_mc", s[0]?.mc); set("md_cd_s1_tc", s[0]?.tc); set("md_cd_s1_uac", s[0]?.uac); set("md_cd_s1_sc", s[0]?.sc); set("md_cd_s1_mpo1", s[0]?.mpo1); set("md_cd_s1_mpo2", s[0]?.mpo2);
set("md_cd_s2_turn", s[1]?.turnover); set("md_cd_s2_mc", s[1]?.mc); set("md_cd_s2_tc", s[1]?.tc); set("md_cd_s2_uac", s[1]?.uac); set("md_cd_s2_sc", s[1]?.sc); set("md_cd_s2_mpo1", s[1]?.mpo1); set("md_cd_s2_mpo2", s[1]?.mpo2);
set("md_cd_s3_turn", s[2]?.turnover); set("md_cd_s3_mc", s[2]?.mc); set("md_cd_s3_tc", s[2]?.tc); set("md_cd_s3_uac", s[2]?.uac); set("md_cd_s3_sc", s[2]?.sc); set("md_cd_s3_mpo1", s[2]?.mpo1); set("md_cd_s3_mpo2", s[2]?.mpo2);
set("md_cd_s4_turn", s[3]?.turnover); set("md_cd_s4_mc", s[3]?.mc); set("md_cd_s4_tc", s[3]?.tc); set("md_cd_s4_uac", s[3]?.uac); set("md_cd_s4_sc", s[3]?.sc); set("md_cd_s4_mpo1", s[3]?.mpo1); set("md_cd_s4_mpo2", s[3]?.mpo2);
}
function readCrewDetailsFromTile(){
const get = id => (document.getElementById(id)?.value || "").trim();
return {
shifts: [
{ turnover:get("md_cd_s1_turn"), mc:get("md_cd_s1_mc"), tc:get("md_cd_s1_tc"), uac:get("md_cd_s1_uac"), sc:get("md_cd_s1_sc"), mpo1:get("md_cd_s1_mpo1"), mpo2:get("md_cd_s1_mpo2") },
{ turnover:get("md_cd_s2_turn"), mc:get("md_cd_s2_mc"), tc:get("md_cd_s2_tc"), uac:get("md_cd_s2_uac"), sc:get("md_cd_s2_sc"), mpo1:get("md_cd_s2_mpo1"), mpo2:get("md_cd_s2_mpo2") },
{ turnover:get("md_cd_s3_turn"), mc:get("md_cd_s3_mc"), tc:get("md_cd_s3_tc"), uac:get("md_cd_s3_uac"), sc:get("md_cd_s3_sc"), mpo1:get("md_cd_s3_mpo1"), mpo2:get("md_cd_s3_mpo2") },
{ turnover:get("md_cd_s4_turn"), mc:get("md_cd_s4_mc"), tc:get("md_cd_s4_tc"), uac:get("md_cd_s4_uac"), sc:get("md_cd_s4_sc"), mpo1:get("md_cd_s4_mpo1"), mpo2:get("md_cd_s4_mpo2") }
]
};
}
function onCrewDetailsTileSave(){
// Update crew details (shifts)
crewDetails = readCrewDetailsFromTile();
// Update mission meta
const mn = (document.getElementById("md_missionNumber")?.value || "").trim();
  const cs = (document.getElementById("md_callsign")?.value || "").trim();
callsign = cs;
const bsStr = (document.getElementById("md_blockStart")?.value || "").replace(/\D/g,"").slice(0,10);
missionNumber = mn;
if (bsStr) {
blockStartNum = Number(bsStr);
} else {
blockStartNum = null;
}
enableIfReady();
dirty = true;
requestAutoSyncSave(true);
showBanner("Mission details saved.");
}
function resetCrewDetailsTile(){
fillCrewDetailsTileFromState();
}
  function updateFileStatus(){
    if(memoryMode){
      fileStatus.textContent="* Memory mode — use Download JSON";
      downloadJsonBtn.style.display="inline-block";
      $("#syncSaveBtn").style.display="none";
    } else {
      downloadJsonBtn.style.display="none";
      $("#syncSaveBtn").style.display="inline-block";
      fileStatus.textContent=fileHandle ? (dirty ? `* Unsaved changes — ${fileHandle.name}` : `Opened: ${fileHandle.name}`) : "No file";
    }
  }
  // ---- Tabs ----
  function setActiveTab(name){
   const validTabs = new Set(Array.from(document.querySelectorAll('.tab-panel')).map(p => p.dataset.tab));
if (!validTabs.has(name)) { name = 'TC'; try{ localStorage.setItem('wf_active_tab','TC'); }catch{} }


    // Buttons
    $$('.tabbar .tab').forEach(btn=>{
      const on = btn.dataset.tabTarget === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // Panels
    $$('.tab-panel').forEach(p=>{
      const on = p.dataset.tab === name;
      p.classList.toggle('active', on);
      p.hidden = !on;
      p.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    // Remember last tab
    try{ localStorage.setItem('wf_active_tab', name); }catch{}
  }
function forceTabTC(){
  setActiveTab('TC'); // make TC the default tab
  try{ localStorage.setItem('wf_active_tab','TC'); }catch{}
}



  
  // ---- Numeric input helpers (consolidated) ----
  function digitsOnly(s){ return String(s||"").replace(/\D/g,""); }
  function clampDigitsInput(el, maxLen=null){
if(!el) return;
el.addEventListener("input", ()=>{
let v = el.value.replace(/\D/g,"");
if(maxLen!=null) v = v.slice(0,maxLen);
el.value = v;
});
}
  function decimalNumeric(el){
    el.addEventListener("input", ()=>{
      let v = el.value.replace(/[^\d.]/g,"");
      const i=v.indexOf(".");
      if(i!==-1) v = v.slice(0,i+1) + v.slice(i+1).replace(/\./g,"");
      el.value = v;
    });
  }

  // ---- Landing wiring ----
    // DMS position display: "DD:MM:SS.ssN DDD:MM:SS.ssE"
  function buildPosDisplay(p){
    // Prefer DMS; fall back to legacy dec-min if necessary
    function fmt(latOrLon){
      const deg  = Number(p[latOrLon+'Deg']  ?? '');
      const min  = Number(p[latOrLon+'Min']  ?? '');
      const sec  = String(p[latOrLon+'Sec'] ?? '').padStart(2,'0');
      const dsec = String(p[latOrLon+'DecSecStr'] ?? '').padStart(2,'0');
      const hem  = (p[latOrLon+'Hem'] || '').toUpperCase();

      if (Number.isFinite(deg) && Number.isFinite(min) && (sec !== 'NaN') && hem){
        const ss = dsec ? `${sec}.${dsec}` : sec;
        return `${String(deg)}:${String(min).padStart(2,'0')}:${ss}${hem}`;
      }
      // Legacy fallback if only dec-min exists
      const decMin = p[latOrLon+'DecMinStr'];
      if (Number.isFinite(deg) && Number.isFinite(min) && decMin && hem){
        const frac = String(decMin);
        return `${String(deg)}:${String(min).padStart(2,'0')}:${('00.'+frac).slice(3)}${hem}`; // approximate SS from dec-min
      }
      return "";
    }
    const lat = fmt('lat');
    const lon = fmt('lon');
    return (lat && lon) ? `${lat} ${lon}` : "";
  }

  document.addEventListener("DOMContentLoaded", ()=>{
 // === Unified TACREP details renderer (replaces Echo enhancer) ===
function renderTacrepDetailsInto(item, payload) {
  if (!item) return;

  let p = payload;
  if (!p) { try { p = JSON.parse(item.dataset.payload || "{}"); } catch { p = {}; } }

  const details = item.querySelector(".item-details");
  if (!details) return;

  if (details.dataset.rendering === "1") return;
  details.dataset.rendering = "1";
  details.innerHTML = "";

  const append = (label, val) => {
    if (val === undefined || val === null) return;
    const s = (typeof val === "string") ? val.trim() : String(val);
    if (s === "") return;
    const span = document.createElement("span");
    span.className = "detail";
    span.innerHTML = `<em>${escapeHtml(label)}:</em> ${escapeHtml(s)}`;
    details.appendChild(span);
  };

  const fallbackType = item.closest(".column")?.dataset.column || "Other";
  const type = tacrepTypeFromCode(p?.code) || fallbackType;
  collectTacrepFields(type, p).forEach(entry => append(entry.label, entry.value));

  delete details.dataset.rendering;
}





// Observe TACREP tiles for expansion and payload updates; re-render details consistently
(function installTacrepDetailsObserver(){
  const board = document.getElementById("board");
  if (!board) return;

  const onMaybeRender = (node) => {
    if (!(node instanceof Element)) return;
    // Target only TACREP tiles that have a badge with data-code
    const item = node.closest?.(".item") || (node.classList?.contains("item") ? node : null);
    if (!item) return;
    if (!item.querySelector('.badge[data-code]')) return; // skip non-TACREP cards
    if (!item.classList.contains("expanded")) return;      // only render when expanded
    renderTacrepDetailsInto(item);
  };

  // 1) Class changes (expanded/collapsed)
  const classObserver = new MutationObserver((muts) => {
    muts.forEach(m => {
      if (m.type === "attributes" && m.attributeName === "class") {
        onMaybeRender(m.target);
      }
    });
  });

  // 2) New TACREP tiles added or payload changed
  const treeObserver = new MutationObserver((muts) => {
  muts.forEach(m => {
    // Newly inserted cards -> render when they are (or become) expanded
    if (m.addedNodes && m.addedNodes.length) {
      m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          if (n.classList?.contains("item")) onMaybeRender(n);
          n.querySelectorAll?.(".item").forEach(onMaybeRender);
        }
      });
    }
    // Any payload change on any element within the board subtree
    if (m.type === "attributes" && m.attributeName === "data-payload") {
      onMaybeRender(m.target);
    }
    // Safety: if innerHTML of details is wiped by other code, re-render
   
  });
});


  // Start observers
  classObserver.observe(board, { subtree: true, attributes: true, attributeFilter: ["class"] });
  treeObserver.observe(board, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-payload"] });

  // Also render any already-expanded items on load
  board.querySelectorAll('.item.expanded .badge[data-code]').forEach(b => {
    const item = b.closest('.item');
    renderTacrepDetailsInto(item);
  });
})();
    $("#versionA").textContent = APP_VERSION; $("#versionB").textContent = APP_VERSION;
    useFS = !!(window.showOpenFilePicker && window.showSaveFilePicker && window.FileSystemFileHandle);
    memoryMode = !useFS;

    $("#btnLandingNew").addEventListener("click", ()=>{ pendingMode="new"; $("#crewInput").value=""; openModal($("#crewModal")); });
    $("#btnLandingCollab").addEventListener("click", ()=>{ pendingMode="collab"; $("#crewInput").value=""; openModal($("#crewModal")); });

    $("#crewCancel").addEventListener("click", ()=>{ pendingMode=null; closeModal($("#crewModal")); });
    $("#crewApply").addEventListener("click", onCrewApply);
    $("#blockCancel").addEventListener("click", ()=> closeModal($("#blockModal")));
    $("#blockApply").addEventListener("click", onBlockApply);
    $("#changeCrewBtn").addEventListener("click", ()=>{ $("#crewInput").value=crewPosition; openModal($("#crewModal")); });

 $("#exportBtn").addEventListener("click", openExportPreview);
    $("#downloadJsonBtn").addEventListener("click", downloadCurrentJSON);
    $("#syncSaveBtn").addEventListener("click", ()=>{ if(memoryMode){ downloadCurrentJSON(); } else { requestAutoSyncSave(true); } });
    $("#suggestionBtn").addEventListener("click", ()=> openModal($("#suggestionModal")));
    const settingsBtn = $("#settingsBtn");
    const settingsModal = $("#settingsModal");
    const tacrepFormatModal = $("#tacrepFormatModal");
    const settingsCloseBtn = $("#settingsCloseBtn");
    const openTacrepFormatBtn = $("#openTacrepFormatBtn");
    const tacrepFormatCancelBtn = $("#tacrepFormatCancelBtn");
    const tacrepFormatResetBtn = $("#tacrepFormatResetBtn");
    if (settingsBtn && settingsModal) {
      settingsBtn.addEventListener("click", ()=> openModal(settingsModal));
    }
    if (settingsCloseBtn && settingsModal) {
      settingsCloseBtn.addEventListener("click", ()=> closeModal(settingsModal));
    }
    if (openTacrepFormatBtn && tacrepFormatModal) {
      openTacrepFormatBtn.addEventListener("click", ()=>{
        if (settingsModal) closeModal(settingsModal);
        buildTacrepFormatModal();
        openModal(tacrepFormatModal);
      });
    }
    if (tacrepFormatCancelBtn && tacrepFormatModal) {
      tacrepFormatCancelBtn.addEventListener("click", ()=> closeModal(tacrepFormatModal));
    }
    if (tacrepFormatResetBtn) {
      tacrepFormatResetBtn.addEventListener("click", ()=>{
        resetTacrepFormatPrefs();
        buildTacrepFormatModal();
        refreshAllTacrepDetails();
      });
    }
    const tfContainer = $("#tacrepFormatContainer");
    if (tfContainer) tfContainer.addEventListener("click", handleTacrepFormatClick);

    $("#cancelEntryBtn").addEventListener("click", ()=> closeForm());
$("#makeCurrentBtn").addEventListener("click", ()=>{ const d=new Date(); $("#timeZuluInput").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`; });
    /* Configure entry form when opening for Echo vs others */
(function installEchoFormConfigurator(){
const entry = document.getElementById("entryModal");
if (!entry) return;

function hideBlockByInputId(id, on){
const el = document.getElementById(id);
if (!el) return;
const row = el.closest(".row");
if (row) row.style.display = on ? "none" : "";
// hide matching label
const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);

if (lab) lab.style.display = on ? "none" : "";
}

function configureEntryFormForColumn(){
const col = (document.getElementById("targetColumn")?.value || "");
const isEcho = (col === "Echo");

// Toggle Echo-only fields
document.querySelectorAll(".echo-only").forEach(el=>{
  el.style.display = isEcho ? "" : "none";
});

// Hide standard fields that Echo must NOT use
const toHide = ["vesselType","sensor","course","speed","trackNumber","minVesselLen","minotaurPaste"];
toHide.forEach(id => hideBlockByInputId(id, isEcho));

// Ensure Minotaur Parse button row is hidden if Echo
const minoBtn = document.getElementById("minoCheckBtn");
if (minoBtn) {
  const minoRow = minoBtn.closest(".row");
  if (minoRow) minoRow.style.display = isEcho ? "none" : "";
  const minoLabel = document.querySelector('label[for="minotaurPaste"]');
  if (minoLabel) minoLabel.style.display = isEcho ? "none" : "";
}

// Refresh abbreviation checkbox enablement/state
try { refreshAbbrevCheckboxesInModal(); } catch {}


}

// React whenever the modal is shown/hidden
const ob = new MutationObserver(()=>{
const visible = entry.style.display !== "none" && entry.getAttribute("aria-hidden") !== "true";
if (visible) configureEntryFormForColumn();
});
ob.observe(entry, { attributes:true, attributeFilter:["style","aria-hidden"] });

// Also auto-configure once on DOM ready if the modal is already open
configureEntryFormForColumn();
})();
 // Mission Details meta inputs
const mdBlock = document.getElementById("md_blockStart");
if (mdBlock) clampDigitsInput(mdBlock);
const mdMission = document.getElementById("md_missionNumber");

// Crew Details modal
const crewDetailsTile = document.getElementById("crewDetailsTile");



$("#cdCancel").addEventListener("click", ()=> closeModal($("#crewDetailsModal")));
    // Crew Details tile (Mission Details tab)
const mdTile = document.getElementById("crewDetailsTile");
 // Ensure Mission Meta (Mission # and TACREP Block) stays directly under the header and crew details are always visible
(function(){
const tile = document.getElementById("crewDetailsTile");
const meta = document.getElementById("md_meta_wrap");
if (tile && meta) {
const header = tile.querySelector(".item-header");
if (header) header.insertAdjacentElement("afterend", meta);
meta.classList.remove("collapsed-only");
}
if (tile) tile.classList.add("expanded");
})();
const mdCdSave = document.getElementById("md_cdSave");
if(mdCdSave){ mdCdSave.addEventListener("click", onCrewDetailsTileSave); }
const mdCdCancel = document.getElementById("md_cdCancel");
if(mdCdCancel){ mdCdCancel.addEventListener("click", resetCrewDetailsTile); }
fillCrewDetailsTileFromState();
$("#cdSave").addEventListener("click", onCrewDetailsSave);
// Ensure Mission Timeline lives under Mission Details and is hidden on other tabs
(function(){
const col = document.querySelector('.column[data-column="MissionTimeline"]');
const mdBoard = document.getElementById('mdBoard');
if (col && mdBoard && col.parentElement !== mdBoard) {
mdBoard.appendChild(col); // move it into the Mission Details board if it was placed globally
}
const mtl = document.getElementById('missionTimelineTile');
if (mtl) {
  mtl.classList.add('expanded');
}
})();


// Patch tab switching to hard-hide Mission Timeline unless Mission Details is active
const __origSetActiveTab = setActiveTab;
setActiveTab = function(name){
__origSetActiveTab(name);
const mtl = document.getElementById('missionTimelineTile');
if (mtl) {
mtl.style.display = (name === 'MD') ? '' : 'none';
}
};    

// Reported toggle button
$("#reportedBtn").addEventListener("click", () => {
  reportedFlag = !reportedFlag;
  const btn = $("#reportedBtn");
  if (reportedFlag) {
    btn.textContent = "REPORTED";
    btn.className = "btn-reported";
  } else {
    btn.textContent = "UNREPORTED";
    btn.className = "btn-secondary";
  }
  btn.style.fontWeight = "bold";
});

// Minotaur Parse button
// Minotaur Parse button
$("#minoCheckBtn").addEventListener("click", () => {
  const paste = $("#minotaurPaste").value.trim();
  if(!paste) return;

  // time (HH:MM:SS(.s) UTC)
  const timeMatch = paste.match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s+UTC/i);
  if(timeMatch){
    $("#timeZuluInput").value = timeMatch[1] + timeMatch[2];
  }

  // latitude 19:32:25.15N
  const latMatch = paste.match(/(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)([NS])/i);
  if(latMatch){
    const deg = latMatch[1];
    const mm  = latMatch[2];
    const ssf = parseFloat(latMatch[3]);               // seconds (may include decimals)
    const ssI = Math.floor(ssf);
    const ssD = Math.round((ssf - ssI) * 100);         // 2 decimal secs to integer
    const hem = latMatch[4].toUpperCase();

    $("#latDeg").value     = deg;
    $("#latMin").value     = String(mm).padStart(2,'0');
    $("#latSec").value     = String(ssI).padStart(2,'0');
    $("#latDecSec").value  = String(ssD).padStart(2,'0').slice(0,2);
    $("#latHem").value     = hem;
  }

  // longitude 128:23:17.68E
  const lonMatch = paste.match(/(\d{1,3}):(\d{2}):(\d{2}(?:\.\d+)?)([EW])/i);
  if(lonMatch){
    const deg = lonMatch[1];
    const mm  = lonMatch[2];
    const ssf = parseFloat(lonMatch[3]);
    const ssI = Math.floor(ssf);
    const ssD = Math.round((ssf - ssI) * 100);
    const hem = lonMatch[4].toUpperCase();

    $("#lonDeg").value     = deg;
    $("#lonMin").value     = String(mm).padStart(2,'0');
    $("#lonSec").value     = String(ssI).padStart(2,'0');
    $("#lonDecSec").value  = String(ssD).padStart(2,'0').slice(0,2);
    $("#lonHem").value     = hem;
  }

  // speed "12 kt"
  const speedMatch = paste.match(/(\d+(?:\.\d+)?)\s*kt/i);
  if(speedMatch) $("#speed").value = speedMatch[1];

  // track "(LTN: 03000)"
  const trackMatch = paste.match(/\(LTN:\s*([^)]+)\)/i);
  if(trackMatch) $("#trackNumber").value = trackMatch[1].trim();

  // course "328.0T deg"
  const courseMatch = paste.match(/(\d+(?:\.\d+)?)T\s*deg/i);
  if(courseMatch) $("#course").value = String(Number(courseMatch[1]));

  showBanner("Minotaur data parsed successfully!");
});






// Inputs
clampDigitsInput($("#latDeg"));
clampDigitsInput($("#latMin"));
clampDigitsInput($("#latSec"), 2);
clampDigitsInput($("#latDecSec"), 2);
clampDigitsInput($("#lonDeg"));
clampDigitsInput($("#lonMin"));
clampDigitsInput($("#lonSec"), 2);
clampDigitsInput($("#lonDecSec"), 2);
clampDigitsInput($("#course"));
decimalNumeric($("#echoFreq"));
clampDigitsInput($("#blockInput"));
clampDigitsInput(document.getElementById("md_blockStart"));
clampDigitsInput($("#codeNumber"));
clampDigitsInput($("#minVesselLen"));
clampDigitsInput($("#faultTime"));

    
    // Abbrev prefs
    $$(".abbrChk").forEach(chk=> chk.addEventListener("change", ()=> setAbbrev(chk.dataset.field, chk.checked)));
    /* ensure Echo-only checkboxes are also wired (they share .abbrChk, so this is already covered) */
    refreshAbbrevCheckboxesInModal();

// Add New buttons (delegated) — gate on Block Start
 // ===== TACREP Edit Pencil: pre-edit chooser (Edit / Correct / Update) =====
let _changeMode = null;          // "edit" | "correct" | "update" | null
let _changeContext = null;       // { itemEl, payload } for current TACREP being edited

// Utility: open the chooser for a specific TACREP element
function openChangeTypeChooser(itemEl){
  try {
    const payload = JSON.parse(itemEl.dataset.payload || "{}");
    _changeContext = { itemEl, payload };
    _changeMode = null;
    openModal(document.getElementById("changeTypeModal"));
  } catch {
    // If payload is missing, fallback to regular edit
    const p = document.getElementById("changeTypeModal");
    if (p) closeModal(p);
    _changeMode = "edit";
    // Fallback open
    openForm(itemEl.closest('.column')?.dataset.column || "India", JSON.parse(itemEl.dataset.payload||"{}"));
  }
}

// Wire chooser buttons
(function(){
  const m = document.getElementById("changeTypeModal");
  const btnE = document.getElementById("btnChangeTypeEdit");
  const btnC = document.getElementById("btnChangeTypeCorrect");
  const btnU = document.getElementById("btnChangeTypeUpdate");
  const btnX = document.getElementById("btnChangeTypeCancel");
  if (btnE) btnE.onclick = ()=>{ _changeMode = "edit";  if (m) closeModal(m); if (_changeContext) openForm(_changeContext.itemEl.closest('.column')?.dataset.column||"India", _changeContext.payload); };
  if (btnC) btnC.onclick = ()=>{ _changeMode = "correct"; if (m) closeModal(m); if (_changeContext) openForm(_changeContext.itemEl.closest('.column')?.dataset.column||"India", _changeContext.payload); };
  if (btnU) btnU.onclick = ()=>{ _changeMode = "update"; if (m) closeModal(m); if (_changeContext) openForm(_changeContext.itemEl.closest('.column')?.dataset.column||"India", _changeContext.payload); };
  if (btnX) btnX.onclick = ()=>{ _changeMode = null; _changeContext = null; if (m) closeModal(m); };
})();

// Intercept pencil clicks anywhere on the board and route to chooser
document.getElementById("board").addEventListener("click", (e)=>{
// Do not open chooser while adding to a correlation or if clicked inside the Correlations column
if (window._addingToCorrelationCard) return;

const btn = e.target && e.target.closest(".icon-edit");
if (!btn) return;
const itemEl = btn.closest(".item");
if (!itemEl) return;

// If this edit icon is inside the Correlations column, ignore it (not a TACREP edit)
const col = itemEl.closest('.column');
if (col && col.dataset.column === "Correlations") return;

// Stop any legacy handlers that would open the editor directly
e.preventDefault();
e.stopPropagation();

openChangeTypeChooser(itemEl);
}, true);

// ===== Confirm + Preview flows for Correct/Update after saving the edit =====

// Compose the TACREP info text (omitting blanks), formatted for copy/paste
function composeTacrepInfoText(p){
  const type = tacrepTypeFromCode(p?.code) || "Other";
  return collectTacrepFields(type, p)
    .map(entry => `${entry.settingsLabel || entry.label}: ${entry.value}`)
    .join("\n");
}

// Open Yes/No confirm (using existing #confirmModal) with dynamic labels
function openSendConfirm(kind /* "correct"|"update" */, tac){
  const modal = document.getElementById("confirmModal");
  const title = document.getElementById("confirmTitle");
  const text  = document.getElementById("confirmText");
  const btnNo = document.getElementById("confirmCancelBtn");
  const btnYes= document.getElementById("confirmOkBtn");
  if (!modal || !title || !text || !btnNo || !btnYes) return;

  // Customize labels: No / Yes
  title.textContent = "Confirm";
  btnNo.textContent = "No";
  btnYes.textContent = "Yes";

  const ask = (kind === "update")
    ? "Would you like to send an updated TACREP report?"
    : "Would you like to send a corrected TACREP report?";
  text.textContent = ask;

  // Clean previous handlers
  btnNo.onclick = null;
  btnYes.onclick = null;

  btnNo.onclick = ()=>{
    closeModal(modal);
    // Log history and return to tiles
    logChangeHistory(kind, tac.code, crewPosition || "");
  };
  btnYes.onclick = ()=>{
    closeModal(modal);
    // Build preview text and show preview modal
    const header = (kind === "update")
      ? `Update to TACREP ${tac.code}`
      : `Correction to TACREP ${tac.code}`;
    const body = composeTacrepInfoText(tac);
    const full = body ? `${header}\n${body}` : header;

    const sp = document.getElementById("sendPreviewModal");
    const ta = document.getElementById("sendPreviewText");
    const ok = document.getElementById("sendPreviewOkBtn");
    const cp = document.getElementById("sendPreviewCopyBtn");
    if (!sp || !ta || !ok || !cp) return;
    ta.value = full;

    cp.onclick = ()=> {
      try{ ta.select(); document.execCommand("copy"); showBanner("Copied to clipboard."); }catch{}
    };
    ok.onclick = ()=> {
      closeModal(sp);
      // After user acknowledges, log history
      logChangeHistory(kind, tac.code, crewPosition || "");
    };

    openModal(sp);
  };

  openModal(modal);
}

// History logging (UI + persistence flag)
function logChangeHistory(kind /* "correct"|"update" */, code, by){
  const when = new Date();
  const ts = `${when.getUTCFullYear()}-${String(when.getUTCMonth()+1).padStart(2,"0")}-${String(when.getUTCDate()).padStart(2,"0")} ${String(when.getUTCHours()).padStart(2,"0")}:${String(when.getUTCMinutes()).padStart(2,"0")}Z`;
  const verb = (kind === "update") ? "updated" : "corrected";
  const payload = { id:`hist_${when.getTime()}`, code, kind, by, at: when.getTime(), line:`[${ts}] ${code} — ${verb} by ${by}` };

  const list = document.getElementById("historyItems");
  if (list) {
    const el = createHistoryItem(payload);
     // If editing, replace the existing card in-place; otherwise insert new
  list.insertBefore(el, list.firstChild || null);


    dirty = true;
    requestAutoSyncSave(true);
  }
}

// Create a simple history row
function createHistoryItem(p){
  const el = document.createElement("div");
  el.className = "item";
  el.dataset.payload = JSON.stringify(p);
  el.innerHTML = `
    <div class="item-header">
      <div class="creator">${escapeHtml(p.line || "")}</div>
      <div class="item-actions"></div>
    </div>
  `;
  return el;
}

// ===== Hook the existing Edit form submission to branch for Correct/Update =====
// After the built-in save logic updates the TACREP tile, we detect _changeMode.
// If it is "correct" or "update", we present the confirm -> (optional) preview flow.
(function hookPostSave(){
  // Monkey-patch requestAutoSyncSave to detect the moment right after entry form closes?
  // Safer: listen for the entry modal closing and, if mode is set and we have context, run confirm on the latest payload.
  const entry = document.getElementById("entryModal");
  if (!entry) return;

  const observer = new MutationObserver(()=>{
    // When the entry modal is hidden and changeMode is set for this cycle, trigger confirm
    const isClosed = entry.getAttribute("aria-hidden") === "true" || entry.style.display === "none";
    if (isClosed && (_changeMode === "correct" || _changeMode === "update") && _changeContext) {
      try{
        // Find the freshly updated TACREP tile by code
        const code = _changeContext.payload?.code;
        if (!code) { _changeMode = null; _changeContext = null; return; }
        const badge = document.querySelector(`.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge[data-code="${CSS.escape(code)}"]`);
        const item = badge && badge.closest(".item");
        const latest = item ? JSON.parse(item.dataset.payload || "{}") : _changeContext.payload || {};
        // Open confirmation tailored to mode
        openSendConfirm(_changeMode, latest);
      } finally {
        // Reset mode/context AFTER we launch confirm (confirm will log history and/or preview)
        _changeMode = null;
        _changeContext = null;
      }
    }
  });
  observer.observe(entry, { attributes:true, attributeFilter:["style","aria-hidden"] });
})();   
    // Correlation code-click -> toggle highlight on associated TACREP tiles only
const corrContainer = document.getElementById("correlationItems");
if (corrContainer) {
corrContainer.addEventListener("click", (e) => {
// 1) "+ add" inside a correlation card -> enter add-to-correlation selection mode
const addBtn = e.target && e.target.closest('button');
if (addBtn && addBtn.textContent && addBtn.textContent.trim() === "+ add") {
const card = addBtn.closest('.item');
if (!card) return;

// Hide all existing action buttons on this correlation card (e.g., Add / Remove)
// and remember which ones we hid so we can restore them later.
const actionArea = card.querySelector('.item-actions') || card.querySelector('.item-header .item-actions') || card.querySelector('.item-header');
const buttonsToHide = Array.from(card.querySelectorAll('button')).filter(b => {
const t = (b.textContent || "").trim().toLowerCase();
return (t === "+ add" || t === "add" || t === "remove" || t === "− remove" || t === "- remove");
});
buttonsToHide.forEach(b => {
b.classList.add('hidden-in-add-mode');
b.style.display = 'none';
});

// Insert a temporary "Done" button on the correlation card itself.
if (actionArea && !card.querySelector('button[data-role="corr-done"]')) {
const doneBtn = document.createElement('button');
doneBtn.type = 'button';
doneBtn.setAttribute('data-role', 'corr-done');
doneBtn.textContent = "Done";
doneBtn.className = "btn-secondary";
doneBtn.addEventListener('click', () => {
// Finish adding (keeps any newly added code and exits selection mode)
endAddMode();
});
actionArea.appendChild(doneBtn);
}

// Enter selection mode scoped to this correlation card
window._addingToCorrelationCard = card;
document.body.classList.add('select-mode');
// Mark TACREP tiles (non-Correlations) as selectable
document.querySelectorAll('.column[data-column]:not([data-column="Correlations"]) .item').forEach(el => el.classList.add('selectable'));

// Show hint + global Cancel
if (selectHint) selectHint.textContent = "Select an attack route to add to this correlation.";
if (correlationCancelBtn) correlationCancelBtn.style.display = "";

// Prevent legacy handlers
e.preventDefault();
e.stopPropagation();
return;
}

// 2) Existing behavior: click a code on a correlation card toggles highlighting of matching TACREP tiles
const badge = e.target && e.target.closest('.badge[data-code]');
const card  = e.target && e.target.closest('.item');
if (!badge || !card) return;

// Prevent any legacy card-highlighting handlers from running
e.preventDefault();
e.stopPropagation();

// Never highlight the correlation card itself
card.classList.remove('corr-highlighted');

// Determine this correlation's unique key (stable per card)
// Use the set of codes on the card as the identity
const codes = currentCodesFromCard(card);
const corrKey = codes.slice().sort().join('|');

// Toggle state flag on the card
const isOn = card.dataset.hlTiles === "1";
const turnOn = !isOn;

// Helper to attach/detach a correlation key to a TACREP tile
function updateTileKeyList(tile, add) {
  const cur = (tile.dataset.corrKeys || "").split(',').filter(s => s);
  const has = cur.includes(corrKey);
  let next = cur.slice();
  if (add && !has) next.push(corrKey);
  if (!add && has) next = next.filter(k => k !== corrKey);
  tile.dataset.corrKeys = next.join(',');
  // Apply visual class iff at least one correlation key remains
  tile.classList.toggle('corr-highlighted', next.length > 0);
}

// For each TACREP code referenced by this correlation, toggle its tile highlight
codes.forEach(code => {
  // Find all matching TACREP tiles (in active boards, not in Correlations)
  const matches = document.querySelectorAll(
    `.column[data-column]:not([data-column="Correlations"]) .badge[data-code="${CSS.escape(code)}"]`
  );
  matches.forEach(b => {
    const tile = b.closest('.item');
    if (tile) updateTileKeyList(tile, turnOn);
  });
});

// Persist the per-card toggle state
card.dataset.hlTiles = turnOn ? "1" : "0";


}, true);
  // Helpers for "add to correlation" selection mode
function endAddMode(){
const card = window._addingToCorrelationCard || null;

// Remove the temporary "Done" button and restore any hidden buttons on the card.
if (card) {
const doneBtn = card.querySelector('button[data-role="corr-done"]');
if (doneBtn && doneBtn.parentElement) doneBtn.parentElement.removeChild(doneBtn);

card.querySelectorAll('.hidden-in-add-mode').forEach(b => {
b.style.display = "";
b.classList.remove('hidden-in-add-mode');
});
}

window._addingToCorrelationCard = null;
document.body.classList.remove('select-mode');
document.querySelectorAll('.item.selectable').forEach(el => el.classList.remove('selectable','selected'));
if (selectHint) selectHint.textContent = "";
if (correlationCancelBtn) correlationCancelBtn.style.display = "none";
}

function addCodeToCorrelationCard(card, code){
if (!card || !code) return;

// Avoid duplicates
const existing = currentCodesFromCard(card);
if (existing.includes(code)) return;

// Append a badge to the card header
const wrap = card.querySelector('.item-header .badge-wrap') || card.querySelector('.badge-wrap');
if (wrap) {
const b = document.createElement('div');
b.className = 'badge';
b.setAttribute('data-code', code);
b.textContent = code;
wrap.appendChild(b);
}

// Update payload to include the new code
let p = {};
try { p = JSON.parse(card.dataset.payload || "{}"); } catch {}
const nextCodes = Array.isArray(p.codes) ? p.codes.slice() : existing.slice();
if (!nextCodes.includes(code)) nextCodes.push(code);
p.codes = nextCodes;
p.lastModified = Date.now();
card.dataset.payload = JSON.stringify(p);
}

// While in add mode, clicking a TACREP code (outside Correlations) adds it to the target correlation
document.getElementById("board").addEventListener("click", (e)=>{
if (!window._addingToCorrelationCard) return;

const badge = e.target && e.target.closest('.column[data-column]:not([data-column="Correlations"]) .badge[data-code]');
if (!badge) return;

e.preventDefault();
e.stopPropagation();

const code = badge.getAttribute('data-code') || badge.textContent.trim();
addCodeToCorrelationCard(window._addingToCorrelationCard, code);
endAddMode();
showBanner(`Added ${code} to correlation.`);

}, true);

// Allow Cancel button to exit add mode
if (correlationCancelBtn) {
correlationCancelBtn.addEventListener("click", ()=> endAddMode());
}
}

$("#board").addEventListener("click", (e)=>{
const btn = e.target.closest(".add-btn");
if(!btn) return;

// Only handle column-level "Add New" buttons (direct children of a .column).
// Do NOT handle the "+ Add" buttons embedded inside correlation cards.
const colEl = btn.closest(".column");
if (!colEl || colEl.querySelector(':scope > .add-btn') !== btn) return;

// If Block Start not set, prompt for it
if(!Number.isInteger(blockStartNum)){
$("#blockInput").value = "";
openModal($("#blockModal"));
return;
}

const col = colEl.dataset.column;

// For normal columns, open the TACREP entry form as before.
if (col && col !== "Correlations") {
openForm(col, null);
}
// For the Correlations column, the column-level button is not used here.
// Adding to an existing correlation is handled by that card's own controls,
// so we intentionally do nothing in this handler.
});


    tickClocks(); setInterval(tickClocks, 1000);
    updateFileStatus();
    setAppEnabled(false); // keep everything disabled until Name + Block Start are set

    // Tabs init + wiring
    // AVP tile clicks (temporary placeholder behavior)




// Weather modal open + wiring
    const missionLogTile = document.getElementById("tileMissionLog");
if (missionLogTile) {
missionLogTile.addEventListener("click", ()=> {
// reset form view each time
resetMissionLogForm();
openModal(document.getElementById("missionLogModal"));
});
}

const weatherTile = document.getElementById("tileWeather");
      function addMissionTimelineEvent(label){
      const d = new Date();
      const payload = {
        timeHHMM: `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`,
        type: label,                  // OFFDECK / ONSTA / OFFSTA / ONDECK
        createdBy: crewPosition || "",
        createdAt: Date.now(),
        lastModified: Date.now()
      };
      const list = document.getElementById("missionTimelineItems");
      if (list) {
        const el = createTimelineItem(payload);
        if (list.firstChild) list.insertBefore(el, list.firstChild);
        else list.appendChild(el);
        dirty = true;
        requestAutoSyncSave(true);
        showBanner(`${label} logged to Mission Timeline.`);
      }
    }



    // Mission Timeline tile buttons (MD tab)
const offDeckBtn = document.getElementById("mtl_OFFDECK");
if (offDeckBtn) {
  offDeckBtn.addEventListener("click", ()=> {
    document.getElementById("offDeckTitle").textContent = "New Off Deck Report";
    window._onDeckMode = false;
    openModal(document.getElementById("offDeckModal"));
  });
}
const onStaBtn = document.getElementById("mtl_ONSTA");
if (onStaBtn) {
onStaBtn.addEventListener("click", ()=> {
window._timelineEntryType = "ONSTA";
document.getElementById("onStaTitle").textContent = "New ONSTA Report";
openModal(document.getElementById("onStaModal"));
});
}
const OFFSTABtn = document.getElementById("mtl_OFFSTA");
if (OFFSTABtn) {
  OFFSTABtn.addEventListener("click", ()=> {
    window._timelineEntryType = "OFFSTA";
    window._editingTimelineItem = null;
    document.getElementById("onStaTitle").textContent = "New OFFSTA Report";
    openModal(document.getElementById("onStaModal"));
  });
}

const onDeckBtn = document.getElementById("mtl_ONDECK");
if (onDeckBtn) {
  onDeckBtn.addEventListener("click", ()=> {
    document.getElementById("offDeckTitle").textContent = "New ONDECK Report";
    window._onDeckMode = true;
    openModal(document.getElementById("offDeckModal"));
  });
}



  const cont1Tile = document.getElementById("tileCONT1");
if (cont1Tile) {
cont1Tile.addEventListener("click", ()=> {
resetCont1Form();
openModal(document.getElementById("cont1Modal"));
});
}
if (weatherTile) {
weatherTile.addEventListener("click", ()=> {
// reset form view each time
resetWeatherForm();
openModal(document.getElementById("weatherModal"));
});
}

// Weather modal controls
const wxCloseBtn = document.getElementById("weatherCloseBtn");
  // CONT-1 modal controls
const cont1CloseBtn = document.getElementById("cont1CloseBtn");
if (cont1CloseBtn) {
cont1CloseBtn.addEventListener("click", ()=> closeModal(document.getElementById("cont1Modal")));
}
const cont1AddBtn = document.getElementById("cont1AddBtn");
if (cont1AddBtn) {
cont1AddBtn.addEventListener("click", openCont1FormNew);
}
const cont1Cancel = document.getElementById("cont1Cancel");
if (cont1Cancel) {
cont1Cancel.addEventListener("click", resetCont1Form);
}
const cont1TimeLostCurrent = document.getElementById("cont1TimeLostCurrent");
if (cont1TimeLostCurrent) {
cont1TimeLostCurrent.addEventListener("click", ()=> {
const d = new Date();
document.getElementById("cont1TimeLost").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

});
}
const cont1TimeRestoredCurrent = document.getElementById("cont1TimeRestoredCurrent");
if (cont1TimeRestoredCurrent) {
cont1TimeRestoredCurrent.addEventListener("click", ()=> {
const d = new Date();
document.getElementById("cont1TimeRestored").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

});
}
const cont1Form = document.getElementById("cont1Form");
if (cont1Form) {
cont1Form.addEventListener("submit", onCont1Save);
}
if (wxCloseBtn) {
wxCloseBtn.addEventListener("click", ()=> closeModal(document.getElementById("weatherModal")));
}
const wxAddBtn = document.getElementById("weatherAddBtn");
if (wxAddBtn) {
wxAddBtn.addEventListener("click", openWeatherFormNew);
}
const wxCancel = document.getElementById("wxCancel");
if (wxCancel) {
wxCancel.addEventListener("click", resetWeatherForm);
}
const wxTimeCurrent = document.getElementById("wxTimeCurrent");
if (wxTimeCurrent) {
  wxTimeCurrent.addEventListener("click", ()=> {
    const d = new Date();
    document.getElementById("wxTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  });
}

const wxForm = document.getElementById("weatherForm");
if (wxForm) {
wxForm.addEventListener("submit", onWeatherSave);
}
// Weather: also handle explicit click on the Save button in case submit binding fails
const wxSaveBtn = document.getElementById("wxSave");
if (wxSaveBtn) {
  wxSaveBtn.addEventListener("click", (e) => {
    e.preventDefault();
    onWeatherSave(e);
  });
}

// Clamp inputs for Weather form
 const mlCloseBtn = document.getElementById("mlCloseBtn");
if (mlCloseBtn) {
mlCloseBtn.addEventListener("click", ()=> closeModal(document.getElementById("missionLogModal")));
}
const mlAddBtn = document.getElementById("mlAddBtn");
if (mlAddBtn) {
mlAddBtn.addEventListener("click", openMissionLogFormNew);
}
const mlCancel = document.getElementById("mlCancel");
if (mlCancel) {
mlCancel.addEventListener("click", resetMissionLogForm);
}
const mlTimeCurrent = document.getElementById("mlTimeCurrent");
if (mlTimeCurrent) {
  mlTimeCurrent.addEventListener("click", ()=> {
    const d = new Date();
    document.getElementById("mlTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  });
}

const mlForm = document.getElementById("missionLogForm");
if (mlForm) {
mlForm.addEventListener("submit", onMissionLogSave);
}
function onWeatherSave(e){
  e && e.preventDefault && e.preventDefault();

  const idEditing = (document.getElementById("wxEditingId")?.value || "").trim();

  const t = (document.getElementById("wxTime").value || "").trim().replace(/\D/g,"").slice(0,4);
  if (t && (t.length !== 4 || Number(t.slice(0,2)) > 23 || Number(t.slice(2,4)) > 59)) {
    alert("Time must be HHMM Zulu.");
    return;
  }

  // DMS latitude
  const latDegStr    = (document.getElementById("wxLatDeg").value || "").replace(/\D/g,"");
  const latMinStr    = (document.getElementById("wxLatMin").value || "").replace(/\D/g,"");
  const latSecStr    = (document.getElementById("wxLatSec").value || "").replace(/\D/g,"").slice(0,2);
  const latDecSecStr = (document.getElementById("wxLatDecSec").value || "").replace(/\D/g,"").slice(0,2);
  const latHem       = (document.getElementById("wxLatHem").value || "N");

  // DMS longitude
  const lonDegStr    = (document.getElementById("wxLonDeg").value || "").replace(/\D/g,"");
  const lonMinStr    = (document.getElementById("wxLonMin").value || "").replace(/\D/g,"");
  const lonSecStr    = (document.getElementById("wxLonSec").value || "").replace(/\D/g,"").slice(0,2);
  const lonDecSecStr = (document.getElementById("wxLonDecSec").value || "").replace(/\D/g,"").slice(0,2);
  const lonHem       = (document.getElementById("wxLonHem").value || "E");

  const latDeg = Number(latDegStr), latMin = Number(latMinStr), latSec = Number(latSecStr);
  const lonDeg = Number(lonDegStr), lonMin = Number(lonMinStr), lonSec = Number(lonSecStr);

  const invalidLat = (latDegStr!=="" || latMinStr!=="" || latSecStr!=="") &&
    (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 ||
     !Number.isFinite(latMin)||latMin<0||latMin>=60 ||
     !Number.isFinite(latSec)||latSec<0||latSec>=60);

  const invalidLon = (lonDegStr!=="" || lonMinStr!=="" || lonSecStr!=="") &&
    (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 ||
     !Number.isFinite(lonMin)||lonMin<0||lonMin>=60 ||
     !Number.isFinite(lonSec)||lonSec<0||lonSec>=60);

  if (invalidLat || invalidLon) {
    alert("Check Position:\n- Lat: 0–90°, 0–59', 0–59.99\"\n- Lon: 0–180°, 0–59', 0–59.99\"");
    return;
  }

  // FL + comments
  const fl = (document.getElementById("wxFL").value || "").replace(/\D/g,"").slice(0,3);
  const comments = (document.getElementById("wxComments").value || "").trim();

  // legacy minute-fraction strings (compat with existing exporters)
  function toDecMinStr(minStr, secStr, decSecStr){
    const mm = Number(minStr||"0");
    const ss = Number(secStr||"0");
    const ds = Number(("0."+(decSecStr||"0")).slice(0,4));
    const total = mm + (ss + ds)/60;
    const whole = Math.floor(total);
    const frac  = total - whole;
    return String(Math.round(frac*1e8)).padStart(8,"0").replace(/0+$/,"");
  }
  const latDecMinStr = toDecMinStr(latMinStr, latSecStr, latDecSecStr);
  const lonDecMinStr = toDecMinStr(lonMinStr, lonSecStr, lonDecSecStr);

  const now = Date.now();

  const payload = {
    id: idEditing || `wx_${now}`,
    timeHHMM: t,
    latDeg: latDegStr, latMin: latMinStr, latSec: latSecStr, latDecSecStr, latDecMinStr, latHem,
    lonDeg: lonDegStr, lonMin: lonMinStr, lonSec: lonSecStr, lonDecSecStr, lonDecMinStr, lonHem,
    altitudeFL: fl,
    comments,
    createdBy: crewPosition || "",
    createdAt: idEditing ? undefined : now,
    lastModified: now
  };

  const list = document.getElementById("weatherItems");
  if (!list) return;

  if (idEditing) {
    const el = Array.from(list.children).find(it => {
      try { return JSON.parse(it.dataset.payload || "{}").id === idEditing; } catch { return false; }
    });
    if (el) {
      const existing = JSON.parse(el.dataset.payload || "{}");
      const merged = { ...existing, ...payload };
      el.dataset.payload = JSON.stringify(merged);
      el.querySelector(".creator").textContent = (crewPosition || "");

      const details = el.querySelector(".item-details");
      if (details) {
        details.innerHTML = "";
        const ss = (v)=>String(v??"").padStart(2,"0");
        const lat = `${merged.latDeg}:${ss(merged.latMin)}:${ss(merged.latSec)}${merged.latDecSecStr?('.'+merged.latDecSecStr):''}${merged.latHem}`;
        const lon = `${merged.lonDeg}:${ss(merged.lonMin)}:${ss(merged.lonSec)}${merged.lonDecSecStr?('.'+merged.lonDecSecStr):''}${merged.lonHem}`;
        const posStr = (merged.latDeg && merged.lonDeg) ? `${lat} ${lon}` : "";
        if (merged.timeHHMM) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Time:</em> ${merged.timeHHMM}Z</span>`);
        if (posStr) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Pos:</em> ${posStr}</span>`);
              if (merged.altitudeFL) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>FL:</em> ${merged.altitudeFL}</span>`);

        if (merged.comments) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(merged.comments)}</span>`);
      }
    }
  } else {
    const el = createWeatherItem(payload);
    list.insertBefore(el, list.firstChild || null);
  }

  // reset UI
  document.getElementById("wxEditingId").value = "";
  document.getElementById("weatherForm").reset();
  document.getElementById("weatherFormWrap").style.display = "none";

  // persist
  dirty = true;
  requestAutoSyncSave(true);
  showBanner("Weather saved.");
}

    // Off Deck modal controls
const odCancel = document.getElementById("odCancel");
if (odCancel) {
  odCancel.addEventListener("click", ()=> {
    window._onDeckMode = false;
    closeModal(document.getElementById("offDeckModal"));
  });
}
const odTimeCurrent = document.getElementById("odTimeCurrent");
if (odTimeCurrent) {
  odTimeCurrent.addEventListener("click", ()=> {
    const d = new Date();
    document.getElementById("odTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  });
}
const odForm = document.getElementById("offDeckForm");
if (odForm) {
  odForm.addEventListener("submit", (e)=> {
    e.preventDefault();
    const t = (document.getElementById("odTime").value || "").trim().replace(/\D/g,"").slice(0,4);
    const airfield = (document.getElementById("odAirfield").value || "").trim();
    const now = Date.now();
    const isOnDeck = window._onDeckMode || false;
    const entryType = isOnDeck ? "ONDECK" : "OFFDECK";
    
    // Validate time if provided
    if (t && (t.length !== 4 || Number(t.slice(0,2)) > 23 || Number(t.slice(2,4)) > 59)) {
      alert("Time must be HHMM Zulu.");
      return;
    }

    // If editing an existing OFFDECK/ONDECK timeline item, update in place
    if (window._editingTimelineItem && (window._editingTimelineItem._kind === "TIMELINE_OFFDECK" || window._editingTimelineItem._kind === "TIMELINE_ONDECK")) {
      const existing = JSON.parse(window._editingTimelineItem.dataset.payload || "{}");
      const payload = {
        ...existing,
        timeHHMM: t,
        type: existing.type || entryType,
        airfield: airfield || "",
        lastModified: now
      };
      updateTimelineItem(window._editingTimelineItem, payload);
      window._editingTimelineItem = null;
      window._onDeckMode = false;
      dirty = true;
      requestAutoSyncSave(true);
      closeModal(document.getElementById("offDeckModal"));
      const typeName = (existing.type === "ONDECK") ? "On Deck" : "Off Deck";
      showBanner(`${typeName} updated.`);
      return;
    }

    // New OFFDECK or ONDECK entry
    const payload = {
      timeHHMM: t,
      type: entryType,
      airfield: airfield || "",
      createdBy: crewPosition || "",
      createdAt: now,
      lastModified: now
    };

    const list = document.getElementById("missionTimelineItems");
    if (list) {
      const el = createTimelineItem(payload);
      if (list.firstChild) list.insertBefore(el, list.firstChild);
      else list.appendChild(el);
    }
    dirty = true;
    requestAutoSyncSave(true);
    closeModal(document.getElementById("offDeckModal"));
    window._onDeckMode = false;
    const typeName = isOnDeck ? "On Deck" : "Off Deck";
    showBanner(`${typeName} logged to Mission Timeline.`);
  });
}

// Clamp Off Deck time input
    // On Sta modal controls
const osCancel = document.getElementById("osCancel");
if (osCancel) {
osCancel.addEventListener("click", ()=> closeModal(document.getElementById("onStaModal")));
}
const osTimeCurrent = document.getElementById("osTimeCurrent");
if (osTimeCurrent) {
  osTimeCurrent.addEventListener("click", ()=> {
    const d = new Date();
    document.getElementById("osTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  });
}

const osForm = document.getElementById("onStaForm");
if (osForm) {
osForm.addEventListener("submit", (e)=> {
e.preventDefault();
const t = (document.getElementById("osTime").value || "").trim().replace(/\D/g,"").slice(0,4);
if (t && (t.length !== 4 || Number(t.slice(0,2)) > 23 || Number(t.slice(2,4)) > 59)) {
alert("Time must be HHMM Zulu.");
return;
}

const latDegStr    = (document.getElementById("osLatDeg").value || "").replace(/\D/g,"");
const latMinStr    = (document.getElementById("osLatMin").value || "").replace(/\D/g,"");
const latSecStr    = (document.getElementById("osLatSec").value || "").replace(/\D/g,"").slice(0,2);
const latDecSecStr = (document.getElementById("osLatDecSec").value || "").replace(/\D/g,"").slice(0,2);
const latHem       = (document.getElementById("osLatHem").value || "N");

const lonDegStr    = (document.getElementById("osLonDeg").value || "").replace(/\D/g,"");
const lonMinStr    = (document.getElementById("osLonMin").value || "").replace(/\D/g,"");
const lonSecStr    = (document.getElementById("osLonSec").value || "").replace(/\D/g,"").slice(0,2);
const lonDecSecStr = (document.getElementById("osLonDecSec").value || "").replace(/\D/g,"").slice(0,2);
const lonHem       = (document.getElementById("osLonHem").value || "E");

// numeric checks (include seconds)
const latDeg=Number(latDegStr), latMin=Number(latMinStr), latSec=Number(latSecStr);
const lonDeg=Number(lonDegStr), lonMin=Number(lonMinStr), lonSec=Number(lonSecStr);

const invalidLat = (latDegStr!=="" || latMinStr!=="" || latSecStr!=="") &&
  (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 ||
   !Number.isFinite(latMin)||latMin<0||latMin>=60 ||
   !Number.isFinite(latSec)||latSec<0||latSec>=60);

const invalidLon = (lonDegStr!=="" || lonMinStr!=="" || lonSecStr!=="") &&
  (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 ||
   !Number.isFinite(lonMin)||lonMin<0||lonMin>=60 ||
   !Number.isFinite(lonSec)||lonSec<0||lonSec>=60);

if(invalidLat || invalidLon){
  alert("Check Position:\n- Lat: 0–90°, 0–59', 0–59.99\"\n- Lon: 0–180°, 0–59', 0–59.99\"");
  return;
}

// build legacy decimal-minutes strings from DMS for compatibility
function toDecMinStr(minStr, secStr, decSecStr){
  const mm = Number(minStr||"0");
  const ss = Number(secStr||"0");
  const ds = Number(("0."+(decSecStr||"0")).slice(0,4)); // two dec-sec digits
  const total = mm + (ss + ds)/60;
  const whole = Math.floor(total);
  const frac  = total - whole;
  return String(Math.round(frac*1e8)).padStart(8,"0").replace(/0+$/,"");
}
const latDecMinStr = toDecMinStr(latMinStr, latSecStr, latDecSecStr);
const lonDecMinStr = toDecMinStr(lonMinStr, lonSecStr, lonDecSecStr);


const altitude = (document.getElementById("osAlt").value || "").trim();
const now = Date.now();

// If editing an existing ONSTA/OFFSTA timeline item, update in place
if (window._editingTimelineItem) {
  const existing = JSON.parse(window._editingTimelineItem.dataset.payload || "{}");
  if ((existing.type || "") === "ONSTA" || (existing.type || "") === "OFFSTA") {
    const payload = {
      ...existing,
      timeHHMM: t,
            type: ((JSON.parse(window._editingTimelineItem.dataset.payload || "{}")||{}).type || window._timelineEntryType || "ONSTA"),

      // DMS + compat dec-minutes
      latDeg: latDegStr, latMin: latMinStr, latSec: latSecStr, latDecSecStr: latDecSecStr, latDecMinStr, latHem,
      lonDeg: lonDegStr, lonMin: lonMinStr, lonSec: lonSecStr, lonDecSecStr: lonDecSecStr, lonDecMinStr, lonHem,
      altitude: altitude || "",
      lastModified: now
    };

 updateTimelineItem(window._editingTimelineItem, payload);
    window._editingTimelineItem = null;
    window._timelineEntryType = "ONSTA";
    dirty = true;
    requestAutoSyncSave(true);
    closeModal(document.getElementById("onStaModal"));
    const typeName = (existing.type === "OFFSTA") ? "OffSta" : "OnSta";
    showBanner(`${typeName} updated.`);
    return;
  }
}


// New ONSTA entry
const payload = {
  timeHHMM: t,
  type: (window._timelineEntryType || "ONSTA"),

  // DMS + compat dec-minutes
  latDeg: latDegStr, latMin: latMinStr, latSec: latSecStr, latDecSecStr: latDecSecStr, latDecMinStr, latHem,
  lonDeg: lonDegStr, lonMin: lonMinStr, lonSec: lonSecStr, lonDecSecStr: lonDecSecStr, lonDecMinStr, lonHem,
  altitude: altitude || "",
  createdBy: crewPosition || "",
  createdAt: now,
  lastModified: now
};


const list = document.getElementById("missionTimelineItems");
if (list) {
  const el = createTimelineItem(payload);
  if (list.firstChild) list.insertBefore(el, list.firstChild);
  else list.appendChild(el);
}
dirty = true;
requestAutoSyncSave(true);
closeModal(document.getElementById("onStaModal"));
const typeName = (window._timelineEntryType === "OFFSTA") ? "OffSta" : "OnSta";
showBanner(`${typeName} logged to Mission Timeline.`);
window._timelineEntryType = "ONSTA";


});
}
// Clamp OnSta inputs
clampDigitsInput(document.getElementById("osTime"));
clampDigitsInput(document.getElementById("osLatDeg"));
clampDigitsInput(document.getElementById("osLatMin"));
clampDigitsInput(document.getElementById("osLatSec"), 2);
clampDigitsInput(document.getElementById("osLatDecSec"), 2);
clampDigitsInput(document.getElementById("osLonDeg"));
clampDigitsInput(document.getElementById("osLonMin"));
clampDigitsInput(document.getElementById("osLonSec"), 2);
clampDigitsInput(document.getElementById("osLonDecSec"), 2);
clampDigitsInput(document.getElementById("odTime"));
    // OFFSTA button -> open the same modal as ONSTA, but mark type and title
const offStaBtn = document.getElementById("offStaBtn");
if (offStaBtn) {
  // Ensure it cannot submit any enclosing form
  try { offStaBtn.setAttribute("type", "button"); } catch {}

  offStaBtn.addEventListener("click", (e) => {
    // prevent any parent form submission or bubbling that could create a log line
    e.preventDefault();
    e.stopPropagation();

    // Open a dedicated popup window for OFFSTA entry
    const w = window.open("", "wf_offsta_popup", "width=820,height=560");
    const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
       <title>New OFFSTA Report</title>

        <style>
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:16px;background:#f7f8fb;color:#111}
          .row{display:flex;gap:8px;align-items:center;margin-bottom:10px}
          .row label{min-width:160px}
          input,select,button{font-size:14px;padding:8px;border:1px solid #cbd5e1;border-radius:8px}
          input{width:100%}
          .deg{width:80px}
          .min{width:80px}
          .sec{width:80px}
          .dec{width:100px}
          .hem{width:80px}
          .actions{display:flex;gap:8px;margin-top:14px}
          .title{font-weight:700;font-size:18px;margin-bottom:12px}
          .muted{color:#6b7280}
        </style>
      </head>
      <body>
<div class="title">New OFFSTA Report</div>


        <div class="row">
          <label for="p_osTime">Time (Zulu)</label>
          <input id="p_osTime" placeholder="HHMM" maxlength="4">
          <span class="muted">HHMM</span>
        </div>

        <div class="row"><strong>Latitude (D° M' S.SS")</strong></div>
        <div class="row">
          <input id="p_osLatDeg" class="deg" placeholder="Deg" maxlength="2">
          <input id="p_osLatMin" class="min" placeholder="Min" maxlength="2">
          <input id="p_osLatSec" class="sec" placeholder="Sec" maxlength="2">
          <span class="muted">.</span>
          <input id="p_osLatDecSec" class="dec" placeholder="Dec Sec" maxlength="2">
          <select id="p_osLatHem" class="hem">
            <option value="N" selected>N</option>
            <option value="S">S</option>
          </select>
        </div>

        <div class="row"><strong>Longitude (D° M' S.SS")</strong></div>
        <div class="row">
          <input id="p_osLonDeg" class="deg" placeholder="Deg" maxlength="3">
          <input id="p_osLonMin" class="min" placeholder="Min" maxlength="2">
          <input id="p_osLonSec" class="sec" placeholder="Sec" maxlength="2">
          <span class="muted">.</span>
          <input id="p_osLonDecSec" class="dec" placeholder="Dec Sec" maxlength="2">
          <select id="p_osLonHem" class="hem">
            <option value="E" selected>E</option>
            <option value="W">W</option>
          </select>
        </div>

        <div class="row">
          <label for="p_osAlt">Altitude</label>
          <input id="p_osAlt" placeholder="e.g., 12500">
        </div>

        <div class="actions">
          <button id="p_cancel" type="button">Cancel</button>
          <button id="p_save" type="button">Save</button>
        </div>

        <script>
          document.getElementById("p_cancel").addEventListener("click", ()=> window.close());
          document.getElementById("p_save").addEventListener("click", ()=>{
            const data = {
              time: (document.getElementById("p_osTime").value || "").trim(),
              latDeg: (document.getElementById("p_osLatDeg").value || "").trim(),
              latMin: (document.getElementById("p_osLatMin").value || "").trim(),
              latSec: (document.getElementById("p_osLatSec").value || "").trim(),
              latDecSec: (document.getElementById("p_osLatDecSec").value || "").trim(),
              latHem: (document.getElementById("p_osLatHem").value || "N"),
              lonDeg: (document.getElementById("p_osLonDeg").value || "").trim(),
              lonMin: (document.getElementById("p_osLonMin").value || "").trim(),
              lonSec: (document.getElementById("p_osLonSec").value || "").trim(),
              lonDecSec: (document.getElementById("p_osLonDecSec").value || "").trim(),
              lonHem: (document.getElementById("p_osLonHem").value || "E"),
              altitude: (document.getElementById("p_osAlt").value || "").trim()
            };
            try{
              if(window.opener){
                window.opener.postMessage({ type: "WF_OFFSTA_SAVE", data }, "*");
              }
            }catch{}
            window.close();
          });
          window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") window.close(); });
        <\/script>
      </body>
      </html>`;


    w.document.open();
    w.document.write(html);
    w.document.close();
  }, true);

  // Keyboard accessibility: Enter/Space opens the popup without submitting a form
  offStaBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      offStaBtn.click();
    }
  }, true);
}




clampDigitsInput(document.getElementById("wxTime"));
/* Receive OFFSTA data from popup and create a Mission Timeline entry */
window.addEventListener("message", (evt) => {
  const msg = evt && evt.data;
  if (!msg || msg.type !== "WF_OFFSTA_SAVE") return;

  try {
    const d = msg.data || {};

    // Normalize inputs
    const t = String(d.time || "").trim().replace(/\D/g, "").slice(0,4);
    if (t && (t.length !== 4 || Number(t.slice(0,2)) > 23 || Number(t.slice(2,4)) > 59)) {
      alert("Time must be HHMM Zulu.");
      return;
    }

    const latDegStr = String(d.latDeg || "").replace(/\D/g, "");
    const latMinStr = String(d.latMin || "").replace(/\D/g, "");
    const latSecStr = String(d.latSec || "").replace(/\D/g, "").slice(0,2);
    const latDecSecStr = String(d.latDecSec || "").replace(/\D/g, "").slice(0,2);
    const latHem = d.latHem || "N";

    const lonDegStr = String(d.lonDeg || "").replace(/\D/g, "");
    const lonMinStr = String(d.lonMin || "").replace(/\D/g, "");
    const lonSecStr = String(d.lonSec || "").replace(/\D/g, "").slice(0,2);
    const lonDecSecStr = String(d.lonDecSec || "").replace(/\D/g, "").slice(0,2);
    const lonHem = d.lonHem || "E";

    const altitude = (String(d.altitude || "").trim());

    // Validate DMS bounds
    const latDeg = Number(latDegStr), latMin = Number(latMinStr), latSec = Number(latSecStr);
    const lonDeg = Number(lonDegStr), lonMin = Number(lonMinStr), lonSec = Number(lonSecStr);

    const invalidLat = (latDegStr !== "" || latMinStr !== "" || latSecStr !== "") &&
      (!Number.isFinite(latDeg) || latDeg < 0 || latDeg > 90 ||
       !Number.isFinite(latMin) || latMin < 0 || latMin >= 60 ||
       !Number.isFinite(latSec) || latSec < 0 || latSec >= 60);

    const invalidLon = (lonDegStr !== "" || lonMinStr !== "" || lonSecStr !== "") &&
      (!Number.isFinite(lonDeg) || lonDeg < 0 || lonDeg > 180 ||
       !Number.isFinite(lonMin) || lonMin < 0 || lonMin >= 60 ||
       !Number.isFinite(lonSec) || lonSec < 0 || lonSec >= 60);

    if (invalidLat || invalidLon) {
      alert("Check Position:\n- Lat: 0–90°, 0–59', 0–59.99\" \n- Lon: 0–180°, 0–59', 0–59.99\"");
      return;
    }

    // Convert DMS seconds/dec-sec to legacy dec-min (compat with existing exporters)
    function toDecMinStr(minStr, secStr, decSecStr){
      const mm = Number(minStr||"0");
      const ss = Number(secStr||"0");
      const ds = Number(("0."+(decSecStr||"0")).slice(0,4)); // up to 2 decimal sec
      const total = mm + (ss + ds)/60;
      const whole = Math.floor(total);
      const frac  = total - whole;
      return String(Math.round(frac*1e8)).padStart(8,"0").replace(/0+$/,"");
    }

    const latDecMinStr = toDecMinStr(latMinStr, latSecStr, latDecSecStr);
    const lonDecMinStr = toDecMinStr(lonMinStr, lonSecStr, lonDecSecStr);

    // Build OFFSTA payload for Mission Timeline
    const now = Date.now();
    const payload = {
      timeHHMM: t,
      type: "OFFSTA",
      latDeg: latDegStr, latMin: latMinStr, latSec: latSecStr, latDecSecStr: latDecSecStr, latDecMinStr, latHem,
      lonDeg: lonDegStr, lonMin: lonMinStr, lonSec: lonSecStr, lonDecSecStr: lonDecSecStr, lonDecMinStr, lonHem,
      altitude: altitude || "",
      createdBy: crewPosition || "",
      createdAt: now,
      lastModified: now
    };

    const list = document.getElementById("missionTimelineItems");
    if (list) {
      const el = createTimelineItem(payload);
      if (list.firstChild) list.insertBefore(el, list.firstChild);
      else list.appendChild(el);
    }
    dirty = true;
    requestAutoSyncSave(true);
showBanner("OFFSTA logged to Mission Timeline.");

 } catch(e){
    console.warn("[OFFSTA popup] Save failed:", e);
  }
});


clampDigitsInput(document.getElementById("wxLatDeg"));
clampDigitsInput(document.getElementById("wxLatMin"));
clampDigitsInput(document.getElementById("wxLatSec"), 2);
clampDigitsInput(document.getElementById("wxLatDecSec"), 2);
clampDigitsInput(document.getElementById("wxLonDeg"));
clampDigitsInput(document.getElementById("wxLonMin"));
clampDigitsInput(document.getElementById("wxLonSec"), 2);
clampDigitsInput(document.getElementById("wxLonDecSec"), 2);
clampDigitsInput(document.getElementById("wxFL"));
clampDigitsInput(document.getElementById("mlTime"));
// Clamp inputs for CONT-1 form
clampDigitsInput(document.getElementById("cont1TimeLost"));
clampDigitsInput(document.getElementById("cont1TimeRestored"));
clampDigitsInput(document.getElementById("cont1LatDeg"));
clampDigitsInput(document.getElementById("cont1LatMin"));
clampDigitsInput(document.getElementById("cont1LatSec"), 2);
clampDigitsInput(document.getElementById("cont1LatDecSec"), 2);
clampDigitsInput(document.getElementById("cont1LonDeg"));
clampDigitsInput(document.getElementById("cont1LonMin"));
clampDigitsInput(document.getElementById("cont1LonSec"), 2);
clampDigitsInput(document.getElementById("cont1LonDecSec"), 2);
clampDigitsInput(document.getElementById("cont1FL"));
 


// Faults section (Mission Details)
const faultAddBtn = document.getElementById("faultAddBtn");
if (faultAddBtn) {
faultAddBtn.addEventListener("click", () => {
document.getElementById("faultTime").value = "";
document.getElementById("faultCode").value = "";
document.getElementById("faultComments").value = "";
openModal(document.getElementById("faultsModal"));
});
}

// Faults modal controls
const faultsCancelBtn = document.getElementById("faultsCancel");
if (faultsCancelBtn) {
faultsCancelBtn.addEventListener("click", () => closeModal(document.getElementById("faultsModal")));
}

const faultsSaveBtn = document.getElementById("faultsSave");
if (faultsSaveBtn) {
faultsSaveBtn.addEventListener("click", () => {
const time = (document.getElementById("faultTime").value || "").trim().replace(/\D/g,"").slice(0,4);
if (time && (time.length !== 4 || Number(time.slice(0,2)) > 23 || Number(time.slice(2,4)) > 59)) {
alert("Time must be HHMM Zulu.");
return;
}
const code = (document.getElementById("faultCode").value || "").trim();
const comments = (document.getElementById("faultComments").value || "").trim();

const payload = {
  timeHHMM: time,
  faultCode: code,
  comments,
  createdBy: crewPosition || "",
  createdAt: Date.now()
};

const container = document.getElementById("faultItems");
if (container) {
  const el = createFaultItem(payload);
  container.appendChild(el);
  dirty = true;
  requestAutoSyncSave(true);
  closeModal(document.getElementById("faultsModal"));
  showBanner("Fault saved.");
}


});
}

const faultsCurrentBtn = document.getElementById("faultTimeCurrent");
if (faultsCurrentBtn) {
faultsCurrentBtn.addEventListener("click", () => {
const d = new Date();
document.getElementById("faultTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

});
}

    const savedTab = (localStorage.getItem('wf_active_tab') || 'TC');
    setActiveTab(savedTab);
    $$('.tabbar .tab').forEach(btn=>{
      btn.addEventListener('click', ()=> setActiveTab(btn.dataset.tabTarget || 'TC'));
    });

    
    // Collaborative poll
    setInterval(async ()=>{
      if(memoryMode||!useFS||!fileHandle||isSaving) return;
      try{
        const f=await fileHandle.getFile();
        if(f.lastModified>lastKnownMod){
          const txt=await f.text();
          const incoming=JSON.parse(txt||"{}");
          applyState(incoming);
          lastKnownMod=f.lastModified;
          dirty=false;
          showBanner("Remote changes detected. View updated.");
          recomputeHighlights();
        }
      }catch{}
    }, POLL_MS);

    // Suggestion form
    $("#sb-cancel").addEventListener("click", ()=> closeModal($("#suggestionModal")));
    $("#suggestionForm").addEventListener("submit", onSuggestionSave);
    ["sb-suggestion","sb-name","sb-email"].forEach(id=> $("#"+id).addEventListener("input", ()=> validateSuggestion(false)));
  });

  // ---- Crew / Block ----
  async function onCrewApply(){
    const v=$("#crewInput").value.trim();
    if(!v){ alert("Please enter a Crew Position."); return; }
    crewPosition=v; $("#crewDisplay").textContent=crewPosition; closeModal($("#crewModal"));

if(pendingMode==="new"){
  // Immediately prompt to save the JSON skeleton after name is submitted
  try{
    if(useFS){
      fileHandle = await window.showSaveFilePicker({
        suggestedName:"warfighter_board.json",
        types:[{ description:"JSON", accept:{ "application/json":[".json"] } }]
      });

      // Create skeleton (no Block Start yet)
      const initialState = mkInitialState(); // blockStartNum is currently null/undefined
      const w = await fileHandle.createWritable();
      await w.write(JSON.stringify(initialState,null,2));
      await w.close();
      try{
        const f = await fileHandle.getFile();
        lastKnownMod = f.lastModified;
      }catch{
        lastKnownMod = Date.now();
      }

      memoryMode = false;
      // Show app; AVP/MPO usable; TC gated by Block Start
      landing.style.display="none";
      app.style.display="block";
      app.setAttribute("aria-hidden","false");
      forceTabTC();
      applyState(initialState);
      updateFileStatus();
      enableIfReady();
      recomputeHighlights();
    } else {
  // Fallback (no File System Access API): memory mode
  memoryMode = true;
  fileHandle = null;
  const initialState = mkInitialState();
  landing.style.display="none";
  app.style.display="block";
  app.setAttribute("aria-hidden","false");
  forceTabTC();
  applyState(initialState);
  updateFileStatus();
  enableIfReady();
  recomputeHighlights();
  showBanner("Running in memory — use Download JSON.");
}
pendingMode = null;

    } catch(e){
console.warn("[New Mission] Save canceled or failed:", e);
// If user cancels save, stay on landing so they can retry.
return;
}

} else if(pendingMode==="collab"){


      if(useFS){
        try{
          const [handle]=await window.showOpenFilePicker({ types:[{ description:"JSON", accept:{ "application/json":[".json"] } }], multiple:false });
          fileHandle=handle; memoryMode=false;
          await loadStateFromFile();
landing.style.display="none"; app.style.display="block"; app.setAttribute("aria-hidden","false");
forceTabTC();   // make TC the default tab
const bsElFS = document.getElementById("md_blockStart");
if(!Number.isInteger(blockStartNum)){
if (bsElFS) bsElFS.value = ""; // leave TC gated; AVP/MPO usable
} else {
if (bsElFS) bsElFS.value = String(blockStartNum);
enableIfReady();
}


          updateFileStatus(); recomputeHighlights();
        }catch(e){ console.warn("[crewApply] open file error:", e); }
      } else {
        const inp=$("#fileOpenFallback");
        inp.onchange=async ()=>{
          const f=inp.files[0]; if(!f) return;
          try{
            const txt=await f.text(); const incoming=JSON.parse(txt||"{}");
            applyState(incoming);
                   blockStartNum = Number.isInteger(incoming.blockStartNum) ? incoming.blockStartNum : blockStartNum;
        const bsElNoFS = document.getElementById("md_blockStart");
        if (bsElNoFS) bsElNoFS.value = Number.isInteger(blockStartNum) ? String(blockStartNum) : "";

            landing.style.display="none"; app.style.display="block"; app.setAttribute("aria-hidden","false");
forceTabTC();   // ensure TC tab after collab (no FS)
memoryMode=true; fileHandle=null; updateFileStatus(); enableIfReady(); recomputeHighlights();

          } catch { alert("Failed to read JSON file."); }
          inp.value="";
        };
        inp.click();
      }
      pendingMode=null;
    }
  }

 async function onBlockApply(){
  const digits = $("#blockInput").value.replace(/\D/g,"").slice(0,10);
  if(!digits){ alert("Enter a whole number for Block Start."); return; }

  blockStartNum = Number(digits);
 const bsEl = document.getElementById("md_blockStart");
if (bsEl) bsEl.value = String(blockStartNum);
closeModal($("#blockModal"));

// Enable TC now that Block Start is set; AVP/MPO were already usable
enableIfReady();
recomputeHighlights();

// Persist to file if available
try {
requestAutoSyncSave(true);
} catch(e) {
console.warn("Block Start save failed:", e);
}

// Clear pendingMode if it was set
pendingMode = null;
}


  async function loadStateFromFile(){
    if(!fileHandle) return;
    const file=await fileHandle.getFile();
    lastKnownMod=file.lastModified;
    const txt=await file.text();
    if(!txt.trim()) return;
    const incoming=JSON.parse(txt);
    applyState(incoming);
    dirty=false;
  }

  // ---- Save (debounced) ----
  let saveTimer=null;
  function requestAutoSyncSave(prioritize=false){
    if(prioritize && saveTimer){ clearTimeout(saveTimer); saveTimer=null; }
    if(saveTimer) return;
    saveTimer=setTimeout(async ()=>{ saveTimer=null; await syncAndSave(); }, AUTO_SAVE_MS);
  }
  async function syncAndSave(){
    if(memoryMode) return downloadCurrentJSON();
    if(!fileHandle) return;
    if(isSaving){ pendingResave=true; return; }
    isSaving=true; fileStatus.textContent=fileHandle ? `Saving… ${fileHandle.name}` : "Saving…";
    try{
      const state=gatherStateFromDOM();
      const w=await fileHandle.createWritable();
      await w.write(JSON.stringify(state,null,2)); await w.close();
      try{ const f2=await fileHandle.getFile(); lastKnownMod=f2.lastModified; }catch{ lastKnownMod=Date.now(); }
      fileStatus.textContent=`Synced: ${fileHandle.name}`;
      dirty=false; showBanner("Synced & saved.");
    }catch(e){ console.error("Save failed:", e); alert("Failed to write JSON. Try again."); }
    finally{ isSaving=false; if(pendingResave){ pendingResave=false; requestAutoSyncSave(true); } }
  }
  function downloadCurrentJSON(){
    const state=gatherStateFromDOM();
    const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    const ts=new Date();
    a.href=url; a.download=`warfighter_board_${ts.getFullYear()}${pad2(ts.getMonth()+1)}${pad2(ts.getDate())}_${pad2(ts.getHours())}${pad2(ts.getMinutes())}.json`;
    a.click(); URL.revokeObjectURL(url);
    showBanner("Downloaded current JSON.");
  }

  // ---- State (build/apply) ----
function mkInitialState(){
return {
crewRoster:[crewPosition],
blockStartNum,
missionNumber,
columns:{ India:[], Echo:[], AIS:[], Alpha:[], November:[], Golf:[] },
correlations:[],
deleted:[],
suggestions:[],
faults:[],
missionLog:[],
missionTimeline:[],

crewDetails
};
}

  function applyState(state){

document.querySelectorAll('.column[data-column]:not([data-column="MissionDetails"]):not([data-column="MissionTimeline"]) .items').forEach(div=> div.innerHTML="");
const faultList = document.getElementById("faultItems");
if (faultList) { faultList.innerHTML = ""; }
    if (Array.isArray(state.faults)) {
  const sortedF = state.faults.slice().sort((a,b)=> Number(b.createdAt||0) - Number(a.createdAt||0));
  const containerF = document.getElementById("faultItems");
  if (containerF) {
    sortedF.forEach(p => {
      try { containerF.appendChild(createFaultItem(p)); }
      catch(e){ console.warn("faults skip:", e); }
    });
  }
}
// Render Change History (newest first if provided)
if (Array.isArray(state.changeHistory)) {
  const list = document.getElementById("historyItems");
  if (list) {
    const sortedH = state.changeHistory.slice().sort((a,b)=> Number(b.at||0) - Number(a.at||0));
    sortedH.forEach(p => {
      try { list.appendChild(createHistoryItem(p)); } catch(e){ console.warn("history skip:", e); }
    });
  }
}

const wxList = document.getElementById("weatherItems");
if (wxList) { wxList.innerHTML = ""; }
const mlList = document.getElementById("missionLogItems");
if (mlList) { mlList.innerHTML = ""; }
const mtlList = document.getElementById("missionTimelineItems");
    const histList = document.getElementById("historyItems");
if (histList) { histList.innerHTML = ""; }

if (mtlList) { mtlList.innerHTML = ""; }

  refreshAllAbbrevBadges();
       if (Array.isArray(state.missionTimeline)) {
      const sortedMTL = state.missionTimeline.slice().sort((a,b)=> Number(b.createdAt||0) - Number(a.createdAt||0));
      const containerMTL = document.getElementById("missionTimelineItems");
      if (containerMTL) {
        sortedMTL.forEach(p => {
          try { containerMTL.appendChild(createTimelineItem(p)); }
          catch(e){ console.warn("missionTimeline skip:", e); }
        });
      }
    }

    if (Array.isArray(state.missionLog)) {
      const sortedML = state.missionLog.slice().sort((a,b)=> Number(b.createdAt||0) - Number(a.createdAt||0));
      const containerML = document.getElementById("missionLogItems");
      if (containerML) {
        sortedML.forEach(p => {
          try { containerML.appendChild(createMissionLogItem(p)); } catch(e){ console.warn("missionLog skip:", e); }
        });
      }
    }


   if(Number.isInteger(state.blockStartNum)){ blockStartNum=state.blockStartNum; }

if (state.crewDetails && Array.isArray(state.crewDetails.shifts)) {
  crewDetails = state.crewDetails;
} else {
  crewDetails = mkCrewDetailsDefaults();
}

    if(state.columns && typeof state.columns==="object"){
      fillCrewDetailsTileFromState();

      Object.entries(state.columns).forEach(([colName,items])=>{
        const target=document.querySelector(`.column[data-column="${CSS.escape(colName)}"] .items`);
        if(!target) return;
        for(const payload of (items||[])){
          try{ target.appendChild(createItemElement(payload,"active")); }catch(e){ console.warn("skip bad:", e); }
        }
      });
      refreshAllAbbrevBadges();
    }

    (state.correlations||[]).forEach(entry=>{ const card=createCorrelationCard(entry); $("#correlationItems").appendChild(card); });

deletedSetLocal=new Set();
    // Also restore mission meta that wasn't being applied
if (typeof state.missionNumber === "string") {
  missionNumber = state.missionNumber;
  // reflect in the Mission Details tile in case columns haven't forced a refresh yet
  fillCrewDetailsTileFromState();
}

(state.deleted||[]).forEach(d=> deletedSetLocal.add(d.originalCode || d.code));

    const deletedTarget=$("#deletedItems");
    (state.deleted||[]).forEach(payload=>{ try{ deletedTarget.appendChild(createItemElement(payload,"deleted")); }catch(e){ console.warn("del skip:", e); } });

    suggestions = Array.isArray(state.suggestions) ? state.suggestions.slice() : [];

    Object.keys(columnNextNumber).forEach(k=> columnNextNumber[k]=null);
    document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"])').forEach(col=>{
      const name=col.dataset.column; let maxNum=null;
      col.querySelectorAll(".item .badge").forEach(b=>{
        const code=b.textContent.trim();
        const m = code.startsWith("AIS") ? code.match(/^AIS(\d+)$/) : code.match(/^[A-Z](\d+)$/i);
        if(m&&m[1]){ const n=Number(m[1]); if(Number.isFinite(n)) maxNum = (maxNum===null)? n : Math.max(maxNum,n); }
      });
      columnNextNumber[name] = (maxNum===null) ? (blockStartNum ?? 0) : (maxNum+1);
    });

    enableIfReady(); dirty=false; recomputeHighlights();
  }

function gatherStateFromDOM(){
  const state = {
crewRoster: crewPosition ? [crewPosition] : [],
blockStartNum,
missionNumber,
columns: {},
correlations: [],
deleted: [],
suggestions: suggestions.slice(),
crewDetails // keep the crew details in the save
};

  // Build columns + deleted + correlations from DOM
  document.querySelectorAll(".column[data-column]").forEach(col=>{
    const name = col.dataset.column;

    if(name === "Correlations"){
      const cards = Array.from(col.querySelectorAll("#correlationItems .item"));
      state.correlations = cards.map(card=>{
        const codes = Array.from(card.querySelectorAll(".badge[data-code]")).map(b=>b.dataset.code);
        return {
          codes,
          createdBy: card.dataset.createdBy || "",
          createdAt: Number(card.dataset.createdAt || 0),
          lastBy: card.dataset.lastBy || (card.dataset.createdBy || ""),
          lastAt: Number(card.dataset.lastAt || card.dataset.createdAt || 0)
        };
      });
    } else if(name === "Deleted"){
      const items = Array.from(col.querySelectorAll(".item")).map(it=> JSON.parse(it.dataset.payload));
      state.deleted = items;
} else if(name !== "History" && name !== "MissionDetails" && name !== "MissionTimeline"){

      const items = Array.from(col.querySelectorAll(".item")).map(it=> JSON.parse(it.dataset.payload));
      state.columns[name] = items;
    }
  });
const faults = Array.from(document.querySelectorAll("#faultItems .item"))
  .map(it => JSON.parse(it.dataset.payload || "{}"));
state.faults = faults;

const missionLog = Array.from(document.querySelectorAll("#missionLogItems .item"))
.map(it => JSON.parse(it.dataset.payload || "{}"));
state.missionLog = missionLog;
const missionTimeline = Array.from(document.querySelectorAll("#missionTimelineItems .item"))
.map(it => JSON.parse(it.dataset.payload || "{}"));
state.missionTimeline = missionTimeline;
// Change History (persist newest-first list)
const changeHistory = Array.from(document.querySelectorAll("#historyItems .item"))
  .map(it => JSON.parse(it.dataset.payload || "{}"));
state.changeHistory = changeHistory;

  return state;
}


  // ---- Entry form ----
  let editingItem=null;
  function openForm(column,data=null){
    $("#targetColumn").value=column;
    $("#editingCode").value=data?.code||"";
    // When editing an existing TACREP (green pencil → Edit/Correct/Update),
    // the TACREP code must NOT be changed. Keep code controls hidden/locked.
    $("#codeEditRow").style.display = "none";
    // Pre-populate for reference only (inputs remain disabled)
    $("#codePrefix").value = data ? (getPrefixFromCode(data.code) || "") : "";
    $("#codeNumber").value = data ? String((data.code || "").replace(/^AIS/,"").replace(/^[A-Z]/i,"")) : "";
    const codeNumberEl = document.getElementById("codeNumber");
    if (codeNumberEl) codeNumberEl.disabled = true;


    $("#modalTitle").textContent=data?"Edit TACREP":"New TACREP";

    $("#timeZuluInput").value = data?.timeHHMM ?? "";
    $("#vesselType").value    = data?.vesselType ?? "";
    $("#sensor").value        = data?.sensor ?? "";

    // DMS fields
    $("#latDeg").value        = data?.latDeg ?? "";
    $("#latMin").value        = data?.latMin ?? "";
    $("#latSec").value        = data?.latSec ?? "";
    $("#latDecSec").value     = data?.latDecSecStr ?? "";
    $("#latHem").value        = data?.latHem ?? "N";

    $("#lonDeg").value        = data?.lonDeg ?? "";
    $("#lonMin").value        = data?.lonMin ?? "";
    $("#lonSec").value        = data?.lonSec ?? "";
    $("#lonDecSec").value     = data?.lonDecSecStr ?? "";
    $("#lonHem").value        = data?.lonHem ?? "E";

    $("#course").value        = data?.course ?? "";
    $("#speed").value         = data?.speed ?? "";
    $("#trackNumber").value   = data?.trackNumber ?? "";

$("#minVesselLen").value   = data?.minVesselLen ?? "";
$("#additionalInfo").value = data?.info ?? "";

// reported flag (button)
reportedFlag = !!data?.reported;
const rb = $("#reportedBtn");
rb.textContent = reportedFlag ? "REPORTED" : "UNREPORTED";
rb.className   = reportedFlag ? "btn-reported" : "btn-secondary";
rb.style.fontWeight = "bold";


    refreshAbbrevCheckboxesInModal();
    openModal(entryModal);
  }
  function closeForm(){
  closeModal(entryModal);
  entryForm.reset();
  editingItem = null;
  $("#editingCode").value = "";

  // Reset reported flag + button
  reportedFlag = false;
  const rb = $("#reportedBtn");
  rb.textContent = "UNREPORTED";
  rb.className = "btn-secondary";
  rb.style.fontWeight = "bold";

  // Hide code edit row
  $("#codeEditRow").style.display = "none";
}


  entryForm.addEventListener("submit", e=>{
  e.preventDefault();
  if(!Number.isInteger(blockStartNum) || !crewPosition){ alert("Set up mission first."); return; }

  const columnName=$("#targetColumn").value;
  const colEl=$$(`.column[data-column]`).find(c=> c.dataset.column===columnName);
  const prefix=colEl ? (colEl.dataset.letter || columnName[0]) : columnName[0];

  const t=$("#timeZuluInput").value.trim().replace(/\D/g,"").slice(0,4);
  if(t && (t.length!==4 || Number(t.slice(0,2))>23 || Number(t.slice(2,4))>59)){ alert("Time must be HHMM Zulu."); return; }

  const vesselType=$("#vesselType").value.trim();
  const sensor=$("#sensor").value.trim();

  // DMS inputs (entry form)
  const latDegStr = digitsOnly($("#latDeg").value);
  const latMinStr = digitsOnly($("#latMin").value);
  const latSecStr = digitsOnly($("#latSec").value);
  const latDecSecStr = digitsOnly($("#latDecSec").value);
  const latHem = $("#latHem").value || "N";

  const lonDegStr = digitsOnly($("#lonDeg").value);
  const lonMinStr = digitsOnly($("#lonMin").value);
  const lonSecStr = digitsOnly($("#lonSec").value);
  const lonDecSecStr = digitsOnly($("#lonDecSec").value);
  const lonHem = $("#lonHem").value || "E";

  const latDeg=Number(latDegStr), latMin=Number(latMinStr), latSec=Number(latSecStr);
  const lonDeg=Number(lonDegStr), lonMin=Number(lonMinStr), lonSec=Number(lonSecStr);

  const invalidLat = (latDegStr!=="" || latMinStr!=="" || latSecStr!=="") &&
    (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 ||
     !Number.isFinite(latMin)||latMin<0||latMin>=60 ||
     !Number.isFinite(latSec)||latSec<0||latSec>=60);
  const invalidLon = (lonDegStr!=="" || lonMinStr!=="" || lonSecStr!=="") &&
    (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 ||
     !Number.isFinite(lonMin)||lonMin<0||lonMin>=60 ||
     !Number.isFinite(lonSec)||lonSec<0||lonSec>=60);
  if(invalidLat || invalidLon){ alert("Check Position:\n- Lat: 0–90°, 0–59', 0–59.99\" \n- Lon: 0–180°, 0–59', 0–59.99\""); return; }

  const courseRaw=$("#course").value.trim();
  let course=courseRaw;
  if(courseRaw){ const c=Number(courseRaw); if(!Number.isFinite(c)||c<0||c>359){ alert("Course 0–359."); return; } course=String(c); }

  let speedVal=$("#speed").value.trim();
  if(speedVal){ speedVal=speedVal.replace(/[^\d.]/g,""); if(speedVal==="." || isNaN(Number(speedVal))){ alert("Speed must be numeric."); return; } }

  const trackNumber=$("#trackNumber").value.trim();
  const minVesselLen = digitsOnly($("#minVesselLen").value).slice(0,8);
  const info = $("#additionalInfo").value.trim();
  const minotaurPaste = $("#minotaurPaste").value.trim();
  const reported = reportedFlag;

  // India requireds
  if(columnName==="India"){
    const missing=[];
    if(!t) missing.push("Time");
    if(!vesselType) missing.push("Vessel Type");
    if(!sensor) missing.push("Sensor");
    if(latDegStr===""||latMinStr===""||!latHem) missing.push("Latitude");
    if(lonDegStr===""||lonMinStr===""||!lonHem) missing.push("Longitude");
    if(!course) missing.push("Course");
    if(speedVal==="") missing.push("Speed");
    if(missing.length){ alert("India TACREP requires: " + missing.join(", ")); return; }
  }

  const editingCode=$("#editingCode").value;
  const now=Date.now();

  let proposedCode = editingCode;
   if(!editingCode){
    // New TACREP: assign the next available number for the column's prefix
    const prefixFinal = getPrefixFromColumnName(columnName);
    const n = lowestAvailable(prefixFinal);
    proposedCode = `${prefixFinal}${n}`;
  } else {
    // Editing an existing TACREP: DO NOT change the code; overwrite in place
    proposedCode = editingCode;
  }



  if((proposedCode!==editingCode) && codeExistsActive(proposedCode)){ alert(`TACREP ${proposedCode} already exists in Active. Choose another number.`); return; }

  const deletedEl=(proposedCode!==editingCode) ? findDeletedElementByCode(proposedCode) : null;

  // Convert DMS to legacy minute-fraction strings for compatibility
  function toDecMinStr(minStr, secStr, decSecStr){
    const mm = Number(minStr||"0");
    const ss = Number(secStr||"0");
    const ds = Number(("0."+(decSecStr||"0")).slice(0,4)); // up to 2 decimal sec
    const total = mm + (ss + ds)/60;
    const whole = Math.floor(total);
    const frac  = total - whole;
    return String(Math.round(frac*1e8)).padStart(8,"0").replace(/0+$/,""); // trim trailing zeros
  }

  const latDecMinStrCompat = toDecMinStr(latMinStr, latSecStr, latDecSecStr);
  const lonDecMinStrCompat = toDecMinStr(lonMinStr, lonSecStr, lonDecSecStr);

  const doSave=(finalCode,reactivate=false)=>{
    if(reactivate && deletedEl){ removeDeletedByCode(finalCode); }

    const payloadBase=editingItem ? JSON.parse(editingItem.dataset.payload) : {};
    const payload={
      ...payloadBase,
      code:finalCode, timeHHMM:t, vesselType, sensor,
      // Store both DMS pieces and legacy minute-fraction for existing renderers/exports
      latDeg:latDegStr, latMin:latMinStr, latSec:latSecStr, latDecSecStr:latDecSecStr, latDecMinStr:latDecMinStrCompat, latHem,
      lonDeg:lonDegStr, lonMin:lonMinStr, lonSec:lonSecStr, lonDecSecStr:lonDecSecStr, lonDecMinStr:lonDecMinStrCompat, lonHem,
      course, speed:speedVal, trackNumber, minVesselLen, info,
      minotaurPaste,
      reported,
      createdBy: payloadBase.createdBy || crewPosition,
      createdAt: payloadBase.createdAt || now,
      lastModified: now
    };

    if(editingItem){
      updateItemElement(editingItem, payload);
    } else {
      const container=colEl.querySelector(".items");
      const el=createItemElement(payload,"active");
      container.appendChild(el);
      columnNextNumber[columnName]=Number(finalCode.replace(/^AIS|^[A-Za-z]/,"")) + 1;
    }

    closeForm();
    dirty=true; requestAutoSyncSave();
    recomputeHighlights();
  };

  if(deletedEl){
    openConfirm(`TACREP <strong>${escapeHtml(proposedCode)}</strong> exists in <em>Deleted</em>.<br>Reactivate and use this number?`, ()=>doSave(proposedCode,true));
    return;
  }

  doSave(proposedCode,false);
});


  function codeExistsActive(newCode){
    return Array.from(document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]) .item .badge')).some(b=> b.textContent.trim()===newCode);
  }
function findDeletedElementByCode(code){
  return (
    Array.from(document.querySelectorAll('#deletedItems .item'))
      .find(it => {
        const p = JSON.parse(it.dataset.payload || "{}");
        return p.code === code || p.originalCode === code;
      }) || null
  );
}

  function removeDeletedByCode(code){ const el=findDeletedElementByCode(code); if(el){ el.remove(); deletedSetLocal.delete(code); } }

  function inferOriginFromCode(code){
    if(code.startsWith("AIS")) return "AIS";
    const p=code[0]?.toUpperCase();
    if(p==="I") return "India";
    if(p==="E") return "Echo";
    if(p==="A") return "Alpha";
    if(p==="N") return "November";
    if(p==="G") return "Golf";
    return "India";
  }

  // ---- TACREP elements ----
  function createItemElement(data, context="active"){
    const { code }=data;
    const item=document.createElement("div");
    item.className="item selectable";
    item.dataset.payload=JSON.stringify(data);

    const header=document.createElement("div"); header.className="item-header";
    const badgeWrap=document.createElement("div"); badgeWrap.className="badge-wrap";
    const pm=document.createElement("span"); pm.className="pm"; pm.textContent="+";
    const badge=document.createElement("div"); badge.className="badge"; badge.textContent=code; badge.dataset.code=code; badge.tabIndex=0;
    badgeWrap.appendChild(pm); badgeWrap.appendChild(badge);

    const creator=document.createElement("span"); creator.className="creator";
    item._renderAbbrev=()=>{ creator.textContent=renderCreatorAndAbbrev(JSON.parse(item.dataset.payload)); };

    const actions=document.createElement("div"); actions.className="item-actions";
    const editBtn=document.createElement("button"); editBtn.type="button"; editBtn.className="icon-btn icon-edit"; editBtn.innerHTML="✏️"; editBtn.title="Edit";
    const delBtn=document.createElement("button"); delBtn.type="button"; delBtn.className="icon-btn icon-delete"; delBtn.innerHTML="❌"; delBtn.title="Move to Deleted";
    const restoreBtn=document.createElement("button"); restoreBtn.type="button"; restoreBtn.className="icon-btn icon-restore"; restoreBtn.innerHTML="↩️"; restoreBtn.title="Restore";
    if(context==="deleted"){ actions.appendChild(restoreBtn); } else { actions.appendChild(editBtn); actions.appendChild(delBtn); }

    header.appendChild(badgeWrap); header.appendChild(creator); header.appendChild(actions);

    const details=document.createElement("div"); details.className="item-details";
    fillDetails(details,data,code);

    item.appendChild(header); item.appendChild(details);
    item._renderAbbrev();

    function handleToggle(){ if(selecting) return; toggleExpandItem(item); }
    badge.addEventListener("click", handleToggle);
    pm.addEventListener("click", handleToggle);
    item.addEventListener("click",(e)=>{ if(!selecting) return; if(e.target.closest('.item-actions')) return; toggleSelectForCorrelation(item); });

    badge.addEventListener("keydown", e=>{ if(selecting){ e.preventDefault(); toggleSelectForCorrelation(item); return; } if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });

    editBtn.addEventListener("click",(e)=>{ e.stopPropagation(); const payload=JSON.parse(item.dataset.payload); const column=inferOriginFromCode(payload.code); openForm(column,payload); $("#codeEditRow").style.display="flex"; const prefix=payload.code.startsWith("AIS")?"AIS":payload.code[0].toUpperCase(); const num=payload.code.replace(/^AIS|^[A-Za-z]/,""); $("#codePrefix").value=prefix; $("#codeNumber").value=num; editingItem=item; });

    delBtn.addEventListener("click",(e)=>{ e.stopPropagation(); openConfirm(`Move TACREP <strong>${escapeHtml(code)}</strong> to Deleted?`, ()=>{ moveItemToDeleted(item); dirty=true; requestAutoSyncSave(true); recomputeHighlights(); }); });

    restoreBtn.addEventListener("click",(e)=>{ e.stopPropagation(); openConfirm(`Restore TACREP <strong>${escapeHtml(code)}</strong>?`, ()=>{ restoreItemFromDeleted(item); dirty=true; requestAutoSyncSave(true); recomputeHighlights(); }); });

    return item;
  }

  function updateItemElement(item,data){
    item.dataset.payload=JSON.stringify(data);
    const badgeEl=item.querySelector(".badge");
    if(badgeEl){ badgeEl.textContent=data.code; badgeEl.dataset.code=data.code; }
    item._renderAbbrev && item._renderAbbrev();
    const details=item.querySelector(".item-details"); details.innerHTML=""; fillDetails(details,data,data.code);
  }

  function fillDetails(container,p,code){
    const copyBtn=document.createElement("button");
    copyBtn.type="button"; copyBtn.className="copy-pill"; copyBtn.textContent="Copy";
    copyBtn.addEventListener("click", async (e)=>{
      e.stopPropagation();
      const parts=[code];
      if(p.timeHHMM) parts.push(`Time: ${p.timeHHMM}Z`);
      if(p.vesselType) parts.push(`Vessel: ${p.vesselType}`);
      if(p.sensor) parts.push(`Sensor: ${p.sensor}`);
      const posStr=buildPosDisplay(p); if(posStr) parts.push(`Pos: ${posStr}`);
      if(p.course) parts.push(`Course: ${p.course}`);
      if(p.speed!==null && p.speed!=="") parts.push(`Speed: ${p.speed} kts`);
      if(p.trackNumber) parts.push(`Track: ${p.trackNumber}`);
      if(p.minVesselLen) parts.push(`MinLen: ${p.minVesselLen} ft`);
      if(p.info) parts.push(`Info: ${p.info}`);
      const text=parts.join(" / ");
      try{ await navigator.clipboard.writeText(text); copyBtn.textContent="Copied!"; copyBtn.classList.add("copied"); setTimeout(()=>{ copyBtn.textContent="Copy"; copyBtn.classList.remove("copied"); },1200); }catch{ alert("Copy failed."); }
    });

    const rows=[];
    const firstRow=document.createElement("span"); firstRow.className="detail";
    firstRow.appendChild(copyBtn);
    if(p.timeHHMM) firstRow.insertAdjacentHTML("beforeend", ` <em>Time:</em> ${escapeHtml(p.timeHHMM)}Z`);
    if(p.vesselType) rows.push(`<span class="detail"><em>Vessel:</em> ${escapeHtml(p.vesselType)}</span>`);
    if(p.sensor) rows.push(`<span class="detail"><em>Sensor:</em> ${escapeHtml(p.sensor)}</span>`);
    const posStr=buildPosDisplay(p);
    if(posStr) rows.push(`<span class="detail"><em>Pos:</em> ${escapeHtml(posStr)}</span>`);
    if(p.course) rows.push(`<span class="detail"><em>Course:</em> ${escapeHtml(p.course)}</span>`);
    if(p.speed!==null && p.speed!=="") rows.push(`<span class="detail"><em>Speed:</em> ${escapeHtml(String(p.speed))} kts</span>`);
    if(p.trackNumber) rows.push(`<span class="detail"><em>Track:</em> ${escapeHtml(p.trackNumber)}</span>`);
    if(p.minVesselLen) rows.push(`<span class="detail"><em>MinLen:</em> ${escapeHtml(p.minVesselLen)} ft</span>`);
    if(p.info) rows.push(`<span class="detail"><em>Info:</em> ${escapeHtml(p.info)}</span>`);

    container.appendChild(firstRow);
    rows.forEach(html=> container.insertAdjacentHTML("beforeend", html));
  }


function toggleExpandItem(el){
  el.classList.toggle("expanded");
  const pm=el.querySelector(".pm");
  if(pm) pm.textContent=el.classList.contains("expanded")?"−":"+";
}

// ⬇️ Add this here, inside the IIFE
  // Timeline items (Mission Timeline)
window._editingTimelineItem = null;
  
window._timelineEntryType = "ONSTA";

function updateTimelineItem(item, p){
  item.dataset.payload = JSON.stringify(p);

  // Header pieces
  const [pm, timeBadge, typeBadge] = item.querySelectorAll(".item-header .badge-wrap > *");
  if (timeBadge) timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");
  if (typeBadge) typeBadge.textContent = (p.type || "—");

  // Creator line
  const creator = item.querySelector(".creator");
  if (creator) {
    const when = isValidDate(new Date(p.createdAt))
      ? `${fmtDateNoYearUTC(new Date(p.createdAt))} ${fmtTimeUTC(new Date(p.createdAt))}`
      : "";
    const by = p.createdBy || "";
    creator.textContent = [by, when].filter(Boolean).join(" • ");
  }

  // Details (expanded)
  const details = item.querySelector(".item-details");
details.innerHTML = "";

// Copy button
const copyBtn = document.createElement("button");
copyBtn.type = "button";
copyBtn.className = "copy-pill";
copyBtn.textContent = "Copy";
copyBtn.addEventListener("click", async (e)=>{
  e.stopPropagation();
  const parts = [];
  if (p.timeHHMM) parts.push(`Time: ${p.timeHHMM}Z`);
  if (p.type === "OFFDECK" && p.airfield) {
    parts.push(`Airfield: ${p.airfield}`);
   } else if (p.type === "ONSTA" || p.type === "OFFSTA") {
    const posStr = buildPosDisplay(p);
    if (posStr) parts.push(`Pos: ${posStr}`);
    if (p.altitude) parts.push(`Alt: ${p.altitude}`);
  }
  const text = parts.join(" / ");
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(()=>{ copyBtn.textContent = "Copy"; copyBtn.classList.remove("copied"); },1200);
  } catch {
    alert("Copy failed.");
  }
});


const firstRow = document.createElement("span");
firstRow.className = "detail";
firstRow.appendChild(copyBtn);
details.appendChild(firstRow);

// Details rows
if (p.type === "OFFDECK" && p.airfield) {
  details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Airfield:</em> ${escapeHtml(p.airfield)}</span>`);
} else if (p.type === "ONSTA" || p.type === "OFFSTA") {

  const posStr = buildPosDisplay(p);
  if (posStr) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Pos:</em> ${escapeHtml(posStr)}</span>`);
  if (p.altitude) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Alt:</em> ${escapeHtml(String(p.altitude))}</span>`);
}

}

function createTimelineItem(p){
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.payload = JSON.stringify(p);
    item._kind = (
  p.type === "OFFDECK" ? "TIMELINE_OFFDECK" :
  p.type === "ONDECK"  ? "TIMELINE_ONDECK"  :
  p.type === "ONSTA"   ? "TIMELINE_ONSTA"   :
  p.type === "OFFSTA"  ? "TIMELINE_OFFSTA"  :
  "TIMELINE_GENERIC"
);


  const header = document.createElement("div");
  header.className = "item-header";

  const badgeWrap = document.createElement("div");
  badgeWrap.className = "badge-wrap";

  const pm = document.createElement("span");
  pm.className = "pm";
  pm.textContent = "+";

  const timeBadge = document.createElement("div");
  timeBadge.className = "badge";
  timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");

  const typeBadge = document.createElement("div");
  typeBadge.className = "badge";
  typeBadge.textContent = (p.type || "—");

  badgeWrap.appendChild(pm);
  badgeWrap.appendChild(timeBadge);
  badgeWrap.appendChild(typeBadge);

  const creator = document.createElement("span");
  creator.className = "creator";

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn icon-edit";
  editBtn.innerHTML = "✏️";
  editBtn.title = "Edit";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "icon-btn icon-delete";
  delBtn.innerHTML = "❌";
  delBtn.title = "Delete";

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  header.appendChild(badgeWrap);
  header.appendChild(creator);
  header.appendChild(actions);

  const details = document.createElement("div");
  details.className = "item-details";

  item.appendChild(header);
  item.appendChild(details);

  // Interactions
  const toggle = ()=> toggleExpandItem(item);
  [pm, timeBadge, typeBadge].forEach(b => {
    b.tabIndex = 0;
    b.addEventListener("click", toggle);
    b.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggle(); } });
  });

  editBtn.addEventListener("click", (e)=>{
e.stopPropagation();
const payload = JSON.parse(item.dataset.payload || "{}");
if (payload.type === "OFFDECK" || payload.type === "ONDECK") {
  document.getElementById("odTime").value = payload.timeHHMM || "";
  document.getElementById("odAirfield").value = payload.airfield || "";
  document.getElementById("offDeckTitle").textContent = (payload.type === "ONDECK") ? "Edit ONDECK Report" : "Edit Off Deck Report";
  window._onDeckMode = (payload.type === "ONDECK");
  window._editingTimelineItem = item;
  openModal(document.getElementById("offDeckModal"));
  return;
}
    else if (payload.type === "ONSTA" || payload.type === "OFFSTA") {
// Prefill OnSta modal
document.getElementById("osTime").value      = payload.timeHHMM || "";
document.getElementById("osLatDeg").value    = payload.latDeg || "";
document.getElementById("osLatMin").value    = payload.latMin || "";
document.getElementById("osLatSec").value    = payload.latSec || "";
document.getElementById("osLatDecSec").value = payload.latDecSecStr || "";
document.getElementById("osLatHem").value    = payload.latHem || "N";

document.getElementById("osLonDeg").value    = payload.lonDeg || "";
document.getElementById("osLonMin").value    = payload.lonMin || "";
document.getElementById("osLonSec").value    = payload.lonSec || "";
document.getElementById("osLonDecSec").value = payload.lonDecSecStr || "";
document.getElementById("osLonHem").value    = payload.lonHem || "E";

document.getElementById("osAlt").value       = payload.altitude || "";

window._timelineEntryType = payload.type || "ONSTA";
window._editingTimelineItem = item;

const titleText = (payload.type === "OFFSTA") ? "Edit OFFSTA Report" : "Edit ONSTA Report";
document.getElementById("onStaTitle").textContent = titleText;
openModal(document.getElementById("onStaModal"));
} else {
alert("Edit not supported for this type (yet).");
}
});

  delBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    openConfirm("Delete this Mission Timeline entry?", ()=>{
      item.remove();
      dirty = true;
      requestAutoSyncSave(true);
    });
  });

  updateTimelineItem(item, p);
  return item;
}
function flashItemByCode(code){
  function toggleHighlightForCorrelation(card, codes){
  // Check if currently highlighted
  const isHighlighted = card.dataset.highlighted === "true";
  
  if(isHighlighted){
    // Remove highlights from all TACREPs in this correlation
    codes.forEach(code=>{
      const badge = Array.from(
        document.querySelectorAll(
          '.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge'
        )
      ).find(b => (b.textContent || '').trim() === code);
      
      if(badge){
        const item = badge.closest('.item');
        if(item) item.classList.remove('corr-highlighted');
      }
    });
    card.dataset.highlighted = "false";
  } else {
    // Add highlights to all TACREPs in this correlation
    codes.forEach(code=>{
      const badge = Array.from(
        document.querySelectorAll(
          '.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge'
        )
      ).find(b => (b.textContent || '').trim() === code);
      
      if(badge){
        const item = badge.closest('.item');
        if(item) item.classList.add('corr-highlighted');
      }
    });
    card.dataset.highlighted = "true";
  }
}
  // Prefer an ACTIVE TACREP (exclude Deleted/History/Correlations columns)
  const badge = Array.from(
    document.querySelectorAll(
      '.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge'
    )
  ).find(b => (b.textContent || '').trim() === code);

  if(!badge) return; // No active match

  const item = badge.closest('.item');
  if(!item) return;

  if(!item.classList.contains('expanded')) toggleExpandItem(item);

  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
  item.classList.add('flash');
  setTimeout(() => item.classList.remove('flash'), 600);
}

  // Single definition (dedupe)
  // ---- Faults UI ----
function createFaultItem(p){
const item = document.createElement("div");
item.className = "item";
item.dataset.payload = JSON.stringify(p);

const header = document.createElement("div");
header.className = "item-header";

const badgeWrap = document.createElement("div");
badgeWrap.className = "badge-wrap";

const timeBadge = document.createElement("div");
timeBadge.className = "badge";
timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");


const codeBadge = document.createElement("div");
codeBadge.className = "badge";
codeBadge.textContent = (p.faultCode || "No Code");

badgeWrap.appendChild(timeBadge);
badgeWrap.appendChild(codeBadge);

const creator = document.createElement("span");
creator.className = "creator";
const by = p.createdBy || "";
const when = isValidDate(new Date(p.createdAt))
  ? `${fmtDateNoYearUTC(new Date(p.createdAt))} ${fmtTimeUTC(new Date(p.createdAt))}`
  : "";

creator.textContent = [by, when].filter(Boolean).join(" • ");

const details = document.createElement("div");
details.className = "item-details";

if (p.comments) {
const comments = document.createElement("span");
comments.className = "detail";
comments.innerHTML = `<em>Comments:</em> ${escapeHtml(p.comments)}`;

details.appendChild(comments);
}

header.appendChild(badgeWrap);
header.appendChild(creator);
item.appendChild(header);
item.appendChild(details);

[timeBadge, codeBadge].forEach(b => {
b.tabIndex = 0;
b.addEventListener("click", () => toggleExpandItem(item));
b.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });
});

return item;
}

// ---- Weather UI ----
let editingWeatherItem = null;

function resetWeatherForm(){
const wrap = document.getElementById("weatherFormWrap");
if (wrap) wrap.style.display = "none";
const ids = ["wxEditingId","wxTime","wxLatDeg","wxLatMin","wxLatDecMin","wxLatHem","wxLonDeg","wxLonMin","wxLonDecMin","wxLonHem","wxFL","wxComments"];
ids.forEach(id=>{
const el = document.getElementById(id);
if(!el) return;
if(el.tagName==="SELECT"){ if(id==="wxLatHem") el.value="N"; if(id==="wxLonHem") el.value="E"; }
else el.value = "";
});
editingWeatherItem = null;
}

function openWeatherFormNew(){
editingWeatherItem = null;
document.getElementById("wxEditingId").value = "";
const wrap = document.getElementById("weatherFormWrap");
if (wrap) wrap.style.display = "block";
}

function openWeatherFormEdit(item, payload){
editingWeatherItem = item;
document.getElementById("wxEditingId").value = String(payload.createdAt || "");
document.getElementById("wxTime").value = payload.timeHHMM || "";
document.getElementById("wxLatDeg").value = payload.latDeg || "";
document.getElementById("wxLatMin").value = payload.latMin || "";
document.getElementById("wxLatDecMin").value = payload.latDecMinStr || "";
document.getElementById("wxLatHem").value = payload.latHem || "N";
document.getElementById("wxLonDeg").value = payload.lonDeg || "";
document.getElementById("wxLonMin").value = payload.lonMin || "";
document.getElementById("wxLonDecMin").value = payload.lonDecMinStr || "";
document.getElementById("wxLonHem").value = payload.lonHem || "E";
document.getElementById("wxFL").value = payload.flightLevel || "";

document.getElementById("wxComments").value = payload.comments || "";
const wrap = document.getElementById("weatherFormWrap");
if (wrap) wrap.style.display = "block";
}

function onWeatherSave(e){
e.preventDefault();

const t = (document.getElementById("wxTime").value || "").trim().replace(/\D/g,"").slice(0,4);
if(t && (t.length!==4 || Number(t.slice(0,2))>23 || Number(t.slice(2,4))>59)){
alert("Time must be HHMM Zulu.");
return;
}

const latDegStr = (document.getElementById("wxLatDeg").value || "").replace(/\D/g,"");
const latMinStr = (document.getElementById("wxLatMin").value || "").replace(/\D/g,"");
const latDecStr = (document.getElementById("wxLatDecMin").value || "").replace(/\D/g,"").slice(0,8);
const latHem = (document.getElementById("wxLatHem").value || "N");

const lonDegStr = (document.getElementById("wxLonDeg").value || "").replace(/\D/g,"");
const lonMinStr = (document.getElementById("wxLonMin").value || "").replace(/\D/g,"");
const lonDecStr = (document.getElementById("wxLonDecMin").value || "").replace(/\D/g,"").slice(0,8);
const lonHem = (document.getElementById("wxLonHem").value || "E");

const latDeg=Number(latDegStr), latMin=Number(latMinStr);
const lonDeg=Number(lonDegStr), lonMin=Number(lonMinStr);

const invalidLat=(latDegStr!=="" || latMinStr!=="") && (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 || !Number.isFinite(latMin)||latMin<0||latMin>=60);
const invalidLon=(lonDegStr!=="" || lonMinStr!=="") && (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 || !Number.isFinite(lonMin)||lonMin<0||lonMin>=60);
if(invalidLat || invalidLon){
alert("Check Position:\n- Lat: 0–90°, 0–59'\n- Lon: 0–180°, 0–59'");
return;
}

const fl = (document.getElementById("wxFL").value || "").trim().replace(/\D/g,"").slice(0,3);
if(fl && fl.length!==3){
alert("Flight Level must be a 3-digit number (e.g., 420 for FL420).");
return;
}

const comments = (document.getElementById("wxComments").value || "").trim();

const now = Date.now();
const existingPayload = editingWeatherItem ? JSON.parse(editingWeatherItem.dataset.payload || "{}") : {};
const payload = {
...existingPayload,
timeHHMM: t,
latDeg: latDegStr, latMin: latMinStr, latDecMinStr: latDecStr, latHem,
lonDeg: lonDegStr, lonMin: lonMinStr, lonDecMinStr: lonDecStr, lonHem,
flightLevel: fl,
comments,
createdBy: existingPayload.createdBy || (typeof crewPosition === "string" ? crewPosition : ""),
createdAt: existingPayload.createdAt || now,
lastModified: now
};

const list = document.getElementById("weatherItems");

if(editingWeatherItem){
updateWeatherItem(editingWeatherItem, payload);
} else {
const el = createWeatherItem(payload);
// newest first — put on top
if(list.firstChild) list.insertBefore(el, list.firstChild);
else list.appendChild(el);
}

resetWeatherForm();
dirty = true;
requestAutoSyncSave(true);
showBanner("Weather entry saved.");
}

function updateWeatherItem(item, p){
  item.dataset.payload = JSON.stringify(p);

  // Update header badges
  const [timeBadge, flBadge] = item.querySelectorAll(".badge-wrap .badge");
  if (timeBadge) timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");
  if (flBadge)  flBadge.textContent  = (p.flightLevel ? `FL${p.flightLevel}` : "FL—");

  // Update creator line
  const creator = item.querySelector(".creator");
  if (creator) {
    const when = isValidDate(new Date(p.createdAt))
      ? `${fmtDateNoYearUTC(new Date(p.createdAt))} ${fmtTimeUTC(new Date(p.createdAt))}`
      : "";
    const by = p.createdBy || "";
    creator.textContent = [by, when].filter(Boolean).join(" • ");
  }

  // Rebuild details
  const details = item.querySelector(".item-details");
  details.innerHTML = "";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-pill";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    const parts=[];
    if(p.timeHHMM) parts.push(`Time: ${p.timeHHMM}Z`);
    const posStr = buildPosDisplay(p);
    if(posStr)    parts.push(`Pos: ${posStr}`);
    if(p.flightLevel) parts.push(`Alt: FL${p.flightLevel}`);
    if(p.comments)    parts.push(`Comments: ${p.comments}`);
    const text = parts.join(" / ");
    try{
      await navigator.clipboard.writeText(text);
      copyBtn.textContent="Copied!";
      copyBtn.classList.add("copied");
      setTimeout(()=>{ copyBtn.textContent="Copy"; copyBtn.classList.remove("copied"); },1200);
    }catch{
      alert("Copy failed.");
    }
  });

  const firstRow = document.createElement("span");
  firstRow.className = "detail";
  firstRow.appendChild(copyBtn);
  details.appendChild(firstRow);

  const posStr = buildPosDisplay(p);
  if(posStr)        details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Pos:</em> ${escapeHtml(posStr)}</span>`);
  if(p.flightLevel) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Alt:</em> FL${escapeHtml(String(p.flightLevel))}</span>`);
  if(p.comments)    details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(p.comments)}</span>`);
}
function createWeatherItem(p){
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.payload = JSON.stringify(p);

  // Header
  const header = document.createElement("div");
  header.className = "item-header";

  const badgeWrap = document.createElement("div");
  badgeWrap.className = "badge-wrap";

  const timeBadge = document.createElement("div");
  timeBadge.className = "badge";
  timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");

  const flBadge = document.createElement("div");
  flBadge.className = "badge";
  flBadge.textContent = (p.flightLevel ? `FL${p.flightLevel}` : "FL—");

  badgeWrap.appendChild(timeBadge);
  badgeWrap.appendChild(flBadge);

  const creator = document.createElement("span");
  creator.className = "creator";

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn icon-edit";
  editBtn.innerHTML = "✏️";
  editBtn.title = "Edit";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "icon-btn icon-delete";
  delBtn.innerHTML = "❌";
  delBtn.title = "Delete";

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  header.appendChild(badgeWrap);
  header.appendChild(creator);
  header.appendChild(actions);

  const details = document.createElement("div");
  details.className = "item-details";

  item.appendChild(header);
  item.appendChild(details);

  // Interactions
  [timeBadge, flBadge].forEach(b => {
    b.tabIndex = 0;
    b.addEventListener("click", () => toggleExpandItem(item));
    b.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });
  });

  editBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    const payload = JSON.parse(item.dataset.payload || "{}");
    openWeatherFormEdit(item, payload);
  });

  delBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    openConfirm("Delete this weather entry?", ()=>{
      item.remove();
      dirty = true;
      requestAutoSyncSave(true);
    });
  });

  // Initial render
  updateWeatherItem(item, p);
  return item;
}

/* ---- CONT-1 UI (standalone; not nested in Weather) ---- */
let editingCont1Item = null;

function resetCont1Form(){
  const wrap = document.getElementById("cont1FormWrap");
  if (wrap) wrap.style.display = "none";
  const ids = [
    "cont1EditingId","cont1TimeLost","cont1LatDeg","cont1LatMin","cont1LatDecMin",
    "cont1LatHem","cont1LonDeg","cont1LonMin","cont1LonDecMin","cont1LonHem",
    "cont1FL","cont1Comments","cont1TimeRestored"
  ];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(el.tagName==="SELECT"){
      if(id==="cont1LatHem") el.value="N";
      if(id==="cont1LonHem") el.value="E";
    } else el.value = "";
  });
  editingCont1Item = null;
}

function openCont1FormNew(){
  editingCont1Item = null;
  document.getElementById("cont1EditingId").value = "";
  const wrap = document.getElementById("cont1FormWrap");
  if (wrap) wrap.style.display = "block";
}

function openCont1FormEdit(item, payload){
  editingCont1Item = item;
  document.getElementById("cont1EditingId").value = String(payload.createdAt || "");
  document.getElementById("cont1TimeLost").value = payload.timeLostHHMM || "";
  document.getElementById("cont1LatDeg").value = payload.latDeg || "";
  document.getElementById("cont1LatMin").value = payload.latMin || "";
  document.getElementById("cont1LatDecMin").value = payload.latDecMinStr || "";
  document.getElementById("cont1LatHem").value = payload.latHem || "N";
  document.getElementById("cont1LonDeg").value = payload.lonDeg || "";
  document.getElementById("cont1LonMin").value = payload.lonMin || "";
  document.getElementById("cont1LonDecMin").value = payload.lonDecMinStr || "";
  document.getElementById("cont1LonHem").value = payload.lonHem || "E";
  document.getElementById("cont1FL").value = payload.flightLevel || "";
  document.getElementById("cont1Comments").value = payload.comments || "";
  document.getElementById("cont1TimeRestored").value = payload.timeRestoredHHMM || "";
  const wrap = document.getElementById("cont1FormWrap");
  if (wrap) wrap.style.display = "block";
}

function onCont1Save(e){
  e.preventDefault();

  const tLost = (document.getElementById("cont1TimeLost").value || "").trim().replace(/\D/g,"").slice(0,4);
  if(tLost && (tLost.length!==4 || Number(tLost.slice(0,2))>23 || Number(tLost.slice(2,4))>59)){
    alert("Time Lost must be HHMM Zulu.");
    return;
  }
  const tRest = (document.getElementById("cont1TimeRestored").value || "").trim().replace(/\D/g,"").slice(0,4);
  if(tRest && (tRest.length!==4 || Number(tRest.slice(0,2))>23 || Number(tRest.slice(2,4))>59)){
    alert("Time Restored must be HHMM Zulu.");
    return;
  }

  const latDegStr = (document.getElementById("cont1LatDeg").value || "").replace(/\D/g,"");
  const latMinStr = (document.getElementById("cont1LatMin").value || "").replace(/\D/g,"");
  const latDecStr = (document.getElementById("cont1LatDecMin").value || "").replace(/\D/g,"").slice(0,8);
  const latHem = (document.getElementById("cont1LatHem").value || "N");

  const lonDegStr = (document.getElementById("cont1LonDeg").value || "").replace(/\D/g,"");
  const lonMinStr = (document.getElementById("cont1LonMin").value || "").replace(/\D/g,"");
  const lonDecStr = (document.getElementById("cont1LonDecMin").value || "").replace(/\D/g,"").slice(0,8);
  const lonHem = (document.getElementById("cont1LonHem").value || "E");

  const latDeg=Number(latDegStr), latMin=Number(latMinStr);
  const lonDeg=Number(lonDegStr), lonMin=Number(lonMinStr);

  const invalidLat=(latDegStr!=="" || latMinStr!=="") && (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 || !Number.isFinite(latMin)||latMin<0||latMin>=60);
  const invalidLon=(lonDegStr!=="" || lonMinStr!=="") && (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 || !Number.isFinite(lonMin)||lonMin<0||lonMin>=60);
  if(invalidLat || invalidLon){
    alert("Check Position:\n- Lat: 0–90°, 0–59'\n- Lon: 0–180°, 0–59'");
    return;
  }

  const fl = (document.getElementById("cont1FL").value || "").trim().replace(/\D/g,"").slice(0,3);
  if(fl && fl.length!==3){
    alert("Flight Level must be a 3-digit number (e.g., 420 for FL420).");
    return;
  }

  const comments = (document.getElementById("cont1Comments").value || "").trim();

  const now = Date.now();
  const existingPayload = editingCont1Item ? JSON.parse(editingCont1Item.dataset.payload || "{}") : {};
  const payload = {
    ...existingPayload,
    timeLostHHMM: tLost,
    latDeg: latDegStr, latMin: latMinStr, latDecMinStr: latDecStr, latHem,
    lonDeg: lonDegStr, lonMin: lonMinStr, lonDecMinStr: lonDecStr, lonHem,
    flightLevel: fl,
    comments,
    timeRestoredHHMM: tRest,
    createdBy: existingPayload.createdBy || (typeof crewPosition === "string" ? crewPosition : ""),
    createdAt: existingPayload.createdAt || now,
    lastModified: now
  };

  const list = document.getElementById("cont1Items");

  if(editingCont1Item){
    updateCont1Item(editingCont1Item, payload);
  } else {
    const el = createCont1Item(payload);
    if(list.firstChild) list.insertBefore(el, list.firstChild);
    else list.appendChild(el);
  }

  resetCont1Form();
  dirty = true;
  requestAutoSyncSave(true);
  showBanner("CONT-1 entry saved.");
}

function updateCont1Item(item, p){
  item.dataset.payload = JSON.stringify(p);

  const [lostBadge, flBadge, restBadge] = item.querySelectorAll(".badge-wrap .badge");
  if (lostBadge)  lostBadge.textContent  = (p.timeLostHHMM ? `${p.timeLostHHMM}Z` : "—");
  if (flBadge)    flBadge.textContent    = (p.flightLevel ? `FL${p.flightLevel}` : "FL—");
  if (restBadge)  restBadge.textContent  = (p.timeRestoredHHMM ? `${p.timeRestoredHHMM}Z` : "—");

  const creator = item.querySelector(".creator");
  if (creator) {
    const when = isValidDate(new Date(p.createdAt))
      ? `${fmtDateNoYearUTC(new Date(p.createdAt))} ${fmtTimeUTC(new Date(p.createdAt))}`
      : "";
    const by = p.createdBy || "";
    creator.textContent = [by, when].filter(Boolean).join(" • ");
  }

  const details = item.querySelector(".item-details");
  details.innerHTML = "";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-pill";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    const parts=[];
    if(p.timeLostHHMM)    parts.push(`Lost: ${p.timeLostHHMM}Z`);
    const posStr = buildPosDisplay(p);
    if(posStr)            parts.push(`Pos: ${posStr}`);
    if(p.flightLevel)     parts.push(`Alt: FL${p.flightLevel}`);
    if(p.comments)        parts.push(`Comments: ${p.comments}`);
    if(p.timeRestoredHHMM)parts.push(`Restored: ${p.timeRestoredHHMM}Z`);
    const text = parts.join(" / ");
    try{
      await navigator.clipboard.writeText(text);
      copyBtn.textContent="Copied!";
      copyBtn.classList.add("copied");
      setTimeout(()=>{ copyBtn.textContent="Copy"; copyBtn.classList.remove("copied"); },1200);
    }catch{
      alert("Copy failed.");
    }
  });

  const firstRow = document.createElement("span");
  firstRow.className = "detail";
  firstRow.appendChild(copyBtn);
  details.appendChild(firstRow);

  const posStr2 = buildPosDisplay(p);
  if(posStr2)        details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Pos:</em> ${escapeHtml(posStr2)}</span>`);
  if(p.flightLevel)  details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Alt:</em> FL${escapeHtml(String(p.flightLevel))}</span>`);
  if(p.comments)     details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(p.comments)}</span>`);
  if(p.timeRestoredHHMM) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Restored:</em> ${escapeHtml(p.timeRestoredHHMM)}Z</span>`);
}

function createCont1Item(p){
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.payload = JSON.stringify(p);

  const header = document.createElement("div");
  header.className = "item-header";

  const badgeWrap = document.createElement("div");
  badgeWrap.className = "badge-wrap";

  const lostBadge = document.createElement("div");
  lostBadge.className = "badge";
  lostBadge.textContent = (p.timeLostHHMM ? `${p.timeLostHHMM}Z` : "—");

  const flBadge = document.createElement("div");
  flBadge.className = "badge";
  flBadge.textContent = (p.flightLevel ? `FL${p.flightLevel}` : "FL—");

  const restBadge = document.createElement("div");
  restBadge.className = "badge";
  restBadge.textContent = (p.timeRestoredHHMM ? `${p.timeRestoredHHMM}Z` : "—");

  badgeWrap.appendChild(lostBadge);
  badgeWrap.appendChild(flBadge);
  badgeWrap.appendChild(restBadge);

  const creator = document.createElement("span");
  creator.className = "creator";

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn icon-edit";
  editBtn.innerHTML = "✏️";
  editBtn.title = "Edit";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "icon-btn icon-delete";
  delBtn.innerHTML = "❌";
  delBtn.title = "Delete";

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  header.appendChild(badgeWrap);
  header.appendChild(creator);
  header.appendChild(actions);

  const details = document.createElement("div");
  details.className = "item-details";

  item.appendChild(header);
  item.appendChild(details);

  [lostBadge, flBadge, restBadge].forEach(b => {
    b.tabIndex = 0;
    b.addEventListener("click", () => toggleExpandItem(item));
    b.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });
  });

  editBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    const payload = JSON.parse(item.dataset.payload || "{}");
    openCont1FormEdit(item, payload);
  });

  delBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    openConfirm("Delete this CONT-1 entry?", ()=>{
      item.remove();
      dirty = true;
      requestAutoSyncSave(true);
    });
  });

  updateCont1Item(item, p);
  return item;
}


  function renderCreatorAndAbbrev(payload){
      const crew = payload.createdBy ? payload.createdBy : "";
  const parts = buildAbbrevList(payload);
  const inside = [crew, ...parts].filter(Boolean).join(" / ");
  return inside ? `(${inside})` : (crew ? `(${crew})` : "");
}

/* ---- Mission Log UI ---- */
let editingMissionLogItem = null;

function resetMissionLogForm(){
const wrap = document.getElementById("missionLogFormWrap");
if (wrap) wrap.style.display = "none";
const ids = ["mlEditingId","mlTime","mlComments"];
ids.forEach(id=>{
  const el = document.getElementById(id);
  if(!el) return;
  el.value = "";
});
editingMissionLogItem = null;
}

function openMissionLogFormNew(){
editingMissionLogItem = null;
document.getElementById("mlEditingId").value = "";
const wrap = document.getElementById("missionLogFormWrap");
if (wrap) wrap.style.display = "block";
}

function openMissionLogFormEdit(item, payload){
editingMissionLogItem = item;
document.getElementById("mlEditingId").value = String(payload.createdAt || "");
document.getElementById("mlTime").value = payload.timeHHMM || "";
document.getElementById("mlComments").value = payload.comments || "";
const wrap = document.getElementById("missionLogFormWrap");
if (wrap) wrap.style.display = "block";
}

function onMissionLogSave(e){
e.preventDefault();

const t = (document.getElementById("mlTime").value || "").trim().replace(/\D/g,"").slice(0,4);
if(t && (t.length!==4 || Number(t.slice(0,2))>23 || Number(t.slice(2,4))>59)){
  alert("Time must be HHMM Zulu.");
  return;
}

const comments = (document.getElementById("mlComments").value || "").trim();

const now = Date.now();
const existingPayload = editingMissionLogItem ? JSON.parse(editingMissionLogItem.dataset.payload || "{}") : {};
const payload = {
  ...existingPayload,
  timeHHMM: t,
  comments,
  createdBy: existingPayload.createdBy || (typeof crewPosition === "string" ? crewPosition : ""),
  createdAt: existingPayload.createdAt || now,
  lastModified: now
};

const list = document.getElementById("missionLogItems");

if(editingMissionLogItem){
  updateMissionLogItem(editingMissionLogItem, payload);
} else {
  const el = createMissionLogItem(payload);
  // newest first — put on top
  if(list.firstChild) list.insertBefore(el, list.firstChild);
  else list.appendChild(el);
}

resetMissionLogForm();
dirty = true;
requestAutoSyncSave(true);
showBanner("Mission log entry saved.");
}

function updateMissionLogItem(item, p){
  item.dataset.payload = JSON.stringify(p);

  // Update header badges
  const [timeBadge] = item.querySelectorAll(".badge-wrap .badge");
  if (timeBadge) timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");

  // Update creator line
  const creator = item.querySelector(".creator");
  if (creator) {
    const when = isValidDate(new Date(p.createdAt))
      ? `${fmtDateNoYearUTC(new Date(p.createdAt))} ${fmtTimeUTC(new Date(p.createdAt))}`
      : "";
    const by = p.createdBy || "";
    creator.textContent = [by, when].filter(Boolean).join(" • ");
  }

  // Rebuild details
  const details = item.querySelector(".item-details");
  details.innerHTML = "";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-pill";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    const parts=[];
    if(p.timeHHMM) parts.push(`Time: ${p.timeHHMM}Z`);
    if(p.comments) parts.push(`Comments: ${p.comments}`);
    const text = parts.join(" / ");
    try{
      await navigator.clipboard.writeText(text);
      copyBtn.textContent="Copied!";
      copyBtn.classList.add("copied");
      setTimeout(()=>{ copyBtn.textContent="Copy"; copyBtn.classList.remove("copied"); },1200);
    }catch{
      alert("Copy failed.");
    }
  });

  const firstRow = document.createElement("span");
  firstRow.className = "detail";
  firstRow.appendChild(copyBtn);
  details.appendChild(firstRow);

  if(p.comments) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(p.comments)}</span>`);
}

function createMissionLogItem(p){
  const item = document.createElement("div");
  item.className = "item";
  item.dataset.payload = JSON.stringify(p);

  // Header
  const header = document.createElement("div");
  header.className = "item-header";

  const badgeWrap = document.createElement("div");
  badgeWrap.className = "badge-wrap";

  const timeBadge = document.createElement("div");
  timeBadge.className = "badge";
  timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "—");

  badgeWrap.appendChild(timeBadge);

  const creator = document.createElement("span");
  creator.className = "creator";

  const actions = document.createElement("div");
  actions.className = "item-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn icon-edit";
  editBtn.innerHTML = "✏️";
  editBtn.title = "Edit";

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "icon-btn icon-delete";
  delBtn.innerHTML = "❌";
  delBtn.title = "Delete";

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  header.appendChild(badgeWrap);
  header.appendChild(creator);
  header.appendChild(actions);

  const details = document.createElement("div");
  details.className = "item-details";

  item.appendChild(header);
  item.appendChild(details);

  // Interactions
  [timeBadge].forEach(b => {
    b.tabIndex = 0;
    b.addEventListener("click", () => toggleExpandItem(item));
    b.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });
  });

  editBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    const payload = JSON.parse(item.dataset.payload || "{}");
    openMissionLogFormEdit(item, payload);
  });

  delBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    openConfirm("Delete this mission log entry?", ()=>{
      item.remove();
      dirty = true;
      requestAutoSyncSave(true);
    });
  });

  // Initial render
  updateMissionLogItem(item, p);
  return item;
}

  // ---- Confirm ----
  const confirmModal=$("#confirmModal");
  const confirmText=$("#confirmText");
  let confirmCallback=null;
  function openConfirm(htmlText,onOk){ $("#confirmTitle").textContent="Confirm"; confirmText.innerHTML=htmlText; confirmCallback=onOk; openModal(confirmModal); }
  function closeConfirm(){ confirmCallback=null; closeModal(confirmModal); }
  $("#confirmCancelBtn").addEventListener("click", closeConfirm);
  $("#confirmOkBtn").addEventListener("click", async ()=>{ const cb=confirmCallback; closeConfirm(); if(cb) await cb(); });

  // ---- Delete/Restore ----
function moveItemToDeleted(itemEl){
  const payload = JSON.parse(itemEl.dataset.payload);
  const originalCode = payload.code;
  const now = Date.now();

  // Determine prefix and rename to <LETTER>XXX (AIS → AISXXX)
  const prefix = getPrefixFromCode(originalCode);
  const renamedCode = `${prefix}XXX`;

  const origin = inferOriginFromCode(originalCode);
  const delPayload = {
    ...payload,
    originColumn: origin,
    originalCode,              // keep original for reactivation checks
    code: renamedCode,         // rename before moving
    deletedAt: now,
lastModified: now

  };

  // Remove from Active UI
  itemEl.remove();

  // Trim correlations that reference the original code
  Array.from(document.querySelectorAll("#correlationItems .item")).forEach(card=>{
    const badges=Array.from(card.querySelectorAll(".badge[data-code]"));
    const codes=badges.map(b=>b.dataset.code);
    if(!codes.includes(originalCode)) return;
    if(codes.length<=2){ card.remove(); return; }
   badges.forEach(b=>{ if(b.dataset.code===originalCode) b.remove(); });
const left = codes.filter(c=> c !== originalCode);
card.dataset.codes = left.join("|");

// NEW: keep the card’s UI consistent
renderBadgesInto(card, left);
updateCorrelationActions(card);
updateCorrelationMeta(card);

  });

  // Add to Deleted (bottom)
  const deletedTarget = $("#deletedItems");
  const newEl = createItemElement(delPayload, "deleted");
  newEl.dataset.payload = JSON.stringify(delPayload);
  deletedTarget.appendChild(newEl);

  // Track deleted by original code so other logic can ignore it
  deletedSetLocal.add(originalCode);
}


  




function restoreItemFromDeleted(itemEl){
  const payload = JSON.parse(itemEl.dataset.payload);
  const now = Date.now();

  // Destination and prefix
  const destColName = payload.originColumn || inferOriginFromCode(payload.originalCode || payload.code);
 const dest = document.querySelector(`.column[data-column="${CSS.escape(destColName)}"] .items`)
  || document.querySelector(`.column[data-column="India"] .items`);


  // Compute next highest unused number for that prefix
  const prefix = getPrefixFromColumnName(destColName);
  const n = nextHighest(prefix);

  // Build restored payload
  const restored = { ...payload };
  delete restored.originColumn;
  delete restored.deletedAt;
  restored.lastModified = now;
  restored.code = `${prefix}${n}`;    // new number on restore

  // Remove from Deleted & tracking
  itemEl.remove();
  deletedSetLocal.delete(payload.originalCode || payload.code);

  // Append to bottom of destination
  const newEl = createItemElement(restored,"active");
  newEl.dataset.payload = JSON.stringify(restored);
  dest.appendChild(newEl);

  recomputeHighlights();
}


  // ---- Correlations ----
 // ---- Correlations ----
let selectingMode = "new";       // "new" | "add"
let editingCorrCard = null;      // DOM element of correlation card when adding
function setSelectMode(on, mode="new", card=null){
  selecting = on;
  selectingMode = mode;
  editingCorrCard = on ? card : null;

  document.body.classList.toggle("select-mode", on);

  // Global controls
  const isNew = (mode === "new");
  correlationBtn.textContent = on && isNew ? "Done" : "Add New";
  correlationBtn.style.display = isNew ? "inline-block" : (on ? "none" : "inline-block");
  correlationCancelBtn.style.display = on ? "inline-block" : "none";

  // Hint
  if(on){
    if(isNew){
      selectHint.textContent = "Click TACREPs to select or deselect. Done to save; Cancel to exit.";
    } else {
      selectHint.textContent = "Click TACREPs to add to this correlation. Done to save; Cancel to exit.";
    }
  } else {
    selectHint.textContent = "";
  }

  // Clear selection UI
  $$(".item.selectable").forEach(el=> el.classList.remove("selected"));
  selectedCodes.clear();

  // Per-card add controls visibility
  $$("#correlationItems .item").forEach(c=>{
    const adding = on && !isNew && c === editingCorrCard;
    c._addDoneBtn && (c._addDoneBtn.style.display = adding ? "inline-block" : "none");
    c._addCancelBtn && (c._addCancelBtn.style.display = adding ? "inline-block" : "none");
  });
}

function toggleSelectForCorrelation(item){
  const code=(JSON.parse(item.dataset.payload)||{}).code; if(!code) return;
  if(selectedCodes.has(code)){ selectedCodes.delete(code); item.classList.remove("selected"); }
  else { selectedCodes.add(code); item.classList.add("selected"); }
}

function updateCorrelationMeta(card){
  const d=new Date(Number(card.dataset.lastAt||0));
  const meta=`${card.dataset.lastBy || card.dataset.createdBy || "—"} • ${fmtDateNoYearUTC(d)} ${fmtTimeUTC(d)}`;
  const creator=card.querySelector(".creator");
  if(creator) creator.textContent = meta;
}

function currentCodesFromCard(card){
  return Array.from(card.querySelectorAll(".badge[data-code]")).map(b=>b.dataset.code);
}

function renderBadgesInto(card, codes){
  const wrap = card.querySelector(".badge-wrap");
  wrap.innerHTML = "";  // reset (we'll rebuild)
    codes.forEach(code=>{
    const b=document.createElement("div");
    b.className="badge";
    b.textContent=code;
    b.dataset.code=code;
    b.addEventListener("click", (e)=> {
      e.stopPropagation();
      toggleHighlightForCorrelation(card, codes);
    });
    wrap.appendChild(b);

    // If card is in remove mode, show little "×" control (managed by card._removeMode)
    if(card._removeMode){
      const x=document.createElement("button");
      x.type="button";
      x.textContent="×";
      x.title="Remove from correlation";
      x.style.cssText="margin-left:4px;padding:0 6px;border:none;border-radius:6px;background:#c62828;color:#fff;cursor:pointer;height:22px;line-height:22px;";
      x.addEventListener("click", (e)=>{
        e.stopPropagation();
        const list=currentCodesFromCard(card);
        if(list.length<=2){ showBanner("A correlation must have at least 2 TACREPs."); return; }
        const idx=list.indexOf(code);
        if(idx>-1){
          list.splice(idx,1);
          card.dataset.codes = list.join("|");
          card.dataset.lastBy = crewPosition || "";
          card.dataset.lastAt = String(Date.now());
          renderBadgesInto(card, list);
          updateCorrelationActions(card);
          updateCorrelationMeta(card);
          dirty=true; requestAutoSyncSave();
        }
      });
      wrap.appendChild(x);
    }
  });
}

function updateCorrelationActions(card){
  const codes = currentCodesFromCard(card);
  const canRemove = codes.length >= 3;
  const canAdd    = codes.length >= 2;

  if(card._removeBtn)  card._removeBtn.disabled = !canRemove;
  if(card._addBtn)     card._addBtn.disabled    = !canAdd;

  // Auto-exit remove mode if it dropped below 3
  if(card._removeMode && !canRemove){
    card._removeMode = false;
    if(card._removeBtn) card._removeBtn.textContent = "− Remove";
    renderBadgesInto(card, codes);
  }
}

function createCorrelationCard(entry){
  const codes=(entry.codes||[]).slice();
  const card=document.createElement("div"); card.className="item";
  card.dataset.createdBy=entry.createdBy||""; 
  card.dataset.createdAt=String(Number(entry.createdAt||0)); 
  card.dataset.lastBy=entry.lastBy || (entry.createdBy||""); 
  card.dataset.lastAt=String(Number(entry.lastAt||entry.createdAt||0)); 
  card.dataset.codes=codes.join("|");
  card._removeMode = false;

  const header=document.createElement("div"); header.className="item-header";
  const badgeWrap=document.createElement("div"); badgeWrap.className="badge-wrap";

  const creator=document.createElement("span"); creator.className="creator";

  const actions=document.createElement("div"); actions.className="item-actions";
  const delBtn=document.createElement("button"); delBtn.type="button"; delBtn.className="icon-btn icon-delete"; delBtn.innerHTML="❌"; delBtn.title="Delete correlation";
  delBtn.addEventListener("click", ()=>{ openConfirm("Delete this correlation?", ()=>{ card.remove(); dirty=true; requestAutoSyncSave(); }); });

  // NEW: Add / Remove controls
  const addBtn=document.createElement("button"); addBtn.type="button"; addBtn.className="icon-btn icon-edit"; addBtn.textContent="+ Add"; addBtn.title="Add TACREPs";
  addBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    setSelectMode(true, "add", card);
  });

  const removeBtn=document.createElement("button"); removeBtn.type="button"; removeBtn.className="icon-btn icon-delete"; removeBtn.textContent="− Remove"; removeBtn.title="Remove TACREPs";
  removeBtn.addEventListener("click", (e)=>{
    e.stopPropagation();
    // Toggle remove mode (only meaningful when 3+)
    const codesNow = currentCodesFromCard(card);
    if(codesNow.length<3){ showBanner("Need 3+ to enable remove."); return; }
    card._removeMode = !card._removeMode;
    removeBtn.textContent = card._removeMode ? "Done" : "− Remove";
    renderBadgesInto(card, currentCodesFromCard(card));
  });

  // Per-card Done/Cancel for ADD mode (hidden until setSelectMode(..., 'add', card))
  const addDoneBtn=document.createElement("button"); addDoneBtn.type="button"; addDoneBtn.className="icon-btn icon-edit"; addDoneBtn.textContent="Done"; addDoneBtn.style.display="none";
  addDoneBtn.addEventListener("click", ()=>{
    // selectedCodes -> to add (filter existing + deleted)
    const existing = new Set(currentCodesFromCard(card));
    const toAdd = Array.from(selectedCodes)
      .filter(c=> !deletedSetLocal.has(c))
      .filter(c=> !existing.has(c));
    if(toAdd.length===0){
      setSelectMode(false);
      return;
    }
    const merged = [...existing, ...toAdd].sort((a,b)=>a.localeCompare(b));
    card.dataset.codes = merged.join("|");
    card.dataset.lastBy = crewPosition || "";
    card.dataset.lastAt = String(Date.now());
    renderBadgesInto(card, merged);
    updateCorrelationActions(card);
    updateCorrelationMeta(card);
    setSelectMode(false);
    dirty=true; requestAutoSyncSave();
  });

  const addCancelBtn=document.createElement("button"); addCancelBtn.type="button"; addCancelBtn.className="icon-btn btn-secondary"; addCancelBtn.textContent="Cancel"; addCancelBtn.style.display="none";
  addCancelBtn.addEventListener("click", ()=> setSelectMode(false));

  // Attach control refs to card for external toggling
  card._addBtn = addBtn;
  card._removeBtn = removeBtn;
  card._addDoneBtn = addDoneBtn;
  card._addCancelBtn = addCancelBtn;

  // Assemble header
  header.appendChild(badgeWrap);
  header.appendChild(creator);
  header.appendChild(actions);
  actions.appendChild(addBtn);
  actions.appendChild(removeBtn);
  actions.appendChild(addDoneBtn);
  actions.appendChild(addCancelBtn);
  actions.appendChild(delBtn);

  card.appendChild(header);

  // Initial render
  renderBadgesInto(card, codes);
  updateCorrelationMeta(card);
  updateCorrelationActions(card);

  return card;
}

// "Add New" correlations (global)
correlationBtn.addEventListener("click", ()=>{
  // If Block Start not set, prompt for it
  if(!Number.isInteger(blockStartNum)){
    $("#blockInput").value = "";
    openModal($("#blockModal"));
    return;
  }


  // Enter select mode for NEW
  if(!selecting){ 
    setSelectMode(true, "new", null); 
    return; 
  }

  // Finalize NEW correlation
  if(selecting && selectingMode==="new"){
    if(selectedCodes.size<2){ alert("Select at least two TACREPs."); return; }
    const group=Array.from(selectedCodes)
      .filter(code=> !deletedSetLocal.has(code))
      .sort((a,b)=>a.localeCompare(b));
    if(group.length<2){ setSelectMode(false); return; }

    const createdBy=crewPosition || ""; const createdAt=Date.now();
    const entry={ codes:group, createdBy, createdAt, lastBy:createdBy, lastAt:createdAt };

    const card=createCorrelationCard(entry); $("#correlationItems").appendChild(card);

    setSelectMode(false); dirty=true; requestAutoSyncSave();
  }
});

correlationCancelBtn.addEventListener("click", ()=> setSelectMode(false));

  // ---- Highlights ----
  function recomputeHighlights(){
    const all=Array.from(document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .item'));
    all.forEach(el=> el.classList.remove("highlight-mine","highlight-others"));
    if(all.length===0) return;
    const sorted=all.map(el=>({ el, payload: JSON.parse(el.dataset.payload||"{}") })).sort((a,b)=> (b.payload.lastModified||0)-(a.payload.lastModified||0));
    const myLatest=sorted.find(x=> (x.payload.createdBy||"") === (crewPosition||"")); if(myLatest) myLatest.el.classList.add("highlight-mine");
    const otherLatest=sorted.find(x=> (x.payload.createdBy||"") !== (crewPosition||"")); if(otherLatest) otherLatest.el.classList.add("highlight-others");
  }

  // ---- Abbreviation prefs ----
  function loadAbbrevPrefs(){
    try{
      const raw=localStorage.getItem("wf_abbrev_prefs");
      if(raw){
        const arr=JSON.parse(raw);
        if(Array.isArray(arr)) return arr.filter(x=>ALLOWED_ABBREV_FIELDS.includes(x)).slice(0, ABBREV_MAX);
      }
    }catch{}
    return SETTINGS.abbrevDefaults || ["time","vesselType","sensor"];
  }
  function saveAbbrevPrefs(){ try{ localStorage.setItem("wf_abbrev_prefs", JSON.stringify(abbrevPrefs)); }catch{} }
  function refreshAbbrevCheckboxesInModal(){ $$(".abbrChk").forEach(chk=>{ chk.checked=abbrevPrefs.includes(chk.dataset.field); }); }
  function setAbbrev(field,on){
    const has=abbrevPrefs.includes(field);
    if(on && !has){
      if(abbrevPrefs.length>=ABBREV_MAX){ alert(`You can select up to ${ABBREV_MAX} abbreviation fields.`); refreshAbbrevCheckboxesInModal(); return; }
      abbrevPrefs.push(field);
    } else if(!on && has){
      abbrevPrefs=abbrevPrefs.filter(f=>f!==field);
    }
    abbrevPrefs=abbrevPrefs.filter(x=>ALLOWED_ABBREV_FIELDS.includes(x));
    saveAbbrevPrefs(); refreshAllAbbrevBadges();
  }
  function refreshAllAbbrevBadges(){ $$(".column .item").forEach(it=>{ if(typeof it._renderAbbrev==="function") it._renderAbbrev(); }); }

  function buildPosCompact(p){
    const latD=digitsOnly(p.latDeg), latM=digitsOnly(p.latMin), lonD=digitsOnly(p.lonDeg), lonM=digitsOnly(p.lonMin);
    if(latD===""||latM===""||!p.latHem||lonD===""||lonM===""||!p.lonHem) return "";
    const latDStr=String(Math.trunc(Number(latD)||0)).padStart(2,"0");
    const latMStr=String(Math.trunc(Number(latM)||0)).padStart(2,"0");
    const lonDStr=String(Math.trunc(Number(lonD)||0)).padStart(3,"0");
    const lonMStr=String(Math.trunc(Number(lonM)||0)).padStart(2,"0");
    return `${latDStr}° ${latMStr}' ${p.latHem}, ${lonDStr}° ${lonMStr}' ${p.lonHem}`;
  }
  function buildPosDisplay(p){
    function fmtTrip(minStr,decStr){
      const mm=digitsOnly(minStr); const dec=digitsOnly(decStr||"");
      const num=mm===""?0:Number(mm); const dn=dec===""?0:Number(`0.${dec}`);
      const total=num+dn; return total.toFixed(3).padStart(6, total<10 ? "0" : "");
    }
    const latD=digitsOnly(p.latDeg), latM=digitsOnly(p.latMin), lonD=digitsOnly(p.lonDeg), lonM=digitsOnly(p.lonMin);
    if(latD===""||latM===""||!p.latHem||lonD===""||lonM===""||!p.lonHem) return "";
    const latDStr=String(Math.trunc(Number(latD)||0)).padStart(2,"0");
    const lonDStr=String(Math.trunc(Number(lonD)||0)).padStart(3,"0");
    const latMStr=fmtTrip(p.latMin,p.latDecMinStr);
    const lonMStr=fmtTrip(p.lonMin,p.lonDecMinStr);
    return `${latDStr}° ${latMStr}' ${p.latHem}, ${lonDStr}° ${lonMStr}' ${p.lonHem}`;
  }

 // ---- Export ----
function openExportWindow(){
const win=window.open("", "wf_export", "width=920,height=760"); if(!win){ alert("Pop-up blocked. Please allow pop-ups for Export."); return; }
const state=gatherStateFromDOM();
const types=["India","Echo","AIS","Alpha","November","Golf"];
const present=types.filter(t=> (state.columns[t]||[]).length>0);

// Build a map from TACREP code -> array of correlation group strings ("I12+E3+AIS5")
const codeToGroups = {};
(state.correlations || []).forEach(entry=>{
const group = (entry.codes || []).slice().sort((a,b)=>a.localeCompare(b)).join("+");
(entry.codes || []).forEach(code=>{
if(!codeToGroups[code]) codeToGroups[code] = [];
codeToGroups[code].push(group);
});
});

const style = `body{font-family:Arial,sans-serif;margin:0;background:#f5f7fb;color:#111}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 12px;display:flex;justify-content:space-between;align-items:center}
.muted{color:#666}
.wrap{padding:12px}
.cbrow{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 14px}
.pill{background:#eef3ff;border:1px solid #c9d8ff;border-radius:999px;padding:4px 10px}
button{padding:6px 10px;border:none;background:#007bff;color:#fff;border-radius:6px;cursor:pointer}
button:hover{background:#0056b3}
.tbl{width:100%;border-collapse:collapse;background:#fff;margin-top:10px}
.tbl th,.tbl td{border:1px solid #e5e7eb;padding:6px 8px;font-size:13px;text-align:left}
.tbl th{background:#f7faff}`;

// build the checkbox HTML safely as strings
const cbHtml = present
  .map(t => `<label><input type="checkbox" class="typeCb" value="${t}" checked> ${t}</label>`)
  .join(" ");

const alsoHtml = `<label><input type="checkbox" id="incWeather" checked> Weather</label>
<label><input type="checkbox" id="incCrew" checked> Crew Details</label>`;


win.document.open();
win.document.write(`<!doctype html><html><head><title>Export CSV</title><meta charset="utf-8"><style>${style}</style></head><body>
<header><div><strong>Export CSV</strong> <span class="pill">Active only</span></div><div class="muted">${new Date().toLocaleString()}</div></header>
<div class="wrap">

<div><strong>Include TACREP types:</strong></div>
<div class="cbrow">${cbHtml || '<span class="muted">No TACREPs</span>'}</div>
<div><strong>Also include:</strong></div>
<div class="cbrow">${alsoHtml}</div>
<button id="btnGen">Generate CSV</button>

  <h3 style="margin:14px 0 6px;">TACREPs</h3>
  <table class="tbl" id="previewTR"><thead><tr>
    <th>Code</th><th>Type</th><th>TimeZ</th><th>Vessel</th><th>Sensor</th><th>Pos</th><th>Course</th><th>Speed</th><th>Track</th><th>MinLen(ft)</th><th>Info</th><th>By</th><th>Correlations</th>
  </tr></thead><tbody id="rowsTR"></tbody></table>

  <h3 style="margin:14px 0 6px;">Weather</h3>
  <table class="tbl" id="previewWX"><thead><tr>
    <th>TimeZ</th><th>Pos</th><th>Alt(FL)</th><th>Comments</th><th>By</th>
  </tr></thead><tbody id="rowsWX"></tbody></table>

  <h3 style="margin:14px 0 6px;">Crew Details</h3>
  
  <table class="tbl" id="previewCDMeta"><tbody id="rowsCDMeta"></tbody></table> <table class="tbl" id="previewCD"><thead><tr> <th>Shift</th><th>Turnover</th><th>MC</th><th>TC</th><th>UAC</th><th>MPO1</th><th>MPO2</th> </tr></thead><tbody id="rowsCD"></tbody></table>
  <div id="crewMetaWrap" style="margin:6px 0 10px;"> <div id="metaCallsign" class="muted"></div> <div id="metaMission" class="muted"></div> <div id="metaBlockStart" class="muted"></div> </div>
  <table class="tbl" id="previewCD"><thead><tr>
        <th>Shift</th><th>Turnover</th><th>MC</th><th>TC</th><th>UAC</th><th>MPO1</th><th>MPO2</th>

  </tr></thead><tbody id="rowsCD"></tbody></table>
</div>

<script>
  const state = ${JSON.stringify(gatherStateFromDOM())};
  const codeToGroups = ${JSON.stringify(codeToGroups)};

  function d(s){ return String(s||'').replace(/\\D/g,''); }
  function buildPos(p){
    function fmt(minStr,decStr){ const mm=d(minStr); const dec=d(decStr||''); const num=mm===''?0:Number(mm); const dn=dec===''?0:Number('0.'+dec); const total=num+dn; return total.toFixed(3).padStart(6, total<10?'0':''); }
    const latD=d(p.latDeg), latM=d(p.latMin), lonD=d(p.lonDeg), lonM=d(p.lonMin);
    if(latD===''||latM===''||!p.latHem||lonD===''||lonM===''||!p.lonHem) return '';
    const latDStr=String(Math.trunc(Number(latD)||0)).padStart(2,'0');
    const lonDStr=String(Math.trunc(Number(lonD)||0)).padStart(3,'0');
    const latMStr=fmt(p.latMin,p.latDecMinStr), lonMStr=fmt(p.lonMin,p.lonDecMinStr);
    // NOTE: no degree symbol here to avoid mojibake in some CSV viewers
    return \`\${latDStr} \${latMStr}' \${p.latHem}, \${lonDStr} \${lonMStr}' \${p.lonHem}\`;
  }

  function selectedTypes(){ return Array.from(document.querySelectorAll('.typeCb')).filter(cb=>cb.checked).map(cb=>cb.value); }
  function corrStringFor(code){
    const arr = codeToGroups[code] || [];
    const uniq = Array.from(new Set(arr)).sort();
    return uniq.join(' ; ');
  }

  // ----- Build & render TACREPs
  function buildRowsTR(){
    const types=selectedTypes(); const rowsEl=document.getElementById('rowsTR'); rowsEl.innerHTML='';
    const out=[];
    ['India','Echo','AIS','Alpha','November','Golf'].forEach(type=>{
      if(!types.includes(type)) return;
      (state.columns[type]||[]).forEach(p=>{
        const corr = corrStringFor(p.code);
        const row=[p.code,type,p.timeHHMM||'',p.vesselType||'',p.sensor||'',buildPos(p),p.course||'',p.speed||'',p.trackNumber||'',p.minVesselLen||'',p.info||'',p.createdBy||'',corr];
        out.push(row);
        const tr=document.createElement('tr');
        row.forEach(cell=>{ const td=document.createElement('td'); td.textContent=String(cell); tr.appendChild(td); });
        rowsEl.appendChild(tr);
      });
    });
    return out;
  }

  // ----- Build & render Weather
  function buildRowsWX(){
    const rowsEl=document.getElementById('rowsWX'); rowsEl.innerHTML='';
    const list = Array.isArray(state.weather) ? state.weather.slice() : [];
    // newest first (createdAt desc)
    list.sort((a,b)=> Number(b.createdAt||0)-Number(a.createdAt||0));
    const out = list.map(p=>{
      const row=[p.timeHHMM||'', buildPos(p), p.flightLevel?('FL'+p.flightLevel):'', p.comments||'', p.createdBy||''];
      const tr=document.createElement('tr');
      row.forEach(cell=>{ const td=document.createElement('td'); td.textContent=String(cell); tr.appendChild(td); });
      rowsEl.appendChild(tr);
      return row;
    });
    return out;
  }

  // ----- Build & render Crew Details
  function buildRowsCDMeta(){
const tbody = document.getElementById('rowsCDMeta');
if(!tbody) return;
tbody.innerHTML = '';
const callsign = (state.crewDetails && state.crewDetails.callsign) || '';
const missionNumber = (state.crewDetails && state.crewDetails.missionNumber) || '';
const rows = [
['Callsign', callsign],
['Mission Number', missionNumber]
];
rows.forEach(r=>{
const tr=document.createElement('tr');
r.forEach(cell=>{ const td=document.createElement('td'); td.textContent=String(cell); tr.appendChild(td); });
tbody.appendChild(tr);
});
}
  function buildRowsCD(){
    const rowsEl=document.getElementById('rowsCD'); rowsEl.innerHTML='';
    const shifts=(state.crewDetails && Array.isArray(state.crewDetails.shifts)) ? state.crewDetails.shifts : [];
    const out=[];
    for(let i=0;i<shifts.length;i++){
      const s=shifts[i]||{};
      const row=[ 'Shift '+(i+1), s.turnover||'', s.mc||'', s.tc||'', s.uac||'', s.mpo1||'', s.mpo2||'' ];
      out.push(row);
      const tr=document.createElement('tr');
      row.forEach(cell=>{ const td=document.createElement('td'); td.textContent=String(cell); tr.appendChild(td); });
      rowsEl.appendChild(tr);
    }
    return out;
  }

  function toCSV(rows){
    const esc=v=>/[",\\n]/.test(String(v))? '"'+String(v).replace(/"/g,'""')+'"' : String(v);
    return rows.map(r=>r.map(esc).join(',')).join('\\n');
  }

  function sectionCSV(title, header, rows){
    const lines=[];
    lines.push(toCSV([[title]]));
    lines.push(toCSV([header]));
    if(rows.length) lines.push(toCSV(rows));
    lines.push(''); // blank line between sections
    return lines.join('\\n');
  }

  function buildAllPreviews(){
    const includeWX = document.getElementById('incWeather').checked;
    const includeCD = document.getElementById('incCrew').checked;

    const trRows = buildRowsTR();
    const wxRows = includeWX ? buildRowsWX() : [];
    const cdRows = includeCD ? buildRowsCD() : [];

    document.getElementById('previewWX').style.display = includeWX ? '' : 'none';
    document.getElementById('previewCDMeta').style.display = includeCD ? '' : 'none';
document.getElementById('previewCD').style.display = includeCD ? '' : 'none';


    return { trRows, wxRows, cdRows, includeWX, includeCD };
    buildRowsCDMeta();

  }

  document.querySelectorAll('.typeCb').forEach(cb=> cb.addEventListener('change', buildAllPreviews));
  document.getElementById('incWeather').addEventListener('change', buildAllPreviews);
  document.getElementById('incCrew').addEventListener('change', buildAllPreviews);

  document.getElementById('btnGen').addEventListener('click', ()=>{
    const { trRows, wxRows, cdRows, includeWX, includeCD } = buildAllPreviews();

    const parts=[];
    parts.push(sectionCSV('TACREPS', ["Code","Type","TimeZ","Vessel","Sensor","Pos","Course","Speed","Track","MinLen(ft)","Info","By","Correlations"], trRows));
    if(includeWX){
      parts.push(sectionCSV('WEATHER', ["TimeZ","Pos","Alt(FL)","Comments","By"], wxRows));
    }
    if(includeCD){
      parts.push(sectionCSV('CREW DETAILS', ["Shift","Turnover","MC","TC","UAC","MPO1","MPO2"], cdRows));
        // Add single-line meta above the Crew Details section (no Block Start)
  parts.push(toCSV([["Callsign", (state.crewDetails && state.crewDetails.callsign) || ""]]));
  parts.push(toCSV([["Mission Number", (state.crewDetails && state.crewDetails.missionNumber) || ""]]));
  parts.push("");
  parts.push(sectionCSV('CREW DETAILS', ["Shift","Turnover","MC","TC","UAC","MPO1","MPO2"], cdRows));

    }

    const csv = parts.join('\\n');
    const blob=new Blob([csv],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='warfighter_export.csv'; a.click(); URL.revokeObjectURL(url);
  });

  buildAllPreviews();
<\/script></body></html>`);


win.document.close();
}


  // ---- Suggestion Box ----
  function validateSuggestion(showErrors){
    const sWrap=$("#sb-suggestion-wrap"), nWrap=$("#sb-name-wrap"), eWrap=$("#sb-email-wrap");
    const sHelp=$("#sb-suggestion-help"), nHelp=$("#sb-name-help"), eHelp=$("#sb-email-help");
    const sVal=$("#sb-suggestion").value.trim(), nVal=$("#sb-name").value.trim(), eVal=$("#sb-email").value.trim();
    let ok=true;
    if(!sVal){ ok=false; sWrap.classList.add("error"); sHelp.style.display="block"; } else { sWrap.classList.remove("error"); sHelp.style.display="none"; }
    if(!nVal){ ok=false; nWrap.classList.add("error"); nHelp.style.display="block"; } else { nWrap.classList.remove("error"); nHelp.style.display="none"; }
       const safeDomain = String(typeof EMAIL_DOMAIN !== "undefined" ? (EMAIL_DOMAIN || "") : "").replace(/\./g, '\\.');
    const emailRx = safeDomain
      ? new RegExp(`^[^@\\s]+@${safeDomain}$`, 'i')
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

    if(!emailRx.test(eVal)){ ok=false; eWrap.classList.add("error"); eHelp.style.display="block"; } else { eWrap.classList.remove("error"); eHelp.style.display="none"; }
    return ok;
  }
  function onSuggestionSave(e){
    e.preventDefault();
    if(!validateSuggestion(true)) return;
    const rec={ suggestion: $("#sb-suggestion").value.trim(), name: $("#sb-name").value.trim(), email: $("#sb-email").value.trim(), createdBy: crewPosition || "", createdAt: Date.now() };
    suggestions.push(rec); dirty=true; requestAutoSyncSave(true); showBanner("Suggestion saved.");
    closeModal($("#suggestionModal"));
  }

  // ---- Abbrev content ----
function buildAbbrevList(p){
  const out=[];
  
  // Add REPORTED status first if true
  if(p.reported) {
    out.push("REPORTED");
  }
  
  const sel=abbrevPrefs;
    if(sel.includes("time")&&p.timeHHMM){ out.push(`${p.timeHHMM}Z`); }
    if(sel.includes("vesselType")&&p.vesselType){ out.push(String(p.vesselType)); }
    if(sel.includes("sensor")&&p.sensor){ out.push(String(p.sensor)); }
    if(sel.includes("position")){ const pos=buildPosCompact(p); if(pos) out.push(pos); }
    if(sel.includes("course")&&p.course){ out.push(String(p.course)); }
    if(sel.includes("speed")&&(p.speed!==null&&p.speed!==undefined&&String(p.speed).trim()!=="")){ out.push(String(p.speed)); }
    if(sel.includes("trackNumber")&&p.trackNumber){ out.push(String(p.trackNumber)); }
    if(sel.includes("minVesselLen")&&p.minVesselLen){ out.push(`${p.minVesselLen} ft`); }
    return out;
  }



})();


