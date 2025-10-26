(function(){

  "use strict";



  // ---- Settings ----

  const {

    SETTINGS = {},

    APP_VERSION = "v1.0",

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

  /**
   * Gracefully copy plain text to the clipboard with a DOM fallback.
   * Returns a promise so callers can show UI feedback.
   */
  function writePlainTextToClipboard(value){
    const text = String(value ?? "");
    if (navigator?.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject)=>{
      try{
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("Browser denied copy command"));
      }catch(err){
        reject(err);
      }
    });
  }

  function setCopyButtonState(btn, label, stateClass){
    if(!btn) return;
    btn.textContent = label;
    btn.classList.remove("copied","error");
    if(stateClass) btn.classList.add(stateClass);
  }

  function copySlashLineToClipboard(text, btn){
    if(!btn) return;
    const originalLabel = btn.dataset.originalLabel || btn.textContent || "Copy";
    btn.disabled = true;
    setCopyButtonState(btn, "Copying...", null);
    writePlainTextToClipboard(text).then(()=>{
      setCopyButtonState(btn, "Copied!", "copied");
    }).catch(()=>{
      setCopyButtonState(btn, "Copy failed", "error");
    }).finally(()=>{
      setTimeout(()=>{
        setCopyButtonState(btn, originalLabel, null);
        btn.disabled = false;
      }, 1500);
    });
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

const usedNumberCache = new Map();
let usedNumberCachePendingClear = false;

function scheduleUsedNumberCacheClear(){
  if (usedNumberCachePendingClear) return;
  usedNumberCachePendingClear = true;
  queueMicrotask(()=>{
    usedNumberCachePendingClear = false;
    usedNumberCache.clear();
  });
}

function getPrefixFromColumnName(columnName){

  const col = document.querySelector(`.column[data-column="${CSS.escape(columnName)}"]`);

  const dl = col?.dataset.letter || columnName[0] || "I";

  return dl.toUpperCase(); // "I", "E", "AIS", etc.

}

function getPrefixFromCode(code){

  return String(code||"").startsWith("AIS") ? "AIS" : String(code||"")[0]?.toUpperCase() || "I";

}

function collectUsedNumbers(prefix){

  if (usedNumberCache.has(prefix)) return usedNumberCache.get(prefix);

  // ACTIVE columns only (exclude Deleted/History/Correlations)

  const badges = Array.from(document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .item .badge'));

  const used = new Set();

  for(const b of badges){

    const c = b.textContent.trim();

    if(prefix === "AIS"){

      const m = c.match(/^AIS(\d+)$/);

      if(m) used.add(Number(m[1]));

    } else {

      const m = c.match(new RegExp(`^${prefix}(\d+)$`, "i"));

      if(m) used.add(Number(m[1]));

    }

  }

  usedNumberCache.set(prefix, used);
  scheduleUsedNumberCacheClear();
  return used;

}

function lowestAvailable(prefix, columnName){

  const used = collectUsedNumbers(prefix);

  let start = (columnName && Number.isInteger(columnNextNumber[columnName])) ? columnNextNumber[columnName] : null;
  if(!Number.isInteger(start) || start <= 0){
    start = Number.isInteger(blockStartNum) && blockStartNum > 0 ? blockStartNum : 1;
  }

  let n = start;
  while(used.has(n)) n++;

  return n;

}

function nextHighest(prefix, columnName){
  const used = collectUsedNumbers(prefix);
  let max = 0;
  for(const v of used) if(v > max) max = v;
  const blockStartBase = Number.isInteger(blockStartNum) && blockStartNum > 0 ? blockStartNum : 1;
  const columnBase = (columnName && Number.isInteger(columnNextNumber[columnName])) ? columnNextNumber[columnName] : null;
  const base = columnBase && columnBase > 0 ? columnBase : blockStartBase;
  if(!used.size){
    return base;
  }
  const candidate = Math.max(max + 1, base);
  return candidate;
}



  // ---- State ----

  let useFS = false, memoryMode = true, fileHandle = null, lastKnownMod = 0;

  let blockStartNum = null, crewPosition = "", dirty = false, isSaving = false, pendingResave = false;

  let callsign = "";

  let missionNumber = "";

  let crewDetails = mkCrewDetailsDefaults();

  let reportedFlag = false; // form-level flag synced with change-type toggle
  let reportedFlagTouched = false;

  let editingItem = null;   // currently edited TACREP card



  const columnNextNumber = { India:null, Echo:null, AIS:null, Alpha:null, November:null, Golf:null, Other:null };
  function getColumnMaxNumber(columnName){
    if(!columnName) return null;
    const column = document.querySelector(`.column[data-column="${CSS.escape(columnName)}"] .items`);
    if(!column) return null;
    let max = null;
    column.querySelectorAll(".item .badge").forEach(b=>{
      const code = b.textContent.trim();
      const m = code.startsWith("AIS") ? code.match(/^AIS(\d+)$/) : code.match(/^[A-Za-z]+(\d+)$/);
      if(m && m[1]){
        const num = Number(m[1]);
        if(Number.isFinite(num)) max = (max===null) ? num : Math.max(max, num);
      }
    });
    return max;
  }
  function syncColumnNextNumber(columnName){
    if(!columnName || !(columnName in columnNextNumber)) return;
    const max = getColumnMaxNumber(columnName);
    const base = Number.isInteger(blockStartNum) && blockStartNum > 0 ? blockStartNum : 1;
    columnNextNumber[columnName] = (max===null) ? base : (max + 1);
  }

  let deletedSetLocal = new Set();

  let historyCodesLocal = new Set();

  let changeHistoryEntries = [];

  let suggestions = [];

  let tacrepFormatPrefs = loadTacrepFormatPrefs();



  function setValue(selector, value) {

    const el = document.querySelector(selector);

    if (el) el.value = value ?? "";

  }

  const POSITION_FORMAT_STORAGE_KEY = "wf_position_format";

  const POSITION_FORMATS = [

    { id:"MGRS", label:"MGRS" },

    { id:"DMS", label:"DMS" },

    { id:"DM.M", label:"DM.M" },

    { id:"D.DD", label:"D.DD" }

  ];

  const DEFAULT_POSITION_FORMAT = "DM.M";

  let positionFormat = loadPositionFormatPref();

  let exportCsvUrl = null;

  const DEBUG_HISTORY = false;

  function normalizeHistoryEntry(raw){

    if(!raw || typeof raw!=="object") return null;

    const at=Number(raw.at||Date.now());

    const id=raw.id ? String(raw.id) : `hist_${at}`;

    const code=raw.code ? String(raw.code) : "";

    const kind=raw.kind || "edit";

    const by=raw.by ? String(raw.by) : "";

    const line=raw.line ? String(raw.line) : "";

    const snapshot=(raw.snapshot && typeof raw.snapshot==="object") ? {...raw.snapshot} : null;

    return { id, code, kind, by, at, line, snapshot };

  }

  function cloneHistoryEntry(entry){

    return normalizeHistoryEntry(entry);

  }

  function createHistoryItem(p){

    const el = document.createElement("div");

    el.className = "item";

    el.dataset.payload = JSON.stringify(p);

    el.dataset.historyId = p.id || "";

    el.innerHTML = `

      <div class="item-header">

        <div class="creator">${escapeHtml(p.line || "")}</div>

        <div class="item-actions"></div>

      </div>

    `;

    return el;

  }

  let pendingMode = null;

  let pendingTacrepColumn = null; // Track which TACREP column user tried to add to before Block Start was set

  let selecting = false;

  const selectedCodes = new Set();
  let changeTypeSendRequired = false;

  let _changeMode = null;          // "edit" | "correct" | "update" | null
  let _changeContext = null;       // { itemEl, payload }

const ALLOWED_ABBREV_FIELDS = ["time","vesselType","vesselName","sensor","mmsi","vesselFlag","imo","tq","amplification","ivo","majorAxis","minorAxis","orientation","bearing","ownshipPosit","position","course","speed","trackNumber","minVesselLen","systemOrPlatform","emitterName","activityOrFunction","frequency","additionalInfo"];
const ALLOWED_ABBREV_SET = new Set(ALLOWED_ABBREV_FIELDS);
const ABBREV_FIELD_ALIAS = { ivoDescription: "ivo" };
const DEFAULT_ABBREV_BY_TYPE = {
  India: ["time","vesselType","sensor"],
  Echo: ["time","systemOrPlatform","emitterName"],
  AIS: ["time","vesselName","mmsi"],
  Alpha: ["time","systemOrPlatform","activityOrFunction"],
  November: ["time","systemOrPlatform","activityOrFunction"],
  Golf: ["time","systemOrPlatform","activityOrFunction"],
  Other: ["time","position","additionalInfo"]
};
const DEFAULT_ABBREV_FALLBACK = ["time","vesselType","sensor"];
const ABBREV_STORAGE_KEY = "wf_abbrev_prefs_by_type_v2";
const ICON_PENCIL = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const ICON_X = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

const TACREP_TYPES = ["India","Echo","AIS","Alpha","November","Golf","Other"];
const ICON_RESTORE = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-5"/></svg>'
const POSITION_MODE_TYPES = new Set(["Echo","Alpha","November","Golf"]);
const IVO_POSITION_TYPES = new Set(["Alpha","November","Golf"]);
const BEARING_LIMIT_TYPES = new Set(["Alpha","November","Golf"]);
const HISTORY_FIELD_MAP = {
  India: [
    { key: "timeHHMM", label: "Time" },
    { key: "vesselType", label: "Vessel Type" },
    { key: "sensor", label: "Sensor" },
    { key: "position", label: "Position", custom: true },
    { key: "tq", label: "TQ" },
    { key: "amplification", label: "Amplification" },
    { key: "course", label: "Course" },
    { key: "speed", label: "Speed" },
    { key: "trackNumber", label: "Track Number" },
    { key: "minVesselLen", label: "Min Vessel Length" },
    { key: "info", label: "Additional Info" }
  ],
  AIS: [
    { key: "timeHHMM", label: "Time" },
    { key: "vesselType", label: "Vessel Type" },
    { key: "vesselName", label: "Vessel Name" },
    { key: "mmsi", label: "MMSI" },
    { key: "vesselFlag", label: "Vessel Flag" },
    { key: "imo", label: "IMO" },
    { key: "position", label: "Position", custom: true },
    { key: "course", label: "Course" },
    { key: "speed", label: "Speed" },
    { key: "trackNumber", label: "Track Number" },
    { key: "minVesselLen", label: "Min Vessel Length" },
    { key: "info", label: "Additional Info" }
  ],
  Echo: [
    { key: "timeHHMM", label: "Time" },
    { key: "systemOrPlatform", label: "System/Platform" },
    { key: "emitterName", label: "Emitter Name" },
    { key: "activityOrFunction", label: "Activity/Function" },
    { key: "frequency", label: "Frequency" },
    { key: "position", label: "Position", custom: true },
    { key: "majorAxis", label: "Major Axis" },
    { key: "minorAxis", label: "Minor Axis" },
    { key: "orientation", label: "Orientation" },
    { key: "course", label: "Course" },
    { key: "speed", label: "Speed" },
    { key: "trackNumber", label: "Track Number" },
    { key: "info", label: "Additional Info" }
  ],
  Alpha: [
    { key: "timeHHMM", label: "Time" },
    { key: "systemOrPlatform", label: "System/Platform" },
    { key: "activityOrFunction", label: "Activity/Function" },
    { key: "amplification", label: "Amplification" },
    { key: "position", label: "Position", custom: true },
    { key: "ivo", label: "IVO" },
    { key: "majorAxis", label: "Major Axis" },
    { key: "minorAxis", label: "Minor Axis" },
    { key: "orientation", label: "Orientation" },
    { key: "bearing", label: "Bearing" },
    { key: "ownshipPosit", label: "Ownship Posit" },
    { key: "info", label: "Additional Info" }
  ],
  November: [
    { key: "timeHHMM", label: "Time" },
    { key: "systemOrPlatform", label: "System/Platform" },
    { key: "activityOrFunction", label: "Activity/Function" },
    { key: "amplification", label: "Amplification" },
    { key: "position", label: "Position", custom: true },
    { key: "ivo", label: "IVO" },
    { key: "majorAxis", label: "Major Axis" },
    { key: "minorAxis", label: "Minor Axis" },
    { key: "orientation", label: "Orientation" },
    { key: "bearing", label: "Bearing" },
    { key: "ownshipPosit", label: "Ownship Posit" },
    { key: "info", label: "Additional Info" }
  ],
  Golf: [
    { key: "timeHHMM", label: "Time" },
    { key: "systemOrPlatform", label: "System/Platform" },
    { key: "activityOrFunction", label: "Activity/Function" },
    { key: "amplification", label: "Amplification" },
    { key: "position", label: "Position", custom: true },
    { key: "ivo", label: "IVO" },
    { key: "majorAxis", label: "Major Axis" },
    { key: "minorAxis", label: "Minor Axis" },
    { key: "orientation", label: "Orientation" },
    { key: "bearing", label: "Bearing" },
    { key: "ownshipPosit", label: "Ownship Posit" },
    { key: "info", label: "Additional Info" }
  ],
  Other: [
    { key: "timeHHMM", label: "Time" },
    { key: "vesselType", label: "Vessel Type" },
    { key: "sensor", label: "Sensor" },
    { key: "position", label: "Position", custom: true },
    { key: "course", label: "Course" },
    { key: "speed", label: "Speed" },
    { key: "trackNumber", label: "Track Number" },
    { key: "minVesselLen", label: "Min Vessel Length" },
    { key: "info", label: "Additional Info" }
  ]
};

const DEFAULT_TACREP_FIELD_ORDER = {

    Echo: ["callsign","timeHHMM","systemOrPlatform","emitterName","activityOrFunction","frequency","majorAxis","minorAxis","orientation","position","course","speed","trackNumber","minVesselLen","additionalInfo"],

    India: ["callsign","timeHHMM","position","vesselType","sensor","tq","amplification","course","speed","trackNumber","minVesselLen","additionalInfo"],

    AIS: ["timeHHMM","vesselType","vesselName","mmsi","position","course","speed","trackNumber","vesselFlag","imo","additionalInfo"],

    Alpha: ["callsign","timeHHMM","systemOrPlatform","activityOrFunction","amplification","position","ivo","majorAxis","minorAxis","orientation","bearing","ownshipPosit","additionalInfo"],

    November: ["callsign","timeHHMM","systemOrPlatform","activityOrFunction","amplification","position","ivo","majorAxis","minorAxis","orientation","bearing","ownshipPosit","additionalInfo"],

    Golf: ["callsign","timeHHMM","systemOrPlatform","activityOrFunction","amplification","position","ivo","majorAxis","minorAxis","orientation","bearing","ownshipPosit","additionalInfo"],

    Other: ["callsign","timeHHMM","position","vesselType","sensor","course","speed","trackNumber","minVesselLen","additionalInfo"]

  };

const TACREP_FIELD_DEFS = {

  callsign: {

    label: "Callsign",

    settingsLabel: "Callsign",

    getValue: () => {

      const el = document.getElementById("md_callsign");

      const fromDom = (el && typeof el.value === "string") ? el.value.trim() : "";

      if (fromDom) return fromDom;

      return (typeof callsign === "string" ? callsign : "");

    }

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

  vesselName: {

    label: "Name",

    settingsLabel: "Vessel Name",

    getValue: payload => (payload?.vesselName || "")

  },

  sensor: {

    label: "Sensor",

    settingsLabel: "Sensor",

    getValue: payload => (payload?.sensor || "")

  },

  tq: {

    label: "TQ",

    settingsLabel: "TQ",

    getValue: payload => (payload?.tq || "")

  },

  mmsi: {

    label: "MMSI",

    settingsLabel: "MMSI",

    getValue: payload => (payload?.mmsi || "")

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

  vesselFlag: {

    label: "Flag",

    settingsLabel: "Vessel Flag",

    getValue: payload => (payload?.vesselFlag || "")

  },

  majorAxis: {

    label: "Major Axis",

    settingsLabel: "Major Axis",

    getValue: payload => (payload?.majorAxis || "")

  },

  minorAxis: {

    label: "Minor Axis",

    settingsLabel: "Minor Axis",

    getValue: payload => (payload?.minorAxis || "")

  },

  orientation: {

    label: "Orientation",

    settingsLabel: "Orientation",

    getValue: payload => (payload?.orientation || "")

  },

  amplification: {

    label: "Amplification",

    settingsLabel: "Amplification",

    getValue: payload => (payload?.amplification || "")

  },

  ivo: {

    label: "IVO",

    settingsLabel: "IVO",

    getValue: payload => (payload?.ivo || "")

  },

  bearing: {

    label: "Bearing",

    settingsLabel: "Bearing",

    getValue: payload => (payload?.bearing || "")

  },

  ownshipPosit: {

    label: "Own Posit",

    settingsLabel: "Ownship Posit",

    getValue: payload => (payload?.ownshipPosit || "")

  },

  additionalInfo: {

    label: "Info",

    settingsLabel: "Additional Info",

    getValue: payload => (payload?.info || "")

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



function sanitizePositionFormat(value){

  const id = String(value || "").toUpperCase();

  return POSITION_FORMATS.find(fmt => fmt.id === id)?.id || null;

}



function loadPositionFormatPref(){

  try {

    const raw = localStorage.getItem(POSITION_FORMAT_STORAGE_KEY);

    const sanitized = sanitizePositionFormat(raw);

    return sanitized || DEFAULT_POSITION_FORMAT;

  } catch {

    return DEFAULT_POSITION_FORMAT;

  }

}



function savePositionFormatPref(){

  try {

    localStorage.setItem(POSITION_FORMAT_STORAGE_KEY, positionFormat);

  } catch {}

}



function updatePositionFormatSummary(){

  const summary = document.getElementById("positionFormatSummary");

  if (summary) {

    const label = POSITION_FORMATS.find(fmt => fmt.id === positionFormat)?.label || positionFormat;

    summary.textContent = `Current format: ${label}`;

  }

}



function applyPositionFormat(newFormat, options){

  const fmt = sanitizePositionFormat(newFormat) || DEFAULT_POSITION_FORMAT;

  const shouldSave = !options || options.save !== false;

  const shouldRefresh = !options || options.refresh !== false;

  positionFormat = fmt;

  if (shouldSave) savePositionFormatPref();

  updatePositionFormatSummary();

  if (shouldRefresh) refreshAllPositionDisplays();

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



function refreshAllPositionDisplays(){

  refreshAllTacrepDetails();



  document.querySelectorAll("#missionTimelineItems .item").forEach(item => {

    try {

      const payload = JSON.parse(item.dataset.payload || "{}");

      updateTimelineItem(item, payload);

    } catch {}

  });



  const faultContainer = document.getElementById("faultItems");

  if (faultContainer) {

    Array.from(faultContainer.children).forEach(item => {

      try {

        const payload = JSON.parse(item.dataset.payload || "{}");

        const replacement = createFaultItem(payload);

        item.replaceWith(replacement);

      } catch {}

    });

  }

  updateRepinTracker();

}



function updateRepinTracker(){

  const tracker = document.getElementById("repinTracker");

  if (!tracker) return;

  const items = document.querySelectorAll("#missionTimelineItems .item");

  let count = 0;

  items.forEach(item=>{

    try {

      const payload = JSON.parse(item.dataset.payload || "{}");

      if ((payload?.type || "").toUpperCase() === "REPIN") count += 1;

    } catch {}

  });

  tracker.textContent = `BAR Re-Pins This Mission: ${count}`;

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



  

  let abbrevPrefsStore = loadAbbrevPrefs();
  let currentAbbrevType = "India";

  function normalizeAbbrevTypeKey(type){
    return DEFAULT_ABBREV_BY_TYPE[type] ? type : "Other";
  }

  function setCurrentAbbrevType(type){
    currentAbbrevType = normalizeAbbrevTypeKey(type || "Other");
  }



  // ---- Cached nodes ----

  const landing=$("#landing"), app=$("#app"), banner=$("#banner"), fileStatus=$("#fileStatus");

  const downloadJsonBtn=$("#downloadJsonBtn");

  const correlationBtn=$("#correlationBtn");

  const correlationCancelBtn=$("#correlationCancelBtn");

  const selectHint=$("#selectHint");

const entryForm=$("#entryForm");
let entryFormBaseline="";
let entryFormDirty=false;

function captureEntryFormSnapshot(){
  if(!entryForm) return "";
  const pairs=[];
  const elements = entryForm.querySelectorAll("input, textarea, select");
  elements.forEach((el,idx)=>{
    if(!el) return;
    const type = (el.type || "").toLowerCase();
    if(type==="button" || type==="submit" || type==="reset") return;
    const key = el.id || el.name || `f${idx}`;
    let value;
    if(type==="checkbox" || type==="radio"){
      value = el.checked ? "1" : "0";
    } else {
      value = el.value ?? "";
    }
    pairs.push(`${key}=${value}`);
  });
  pairs.push(`reported=${reportedFlag?1:0}`);
  return pairs.join("|");
}

function applyEntrySaveState(){
  const btn=document.getElementById("saveBtn");
  if(!btn) return;
  btn.disabled = !entryFormDirty;
  btn.setAttribute("aria-disabled", entryFormDirty ? "false" : "true");
}

function setEntryFormBaseline(){
  entryFormBaseline = captureEntryFormSnapshot();
  entryFormDirty = reportedFlagTouched ? true : false;
  applyEntrySaveState();
}

function evaluateEntryFormDirty(){
  if(!entryForm) return;
  const snap = captureEntryFormSnapshot();
  entryFormDirty = (snap !== entryFormBaseline);
  applyEntrySaveState();
}

if(entryForm){
  ["input","change"].forEach(evt=>{
    entryForm.addEventListener(evt, evaluateEntryFormDirty, true);
  });
}
applyEntrySaveState();

function validateBearingFieldForType(type){
  if(!BEARING_LIMIT_TYPES.has(type)) return true;
  const field = document.getElementById("bearing");
  if(!field) return true;
  const raw = field.value.trim();
  if(!raw) return true;
  if(!/^\d{1,3}$/.test(raw)){
    alert("Bearing must be a number between 0 and 359.");
    field.focus();
    return false;
  }
  const num = Number(raw);
  if(!Number.isFinite(num) || num < 0 || num > 359){
    alert("Bearing must be a number between 0 and 359.");
    field.focus();
    return false;
  }
  return true;
}

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

const vesselName = get("vesselName");

const mmsi = get("mmsi").replace(/\D/g,"").slice(0,9);

const vesselFlag = get("vesselFlag");

const imo = get("imo").replace(/\D/g,"").slice(0,7);

const tq = get("tq");

const majorAxis = get("majorAxis");

const minorAxis = get("minorAxis");

const orientation = get("orientation");

const amplification = get("amplification");

const ivo = get("ivoDescription");

const bearing = get("bearing");

const ownshipPosit = get("ownshipPosit");



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

const ownLatDeg = get("ownLatDeg").replace(/\D/g,"");

const ownLatMin = get("ownLatMin").replace(/\D/g,"");

const ownLatSec = get("ownLatSec").replace(/\D/g,"").slice(0,2);

const ownLatDecSecStr = get("ownLatDecSec").replace(/\D/g,"").slice(0,2);

const ownLatHem = get("ownLatHem") || "N";

const ownLonDeg = get("ownLonDeg").replace(/\D/g,"");

const ownLonMin = get("ownLonMin").replace(/\D/g,"");

const ownLonSec = get("ownLonSec").replace(/\D/g,"").slice(0,2);

const ownLonDecSecStr = get("ownLonDecSec").replace(/\D/g,"").slice(0,2);

const ownLonHem = get("ownLonHem") || "E";



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

systemOrPlatform: get("systemOrPlatform"),

emitterName: get("echoEmitter"),

activityOrFunction: get("echoActivity"),

frequency: (() => {

const num = get("echoFreq").replace(/[^0-9.]/g,"");

const unit = (document.getElementById("echoFreqUnit")?.value || "MHz");

return num ? `${num} ${unit}` : "";



})(),

positionMode: (document.getElementById("echoPositionMode")?.value || "latlon"),



// Standard fields (used by India/others; hidden for Echo via UI)

vesselType: get("vesselType"),

vesselName,

sensor: get("sensor"),

mmsi,

vesselFlag,

imo,

tq,

majorAxis,

minorAxis,

orientation,

amplification,

ivo,

bearing,

ownshipPosit,



// Position (DMS + compatibility fields)

latDeg, latMin, latSec, latDecSecStr, latDecMinStr, latHem,

lonDeg, lonMin, lonSec, lonDecSecStr, lonDecMinStr, lonHem,

ownLatDeg, ownLatMin, ownLatSec, ownLatDecSecStr, ownLatHem,
ownLonDeg, ownLonMin, ownLonSec, ownLonDecSecStr, ownLonHem,



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

if(!entryFormDirty){
  e.preventDefault();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  return;
}

const requiresSendFlow = (_changeMode === "correct" || _changeMode === "update");

const editType = (document.getElementById("targetColumn")?.value || "Other");
if(!validateBearingFieldForType(editType)){
  return;
}


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

    changeTypeSendRequired = requiresSendFlow;

  } else {

    showBanner("Unable to locate existing TACREP to update.");

    changeTypeSendRequired = false;

  }

} catch(err) {

  console.error("TACREP edit error:", err);

  showBanner("Edit failed. Check console.");

  changeTypeSendRequired = false;

} finally {

  // Always close modal AFTER save completes (or on error)

  closeForm({ preserveChangeMode: requiresSendFlow && changeTypeSendRequired });

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

    systemOrPlatform:   get("systemOrPlatform"),

    emitterName:        get("echoEmitter"),

    activityOrFunction: get("echoActivity"),

    frequency:          freqNum ? `${freqNum} ${freqUnit}` : "",

    positionMode:       (document.getElementById("echoPositionMode")?.value || "latlon"),

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

  const fmtTimeUTC = d => isValidDate(d) ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z` : "--";

  const tzFormatterCache = new Map();
  const getTZFormatter = (tz)=>{
    if(!tzFormatterCache.has(tz)){
      tzFormatterCache.set(tz, new Intl.DateTimeFormat(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false,timeZone:tz}));
    }
    return tzFormatterCache.get(tz);
  };

  const dateNoYearFormatter = new Intl.DateTimeFormat(undefined, {month:'short',day:'2-digit',timeZone:'UTC'});

  const fmtTZ = (d, tz) => isValidDate(d) ? getTZFormatter(tz).format(d) : "--";

  const fmtDateNoYearUTC = d => isValidDate(d) ? dateNoYearFormatter.format(d) : "--";

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
const correlationLookup = buildCorrelationLookup();

document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]):not([data-column="MissionDetails"]):not([data-column="MissionTimeline"]) .item').forEach(it=>{

try{

const p = JSON.parse(it.dataset.payload || "{}");

if(!p || !p.code) return; // only export real TACREPs



  const t = tacrepTypeFromCode(p.code);

  const labels = getTacrepFieldLabels(t, true);

  const headers = ["Code"].concat(labels, ["Correlations","CreatedBy","CreatedAt"]);

  const row = [p.code || ""]

    .concat(getTacrepFieldValues(t, p))

    .concat([

      formatCorrelationCell(p.code, correlationLookup),
      p.createdBy || "",

      p.createdAt ? new Date(p.createdAt).toISOString() : ""

    ]);



  if (!groups.has(t)) groups.set(t, { headers, rows: [] });

  const bucket = groups.get(t);

  bucket.headers = headers;

  bucket.rows.push(row);

}catch{}





});




function formatCorrelationCell(code, lookup){
  const arr = lookup[code] || [];
  if(!arr.length) return "";
  return arr.join("; ");
}

function buildCorrelationLookup(){
  const map = {};
  const cards = Array.from(document.querySelectorAll("#correlationItems .item"));
  cards.forEach(card=>{
    const codes = (card.dataset.codes || "").split("|").map(c=>c.trim()).filter(Boolean);
    codes.forEach(code=>{
      if(!map[code]) map[code]=new Set();
      codes.filter(other=> other && other !== code).forEach(other=> map[code].add(other));
    });
  });
  const out={};
  Object.keys(map).forEach(code=>{ out[code]=Array.from(map[code]).sort((a,b)=>a.localeCompare(b)); });
  return out;
}

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
  const lat = formatDmsString(p.latDeg, p.latMin, p.latSec, p.latDecSecStr, p.latHem) || "";
  const lon = formatDmsString(p.lonDeg, p.lonMin, p.lonSec, p.lonDecSecStr, p.lonHem) || "";

  timelineRows.push([
    p.timeHHMM||"",
    p.type||"",
    p.airfield||"",
    (p.type === "REPIN" ? (p.associatedFault || "") : (p.fault || "")),
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



/* MissionDetails -- title row, then two key/value rows (no BlockStart here) */

allCsvRows.push(["MissionDetails"]);

allCsvRows.push(["","Callsign", typeof callsign === "string" ? callsign : ""]);

allCsvRows.push(["","MissionNumber", typeof missionNumber === "string" ? missionNumber : ""]);

allCsvRows.push([]);



/* Crew Details -- title row, then header starting in column B */

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



/* Tacreps -- add a top-level title row, then each type as its own section */

allCsvRows.push(["Tacreps"]);

allTypes.forEach(t => {

  const { headers, rows } = groups.get(t);

 allCsvRows.push([t]);                         // keep section title in column A

allCsvRows.push([""].concat(headers));        // headers start in column B

rows.forEach(r => allCsvRows.push([""].concat(r))); // data start in column B



  allCsvRows.push([]);          // spacer between type sections

});



/* MissionTimeline -- title row, then header row (not combined) */

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

  // Keep Add buttons clickable (we gate in the click handler if Block Start isn't set)

  $$(".add-btn").forEach(b=> b.disabled = false);

  // Only gate starting correlations

  $("#correlationBtn").disabled = !on;

}



// === TACREP form open/close helpers (fixes "+" click freeze) ===

function updateReportedToggleUI(){
  const btn = document.getElementById("changeTypeReportedBtn");
  if(!btn) return;
  btn.textContent = reportedFlag ? "Mark as Unreported" : "Mark as Reported";
  btn.classList.remove("btn-reported","btn-danger");
  btn.classList.add(reportedFlag ? "btn-reported" : "btn-danger");
}

function setReportedBtn(on){
  reportedFlag = !!on;
  reportedFlagTouched = false;
  updateReportedToggleUI();
}



  function toggleFieldRowById(id, show){

    const el = document.getElementById(id);

    if (el){

      const row = el.closest(".row");

      if (row) row.style.display = show ? "" : "none";

    }

    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);

    if (label) label.style.display = show ? "" : "none";

  }



  function togglePositionGroup(show){

    const latRow = document.getElementById("latDeg")?.closest(".row");

    const lonRow = document.getElementById("lonDeg")?.closest(".row");

    if (latRow) latRow.style.display = show ? "" : "none";

    if (lonRow) lonRow.style.display = show ? "" : "none";

    const latLabel = latRow?.previousElementSibling;

    if (latLabel && latLabel.tagName === "LABEL") latLabel.style.display = show ? "" : "none";

    const lonLabel = lonRow?.previousElementSibling;

    if (lonLabel && lonLabel.tagName === "LABEL") lonLabel.style.display = show ? "" : "none";

  }



  const FIELD_CLEAR_HANDLERS = {

    systemOrPlatform: () => setValue("#systemOrPlatform", ""),

    vesselType: () => setValue("#vesselType", ""),

    vesselName: () => setValue("#vesselName", ""),

    mmsi: () => setValue("#mmsi", ""),

    vesselFlag: () => setValue("#vesselFlag", ""),

    imo: () => setValue("#imo", ""),

    tq: () => setValue("#tq", ""),

    sensor: () => setValue("#sensor", ""),

    echoPositionMode: () => {

      const sel = document.getElementById("echoPositionMode");

      if (sel) sel.value = "latlon";

    },

    amplification: () => setValue("#amplification", ""),

    ivoDescription: () => setValue("#ivoDescription", ""),

    majorAxis: () => setValue("#majorAxis", ""),

    minorAxis: () => setValue("#minorAxis", ""),

    orientation: () => setValue("#orientation", ""),

    bearing: () => setValue("#bearing", ""),

    ownshipPosit: () => setValue("#ownshipPosit", ""),

    ownLatDeg: () => setValue("#ownLatDeg", ""),

    ownLatMin: () => setValue("#ownLatMin", ""),

    ownLatSec: () => setValue("#ownLatSec", ""),

    ownLatDecSec: () => setValue("#ownLatDecSec", ""),

    ownLonDeg: () => setValue("#ownLonDeg", ""),

    ownLonMin: () => setValue("#ownLonMin", ""),

    ownLonSec: () => setValue("#ownLonSec", ""),

    ownLonDecSec: () => setValue("#ownLonDecSec", ""),

    course: () => setValue("#course", ""),

    speed: () => setValue("#speed", ""),

    trackNumber: () => setValue("#trackNumber", ""),

    minVesselLen: () => setValue("#minVesselLen", ""),

    additionalInfo: () => setValue("#additionalInfo", ""),

    minotaur: () => setValue("#minotaurPaste", ""),

    emitterName: () => setValue("#echoEmitter", ""),

    activityOrFunction: () => setValue("#echoActivity", ""),

    frequency: () => {

      setValue("#echoFreq", "");

      const freqUnit = document.getElementById("echoFreqUnit");

      if (freqUnit) freqUnit.value = "MHz";

    },

    position: () => {

      ["#latDeg","#latMin","#latSec","#latDecSec","#lonDeg","#lonMin","#lonSec","#lonDecSec"].forEach(sel => setValue(sel, ""));

      const latHemSel = document.getElementById("latHem");

      if (latHemSel) latHemSel.value = "N";

      const lonHemSel = document.getElementById("lonHem");

      if (lonHemSel) lonHemSel.value = "E";

    }

  };



const FIELD_GROUPS = {

    time: show => toggleFieldRowById("timeZuluInput", show),

    systemOrPlatform: show => toggleFieldRowById("systemOrPlatform", show),

    vesselType: show => toggleFieldRowById("vesselType", show),

    vesselName: show => toggleFieldRowById("vesselName", show),

    mmsi: show => toggleFieldRowById("mmsi", show),

    vesselFlag: show => toggleFieldRowById("vesselFlag", show),

    imo: show => toggleFieldRowById("imo", show),

    tq: show => toggleFieldRowById("tq", show),

    sensor: show => toggleFieldRowById("sensor", show),

    echoPositionMode: show => toggleFieldRowById("echoPositionMode", show),

    amplification: show => toggleFieldRowById("amplification", show),

    ivoDescription: show => toggleFieldRowById("ivoDescription", show),

    majorAxis: show => toggleFieldRowById("majorAxis", show),

    minorAxis: show => toggleFieldRowById("minorAxis", show),

    orientation: show => toggleFieldRowById("orientation", show),

    position: show => togglePositionGroup(show),

    bearing: show => toggleFieldRowById("bearing", show),

    ownshipPosit: show => toggleFieldRowById("ownshipPosit", show),

    course: show => toggleFieldRowById("course", show),

    speed: show => toggleFieldRowById("speed", show),

    trackNumber: show => toggleFieldRowById("trackNumber", show),

    minVesselLen: show => toggleFieldRowById("minVesselLen", show),

    additionalInfo: show => toggleFieldRowById("additionalInfo", show),

    minotaur: show => toggleFieldRowById("minotaurPaste", show),

    emitterName: show => toggleFieldRowById("echoEmitter", show),

    activityOrFunction: show => toggleFieldRowById("echoActivity", show),

    frequency: show => toggleFieldRowById("echoFreq", show)

  };

  const additionalInfoLabel = document.querySelector('label[for="additionalInfo"]');
  const additionalInfoTextarea = document.getElementById("additionalInfo");
  const additionalInfoAbbr = document.querySelector('.abbrChk[data-field="additionalInfo"]');

  function applyAdditionalInfoLabel(type){
    const useAmplification = type === "Echo" || type === "AIS";
    const labelText = useAmplification ? "Amplification" : "Additional Info";
    if (additionalInfoLabel) additionalInfoLabel.textContent = labelText;
    if (additionalInfoTextarea){
      additionalInfoTextarea.placeholder = useAmplification ? "Amplification details..." : "Additional information...";
      additionalInfoTextarea.setAttribute("aria-label", labelText);
    }
    if (additionalInfoAbbr){
      const desc = `Include ${labelText} in abbreviation`;
      additionalInfoAbbr.title = desc;
      additionalInfoAbbr.setAttribute("aria-label", desc);
    }
  }



const FIELD_PRESETS = {

  India: ["time","vesselType","sensor","position","course","speed","tq","amplification","trackNumber","minVesselLen","minotaur"],

  AIS: ["time","vesselType","vesselName","mmsi","vesselFlag","imo","position","course","speed","trackNumber","additionalInfo"],

  Echo: ["time","systemOrPlatform","emitterName","activityOrFunction","frequency","echoPositionMode","position","majorAxis","minorAxis","orientation","additionalInfo"],

  Alpha: ["time","systemOrPlatform","activityOrFunction","amplification","echoPositionMode","position","majorAxis","minorAxis","orientation","bearing","ownshipPosit"],

  November: ["time","systemOrPlatform","activityOrFunction","amplification","echoPositionMode","position","majorAxis","minorAxis","orientation","bearing","ownshipPosit"],

  Golf: ["time","systemOrPlatform","activityOrFunction","amplification","echoPositionMode","position","majorAxis","minorAxis","orientation","bearing","ownshipPosit"],

  Other: ["time","systemOrPlatform","position","additionalInfo"]

};



  const echoPositionDynamic = document.getElementById("echoPositionDynamic");

  const latlonBlock = document.getElementById("latlonBlock");

  const aouBlock = document.getElementById("aouBlock");

  const bearingBlock = document.getElementById("bearingBlock");

  const echoPositionBlocks = [latlonBlock, aouBlock, bearingBlock];

  const originalPositionMap = new Map();



  function moveBlockToEcho(node){

    if (!node || !echoPositionDynamic) return;

    if (!originalPositionMap.has(node)){

      originalPositionMap.set(node, { parent: node.parentNode, nextSibling: node.nextSibling });

    }

    if (node.parentNode !== echoPositionDynamic){

      echoPositionDynamic.appendChild(node);

    }

  }



  const ownshipLatLonGroup = document.getElementById("ownshipLatLonGroup");

  const ownshipLatLonFields = ["ownLatDeg","ownLatMin","ownLatSec","ownLatDecSec","ownLonDeg","ownLonMin","ownLonSec","ownLonDecSec"];

  function clearOwnshipLatLonFields(){
    ownshipLatLonFields.forEach(id => setValue(`#${id}`, ""));
    const ownLatHemSel = document.getElementById("ownLatHem");
    if (ownLatHemSel) ownLatHemSel.value = "N";
    const ownLonHemSel = document.getElementById("ownLonHem");
    if (ownLonHemSel) ownLonHemSel.value = "E";
    const ownPosInput = document.getElementById("ownshipPosit");
    if (ownPosInput) ownPosInput.value = "";
  }



  function restoreBlockFromEcho(node){

    if (!node) return;

    const info = originalPositionMap.get(node);

    if (!info) return;

    if (node.parentNode === info.parent) return;

    const { parent, nextSibling } = info;

    if (nextSibling && nextSibling.parentNode === parent){

      parent.insertBefore(node, nextSibling);

    } else {

      parent.appendChild(node);

    }

    node.classList.remove("echo-pos-active");

  }



  function formatDmsString(deg, min, sec, dec, hem){

    if (!(deg || min || sec || dec)) return "";

    const degPart = deg || "";

    const minPart = min || "";

    const secPart = sec || "";

    const decPart = dec ? `.${dec}` : "";

    return `${degPart}${DEG_SYM}${minPart}'${secPart}${decPart}"${hem || ""}`;

  }



  function applyEchoPositionMode(mode, { clearHidden = true } = {}){

    const select = document.getElementById("echoPositionMode");

    if (!select) return;

    const resolved = mode || select.value || "latlon";

    if (mode) select.value = mode;



    const setField = (key, visible)=>{

      const toggle = FIELD_GROUPS[key];

      if (toggle) toggle(visible);

      if (!visible && clearHidden){

        const clear = FIELD_CLEAR_HANDLERS[key];

        if (clear) clear();

      }

      enforceAbbrevVisibility(key, visible);

    };



    setField("position", resolved === "latlon");

    ["majorAxis","minorAxis","orientation"].forEach(key=> setField(key, resolved === "aou"));

    ["bearing","ownshipPosit"].forEach(key=> setField(key, resolved === "bearing"));
    setField("ivoDescription", resolved === "ivo");
    if (resolved === "bearing") {
      toggleFieldRowById("ownshipPosit", false);
    }

    if (ownshipLatLonGroup) {

      const showOwnLatLon = resolved === "bearing";

      ownshipLatLonGroup.style.display = showOwnLatLon ? "" : "none";

      if (!showOwnLatLon && clearHidden) clearOwnshipLatLonFields();

    }



    if (echoPositionDynamic && echoPositionDynamic.classList.contains("active")){

      let activeBlock = null;

      if (resolved === "latlon") activeBlock = latlonBlock;

      else if (resolved === "aou") activeBlock = aouBlock;

      else if (resolved === "bearing") activeBlock = bearingBlock;

      echoPositionBlocks.forEach(block => {

        if (block) block.classList.toggle("echo-pos-active", block === activeBlock);

      });

    } else if (echoPositionDynamic) {

      echoPositionBlocks.forEach(block => block?.classList.remove("echo-pos-active"));

    }

  }



  function inferEchoPositionMode(payload){

    if (!payload || typeof payload !== "object") return "latlon";

    if (payload.positionMode && ["latlon","aou","bearing","ivo"].includes(payload.positionMode)) {

      return payload.positionMode;

    }

    if (payload.ivo) return "ivo";

    const hasBearing = !!(payload.bearing || payload.ownshipPosit);

    if (hasBearing) return "bearing";

    const hasAou = !!(payload.majorAxis || payload.minorAxis || payload.orientation);

    if (hasAou) return "aou";

    const hasLatLon = !!(payload.latDeg || payload.latMin || payload.latSec || payload.lonDeg || payload.lonMin || payload.lonSec);

    if (hasLatLon) return "latlon";

    return "latlon";

  }



  function applyFieldPresetForType(type){

    const allowed = new Set(FIELD_PRESETS[type] || FIELD_PRESETS.Other);

    for (const [key, toggle] of Object.entries(FIELD_GROUPS)){

      const shouldShow = allowed.has(key);

      toggle(shouldShow);
      enforceAbbrevVisibility(key, shouldShow);

      if (!shouldShow && FIELD_CLEAR_HANDLERS[key]) {

        try { FIELD_CLEAR_HANDLERS[key](); } catch {}

      }

    }

    const usesPositionModes = POSITION_MODE_TYPES.has(type);
    const select = document.getElementById("echoPositionMode");
    const ivoOption = select?.querySelector('option[value="ivo"]');
    if (select && ivoOption) {
      const allowIvo = usesPositionModes && (IVO_POSITION_TYPES.has(type) || select.value === "ivo");
      ivoOption.hidden = !allowIvo;
      if (!allowIvo && select.value === "ivo") {
        select.value = "latlon";
      }
    }

    applyAdditionalInfoLabel(type);

    if (usesPositionModes) {

      if (echoPositionDynamic) {

        echoPositionDynamic.classList.add("active");

        echoPositionDynamic.style.display = "";

      }

      echoPositionBlocks.forEach(moveBlockToEcho);

      applyEchoPositionMode(undefined, { clearHidden:false });

    } else {

      if (echoPositionDynamic) {

        echoPositionDynamic.classList.remove("active");

        echoPositionDynamic.style.display = "none";

      }

      echoPositionBlocks.forEach(block => {

        restoreBlockFromEcho(block);

        block?.classList.remove("echo-pos-active");

      });

      clearOwnshipLatLonFields();

    }

  }



// Fill the modal from an existing payload (edit mode)

function fillEntryFormFromPayload(p){

  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.value = v==null ? "" : String(v); };



  set("timeZuluInput", p.timeHHMM || "");

  // Standard fields

  set("vesselType", p.vesselType);

  set("vesselName", p.vesselName);

  set("mmsi", p.mmsi);

  set("vesselFlag", p.vesselFlag);

  set("imo", p.imo);

  set("tq", p.tq);

  set("majorAxis", p.majorAxis);

  set("minorAxis", p.minorAxis);

  set("orientation", p.orientation);

  set("ownLatDeg", p.ownLatDeg);

  set("ownLatMin", p.ownLatMin);

  set("ownLatSec", p.ownLatSec);

  set("ownLatDecSec", p.ownLatDecSecStr);

  if (p.ownLatHem) {

    const ownLatHemSel = document.getElementById("ownLatHem");

    if (ownLatHemSel) ownLatHemSel.value = p.ownLatHem;

  }

  set("ownLonDeg", p.ownLonDeg);

  set("ownLonMin", p.ownLonMin);

  set("ownLonSec", p.ownLonSec);

  set("ownLonDecSec", p.ownLonDecSecStr);

  if (p.ownLonHem) {

    const ownLonHemSel = document.getElementById("ownLonHem");

    if (ownLonHemSel) ownLonHemSel.value = p.ownLonHem;

  }

  set("amplification", p.amplification);

  set("ivoDescription", p.ivo);

  set("bearing", p.bearing);

  set("ownshipPosit", p.ownshipPosit);

  set("sensor", p.sensor);

  set("course", p.course);

  set("speed", p.speed);

  set("trackNumber", p.trackNumber);

  set("minVesselLen", p.minVesselLen);

  set("additionalInfo", p.info);



  // Echo-only fields

  set("systemOrPlatform", p.systemOrPlatform);

  set("echoPositionMode", p.positionMode || "latlon");

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



  if(!reportedFlagTouched){
    setReportedBtn(!!p.reported);
  } else {
    updateReportedToggleUI();
  }

}



function resetEntryForm(){

  const form = document.getElementById("entryForm");

  if (form) form.reset();

  echoPositionBlocks.forEach(restoreBlockFromEcho);

  if (echoPositionDynamic) {

    echoPositionDynamic.classList.remove("active");

  }

  echoPositionBlocks.forEach(block => block?.classList.remove("echo-pos-active"));

  const posModeSel = document.getElementById("echoPositionMode");

  if (posModeSel) {

    posModeSel.value = "latlon";

    applyEchoPositionMode("latlon", { clearHidden:false });

  }

  reportedFlagTouched = false;
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



  const effectiveType = columnName || "Other";
  const editing = !!(existingPayload && existingPayload.code);
  const preservedReportedFlag = reportedFlag;
  const preservedReportedTouched = reportedFlagTouched;

  // Reset then set context

  resetEntryForm();

  if (editing) {
    if (preservedReportedTouched) {
      reportedFlag = preservedReportedFlag;
      reportedFlagTouched = true;
      updateReportedToggleUI();
    } else {
      setReportedBtn(!!(existingPayload && existingPayload.reported));
    }
  }

  targetCol.value = effectiveType;

  setCurrentAbbrevType(effectiveType);
  changeTypeSendRequired = false;

  if (modal) modal.dataset.tacrep = effectiveType;

  applyFieldPresetForType(effectiveType);
  try { refreshAbbrevCheckboxesInModal(); } catch {}


  // Show edit header bits if editing

  const codeRow = document.getElementById("codeEditRow");

  const codePrefix = document.getElementById("codePrefix");

  const codeNumber = document.getElementById("codeNumber");

  const editingCode = document.getElementById("editingCode");
  const usesPositionModes = POSITION_MODE_TYPES.has(effectiveType);



  if (editing){

    if (editingCode) editingCode.value = existingPayload.code;

    if (codeRow) codeRow.style.display = "block";

    const prefix = getPrefixFromCode(existingPayload.code);

    const number = (existingPayload.code || "").replace(/^[^\d]+/,"");

    if (codePrefix) codePrefix.value = prefix || "";

    if (codeNumber) codeNumber.value = number || "";

    if (codeNumber) codeNumber.disabled = true;

    const typeLabel = columnName || "TACREP";

    let modeLabel = "Correcting";

    if (_changeMode === "update") modeLabel = "Updating";

    else if (_changeMode === "correct") modeLabel = "Correcting";

    else if (_changeMode === "edit") modeLabel = "Correcting";

    title.textContent = `${modeLabel} TACREP ${typeLabel}`;

    fillEntryFormFromPayload(existingPayload);

    if (usesPositionModes) {

      const inferredMode = inferEchoPositionMode(existingPayload);

      applyEchoPositionMode(inferredMode, { clearHidden:false });

    }

  } else {

    if (codeRow) codeRow.style.display = "none";
  entryFormBaseline="";
  entryFormDirty=false;
  applyEntrySaveState();

    if (codeNumber) codeNumber.disabled = false;

    const typeLabel = columnName || "TACREP";

    title.textContent = `New TACREP ${typeLabel}`;

    if (usesPositionModes) {

      applyEchoPositionMode("latlon", { clearHidden:false });

    }

  }



  // Echo vs. others visibility handled by existing MutationObserver when modal opens

  openModal(modal);

  try { refreshAbbrevCheckboxesInModal(); } catch {}
  setTimeout(setEntryFormBaseline, 0);

}



// Close + clean up helper

function closeForm(options={}){
  const { preserveChangeMode=false } = options;

  const modal = document.getElementById("entryModal");

  if (!modal) return;

  resetEntryForm();

  closeModal(modal);

  modal.dataset.tacrep = "";

  editingItem = null;

  const codeRow = document.getElementById("codeEditRow");

  if (codeRow) codeRow.style.display = "none";
  entryFormBaseline="";
  entryFormDirty=false;
  applyEntrySaveState();

  if (!preserveChangeMode){
    _changeMode = null;
    _changeContext = null;
    changeTypeSendRequired = false;
  }
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

refreshAllTacrepDetails();

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

      fileStatus.textContent="* Memory mode -- use Download JSON";

      downloadJsonBtn.style.display="inline-block";

      $("#syncSaveBtn").style.display="none";

    } else {

      downloadJsonBtn.style.display="none";

      $("#syncSaveBtn").style.display="inline-block";

      fileStatus.textContent=fileHandle ? (dirty ? `* Unsaved changes -- ${fileHandle.name}` : `Opened: ${fileHandle.name}`) : "No file";

    }

  }

  // ---- Tabs ----

  function setActiveTab(name){

   const validTabs = new Set(Array.from(document.querySelectorAll('.tab-panel')).map(p => p.dataset.tab));

if (!validTabs.has(name)) { name = 'MD'; try{ localStorage.setItem('wf_active_tab','MD'); }catch{} }





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

function forceTabMD(){

  setActiveTab('MD'); // make Mission Details the default tab

  try{ localStorage.setItem('wf_active_tab','MD'); }catch{}

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

    return buildPosCompact(p);

  }



  let renderTacrepDetailsInto = ()=>{};



  document.addEventListener("DOMContentLoaded", ()=>{

 // === Unified TACREP details renderer (replaces Echo enhancer) ===

renderTacrepDetailsInto = function(item, payload) {

  if (!item) return;



  let p = payload;

  if (!p) {
    const raw = item.dataset.payload || "{}";
    if (item._cachedPayloadRaw !== raw) {
      item._cachedPayloadRaw = raw;
      try { item._cachedPayloadParsed = JSON.parse(raw); } catch { item._cachedPayloadParsed = {}; }
    }
    p = item._cachedPayloadParsed || {};
  }



  const details = item.querySelector(".item-details");

  if (!details) return;



  if (details.dataset.rendering === "1") return;

  details.dataset.rendering = "1";

  details.innerHTML = "";



  const fallbackType = item.closest(".column")?.dataset.column || "Other";

  const type = tacrepTypeFromCode(p?.code) || fallbackType;

  const entries = collectTacrepFields(type, p);



  const append = (label, val) => {

    if (!val) return;

    const span = document.createElement("span");

    span.className = "detail";

    span.innerHTML = `<em>${escapeHtml(label)}:</em> ${escapeHtml(val)}`;

    details.appendChild(span);

  };



  entries.forEach(entry => append(entry.label, entry.value));



  if (entries.length) {
    const slashLine = entries.map(entry => entry.value).join("/");
    const slashWrap = document.createElement("div");
    slashWrap.className = "detail detail-line-wrap";

    const span = document.createElement("span");
    span.className = "detail-line";
    span.textContent = slashLine;

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-pill copy-slash-btn";
    copyBtn.dataset.originalLabel = "Copy Report";
    copyBtn.textContent = "Copy Report";
    copyBtn.setAttribute("aria-label", "Copy report to clipboard");
    copyBtn.addEventListener("click", ()=> copySlashLineToClipboard(slashLine, copyBtn));

    slashWrap.appendChild(span);
    slashWrap.appendChild(copyBtn);
    details.appendChild(slashWrap);
  }



  delete details.dataset.rendering;

};











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

    if (item._renderQueued) return;
    item._renderQueued = true;
    requestAnimationFrame(()=>{
      item._renderQueued = false;
      renderTacrepDetailsInto(item);
    });

  };



  // 1) Class changes (expanded/collapsed)

  const classObserver = new MutationObserver((muts) => {

    muts.forEach(m => {

      if (m.type === "attributes" && m.attributeName === "class") {

        if (m.target?.classList?.contains("item")) {
          onMaybeRender(m.target);
        }

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
    const crewInputEl = $("#crewInput");
    if (crewInputEl) {
      crewInputEl.addEventListener("keydown", (e)=>{
        if (e.key === "Enter") {
          e.preventDefault();
          $("#crewApply")?.click();
        }
      });
    }

    $("#blockCancel").addEventListener("click", ()=>{ pendingTacrepColumn=null; closeModal($("#blockModal")); });

    $("#blockApply").addEventListener("click", onBlockApply);

    $("#changeCrewBtn").addEventListener("click", ()=>{ $("#crewInput").value=crewPosition; openModal($("#crewModal")); });



 $("#exportBtn").addEventListener("click", openExportPreview);

    $("#downloadJsonBtn").addEventListener("click", downloadCurrentJSON);

    $("#syncSaveBtn").addEventListener("click", ()=>{ if(memoryMode){ downloadCurrentJSON(); } else { requestAutoSyncSave(true); } });

    $("#suggestionBtn").addEventListener("click", ()=> openModal($("#suggestionModal")));

    const settingsBtn = $("#settingsBtn");

    const settingsModal = $("#settingsModal");

    const tacrepFormatModal = $("#tacrepFormatModal");

    const positionFormatModal = $("#positionFormatModal");

    const settingsCloseBtn = $("#settingsCloseBtn");

    const openTacrepFormatBtn = $("#openTacrepFormatBtn");

    const openPositionFormatBtn = $("#openPositionFormatBtn");

    const tacrepFormatCancelBtn = $("#tacrepFormatCancelBtn");

    const tacrepFormatResetBtn = $("#tacrepFormatResetBtn");

    const positionFormatCancelBtn = $("#positionFormatCancelBtn");

    const positionFormatForm = $("#positionFormatForm");

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

    if (openPositionFormatBtn && positionFormatModal) {

      openPositionFormatBtn.addEventListener("click", ()=>{

        if (settingsModal) closeModal(settingsModal);

        if (positionFormatForm) {

          positionFormatForm.querySelectorAll('input[name="positionFormatChoice"]').forEach(radio => {

            radio.checked = (radio.value === positionFormat);

          });

        }

        openModal(positionFormatModal);

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

    if (positionFormatCancelBtn && positionFormatModal) {

      positionFormatCancelBtn.addEventListener("click", ()=> closeModal(positionFormatModal));

    }

    if (positionFormatForm && positionFormatModal) {

      positionFormatForm.addEventListener("submit", (e)=>{

        e.preventDefault();

        const selected = positionFormatForm.querySelector('input[name="positionFormatChoice"]:checked');

        if (selected) {

          applyPositionFormat(selected.value);

        }

        closeModal(positionFormatModal);

      });

    }

    const tfContainer = $("#tacrepFormatContainer");

    if (tfContainer) tfContainer.addEventListener("click", handleTacrepFormatClick);



    $("#cancelEntryBtn").addEventListener("click", ()=> closeForm());

$("#makeCurrentBtn").addEventListener("click", ()=>{ const d=new Date(); $("#timeZuluInput").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`; });

    const echoPosModeSel = document.getElementById("echoPositionMode");

    if (echoPosModeSel) {

      echoPosModeSel.addEventListener("change", ()=> applyEchoPositionMode(echoPosModeSel.value, { clearHidden:true }));

    }

    applyPositionFormat(positionFormat, { save:false });

    updateRepinTracker();

/* Configure entry form when opening for each TACREP type */

(function installFieldConfigurator(){

  const entry = document.getElementById("entryModal");

  if (!entry) return;



  function configureEntryFormForColumn(){

    const col = (document.getElementById("targetColumn")?.value || "");

    const normalized = col || "Other";
    setCurrentAbbrevType(normalized);
    applyFieldPresetForType(normalized);

    try { refreshAbbrevCheckboxesInModal(); } catch {}

  }



  const ob = new MutationObserver(()=>{

    const visible = entry.style.display !== "none" && entry.getAttribute("aria-hidden") !== "true";

    if (visible) configureEntryFormForColumn();

  });

  ob.observe(entry, { attributes:true, attributeFilter:["style","aria-hidden"] });

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

// Ensure Mission Timeline is expanded by default on LOG tab

(function(){

const mtl = document.getElementById('missionTimelineTile');

if (mtl) {

  mtl.classList.add('expanded');

}

})();





// Patch tab switching to hard-hide Mission Timeline unless LOG (MPO) tab is active

const __origSetActiveTab = setActiveTab;

setActiveTab = function(name){

__origSetActiveTab(name);

const mtl = document.getElementById('missionTimelineTile');

if (mtl) {

mtl.style.display = (name === 'MPO') ? '' : 'none';

}

};    



const changeTypeReportedBtn = document.getElementById("changeTypeReportedBtn");
if(changeTypeReportedBtn){
  changeTypeReportedBtn.addEventListener("click", ()=>{
    reportedFlag = !reportedFlag;
    reportedFlagTouched = true;
    updateReportedToggleUI();
  });
}
updateReportedToggleUI();



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

clampDigitsInput($("#ownLatDeg"));
clampDigitsInput($("#ownLatMin"));
clampDigitsInput($("#ownLatSec"), 2);
clampDigitsInput($("#ownLatDecSec"), 2);
clampDigitsInput($("#ownLonDeg"));
clampDigitsInput($("#ownLonMin"));
clampDigitsInput($("#ownLonSec"), 2);
clampDigitsInput($("#ownLonDecSec"), 2);

clampDigitsInput($("#course"));

decimalNumeric($("#echoFreq"));

clampDigitsInput($("#blockInput"));

clampDigitsInput(document.getElementById("md_blockStart"));

clampDigitsInput($("#codeNumber"));

clampDigitsInput($("#minVesselLen"));

clampDigitsInput($("#mmsi"), 9);

clampDigitsInput($("#imo"), 7);

clampDigitsInput($("#faultTime"));

clampDigitsInput($("#tfTime"));



    

    // Abbrev prefs

    $$(".abbrChk").forEach(chk=> chk.addEventListener("change", ()=> setAbbrev(chk.dataset.field, chk.checked)));

    /* ensure Echo-only checkboxes are also wired (they share .abbrChk, so this is already covered) */

    refreshAbbrevCheckboxesInModal();



// Add New buttons (delegated) -- gate on Block Start

// ===== TACREP Edit Pencil: pre-edit chooser (Edit / Correct / Update) =====



// Utility: open the chooser for a specific TACREP element

function openChangeTypeChooser(itemEl){

  try {

    const payload = JSON.parse(itemEl.dataset.payload || "{}");

    _changeContext = { itemEl, payload };

    _changeMode = null;
    changeTypeSendRequired = false;
    reportedFlagTouched = false;
    setReportedBtn(!!payload.reported);

    openModal(document.getElementById("changeTypeModal"));

  } catch {

    // If payload is missing, fallback to regular edit

    const p = document.getElementById("changeTypeModal");

    if (p) closeModal(p);

    _changeMode = "edit";
    changeTypeSendRequired = false;

    // Fallback open

    editingItem = itemEl;

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
  const btnSave = document.getElementById("btnChangeTypeSave");

  const launchEditFlow = (mode)=>{
    _changeMode = mode;
    changeTypeSendRequired = false;
    if (m) closeModal(m);
    if (_changeContext) {
      editingItem = _changeContext.itemEl || null;
      openForm(_changeContext.itemEl.closest('.column')?.dataset.column||"India", _changeContext.payload);
    }
  };

  if (btnE) btnE.onclick = ()=> launchEditFlow("edit");

  if (btnC) btnC.onclick = ()=> launchEditFlow("correct");

  if (btnU) btnU.onclick = ()=> launchEditFlow("update");

  if (btnX) btnX.onclick = ()=>{
    if (_changeContext && _changeContext.payload){
      setReportedBtn(!!_changeContext.payload.reported);
    }
    _changeMode = null;
    _changeContext = null;
    changeTypeSendRequired = false;
    if (m) closeModal(m);
  };

  if (btnSave) btnSave.onclick = async ()=>{
    if (!_changeContext || !_changeContext.itemEl) {
      if (m) closeModal(m);
      return;
    }
    const item = _changeContext.itemEl;
    let payload;
    try { payload = JSON.parse(item.dataset.payload || "{}"); } catch { payload = {}; }
    const desired = !!reportedFlag;
    if (!reportedFlagTouched && !!payload.reported === desired) {
      if (m) closeModal(m);
      return;
    }
    payload.reported = desired;
    item.dataset.payload = JSON.stringify(payload);
    updateItemElement(item, payload);
    _changeContext.payload = payload;

    try{
      dirty = true;
      await syncAndSave();
      showBanner(`TACREP ${payload.code || ""} marked ${desired ? "reported" : "unreported"}.`);
    } catch(err){
      console.error("Reported toggle save failed:", err);
      showBanner("Unable to save reported status.");
    }

    reportedFlagTouched = false;
    changeTypeSendRequired = false;
    if (m) closeModal(m);
  };

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
  const fields = collectTacrepFields(type, p)
    .map(entry => String(entry.value || "").trim())
    .filter(Boolean);
  if (!fields.length) return "";
  return fields.join(" / ");

}



// Open Yes/No confirm (using existing #confirmModal) with dynamic labels

// tac: the TACREP data to show in preview (latest/corrected state)

// originalTac: the TACREP data to save to history (pre-correction state)

function openSendConfirm(kind /* "correct"|"update" */, tac, originalTac){

  const modal = document.getElementById("confirmModal");

  const title = document.getElementById("confirmTitle");

  const text  = document.getElementById("confirmText");

  const btnNo = document.getElementById("confirmCancelBtn");

  const btnYes= document.getElementById("confirmOkBtn");

  if (!modal || !title || !text || !btnNo || !btnYes) return;



  // If no originalTac provided, use tac (for backward compatibility)

  const historySnapshot = originalTac || tac;



  // Set flag to prevent addEventListener from interfering

  if (typeof usingSendConfirmMode !== 'undefined') {

    usingSendConfirmMode = true;

  }



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

    // Reset flag and clear handlers

    if (typeof usingSendConfirmMode !== 'undefined') usingSendConfirmMode = false;

    btnNo.onclick = null;

    btnYes.onclick = null;

    closeModal(modal);

    // Log ORIGINAL state to history

    logChangeHistory(kind, tac.code, crewPosition || "", historySnapshot);

  };

  btnYes.onclick = ()=>{

    // Reset flag and clear handlers

    if (typeof usingSendConfirmMode !== 'undefined') usingSendConfirmMode = false;

    btnNo.onclick = null;

    btnYes.onclick = null;

    closeModal(modal);

    // Build preview text and show preview modal using LATEST data

    const header = (kind === "update")

      ? `Update to TACREP ${tac.code}`

      : `Correction to TACREP ${tac.code}`;

    const body = composeTacrepInfoText(tac);

    const full = body ? `${header}
${body}` : header;



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

      // After user acknowledges, log ORIGINAL state to history

      logChangeHistory(kind, tac.code, crewPosition || "", historySnapshot);

    };



    openModal(sp);

  };



  openModal(modal);

}

function openConfirm(message, onConfirm){
  const modal = document.getElementById("confirmModal");
  const title = document.getElementById("confirmTitle");
  const text  = document.getElementById("confirmText");
  const btnNo = document.getElementById("confirmCancelBtn");
  const btnYes= document.getElementById("confirmOkBtn");
  if (!modal || !title || !text || !btnNo || !btnYes) return;

  title.textContent = "Confirm";
  text.textContent = message;
  btnNo.textContent = "Cancel";
  btnYes.textContent = "OK";

  btnNo.onclick = ()=>{
    btnNo.onclick = null;
    btnYes.onclick = null;
    closeModal(modal);
  };
  btnYes.onclick = ()=>{
    btnNo.onclick = null;
    btnYes.onclick = null;
    closeModal(modal);
    try{
      if(typeof onConfirm === "function") onConfirm();
    }catch(err){
      console.error("Confirm handler failed:", err);
    }
  };

  openModal(modal);
}
window.openConfirm = openConfirm;



// History logging (UI + persistence flag)

function logChangeHistory(kind /* "correct"|"update"|"edit" */, code, by, tacrepData){

  const when = new Date();

  const ts = `${when.getUTCFullYear()}-${String(when.getUTCMonth()+1).padStart(2,"0")}-${String(when.getUTCDate()).padStart(2,"0")} ${String(when.getUTCHours()).padStart(2,"0")}:${String(when.getUTCMinutes()).padStart(2,"0")}Z`;

  const verb = (kind === "update") ? "updated" : (kind === "edit") ? "edited" : "corrected";

  const payload = normalizeHistoryEntry({

    id:`hist_${when.getTime()}`,

    code,

    kind,

    by,

    at: when.getTime(),

    line:`[${ts}] ${code} - ${verb} by ${by}`,

    snapshot: tacrepData ? {...tacrepData} : null

  });

  if(!payload) return;



  const list = document.getElementById("historyItems");

  if (list) {

    const dup = payload.id ? list.querySelector(`.item[data-history-id="${CSS.escape(payload.id)}"]`) : null;

    if (dup) dup.remove();

    const el = createHistoryItem(payload);

    list.insertBefore(el, list.firstChild || null);

    if (code) { historyCodesLocal.add(code); }

  }



  changeHistoryEntries = [payload, ...changeHistoryEntries.filter(entry => entry.id !== payload.id)];



  dirty = true;

  requestAutoSyncSave(true);



  if (typeof updateAllHistoryButtons === 'function') {

    updateAllHistoryButtons();

  }

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

    if (isClosed && changeTypeSendRequired && (_changeMode === "correct" || _changeMode === "update") && _changeContext) {

      try{

        // Find the freshly updated TACREP tile by code

        const code = _changeContext.payload?.code;

        if (!code) { _changeMode = null; _changeContext = null; return; }

        const badge = document.querySelector(`.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge[data-code="${CSS.escape(code)}"]`);

        const item = badge && badge.closest(".item");

        const latest = item ? JSON.parse(item.dataset.payload || "{}") : null;



        // For correct/update: save ORIGINAL state to history, show LATEST in preview

        // Pass both: original for history logging, latest for preview display

        const original = _changeContext.payload;

        openSendConfirm(_changeMode, latest || original, original);

      } finally {

        // Reset mode/context AFTER we launch confirm (confirm will log history and/or preview)

        _changeMode = null;

        _changeContext = null;

        changeTypeSendRequired = false;

      }

    } else if (isClosed) {
      changeTypeSendRequired = false;
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

return (t === "+ add" || t === "add" || t === "remove" || t === "- remove" || t === "- remove");

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



const col = colEl.dataset.column;



// If Block Start not set, prompt for it and remember which column was clicked

if(!Number.isInteger(blockStartNum)){

pendingTacrepColumn = col; // Remember which TACREP type user wanted to add

$("#blockInput").value = "";

openModal($("#blockModal"));

return;

}



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

        insertTimelineItemSorted(list, el);

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



const timelineFaultBtn = document.getElementById("mtl_FAULTS");

if (timelineFaultBtn) {

  timelineFaultBtn.addEventListener("click", ()=> {

    document.getElementById("tfTime").value = "";

    document.getElementById("tfCode").value = "";

    document.getElementById("tfComments").value = "";

    window._editingTimelineFaultItem = null;

    openModal(document.getElementById("timelineFaultModal"));

  });

}



// Mission Log button handler

const repinBtn = document.getElementById("mtl_REPIN");

if (repinBtn) {

  repinBtn.addEventListener("click", ()=> {

    document.getElementById("repinTime").value = "";

    document.getElementById("repinFault").value = "";

    window._editingTimelineRepinItem = null;

    openModal(document.getElementById("repinModal"));

  });

}



const missionLogBtn = document.getElementById("mtl_MISSIONLOG");

if (missionLogBtn) {

  missionLogBtn.addEventListener("click", ()=> {

    // Reset form and editing state

    document.getElementById("mlTime").value = "";

    document.getElementById("mlComments").value = "";

    window._editingMissionLogItem = null;

    openModal(document.getElementById("missionLogModal"));

  });

}



const repinTimeCurrentBtn = document.getElementById("repinTimeCurrent");

if (repinTimeCurrentBtn) {

  repinTimeCurrentBtn.addEventListener("click", ()=> {

    const d = new Date();

    document.getElementById("repinTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

  });

}



const repinCancelBtn = document.getElementById("repinCancel");

if (repinCancelBtn) {

  repinCancelBtn.addEventListener("click", ()=>{

    window._editingTimelineRepinItem = null;

    closeModal(document.getElementById("repinModal"));

  });

}



const repinForm = document.getElementById("repinForm");

if (repinForm) {

  repinForm.addEventListener("submit", (e)=>{

    e.preventDefault();

    const timeVal = (document.getElementById("repinTime").value || "").trim().replace(/\D/g,"").slice(0,4);

    if (!timeVal || timeVal.length !== 4) {

      alert("Enter time in HHMM format.");

      return;

    }

    const hh = Number(timeVal.slice(0,2));

    const mm = Number(timeVal.slice(2,4));

    if (hh > 23 || mm > 59) {

      alert("Invalid time. Hours must be 0-23 and minutes must be 0-59.");

      return;

    }

    const faultVal = (document.getElementById("repinFault").value || "").trim();

    const list = document.getElementById("missionTimelineItems");

    if (!list) {

      closeModal(document.getElementById("repinModal"));

      return;

    }

    const now = Date.now();



    if (window._editingTimelineRepinItem) {

      const existing = JSON.parse(window._editingTimelineRepinItem.dataset.payload || "{}");

      const payload = {

        ...existing,

        timeHHMM: timeVal,

        associatedFault: faultVal,

        lastModified: now

      };

      updateTimelineItem(window._editingTimelineRepinItem, payload);

      window._editingTimelineRepinItem = null;

      dirty = true;

      requestAutoSyncSave(true);

      showBanner("Re-pin updated.");

    } else {

      const payload = {

        timeHHMM: timeVal,

        type: "REPIN",

        associatedFault: faultVal,

        createdBy: crewPosition || "",

        createdAt: now,

        lastModified: now

      };

      const el = createTimelineItem(payload);

      insertTimelineItemSorted(list, el);

      dirty = true;

      requestAutoSyncSave(true);

      showBanner("Re-pin logged.");

    }



    updateRepinTracker();

    closeModal(document.getElementById("repinModal"));

  });

}



// Mission Log - Current time button

const mlTimeCurrentBtn = document.getElementById("mlTimeCurrent");

if (mlTimeCurrentBtn) {

  mlTimeCurrentBtn.addEventListener("click", ()=> {

    const d = new Date();

    document.getElementById("mlTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

  });

}



// Mission Log - Cancel button

const mlCancelBtn = document.getElementById("mlCancel");

if (mlCancelBtn) {

  mlCancelBtn.addEventListener("click", ()=> {

    closeModal(document.getElementById("missionLogModal"));

  });

}



// Mission Log - Form submission

const missionLogForm = document.getElementById("missionLogForm");

if (missionLogForm) {

  missionLogForm.addEventListener("submit", (e)=> {

    e.preventDefault();



    const timeVal = document.getElementById("mlTime").value.trim();

    const commentsVal = document.getElementById("mlComments").value.trim();



    // Validate time

    if (!timeVal || timeVal.length !== 4) {

      alert("Please enter time in HHMM format.");

      return;

    }



    const hh = Number(timeVal.slice(0, 2));

    const mm = Number(timeVal.slice(2, 4));

    if (hh > 23 || mm > 59) {

      alert("Invalid time. Hours must be 0-23 and minutes must be 0-59.");

      return;

    }



    const list = document.getElementById("missionTimelineItems");



    // Check if we're editing an existing entry

    if (window._editingMissionLogItem) {

      // Update existing entry

      const existingPayload = JSON.parse(window._editingMissionLogItem.dataset.payload || "{}");

      const updatedPayload = {

        ...existingPayload,

        timeHHMM: timeVal,

        comments: commentsVal,

        lastModified: Date.now()

      };



      updateTimelineItem(window._editingMissionLogItem, updatedPayload);

      window._editingMissionLogItem = null;



      dirty = true;

      requestAutoSyncSave(true);

      showBanner("Mission Log entry updated.");

    } else {

      // Create new mission timeline entry

      const payload = {

        timeHHMM: timeVal,

        type: "MISSIONLOG",

        comments: commentsVal,

        createdBy: crewPosition || "",

        createdAt: Date.now(),

        lastModified: Date.now()

      };



      if (list) {

        const el = createTimelineItem(payload);

        insertTimelineItemSorted(list, el);



        dirty = true;

        requestAutoSyncSave(true);

        showBanner("Mission Log entry added.");

      }

    }



    closeModal(document.getElementById("missionLogModal"));

  });

}



// Mission Timeline Fault modal controls

const tfTimeCurrentBtn = document.getElementById("tfTimeCurrent");

if (tfTimeCurrentBtn) {

  tfTimeCurrentBtn.addEventListener("click", ()=> {

    const d = new Date();

    document.getElementById("tfTime").value = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

  });

}



const tfCancelBtn = document.getElementById("tfCancel");

if (tfCancelBtn) {

  tfCancelBtn.addEventListener("click", ()=> {

    closeModal(document.getElementById("timelineFaultModal"));

    window._editingTimelineFaultItem = null;

  });

}



const timelineFaultForm = document.getElementById("timelineFaultForm");

if (timelineFaultForm) {

  timelineFaultForm.addEventListener("submit", (e)=> {

    e.preventDefault();

    const timeVal = (document.getElementById("tfTime").value || "").trim().replace(/\D/g,"").slice(0,4);

    if (!timeVal || timeVal.length !== 4) {

      alert("Enter time in HHMM Zulu.");

      return;

    }

    const hh = Number(timeVal.slice(0,2));

    const mm = Number(timeVal.slice(2,4));

    if (hh > 23 || mm > 59) {

      alert("Invalid time. Hours must be 0-23 and minutes 0-59.");

      return;

    }

    const faultVal = (document.getElementById("tfCode").value || "").trim();

    const commentsVal = (document.getElementById("tfComments").value || "").trim();

    const container = document.getElementById("missionTimelineItems");

    if (!container) {

      closeModal(document.getElementById("timelineFaultModal"));

      return;

    }

    const now = Date.now();



    if (window._editingTimelineFaultItem) {

      const existing = JSON.parse(window._editingTimelineFaultItem.dataset.payload || "{}");

      const payload = {

        ...existing,

        timeHHMM: timeVal,

        fault: faultVal,

        comments: commentsVal,

        lastModified: now

      };

      updateTimelineItem(window._editingTimelineFaultItem, payload);

      window._editingTimelineFaultItem = null;

      dirty = true;

      requestAutoSyncSave(true);

      showBanner("Fault updated.");

    } else {

      const payload = {

        timeHHMM: timeVal,

        type: "FAULT",

        fault: faultVal,

        comments: commentsVal,

        createdBy: crewPosition || "",

        createdAt: now,

      lastModified: now

      };

      const el = createTimelineItem(payload);

      insertTimelineItemSorted(container, el);

      dirty = true;

      requestAutoSyncSave(true);

      showBanner("Fault logged to Mission Timeline.");

    }



    closeModal(document.getElementById("timelineFaultModal"));

  });

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

      insertTimelineItemSorted(list, el);

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
  alert("Check Position:\n- Lat: 0-90 deg, 0-59', 0-59.99\" \n- Lon: 0-180 deg, 0-59', 0-59.99\"");
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

  insertTimelineItemSorted(list, el);

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



        <div class="row"><strong>Latitude (DÃÂ° M' S.SS")</strong></div>

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



        <div class="row"><strong>Longitude (DÃÂ° M' S.SS")</strong></div>

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

      alert("Check Position:\n- Lat: 0-90 deg, 0-59', 0-59.99\"\n- Lon: 0-180 deg, 0-59', 0-59.99\"");
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

      insertTimelineItemSorted(list, el);

    }

    dirty = true;

    requestAutoSyncSave(true);

showBanner("OFFSTA logged to Mission Timeline.");



 } catch(e){

    console.warn("[OFFSTA popup] Save failed:", e);

  }

});





clampDigitsInput(document.getElementById("mlTime"));

// Clamp inputs for CONT-1 form


 





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



    const DEFAULT_TAB = 'MD';

    setActiveTab(DEFAULT_TAB);

    try{ localStorage.setItem('wf_active_tab', DEFAULT_TAB); }catch{}

    $$('.tabbar .tab').forEach(btn=>{

      btn.addEventListener('click', ()=> setActiveTab(btn.dataset.tabTarget || DEFAULT_TAB));

    });



    

    // Collaborative poll

    const POLL_INTERVAL_MS = Math.max(2000, Number(POLL_MS) || 5000);
    let collabPollTimer = null;

    const shouldPollCollab = () => (
      !memoryMode &&
      useFS &&
      !!fileHandle &&
      !isSaving &&
      document.visibilityState === "visible"
    );

    const runCollabPoll = async () => {
      if(!shouldPollCollab()) return;
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
          // Update history buttons after remote changes are applied (with small delay to ensure DOM is ready)
          setTimeout(() => {
            if (typeof updateAllHistoryButtons === 'function') {
              updateAllHistoryButtons();
            }
          }, 100);
        }
      }catch(err){
        console.error("Sync poll failed:", err);
      }
    };

    const startCollabPolling = ()=>{
      if (collabPollTimer) return;
      collabPollTimer = setInterval(runCollabPoll, POLL_INTERVAL_MS);
    };

    const stopCollabPolling = ()=>{
      if (!collabPollTimer) return;
      clearInterval(collabPollTimer);
      collabPollTimer = null;
    };

    document.addEventListener("visibilitychange", ()=>{
      if (document.visibilityState === "visible") {
        runCollabPoll();
        startCollabPolling();
      } else {
        stopCollabPolling();
      }
    });

    startCollabPolling();



    // Suggestion form

    const sbCancel = $("#sb-cancel");

    if (sbCancel) sbCancel.addEventListener("click", ()=> closeModal($("#suggestionModal")));

    const suggestionFormEl = $("#suggestionForm");

    if (suggestionFormEl) suggestionFormEl.addEventListener("submit", (e)=>{ e.preventDefault(); closeModal($("#suggestionModal")); });

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

      forceTabMD();

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

  forceTabMD();

  applyState(initialState);

  updateFileStatus();

  enableIfReady();

  recomputeHighlights();

  showBanner("Running in memory -- use Download JSON.");

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

forceTabMD();   // make Mission Details the default tab

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

forceTabMD();   // ensure Mission Details tab after collab (no FS)

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



// If user was trying to add a TACREP before Block Start was set, open that form now

if (pendingTacrepColumn && pendingTacrepColumn !== "Correlations") {

openForm(pendingTacrepColumn, null);

}

pendingTacrepColumn = null; // Clear the pending column



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

    // Update history buttons after loading from file

    setTimeout(() => {

      if (typeof updateAllHistoryButtons === 'function') {

        updateAllHistoryButtons();

      }

    }, 100);

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

    isSaving=true; fileStatus.textContent=fileHandle ? `SavingÃ¢â¬Â¦ ${fileHandle.name}` : "SavingÃ¢â¬Â¦";

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

missionTimeline:[],



crewDetails

};

}



  function applyState(state){



// Clear all TACREP columns (but not History, MissionDetails, or MissionTimeline)

document.querySelectorAll('.column[data-column]:not([data-column="MissionDetails"]):not([data-column="MissionTimeline"]):not([data-column="History"]) .items').forEach(div=> div.innerHTML="");



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

const historyList = document.getElementById("historyItems");

if (historyList) { historyList.innerHTML = ""; } // Clear history before loading

historyCodesLocal.clear();

if (Array.isArray(state.changeHistory)) {

  if (DEBUG_HISTORY) console.debug(`[History] loading ${state.changeHistory.length} items from state`, state.changeHistory);

  const normalizedHistory = state.changeHistory

    .map(normalizeHistoryEntry)

    .filter(Boolean)

    .sort((a,b)=> Number(b.at||0) - Number(a.at||0));

  changeHistoryEntries = normalizedHistory.slice();

  normalizedHistory.forEach(p => {

    if (DEBUG_HISTORY) console.debug(`[History] insert ${p.code}`);

    if (p && p.code) { historyCodesLocal.add(p.code); }

    if (historyList) {

      try {

        historyList.appendChild(createHistoryItem(p));

      } catch(e){ console.warn("history skip:", e); }

    }

  });

} else {

  changeHistoryEntries = [];

  if (DEBUG_HISTORY) console.debug("[History] none in state");

}



const mtlList = document.getElementById("missionTimelineItems");



if (mtlList) { mtlList.innerHTML = ""; }



  refreshAllAbbrevBadges();

       if (Array.isArray(state.missionTimeline)) {

      const sortedMTL = state.missionTimeline.slice().sort(compareTimelinePayloadDesc);

      const containerMTL = document.getElementById("missionTimelineItems");

      if (containerMTL) {

        sortedMTL.forEach(p => {

          try {

            containerMTL.appendChild(createTimelineItem(p));

          }

          catch(e){ console.warn("missionTimeline skip:", e); }

        });

        updateRepinTracker();

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

if (typeof state.callsign === "string") {

  callsign = state.callsign;

}

if (typeof state.missionNumber === "string") {

  missionNumber = state.missionNumber;

}

// reflect in the Mission Details tile in case columns haven't forced a refresh yet

if (state.callsign || state.missionNumber) {

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



    // Update history button states after all state has been applied

    if (typeof updateAllHistoryButtons === 'function') {

      updateAllHistoryButtons();

    }

  }



function gatherStateFromDOM(){

  const state = {

crewRoster: crewPosition ? [crewPosition] : [],

blockStartNum,

callsign,

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



const missionTimeline = Array.from(document.querySelectorAll("#missionTimelineItems .item"))

.map(it => {

  const payload = JSON.parse(it.dataset.payload || "{}");

  if (payload && typeof payload === "object") delete payload.positionFmt;

  return payload;

});

state.missionTimeline = missionTimeline;

// Change History (persist newest-first list)

const changeHistory = changeHistoryEntries.length

  ? changeHistoryEntries.map(cloneHistoryEntry)

  : Array.from(document.querySelectorAll("#historyItems .item"))

      .map(it => normalizeHistoryEntry(JSON.parse(it.dataset.payload || "{}")))

      .filter(Boolean);

state.changeHistory = changeHistory;



  return state;

}





  entryForm.addEventListener("submit", e=>{

  e.preventDefault();

  if(!entryFormDirty){
    return;
  }

  if(!Number.isInteger(blockStartNum) || !crewPosition){ alert("Set up mission first."); return; }

  const requiresSendFlow = (_changeMode === "correct" || _changeMode === "update");



  const columnName=$("#targetColumn").value;
  const usesPositionModes = POSITION_MODE_TYPES.has(columnName);

  const colEl=$$(`.column[data-column]`).find(c=> c.dataset.column===columnName);

  const prefix=colEl ? (colEl.dataset.letter || columnName[0]) : columnName[0];

  if(!validateBearingFieldForType(columnName)){
    return;
  }



  const t=$("#timeZuluInput").value.trim().replace(/\D/g,"").slice(0,4);

  if(t && (t.length!==4 || Number(t.slice(0,2))>23 || Number(t.slice(2,4))>59)){ alert("Time must be HHMM Zulu."); return; }



  const vesselType = $("#vesselType") ? $("#vesselType").value.trim() : "";
  const systemOrPlatform = $("#systemOrPlatform") ? $("#systemOrPlatform").value.trim() : "";
  const vesselName = $("#vesselName") ? $("#vesselName").value.trim() : "";
  const sensor = $("#sensor") ? $("#sensor").value.trim() : "";
  const echoPositionModeVal = document.getElementById("echoPositionMode")?.value || "latlon";
  let mmsi = digitsOnly($("#mmsi").value).slice(0,9);
  $("#mmsi").value = mmsi;
  const vesselFlag=$("#vesselFlag").value.trim();
  let imo = digitsOnly($("#imo").value).slice(0,7);
  $("#imo").value = imo;
  const tqVal = ($("#tq")?.value || "").trim();
  const amplificationVal = ($("#amplification")?.value || "").trim();
  const ivoVal = ($("#ivoDescription")?.value || "").trim();
  const majorAxisVal = ($("#majorAxis")?.value || "").trim();
  const minorAxisVal = ($("#minorAxis")?.value || "").trim();
  const orientationVal = ($("#orientation")?.value || "").trim();
  const bearingVal = ($("#bearing")?.value || "").trim();
  let ownshipPositVal = ($("#ownshipPosit")?.value || "").trim();

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
  const ownLatDegStr = digitsOnly($("#ownLatDeg")?.value || "");
  const ownLatMinStr = digitsOnly($("#ownLatMin")?.value || "");
  const ownLatSecStr = digitsOnly($("#ownLatSec")?.value || "");
  const ownLatDecSecStr = digitsOnly($("#ownLatDecSec")?.value || "");
  const ownLatHem = $("#ownLatHem")?.value || "N";
  const ownLonDegStr = digitsOnly($("#ownLonDeg")?.value || "");
  const ownLonMinStr = digitsOnly($("#ownLonMin")?.value || "");
  const ownLonSecStr = digitsOnly($("#ownLonSec")?.value || "");
  const ownLonDecSecStr = digitsOnly($("#ownLonDecSec")?.value || "");
  const ownLonHem = $("#ownLonHem")?.value || "E";

  const latDeg=Number(latDegStr), latMin=Number(latMinStr), latSec=Number(latSecStr);
  const lonDeg=Number(lonDegStr), lonMin=Number(lonMinStr), lonSec=Number(lonSecStr);

  const invalidLat = (latDegStr!="" || latMinStr!="" || latSecStr!="") &&
    (!Number.isFinite(latDeg)||latDeg<0||latDeg>90 ||
     !Number.isFinite(latMin)||latMin<0||latMin>=60 ||
     !Number.isFinite(latSec)||latSec<0||latSec>=60);
  const invalidLon = (lonDegStr!="" || lonMinStr!="" || lonSecStr!="") &&
    (!Number.isFinite(lonDeg)||lonDeg<0||lonDeg>180 ||
     !Number.isFinite(lonMin)||lonMin<0||lonMin>=60 ||
     !Number.isFinite(lonSec)||lonSec<0||lonSec>=60);
  if(invalidLat || invalidLon){
    alert("Check Position:\n- Lat: 0-90 deg, 0-59', 0-59.99\" \n- Lon: 0-180 deg, 0-59', 0-59.99\"");
    return;
  }
  const ownLatProvided = ownLatDegStr || ownLatMinStr || ownLatSecStr || ownLatDecSecStr;
  const ownLonProvided = ownLonDegStr || ownLonMinStr || ownLonSecStr || ownLonDecSecStr;
  if(usesPositionModes && echoPositionModeVal==="bearing" && (ownLatProvided || ownLonProvided)){
    const latStr = formatDmsString(ownLatDegStr, ownLatMinStr, ownLatSecStr, ownLatDecSecStr, ownLatHem);
    const lonStr = formatDmsString(ownLonDegStr, ownLonMinStr, ownLonSecStr, ownLonDecSecStr, ownLonHem);
    const parts = [];
    if (latStr) parts.push(latStr);
    if (lonStr) parts.push(lonStr);
    ownshipPositVal = parts.join(" / ").trim();
  }

  const courseRaw=$("#course").value.trim();

  let course=courseRaw;

  if(courseRaw){ const c=Number(courseRaw); if(!Number.isFinite(c)||c<0||c>359){ alert("Course 0-359."); return; } course=String(c); }



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

    const n = lowestAvailable(prefixFinal, columnName);

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

      code:finalCode, timeHHMM:t, systemOrPlatform, vesselType, vesselName, sensor, ...(usesPositionModes ? { positionMode: echoPositionModeVal } : {}),

      // Store both DMS pieces and legacy minute-fraction for existing renderers/exports

      latDeg:latDegStr, latMin:latMinStr, latSec:latSecStr, latDecSecStr:latDecSecStr, latDecMinStr:latDecMinStrCompat, latHem,
      lonDeg:lonDegStr, lonMin:lonMinStr, lonSec:lonSecStr, lonDecSecStr:lonDecSecStr, lonDecMinStr:lonDecMinStrCompat, lonHem,
      ownLatDeg:ownLatDegStr, ownLatMin:ownLatMinStr, ownLatSec:ownLatSecStr, ownLatDecSecStr, ownLatHem,
      ownLonDeg:ownLonDegStr, ownLonMin:ownLonMinStr, ownLonSec:ownLonSecStr, ownLonDecSecStr, ownLonHem,

      mmsi,

      vesselFlag,

      imo,

      tq: tqVal,

      majorAxis: majorAxisVal,

      minorAxis: minorAxisVal,

      orientation: orientationVal,

      amplification: amplificationVal,

      ivo: ivoVal,

      bearing: bearingVal,

      ownshipPosit: ownshipPositVal,

      course, speed:speedVal, trackNumber, minVesselLen, info,

      minotaurPaste,

      reported,

      createdBy: payloadBase.createdBy || crewPosition,

      createdAt: payloadBase.createdAt || now,

      lastModified: now

    };



    if(editingItem){

      updateItemElement(editingItem, payload);

      // Log history for edits (unless it's part of a correct/update flow)

      if (!_changeMode) {

        logChangeHistory("edit", finalCode, crewPosition || "", payload);

      }

    } else {

      const container=colEl.querySelector(".items");

      const el=createItemElement(payload,"active");

      container.appendChild(el);

      columnNextNumber[columnName]=Number(finalCode.replace(/^AIS|^[A-Za-z]/,"")) + 1;

    }



    changeTypeSendRequired = requiresSendFlow;

    closeForm({ preserveChangeMode: requiresSendFlow });

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

  // Helper function to check if history exists for a code

  function hasHistoryForCode(code){

    if (!code) return false;

    if (historyCodesLocal.has(code)) {

      if (DEBUG_HISTORY) console.debug(`[History] cache hit for ${code}`);

      return true;

    }

    const historyItems = document.querySelectorAll('#historyItems .item');

    const found = Array.from(historyItems).some(item => {

      try {

        const payload = JSON.parse(item.dataset.payload || "{}");

        return payload.code === code;

      } catch {

        return false;

      }

    });

    if (found) { historyCodesLocal.add(code); }

    if (DEBUG_HISTORY) console.debug(`[History] cache scan ${code} -> ${found}`);

    return found;

  }



  // Helper function to view history for a code - opens modal with version comparison

  function viewHistoryForCode(code){

    // Get current version of the TACREP

    const currentBadge = Array.from(

      document.querySelectorAll('.column[data-column]:not([data-column="Deleted"]):not([data-column="History"]):not([data-column="Correlations"]) .badge')

    ).find(b => (b.textContent || '').trim() === code);



    let currentVersion = null;

    if (currentBadge) {

      const item = currentBadge.closest('.item');

      if (item) {

        try {

          currentVersion = JSON.parse(item.dataset.payload || "{}");

        } catch {}

      }

    }



    // Get all history entries for this code

    const codeKey = String(code || "").trim().toUpperCase();

    const sourceHistory = changeHistoryEntries.length

      ? changeHistoryEntries

      : Array.from(document.querySelectorAll('#historyItems .item'))

          .map(item => {

            try {

              return normalizeHistoryEntry(JSON.parse(item.dataset.payload || "{}"));

            } catch {

              return null;

            }

          })

          .filter(Boolean);



    const historyVersions = sourceHistory

      .filter(entry => entry && entry.snapshot && String(entry.code || "").trim().toUpperCase() === codeKey)

      .map(cloneHistoryEntry);



    // Sort by timestamp (newest first)

    historyVersions.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));



    // Build versions array with current first, then history

    const allVersions = [];

    if (currentVersion) {

      allVersions.push({

        snapshot: currentVersion,

        isCurrent: true,

        timestamp: currentVersion.lastModified || Date.now(),

        by: currentVersion.createdBy || ""

      });

    }

    historyVersions.forEach(hv => {

      allVersions.push({

        snapshot: hv.snapshot,

        isCurrent: false,

        timestamp: hv.at,

        by: hv.by,

        kind: hv.kind

      });

    });



    // Display in modal

    showHistoryModal(code, allVersions);

  }



  // Helper to format field value for display

  function formatFieldValue(key, value){

    if (value === null || value === undefined || value === "") return "--";

    if (key === "timeHHMM") return `${value}Z`;

    if (key.includes("lat") || key.includes("lon")) {

      // Handle coordinate fields

      if (key.endsWith("Hem")) return value;

      return value;

    }

    if (key === "speed") return `${value} kts`;

    if (key === "course") return `${value}${DEG_SYM}`;

    if (key === "minVesselLen") return `${value} ft`;

    return String(value);

  }



  // Helper to compare two objects and return changed fields

  function getChangedFields(newer, older){

    const changed = new Set();

    const keysToCompare = ["timeHHMM", "vesselType", "vesselName", "sensor", "mmsi", "vesselFlag", "imo", "tq",
      "latDeg", "latMin", "latSec", "latDecSecStr", "latHem",
      "lonDeg", "lonMin", "lonSec", "lonDecSecStr", "lonHem", "course", "speed", "trackNumber", "minVesselLen", "info",
      "systemOrPlatform", "emitterName", "activityOrFunction", "frequency", "amplification", "ivo", "majorAxis",
      "minorAxis", "orientation", "bearing", "ownshipPosit"];



    keysToCompare.forEach(key => {

      const newerVal = newer[key];

      const olderVal = older ? older[key] : undefined;

      if (newerVal !== olderVal) {

        changed.add(key);

      }

    });



    return changed;

  }



  // Display history modal with version comparison

  function showHistoryModal(code, versions){

    const modal = document.getElementById("tacrepHistoryModal");

    const title = document.getElementById("tacrepHistoryTitle");

    const content = document.getElementById("tacrepHistoryContent");

    const closeBtn = document.getElementById("tacrepHistoryCloseBtn");



    if (!modal || !title || !content || !closeBtn) return;



    title.textContent = `History: ${code}`;

    content.innerHTML = "";



    if (versions.length === 0) {

      content.innerHTML = "<p style='text-align:center; color:#6c757d;'>No history found.</p>";

    } else {

      // Keep order: Current first, then history (newest to oldest)

      versions.forEach((ver, idx) => {

        // Compare with next version (older) to highlight what changed FROM that version

        const changedFields = idx < versions.length - 1 ? getChangedFields(ver.snapshot, versions[idx + 1].snapshot) : new Set();



        const versionEl = document.createElement("div");

        versionEl.className = "history-version";



        // Header

        const header = document.createElement("div");

        header.className = "history-version-header";



        const label = document.createElement("div");

        label.className = "history-version-label";



        // Calculate version number: Current on top, then history counting down

        // Total history items (excluding current)

        const historyCount = versions.filter(v => !v.isCurrent).length;

        let versionLabel;

        if (ver.isCurrent) {

          versionLabel = "Current Version";

        } else {

          // For history items: newest = highest number, oldest = 1

          // If current is at idx 0, first history is at idx 1

          const historyIdx = ver.isCurrent ? 0 : (idx - (versions[0].isCurrent ? 1 : 0));

          const versionNum = historyCount - historyIdx;

          versionLabel = `Version ${versionNum}${ver.kind ? ` (${ver.kind})` : ""}`;

        }

        label.textContent = versionLabel;



        const timestamp = document.createElement("div");

        timestamp.className = "history-version-timestamp";

        const date = new Date(ver.timestamp);

        timestamp.textContent = `${date.toLocaleDateString()} ${date.toLocaleTimeString()} by ${ver.by}`;



        header.appendChild(label);

        header.appendChild(timestamp);



        // Body - show all fields

        const body = document.createElement("div");

        body.className = "history-version-body";



        // Determine TACREP type from code to show appropriate fields

        const tacrepType = tacrepTypeFromCode(code);
        const fieldsToShow = HISTORY_FIELD_MAP[tacrepType] || HISTORY_FIELD_MAP.Other;



        fieldsToShow.forEach(field => {

          const fieldLabel = document.createElement("div");

          fieldLabel.className = "history-field-label";

          fieldLabel.textContent = `${field.label}:`;



          const fieldValue = document.createElement("div");
          fieldValue.className = "history-field-value";

          let value;

          if (field.custom && field.key === "position") {
            // Build position string with proper formatting
            const s = ver.snapshot;

            if (s.latDeg && s.lonDeg) {
              const latLabel = formatDmsString(s.latDeg, s.latMin, s.latSec, s.latDecSecStr, s.latHem);
              const lonLabel = formatDmsString(s.lonDeg, s.lonMin, s.lonSec, s.lonDecSecStr, s.lonHem);
              value = `${latLabel || "--"}, ${lonLabel || "--"}`;

              if (changedFields.has("latDeg") || changedFields.has("latMin") || changedFields.has("latSec") ||
                  changedFields.has("latDecSecStr") || changedFields.has("latHem") ||
                  changedFields.has("lonDeg") || changedFields.has("lonMin") || changedFields.has("lonSec") ||
                  changedFields.has("lonDecSecStr") || changedFields.has("lonHem")) {
                fieldValue.classList.add("history-field-changed");
              }
            } else {
              value = "--";
            }

          } else {

            value = formatFieldValue(field.key, ver.snapshot[field.key]);

            if (changedFields.has(field.key)) {

              fieldValue.classList.add("history-field-changed");

            }

          }



          fieldValue.textContent = value;



          body.appendChild(fieldLabel);

          body.appendChild(fieldValue);

        });



        versionEl.appendChild(header);

        versionEl.appendChild(body);

        content.appendChild(versionEl);



        // Add separator between versions (except after last)

        if (idx < versions.length - 1) {

          const separator = document.createElement("div");

          separator.className = "history-separator";

          separator.textContent = "? Changes from older version highlighted above";

          content.appendChild(separator);

        }

      });

    }



    closeBtn.onclick = () => closeModal(modal);

    openModal(modal);

  }



  // Function to update all history button states

  function updateAllHistoryButtons(){

    if (DEBUG_HISTORY) console.debug("[History] updating button states");

    const allItems = document.querySelectorAll('.column[data-column]:not([data-column="History"]) .item');

    if (DEBUG_HISTORY) console.debug(`[History] scanning ${allItems.length} TACREPs`);

    allItems.forEach(item => {

      try {

        const payload = JSON.parse(item.dataset.payload || "{}");

        const historyBtn = item.querySelector('.icon-history');

        if (historyBtn && payload.code) {

          const hasHistory = hasHistoryForCode(payload.code);

          historyBtn.disabled = !hasHistory;

          if (DEBUG_HISTORY) console.debug(`[History] button ${payload.code} disabled=${!hasHistory}`);

        }

      } catch {}

    });

  }

  function applyReportedStatusEl(el, reported){
    if (!el) return;
    el.textContent = reported ? "REPORTED" : "UNREPORTED";
    el.classList.toggle("reported", !!reported);
  }

  function createItemElement(data, context="active"){

    const { code }=data;

    const item=document.createElement("div");

    item.className="item selectable";

    item.dataset.payload=JSON.stringify(data);



    const header=document.createElement("div"); header.className="item-header";

    const badgeWrap=document.createElement("div"); badgeWrap.className="badge-wrap";

    const pm=document.createElement("span"); pm.className="pm"; pm.textContent="+";

    const badgeStack=document.createElement("div"); badgeStack.className="badge-stack";
    const badge=document.createElement("div"); badge.className="badge"; badge.textContent=code; badge.dataset.code=code; badge.tabIndex=0;
    const statusLabel=document.createElement("span"); statusLabel.className="reported-pill";

    badgeWrap.appendChild(pm);
    badgeWrap.appendChild(badgeStack);
    badgeStack.appendChild(statusLabel);
    badgeStack.appendChild(badge);
    applyReportedStatusEl(statusLabel, data.reported);



    const creator=document.createElement("span"); creator.className="creator";

    item._renderAbbrev=()=>{ creator.textContent=renderCreatorAndAbbrev(JSON.parse(item.dataset.payload)); };



    const actions=document.createElement("div"); actions.className="item-actions";

    const historyBtn=document.createElement("button"); historyBtn.type="button"; historyBtn.className="icon-btn icon-history"; historyBtn.innerHTML = "<span aria-hidden=\"true\">\u23F2\uFE0E</span>"; historyBtn.setAttribute("aria-label","View History"); historyBtn.title="View History";

    const editBtn=document.createElement("button"); editBtn.type="button"; editBtn.className="icon-btn icon-edit"; editBtn.innerHTML=ICON_PENCIL; editBtn.title="Edit";

    const delBtn=document.createElement("button"); delBtn.type="button"; delBtn.className="icon-btn icon-delete"; delBtn.innerHTML=ICON_X; delBtn.title="Move to Deleted";

    const restoreBtn=document.createElement("button"); restoreBtn.type="button"; restoreBtn.className="icon-btn icon-restore"; restoreBtn.innerHTML=ICON_RESTORE; restoreBtn.title="Restore";



    // Check if history exists for this code and update button state

    const hasHistory = hasHistoryForCode(code);

    historyBtn.disabled = !hasHistory;



    if(context==="deleted"){

      actions.appendChild(historyBtn);

      actions.appendChild(restoreBtn);

    } else {

      actions.appendChild(historyBtn);

      actions.appendChild(editBtn);

      actions.appendChild(delBtn);

    }



    header.appendChild(badgeWrap); header.appendChild(creator); header.appendChild(actions);



    const details=document.createElement("div"); details.className="item-details";

    fillDetails(details,data,code);



    item.appendChild(header); item.appendChild(details);
    item._reportedStatusEl = statusLabel;

    item._renderAbbrev();



    function handleToggle(){ if(selecting) return; toggleExpandItem(item); }

    badge.addEventListener("click", handleToggle);

    pm.addEventListener("click", handleToggle);

    item.addEventListener("click",(e)=>{ if(!selecting) return; if(e.target.closest('.item-actions')) return; toggleSelectForCorrelation(item); });



    badge.addEventListener("keydown", e=>{ if(selecting){ e.preventDefault(); toggleSelectForCorrelation(item); return; } if(e.key==="Enter"||e.key===" "){ e.preventDefault(); toggleExpandItem(item); } });



    historyBtn.addEventListener("click",(e)=>{ e.stopPropagation(); if(!historyBtn.disabled){ viewHistoryForCode(code); } });



    editBtn.addEventListener("click",(e)=>{ e.stopPropagation(); const payload=JSON.parse(item.dataset.payload); const column=inferOriginFromCode(payload.code); openForm(column,payload); $("#codeEditRow").style.display="flex"; const prefix=payload.code.startsWith("AIS")?"AIS":payload.code[0].toUpperCase(); const num=payload.code.replace(/^AIS|^[A-Za-z]/,""); $("#codePrefix").value=prefix; $("#codeNumber").value=num; editingItem=item; });



    delBtn.addEventListener("click",(e)=>{ e.stopPropagation(); openConfirm(`Move TACREP ${escapeHtml(code)} to Deleted?`, ()=>{ moveItemToDeleted(item); dirty=true; requestAutoSyncSave(true); recomputeHighlights(); }); });



    restoreBtn.addEventListener("click",(e)=>{ e.stopPropagation(); openConfirm(`Restore TACREP ${escapeHtml(code)}?`, ()=>{ restoreItemFromDeleted(item); dirty=true; requestAutoSyncSave(true); recomputeHighlights(); }); });



    return item;

  }



  function updateItemElement(item,data){

    item.dataset.payload=JSON.stringify(data);

    const badgeEl=item.querySelector(".badge");

    if(badgeEl){ badgeEl.textContent=data.code; badgeEl.dataset.code=data.code; }

    item._renderAbbrev && item._renderAbbrev();
    applyReportedStatusEl(item._reportedStatusEl, data.reported);

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

      if(p.vesselName) parts.push(`Name: ${p.vesselName}`);

      if(p.mmsi) parts.push(`MMSI: ${p.mmsi}`);

      if(p.vesselFlag) parts.push(`Flag: ${p.vesselFlag}`);

      if(p.imo) parts.push(`IMO: ${p.imo}`);

      if(p.sensor) parts.push(`Sensor: ${p.sensor}`);

      if(p.tq) parts.push(`TQ: ${p.tq}`);

      if(p.majorAxis) parts.push(`Major Axis: ${p.majorAxis}`);

      if(p.minorAxis) parts.push(`Minor Axis: ${p.minorAxis}`);

      if(p.orientation) parts.push(`Orientation: ${p.orientation}`);

      if(p.amplification) parts.push(`Amplification: ${p.amplification}`);

      if(p.ivo) parts.push(`IVO: ${p.ivo}`);

      if(p.bearing) parts.push(`Bearing: ${p.bearing}`);

      if(p.ownshipPosit) parts.push(`Ownship Posit: ${p.ownshipPosit}`);

      const posStr=buildPosDisplay(p); if(posStr) parts.push(`Pos: ${posStr}`);

      if(p.course) parts.push(`Course: ${p.course}`);

      if(p.speed!==null && p.speed!=="") parts.push(`Speed: ${p.speed} kts`);

      if(p.trackNumber) parts.push(`Track: ${p.trackNumber}`);

      if(p.minVesselLen) parts.push(`MinLen: ${p.minVesselLen} ft`);

      if(p.info) parts.push(`Info: ${p.info}`);

      if(p.type === "REPIN" && p.associatedFault) parts.push(`Associated Fault: ${p.associatedFault}`);

      const text=parts.join(" / ");

      try{ await navigator.clipboard.writeText(text); copyBtn.textContent="Copied!"; copyBtn.classList.add("copied"); setTimeout(()=>{ copyBtn.textContent="Copy"; copyBtn.classList.remove("copied"); },1200); }catch{ alert("Copy failed."); }

    });



    const rows=[];

    const firstRow=document.createElement("span"); firstRow.className="detail";

    firstRow.appendChild(copyBtn);

    if(p.timeHHMM) firstRow.insertAdjacentHTML("beforeend", ` <em>Time:</em> ${escapeHtml(p.timeHHMM)}Z`);

    if(p.vesselType) rows.push(`<span class="detail"><em>Vessel:</em> ${escapeHtml(p.vesselType)}</span>`);

    if(p.vesselName) rows.push(`<span class="detail"><em>Name:</em> ${escapeHtml(p.vesselName)}</span>`);

    if(p.mmsi) rows.push(`<span class="detail"><em>MMSI:</em> ${escapeHtml(p.mmsi)}</span>`);

    if(p.vesselFlag) rows.push(`<span class="detail"><em>Flag:</em> ${escapeHtml(p.vesselFlag)}</span>`);

    if(p.imo) rows.push(`<span class="detail"><em>IMO:</em> ${escapeHtml(p.imo)}</span>`);

    if(p.sensor) rows.push(`<span class="detail"><em>Sensor:</em> ${escapeHtml(p.sensor)}</span>`);

    if(p.tq) rows.push(`<span class="detail"><em>TQ:</em> ${escapeHtml(p.tq)}</span>`);

    if(p.majorAxis) rows.push(`<span class="detail"><em>Major Axis:</em> ${escapeHtml(p.majorAxis)}</span>`);

    if(p.minorAxis) rows.push(`<span class="detail"><em>Minor Axis:</em> ${escapeHtml(p.minorAxis)}</span>`);

    if(p.orientation) rows.push(`<span class="detail"><em>Orientation:</em> ${escapeHtml(p.orientation)}</span>`);

    if(p.amplification) rows.push(`<span class="detail"><em>Amplification:</em> ${escapeHtml(p.amplification)}</span>`);

    if(p.ivo) rows.push(`<span class="detail"><em>IVO:</em> ${escapeHtml(p.ivo)}</span>`);

    if(p.bearing) rows.push(`<span class="detail"><em>Bearing:</em> ${escapeHtml(p.bearing)}</span>`);

    if(p.ownshipPosit) rows.push(`<span class="detail"><em>Ownship Posit:</em> ${escapeHtml(p.ownshipPosit)}</span>`);

    const posStr=buildPosDisplay(p);

    if(posStr) rows.push(`<span class="detail"><em>Pos:</em> ${escapeHtml(posStr)}</span>`);

    if(p.course) rows.push(`<span class="detail"><em>Course:</em> ${escapeHtml(p.course)}</span>`);

    if(p.speed!==null && p.speed!=="") rows.push(`<span class="detail"><em>Speed:</em> ${escapeHtml(String(p.speed))} kts</span>`);

    if(p.trackNumber) rows.push(`<span class="detail"><em>Track:</em> ${escapeHtml(p.trackNumber)}</span>`);

    if(p.minVesselLen) rows.push(`<span class="detail"><em>MinLen:</em> ${escapeHtml(p.minVesselLen)} ft</span>`);

      if(p.info) rows.push(`<span class="detail"><em>Info:</em> ${escapeHtml(p.info)}</span>`);

      if (p.type === "REPIN" && p.associatedFault) rows.push(`<span class="detail"><em>Associated Fault:</em> ${escapeHtml(p.associatedFault)}</span>`);



    container.appendChild(firstRow);

    rows.forEach(html=> container.insertAdjacentHTML("beforeend", html));

  }





function toggleExpandItem(el){

  el.classList.toggle("expanded");

  const pm=el.querySelector(".pm");

  if(pm) pm.textContent=el.classList.contains("expanded")?"-":"+";

}



// ?? Add this here, inside the IIFE

  // Timeline items (Mission Timeline)

window._editingTimelineItem = null;

  

window._timelineEntryType = "ONSTA";

window._editingTimelineFaultItem = null;

window._editingTimelineRepinItem = null;



function updateTimelineItemLegacy(item, p){

  updateTimelineItem(item, p);

}



function timelineSortKey(payload){

  const timeDigits = String(payload?.timeHHMM || "").replace(/\D/g,"");

  const timeVal = (timeDigits.length === 4) ? Number(timeDigits) : -1;

  const time = Number.isFinite(timeVal) ? timeVal : -1;

  const createdRaw = Number(payload?.createdAt || 0);

  const created = Number.isFinite(createdRaw) ? createdRaw : 0;

  return { time, created };

}



function compareTimelinePayloadDesc(a, b){

  const ka = timelineSortKey(a);

  const kb = timelineSortKey(b);

  if (ka.time !== kb.time) return kb.time - ka.time;

  if (ka.created !== kb.created) return kb.created - ka.created;

  return 0;

}



function insertTimelineItemSorted(list, item){

  if (!list || !item) return;

  let payload;

  try { payload = JSON.parse(item.dataset.payload || "{}"); }

  catch { payload = {}; }



  const children = Array.from(list.children);

  for (const existing of children){

    let existingPayload;

    try { existingPayload = JSON.parse(existing.dataset.payload || "{}"); }

    catch { existingPayload = {}; }



    if (compareTimelinePayloadDesc(payload, existingPayload) < 0){

      list.insertBefore(item, existing);

      return;

    }

  }

  list.appendChild(item);

}



function repositionTimelineItem(item){

  if (!item) return;

  const parent = item.parentElement;

  if (!parent) return;

  parent.removeChild(item);

  insertTimelineItemSorted(parent, item);

}



function updateTimelineItem(item, payload){

  if (!item) return;

  let prevPayload;

  try { prevPayload = JSON.parse(item.dataset.payload || "{}"); }

  catch { prevPayload = {}; }



  const next = { ...(payload || {}) };

  const formattedPos = formatPositionFromPayload(next);

  if (formattedPos) next.positionFmt = formattedPos;

  else delete next.positionFmt;

  item.dataset.payload = JSON.stringify(next);



  const badgeWrap = item.querySelector(".item-header .badge-wrap");

  const pm = badgeWrap ? badgeWrap.querySelector(".pm") : null;

  const timeBadge = badgeWrap ? badgeWrap.querySelector(".badge-time") : null;

  const typeBadge = badgeWrap ? badgeWrap.querySelector(".badge-type") : null;

  const faultBadge = badgeWrap ? badgeWrap.querySelector(".badge-fault") : null;

  if (timeBadge) timeBadge.textContent = (next.timeHHMM ? `${next.timeHHMM}Z` : "-");

  if (typeBadge) typeBadge.textContent = (next.type || "-");

  if (faultBadge) {

    if (next.type === "FAULT" && (next.fault || next.fault === "")) {

      faultBadge.textContent = next.fault ? String(next.fault) : "(No fault code)";

      faultBadge.style.display = "";

    } else if (next.type === "REPIN") {

      faultBadge.textContent = next.associatedFault ? String(next.associatedFault) : "(No associated fault)";

      faultBadge.style.display = "";

    } else {

      faultBadge.style.display = "none";

      faultBadge.textContent = "";

    }

  }



  const creator = item.querySelector(".creator");

  if (creator) {

    const when = isValidDate(new Date(next.createdAt))

      ? `${fmtDateNoYearUTC(new Date(next.createdAt))} ${fmtTimeUTC(new Date(next.createdAt))}`

      : "";

    const by = next.createdBy || "";

    creator.textContent = [by, when].filter(Boolean).join(" | ");

  }



  const details = item.querySelector(".item-details");

  details.innerHTML = "";



  const copyBtn = document.createElement("button");

  copyBtn.type = "button";

  copyBtn.className = "copy-pill";

  copyBtn.textContent = "Copy";

  copyBtn.addEventListener("click", async (e)=>{

    e.stopPropagation();

    const parts = [];

    if (next.timeHHMM) parts.push(`Time: ${next.timeHHMM}Z`);

    if (next.type === "OFFDECK" && next.airfield) {

      parts.push(`Airfield: ${next.airfield}`);

    } else if (next.type === "ONSTA" || next.type === "OFFSTA") {

      const posStr = buildPosDisplay(next);

      if (posStr) parts.push(`Pos: ${posStr}`);

      if (next.altitude) parts.push(`Alt: ${next.altitude}`);

    } else if (next.type === "MISSIONLOG" && next.comments) {

      parts.push(`Comments: ${next.comments}`);

    } else if (next.type === "FAULT") {

      if (next.fault) parts.push(`Fault: ${next.fault}`);

      if (next.comments) parts.push(`Comments: ${next.comments}`);

    } else if (next.type === "REPIN") {

      if (next.associatedFault) parts.push(`Associated Fault: ${next.associatedFault}`);

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



  if (next.type === "OFFDECK" && next.airfield) {

    details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Airfield:</em> ${escapeHtml(next.airfield)}</span>`);

  } else if (next.type === "ONSTA" || next.type === "OFFSTA") {

    const posStr = buildPosDisplay(next);

    if (posStr) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Pos:</em> ${escapeHtml(posStr)}</span>`);

    if (next.altitude) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Alt:</em> ${escapeHtml(String(next.altitude))}</span>`);

  } else if (next.type === "MISSIONLOG") {

    if (next.comments) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(next.comments)}</span>`);

  } else if (next.type === "FAULT") {

    if (next.comments) {

      details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Comments:</em> ${escapeHtml(next.comments)}</span>`);

    }

  } else if (next.type === "REPIN") {

    if (next.associatedFault) details.insertAdjacentHTML("beforeend", `<span class="detail"><em>Associated Fault:</em> ${escapeHtml(next.associatedFault)}</span>`);

  }



  if (pm) pm.textContent = item.classList.contains("expanded") ? "?^'" : "+";



  updateRepinTracker();



  if (compareTimelinePayloadDesc(next, prevPayload) !== 0){

    repositionTimelineItem(item);

  }

}

function createTimelineItem(p){

  const item = document.createElement("div");

  const formattedPos = formatPositionFromPayload(p);

  if (formattedPos) p.positionFmt = formattedPos;

  else delete p.positionFmt;

  item.className = "item";

  item.dataset.payload = JSON.stringify(p);

    item._kind = (

  p.type === "OFFDECK"    ? "TIMELINE_OFFDECK" :

  p.type === "ONDECK"     ? "TIMELINE_ONDECK"  :

  p.type === "ONSTA"      ? "TIMELINE_ONSTA"   :

  p.type === "OFFSTA"     ? "TIMELINE_OFFSTA"  :

  p.type === "MISSIONLOG" ? "TIMELINE_MISSIONLOG" :

  p.type === "FAULT"      ? "TIMELINE_FAULT" :

  p.type === "REPIN"      ? "TIMELINE_REPIN" :

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

  timeBadge.className = "badge badge-time";

  timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "-");



  const typeBadge = document.createElement("div");

  typeBadge.className = "badge badge-type";

  typeBadge.textContent = (p.type || "-");



  const faultBadge = document.createElement("div");

  faultBadge.className = "badge badge-fault";

  faultBadge.style.display = "none";



  badgeWrap.appendChild(pm);

  badgeWrap.appendChild(timeBadge);

  badgeWrap.appendChild(typeBadge);

  badgeWrap.appendChild(faultBadge);



  const creator = document.createElement("span");

  creator.className = "creator";



  const actions = document.createElement("div");

  actions.className = "item-actions";



  const editBtn = document.createElement("button");

  editBtn.type = "button";

  editBtn.className = "icon-btn icon-edit";

  editBtn.innerHTML = ICON_PENCIL;

  editBtn.title = "Edit";



  const delBtn = document.createElement("button");

  delBtn.type = "button";

  delBtn.className = "icon-btn icon-delete";

  delBtn.innerHTML = ICON_X;

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

  [pm, timeBadge, typeBadge, faultBadge].forEach(b => {

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

} else if (payload.type === "MISSIONLOG") {

  // Prefill Mission Log modal for editing

  document.getElementById("mlTime").value = payload.timeHHMM || "";

  document.getElementById("mlComments").value = payload.comments || "";

  window._editingMissionLogItem = item;

  openModal(document.getElementById("missionLogModal"));

} else if (payload.type === "FAULT") {

  document.getElementById("tfTime").value = payload.timeHHMM || "";

  document.getElementById("tfCode").value = payload.fault || "";

  document.getElementById("tfComments").value = payload.comments || "";

  window._editingTimelineFaultItem = item;

  openModal(document.getElementById("timelineFaultModal"));

} else if (payload.type === "REPIN") {

  document.getElementById("repinTime").value = payload.timeHHMM || "";

  document.getElementById("repinFault").value = payload.associatedFault || "";

  window._editingTimelineRepinItem = item;

  openModal(document.getElementById("repinModal"));

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

      updateRepinTracker();

    });

  });



  updateTimelineItem(item, p);

  updateRepinTracker();

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

timeBadge.textContent = (p.timeHHMM ? `${p.timeHHMM}Z` : "--");





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



creator.textContent = [by, when].filter(Boolean).join(" | ");



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



// ---- Delete/Restore ----

function moveItemToDeleted(itemEl){

  const payload = JSON.parse(itemEl.dataset.payload);

  const originalCode = payload.code;

  const now = Date.now();



  // Determine prefix and rename to <LETTER>XXX (AIS ? AISXXX)

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
  if(origin){
    syncColumnNextNumber(origin);
  }
  usedNumberCache.clear();



  // Trim correlations that reference the original code

  Array.from(document.querySelectorAll("#correlationItems .item")).forEach(card=>{

    const badges=Array.from(card.querySelectorAll(".badge[data-code]"));

    const codes=badges.map(b=>b.dataset.code);

    if(!codes.includes(originalCode)) return;

    if(codes.length<=2){ card.remove(); return; }

   badges.forEach(b=>{ if(b.dataset.code===originalCode) b.remove(); });

const left = codes.filter(c=> c !== originalCode);

card.dataset.codes = left.join("|");



// NEW: keep the card's UI consistent

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

  const existingMax = getColumnMaxNumber(destColName);
  const baseNumber = Number.isInteger(blockStartNum) && blockStartNum > 0 ? blockStartNum : 1;
  const n = Number.isInteger(existingMax) ? existingMax + 1 : baseNumber;



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

  syncColumnNextNumber(destColName);

  usedNumberCache.clear();
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
  const owner = card.dataset.lastBy || card.dataset.createdBy || "--";
  const meta = `${owner} - ${fmtDateNoYearUTC(d)} ${fmtTimeUTC(d)}`;
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



    // If card is in remove mode, show little "Ãâ" control (managed by card._removeMode)

    if(card._removeMode){

      const x=document.createElement("button");
      x.type="button";
      x.className="icon-btn icon-delete";
      x.innerHTML=ICON_X;
      x.title="Remove from correlation";
      x.style.marginLeft="4px";
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

    if(card._removeBtn) card._removeBtn.textContent = "- Remove";

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

  const delBtn=document.createElement("button"); delBtn.type="button"; delBtn.className="icon-btn icon-delete"; delBtn.innerHTML=ICON_X; delBtn.title="Delete correlation";

  delBtn.addEventListener("click", ()=>{ openConfirm("Delete this correlation?", ()=>{ card.remove(); dirty=true; requestAutoSyncSave(); }); });



  // NEW: Add / Remove controls

  const addBtn=document.createElement("button"); addBtn.type="button"; addBtn.className="icon-btn icon-edit"; addBtn.textContent="+ Add"; addBtn.title="Add TACREPs";

  addBtn.addEventListener("click", (e)=>{

    e.stopPropagation();

    setSelectMode(true, "add", card);

  });



  const removeBtn=document.createElement("button"); removeBtn.type="button"; removeBtn.className="icon-btn icon-delete"; removeBtn.textContent="- Remove"; removeBtn.title="Remove TACREPs";

  removeBtn.addEventListener("click", (e)=>{

    e.stopPropagation();

    // Toggle remove mode (only meaningful when 3+)

    const codesNow = currentCodesFromCard(card);

    if(codesNow.length<3){ showBanner("Need 3+ to enable remove."); return; }

    card._removeMode = !card._removeMode;

    removeBtn.textContent = card._removeMode ? "Done" : "- Remove";

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

    const ensureObj = obj=>{
      const out = {};
      if(obj && typeof obj === "object"){
        Object.entries(obj).forEach(([key,val])=>{
          if(Array.isArray(val)){
            out[key] = val.filter(x=>ALLOWED_ABBREV_SET.has(x)).slice(0, ABBREV_MAX);
          }
        });
      }
      return out;
    };

    try{
      const raw = localStorage.getItem(ABBREV_STORAGE_KEY);
      if(raw){
        return ensureObj(JSON.parse(raw));
      }
      const legacy = localStorage.getItem("wf_abbrev_prefs");
      if(legacy){
        const arr = JSON.parse(legacy);
        if(Array.isArray(arr)){
          const sanitized = arr.filter(x=>ALLOWED_ABBREV_SET.has(x)).slice(0,ABBREV_MAX);
          const map = {};
          Object.keys(DEFAULT_ABBREV_BY_TYPE).forEach(type=> map[type]=sanitized.slice());
          localStorage.removeItem("wf_abbrev_prefs");
          return map;
        }
      }
    }catch{}

    return {};

  }

  function saveAbbrevPrefs(){
    try{
      localStorage.setItem(ABBREV_STORAGE_KEY, JSON.stringify(abbrevPrefsStore));
    }catch{}
  }

  function getAbbrevPrefsForType(type){
    const key = normalizeAbbrevTypeKey(type);
    const stored = abbrevPrefsStore[key];
    if(Array.isArray(stored) && stored.length){
      return stored.filter(x=>ALLOWED_ABBREV_SET.has(x)).slice(0, ABBREV_MAX);
    }
    return [...(DEFAULT_ABBREV_BY_TYPE[key] || DEFAULT_ABBREV_FALLBACK)].slice(0, ABBREV_MAX);
  }

  function getActiveAbbrevPrefs(){
    return getAbbrevPrefsForType(currentAbbrevType);
  }

  function setActiveAbbrevPrefs(list){
    const key = normalizeAbbrevTypeKey(currentAbbrevType);
    abbrevPrefsStore[key] = list.slice(0, ABBREV_MAX);
    saveAbbrevPrefs();
  }

  function refreshAbbrevCheckboxesInModal(){
    const prefs = getActiveAbbrevPrefs();
    $$(".abbrChk").forEach(chk=>{
      chk.checked=prefs.includes(chk.dataset.field);
    });
  }

  function setAbbrev(field,on,{silent=false}={}){

    const normalized = normalizeAbbrevKey(field);
    if(!ALLOWED_ABBREV_SET.has(normalized)) return false;

    let prefs = getActiveAbbrevPrefs();
    const has=prefs.includes(normalized);
    let changed=false;

    if(on && !has){

      if(prefs.length>=ABBREV_MAX){
        if(!silent){
          alert(`You can select up to ${ABBREV_MAX} abbreviation fields.`);
        }
        refreshAbbrevCheckboxesInModal();
        return false;
      }

      prefs=prefs.concat([normalized]);
      changed=true;

    } else if(!on && has){

      prefs=prefs.filter(f=>f!==normalized);
      changed=true;

    }

    if(!changed) return true;

    prefs=prefs.filter(x=>ALLOWED_ABBREV_SET.has(x));

    setActiveAbbrevPrefs(prefs);
    refreshAbbrevCheckboxesInModal();
    refreshAllAbbrevBadges();
    return true;

  }

  function normalizeAbbrevKey(fieldKey){
    return ABBREV_FIELD_ALIAS[fieldKey] || fieldKey;
  }

  function enforceAbbrevVisibility(fieldKey, visible){
    if(visible) return;
    const mapped = normalizeAbbrevKey(fieldKey);
    if(ALLOWED_ABBREV_SET.has(mapped)){
      setAbbrev(mapped,false,{silent:true});
    }
  }

  function refreshAllAbbrevBadges(){ $$(".column .item").forEach(it=>{ if(typeof it._renderAbbrev==="function") it._renderAbbrev(); }); }



  function computeDecimalMinutes(minStr, decMinStr, secStr, decSecStr){

    const minDigits = digitsOnly(minStr);

    if (minDigits === "") return null;

    let base = Number(minDigits);

    if (!Number.isFinite(base)) base = 0;



    let fraction = null;



    const decMinDigits = digitsOnly(decMinStr || "");

    if (decMinDigits) {

      fraction = Number(`0.${decMinDigits}`);

    } else {

      const secDigits = digitsOnly(secStr || "");

      if (secDigits) {

        let seconds = Number(secDigits);

        if (!Number.isFinite(seconds)) seconds = 0;

        const decSecDigits = digitsOnly(decSecStr || "");

        if (decSecDigits) {

          const decSec = Number(`0.${decSecDigits}`);

          if (Number.isFinite(decSec)) seconds += decSec;

        }

        fraction = seconds / 60;

      }

    }



    const total = base + (fraction ?? 0);

    if (!Number.isFinite(total)) return null;

    return Number(total.toFixed(3));

  }



  const DEG_SYM = "\u00B0";

  const PRIME = "'";

  const DOUBLE_PRIME = '"';

  const POSITION_LAT_BANDS = "CDEFGHJKLMNPQRSTUVWX";

  const E100K_LETTERS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];

  const N100K_LETTERS = ["ABCDEFGHJKLMNPQRSTUV", "FGHJKLMNPQRSTUVABCDE"];



  function getDecimalDegreesFromParts(degStr, minStr, decMinStr, secStr, decSecStr, hem){

    const degDigits = digitsOnly(degStr);

    if (degDigits === "") return null;

    const deg = Number(degDigits);

    if (!Number.isFinite(deg)) return null;

    let minutes = computeDecimalMinutes(minStr, decMinStr, secStr, decSecStr);

    if (minutes === null) minutes = 0;

    let decimal = deg + (minutes / 60);

    const hemisphere = String(hem || "").trim().toUpperCase();

    if (hemisphere === "S" || hemisphere === "W") decimal *= -1;

    return decimal;

  }



  function getDecimalLatLon(p){

    const lat = getDecimalDegreesFromParts(p.latDeg, p.latMin, p.latDecMinStr, p.latSec, p.latDecSecStr, p.latHem);

    const lon = getDecimalDegreesFromParts(p.lonDeg, p.lonMin, p.lonDecMinStr, p.lonSec, p.lonDecSecStr, p.lonHem);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { lat, lon };

  }



  function hemisphereLetter(value, isLat){

    if (isLat) return value >= 0 ? "N" : "S";

    return value >= 0 ? "E" : "W";

  }



  function formatDMSComponent(value, isLat){

    const abs = Math.abs(value);

    let deg = Math.floor(abs);

    let minutesFloat = (abs - deg) * 60;

    let minutes = Math.floor(minutesFloat);

    let seconds = Math.round((minutesFloat - minutes) * 60);

    if (seconds === 60) {

      seconds = 0;

      minutes += 1;

    }

    if (minutes === 60) {

      minutes = 0;

      deg += 1;

    }

    const padDeg = isLat ? 2 : 3;

    return `${String(deg).padStart(padDeg, "0")}${DEG_SYM} ${String(minutes).padStart(2,"0")}${PRIME} ${String(seconds).padStart(2,"0")}${DOUBLE_PRIME} ${hemisphereLetter(value, isLat)}`;

  }



  function formatDMmComponent(value, isLat){

    const abs = Math.abs(value);

    const deg = Math.floor(abs);

    const minutes = (abs - deg) * 60;

    const padDeg = isLat ? 2 : 3;

    return `${String(deg).padStart(padDeg, "0")}${DEG_SYM} ${minutes.toFixed(3).padStart(6,"0")}${PRIME} ${hemisphereLetter(value, isLat)}`;

  }



  function formatDecimalComponent(value, isLat){

    const abs = Math.abs(value);

    return `${abs.toFixed(6)}${DEG_SYM} ${hemisphereLetter(value, isLat)}`;

  }



  function formatDMmFromPartsSingle(degStr, minStr, decMinStr, secStr, decSecStr, hem, isLat){

    const degDigits = digitsOnly(degStr);

    if (degDigits === "") return "";

    const degVal = Number(degDigits);

    if (!Number.isFinite(degVal)) return "";

    let minutes = computeDecimalMinutes(minStr, decMinStr, secStr, decSecStr);

    if (minutes === null) minutes = 0;

    const padDeg = isLat ? 2 : 3;

    const hemi = String(hem || "").trim().toUpperCase() || (isLat ? "N" : "E");

    return `${String(Math.trunc(degVal)).padStart(padDeg, "0")}${DEG_SYM} ${minutes.toFixed(3)}${PRIME} ${hemi}`;

  }



  function formatDMmFromPartsFallback(p){

    const lat = formatDMmFromPartsSingle(p.latDeg, p.latMin, p.latDecMinStr, p.latSec, p.latDecSecStr, p.latHem, true);

    const lon = formatDMmFromPartsSingle(p.lonDeg, p.lonMin, p.lonDecMinStr, p.lonSec, p.lonDecSecStr, p.lonHem, false);

    return (lat && lon) ? `${lat}, ${lon}` : "";

  }



  function formatDMmPair(lat, lon){

    return `${formatDMmComponent(lat, true)}, ${formatDMmComponent(lon, false)}`;

  }



  function formatDmsPair(lat, lon){

    return `${formatDMSComponent(lat, true)}, ${formatDMSComponent(lon, false)}`;

  }



  function formatDecimalPair(lat, lon){

    return `${formatDecimalComponent(lat, true)}, ${formatDecimalComponent(lon, false)}`;

  }



  function getZoneLetter(lat){

    if (lat > 84 || lat < -80) return null;

    const index = Math.floor((lat + 80) / 8);

    return POSITION_LAT_BANDS[Math.min(Math.max(index, 0), POSITION_LAT_BANDS.length - 1)];

  }



  function adjustZoneNumber(lat, lon, zoneNumber){

    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;

    if (lat >= 72 && lat < 84) {

      if      (lon >= 0  && lon < 9 ) return 31;

      else if (lon >= 9  && lon < 21) return 33;

      else if (lon >= 21 && lon < 33) return 35;

      else if (lon >= 33 && lon < 42) return 37;

    }

    return zoneNumber;

  }



  function get100kSetForZone(zoneNumber){

    let set = zoneNumber % 6;

    if (set === 0) set = 6;

    return set;

  }



  function getEasting100kLetter(set, column){

    const letters = E100K_LETTERS[(set - 1) % 3];

    const index = (column - 1) % letters.length;

    return letters.charAt(index);

  }



  function getNorthing100kLetter(set, row){

    const letters = N100K_LETTERS[(set - 1) % 2];

    const index = row % letters.length;

    return letters.charAt(index);

  }



  function getMinNorthing(zoneLetter){

    switch(zoneLetter){

      case "C": return 1100000;

      case "D": return 2000000;

      case "E": return 2800000;

      case "F": return 3700000;

      case "G": return 4600000;

      case "H": return 5500000;

      case "J": return 6400000;

      case "K": return 7300000;

      case "L": return 8200000;

      case "M": return 9100000;

      case "N": return 0;

      case "P": return 800000;

      case "Q": return 1700000;

      case "R": return 2600000;

      case "S": return 3500000;

      case "T": return 4400000;

      case "U": return 5300000;

      case "V": return 6200000;

      case "W": return 7000000;

      case "X": return 7900000;

      default: return 0;

    }

  }



  function latLonToUTM(lat, lon){

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    if (lat > 84 || lat < -80) return null;



    const a = 6378137.0;

    const f = 1 / 298.257223563;

    const k0 = 0.9996;

    const eSq = f * (2 - f);

    const eccPrimeSq = eSq / (1 - eSq);

    const degToRad = Math.PI / 180;



    let zoneNumber = Math.floor((lon + 180) / 6) + 1;

    zoneNumber = adjustZoneNumber(lat, lon, zoneNumber);



    const zoneLetter = getZoneLetter(lat);

    if (!zoneLetter) return null;



    const lonOrigin = (zoneNumber - 1) * 6 - 180 + 3;

    const latRad = lat * degToRad;

    const lonRad = lon * degToRad;

    const lonOriginRad = lonOrigin * degToRad;



    const sinLat = Math.sin(latRad);

    const cosLat = Math.cos(latRad);

    const tanLat = Math.tan(latRad);



    const N = a / Math.sqrt(1 - eSq * sinLat * sinLat);

    const T = tanLat * tanLat;

    const C = eccPrimeSq * cosLat * cosLat;

    const A = cosLat * (lonRad - lonOriginRad);



    const M = a * (

      (1 - eSq/4 - 3*eSq*eSq/64 - 5*eSq*eSq*eSq/256) * latRad

      - (3*eSq/8 + 3*eSq*eSq/32 + 45*eSq*eSq*eSq/1024) * Math.sin(2*latRad)

      + (15*eSq*eSq/256 + 45*eSq*eSq*eSq/1024) * Math.sin(4*latRad)

      - (35*eSq*eSq*eSq/3072) * Math.sin(6*latRad)

    );



    const easting = k0 * N * (

      A + (1 - T + C) * Math.pow(A,3) / 6 + (5 - 18*T + T*T + 72*C - 58*eccPrimeSq) * Math.pow(A,5) / 120

    ) + 500000.0;



    let northing = k0 * (

      M + N * tanLat * (

        Math.pow(A,2)/2 + (5 - T + 9*C + 4*C*C) * Math.pow(A,4)/24 + (61 - 58*T + T*T + 600*C - 330*eccPrimeSq) * Math.pow(A,6)/720

      )

    );



    if (lat < 0) northing += 10000000.0;



    return { zoneNumber, zoneLetter, easting, northing };

  }



  function get100kGridLetters(zoneNumber, easting, northing, zoneLetter){

    const set = get100kSetForZone(zoneNumber);

    const columnValue = Math.floor(easting / 100000);

    let northingValue = northing;

    const minNorth = getMinNorthing(zoneLetter);

    while (northingValue < minNorth) northingValue += 2000000;

    const rowValue = Math.floor(northingValue / 100000);

    const columnLetter = getEasting100kLetter(set, columnValue);

    const rowLetter = getNorthing100kLetter(set, rowValue);

    return columnLetter + rowLetter;

  }



  function latLonToMGRS(lat, lon){

    const utm = latLonToUTM(lat, lon);

    if (!utm) return "";

    const { zoneNumber, zoneLetter, easting, northing } = utm;

    const grid = get100kGridLetters(zoneNumber, easting, northing, zoneLetter);

    let eRemainder = Math.round(easting % 100000);

    let nRemainder = Math.round(northing % 100000);

    if (eRemainder === 100000) eRemainder = 0;

    if (nRemainder === 100000) nRemainder = 0;

    return `${zoneNumber}${zoneLetter} ${grid} ${String(eRemainder).padStart(5,"0")} ${String(nRemainder).padStart(5,"0")}`;

  }



  function formatPositionWithFormat(p, formatOverride){

    const fmt = sanitizePositionFormat(formatOverride) || positionFormat;

    if (fmt === "MGRS") {

      const coords = getDecimalLatLon(p);

      if (!coords) return "";

      return latLonToMGRS(coords.lat, coords.lon);

    }

    const coords = getDecimalLatLon(p);

    if (fmt === "DM.M") {

      if (coords) return formatDMmPair(coords.lat, coords.lon);

      return formatDMmFromPartsFallback(p);

    }

    if (!coords) return "";

    switch (fmt) {

      case "DMS":

        return formatDmsPair(coords.lat, coords.lon);

      case "D.DD":

        return formatDecimalPair(coords.lat, coords.lon);

      default:

        return formatDMmPair(coords.lat, coords.lon);

    }

  }



  function formatPositionFromPayload(p, override){

    if (!p || typeof p !== "object") return "";

    return formatPositionWithFormat(p, override);

  }



  function buildPosCompact(p){

    return formatPositionWithFormat(p);

  }



  function buildPosDisplay(p){

    return formatPositionWithFormat(p);

  }



  function annotatePositionsForFormat(stateObj, fmt){

    if (!stateObj || typeof stateObj !== "object") return;

    const formatList = (list)=>{

      if (!Array.isArray(list)) return;

      list.forEach(rec=>{

        if (rec && typeof rec === "object") {

          const formatted = formatPositionWithFormat(rec, fmt);

          if (formatted) rec.positionFmt = formatted;

          else delete rec.positionFmt;

        }

      });

    };

    if (stateObj.columns && typeof stateObj.columns === "object") {

      Object.values(stateObj.columns).forEach(formatList);

    }

    formatList(stateObj.missionTimeline);

  }



 // ---- Export ----

function openExportWindow(){

const win=window.open("", "wf_export", "width=920,height=760"); if(!win){ alert("Pop-up blocked. Please allow pop-ups for Export."); return; }

const state=gatherStateFromDOM();

    annotatePositionsForFormat(state, positionFormat);

const types=["India","Echo","AIS","Alpha","November","Golf"];

const present=types.filter(t=> (state.columns[t]||[]).length>0);



function correlationLabel(code){ const raw = String(code||""); if(!raw) return ""; if(raw.toUpperCase().startsWith("AIS")){ const numeric = raw.slice(3).trim(); return numeric ? `AIS ${numeric}` : "AIS"; } const type = tacrepTypeFromCode(raw); if(!type || type === "Other") return raw; let numeric = raw.replace(/^[A-Za-z]+/, "").trim(); return numeric ? `${type.toUpperCase()} ${numeric}` : type.toUpperCase(); }



const correlationMap = {};

(state.correlations || []).forEach(entry => {

  const codes = (entry.codes || []).map(c => String(c || "")).filter(Boolean).sort((a,b)=>a.localeCompare(b));

  codes.forEach(code => {

    if (!correlationMap[code]) correlationMap[code] = [];

  });

  codes.forEach(code => {

    codes.forEach(other => {

      if (other === code) return;

      const label = correlationLabel(other);

      if (label && !correlationMap[code].includes(label)) {

        correlationMap[code].push(label);

      }

    });

  });

});

Object.keys(correlationMap).forEach(code => {

  correlationMap[code].sort((a,b)=>a.localeCompare(b));

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



const alsoHtml = `<label><input type="checkbox" id="incCrew" checked> Crew Details</label>`;





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



  <h3 style="margin:14px 0 6px;">Crew Details</h3>

  

  <table class="tbl" id="previewCDMeta"><tbody id="rowsCDMeta"></tbody></table> <table class="tbl" id="previewCD"><thead><tr> <th>Shift</th><th>Turnover</th><th>MC</th><th>TC</th><th>UAC</th><th>MPO1</th><th>MPO2</th> </tr></thead><tbody id="rowsCD"></tbody></table>

  <div id="crewMetaWrap" style="margin:6px 0 10px;"> <div id="metaCallsign" class="muted"></div> <div id="metaMission" class="muted"></div> <div id="metaBlockStart" class="muted"></div> </div>

  <table class="tbl" id="previewCD"><thead><tr>

        <th>Shift</th><th>Turnover</th><th>MC</th><th>TC</th><th>UAC</th><th>MPO1</th><th>MPO2</th>



  </tr></thead><tbody id="rowsCD"></tbody></table>

</div>



<script>

  const state = ${JSON.stringify(state)};

  const codeToGroups = ${JSON.stringify(correlationMap)};





  function d(s){ return String(s||'').replace(/\D/g,''); }

  function buildPos(p){

    if (p && typeof p.positionFmt === 'string' && p.positionFmt) return p.positionFmt;

    function fmt(minStr,decStr){ const mm=d(minStr); const dec=d(decStr||''); const num=mm===''?0:Number(mm); const dn=dec===''?0:Number('0.'+dec); const total=num+dn; return total.toFixed(3).padStart(6, total<10?'0':''); }

    const latD=d(p.latDeg), latM=d(p.latMin), lonD=d(p.lonDeg), lonM=d(p.lonMin);

    if(latD===''||latM===''||!p.latHem||lonD===''||lonM===''||!p.lonHem) return '';

    const latDStr=String(Math.trunc(Number(latD)||0)).padStart(2,'0');

    const lonDStr=String(Math.trunc(Number(lonD)||0)).padStart(3,'0');

    const latMStr=fmt(p.latMin,p.latDecMinStr), lonMStr=fmt(p.lonMin,p.lonDecMinStr);

    return latDStr + ':' + latMStr + (p.latHem || '') + ', ' + lonDStr + ':' + lonMStr + (p.lonHem || '');

  }



  function selectedTypes(){ return Array.from(document.querySelectorAll('.typeCb')).filter(cb=>cb.checked).map(cb=>cb.value); }

  function corrStringFor(code){

    const arr = codeToGroups[code] || [];

    if (!arr.length) return '';

    return arr.join(', ');

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

    const esc=v=>/[",\n]/.test(String(v))? '"'+String(v).replace(/"/g,'""')+'"' : String(v);

    return rows.map(r=>r.map(esc).join(',')).join('\n');

  }



  function sectionCSV(title, header, rows){

    const lines=[];

    lines.push(toCSV([[title]]));

    lines.push(toCSV([header]));

    if(rows.length) lines.push(toCSV(rows));

    lines.push(''); // blank line between sections

    return lines.join('\n');

  }



  function buildAllPreviews(){

    const includeCD = document.getElementById('incCrew').checked;

    const trRows = buildRowsTR();
    const cdRows = includeCD ? buildRowsCD() : [];

    const cdMeta = document.getElementById('previewCDMeta');
    if (cdMeta) cdMeta.style.display = includeCD ? '' : 'none';
    const cdTable = document.getElementById('previewCD');
    if (cdTable) cdTable.style.display = includeCD ? '' : 'none';

    return { trRows, cdRows, includeCD };

  }

  document.querySelectorAll('.typeCb').forEach(cb=> cb.addEventListener('change', buildAllPreviews));

  document.getElementById('incCrew').addEventListener('change', buildAllPreviews);



  document.getElementById('btnGen').addEventListener('click', ()=>{

    const { trRows, cdRows, includeCD } = buildAllPreviews();

    const parts=[];

    parts.push(sectionCSV('TACREPS', ["Code","Type","TimeZ","Vessel","Sensor","Pos","Course","Speed","Track","MinLen(ft)","Info","By","Correlations"], trRows));

    if(includeCD){

        // Add single-line meta above the Crew Details section (no Block Start)

  parts.push(toCSV([["Callsign", (state.crewDetails && state.crewDetails.callsign) || ""]]));

  parts.push(toCSV([["Mission Number", (state.crewDetails && state.crewDetails.missionNumber) || ""]]));

  parts.push("");

  parts.push(sectionCSV('CREW DETAILS', ["Shift","Turnover","MC","TC","UAC","MPO1","MPO2"], cdRows));



    }



    const csv = parts.join('\n');

    const blob=new Blob([csv],{type:'text/csv'});

    const url=URL.createObjectURL(blob);

    const a=document.createElement('a'); a.href=url; a.download='warfighter_export.csv'; a.click(); URL.revokeObjectURL(url);

  });



  buildAllPreviews();

<\/script></body></html>`);





win.document.close();

}

  // ---- Abbrev content ----

function buildAbbrevList(p){

  if(!p || typeof p!=="object") return [];

  const out=[];

  const type = tacrepTypeFromCode(p.code || "") || "Other";
  const sel = getAbbrevPrefsForType(type);

  if(sel.includes("time") && p.timeHHMM){ out.push(`${p.timeHHMM}Z`); }
  if(sel.includes("vesselType") && p.vesselType){ out.push(String(p.vesselType).trim()); }
  if(sel.includes("vesselName") && p.vesselName){ out.push(String(p.vesselName).trim()); }
  if(sel.includes("systemOrPlatform") && p.systemOrPlatform){ out.push(String(p.systemOrPlatform).trim()); }
  if(sel.includes("emitterName") && p.emitterName){ out.push(String(p.emitterName).trim()); }
  if(sel.includes("activityOrFunction") && p.activityOrFunction){ out.push(String(p.activityOrFunction).trim()); }
  if(sel.includes("frequency") && p.frequency){ out.push(String(p.frequency).trim()); }
  if(sel.includes("sensor") && p.sensor){ out.push(String(p.sensor).trim()); }
  if(sel.includes("mmsi") && p.mmsi){ out.push(`MMSI ${p.mmsi}`); }
  if(sel.includes("vesselFlag") && p.vesselFlag){ out.push(String(p.vesselFlag).trim()); }
  if(sel.includes("imo") && p.imo){ out.push(`IMO ${p.imo}`); }
  if(sel.includes("tq") && p.tq){ out.push(String(p.tq).trim()); }
  if(sel.includes("amplification") && p.amplification){ out.push(String(p.amplification).trim()); }
  if(sel.includes("ivo") && p.ivo){ out.push(String(p.ivo).trim()); }
  if(sel.includes("majorAxis") && p.majorAxis){ out.push(String(p.majorAxis).trim()); }
  if(sel.includes("minorAxis") && p.minorAxis){ out.push(String(p.minorAxis).trim()); }
  if(sel.includes("orientation") && p.orientation){ out.push(String(p.orientation).trim()); }
  if(sel.includes("bearing") && p.bearing){ out.push(String(p.bearing).trim()); }
  if(sel.includes("ownshipPosit") && p.ownshipPosit){ out.push(String(p.ownshipPosit).trim()); }
  if(sel.includes("position")){
    const pos=buildPosCompact(p);
    if(pos) out.push(pos);
  }
  if(sel.includes("course") && p.course){ out.push(String(p.course).trim()); }
  if(sel.includes("speed") && (p.speed!==null && p.speed!==undefined) && String(p.speed).trim()!==""){ out.push(String(p.speed).trim()); }
  if(sel.includes("trackNumber") && p.trackNumber){ out.push(String(p.trackNumber).trim()); }
  if(sel.includes("minVesselLen") && p.minVesselLen){ out.push(`${p.minVesselLen} ft`); }
  if(sel.includes("additionalInfo") && p.info){ out.push(String(p.info).trim()); }

  return out;

}

function renderCreatorAndAbbrev(payload){
  const data = (payload && typeof payload === "object") ? payload : {};
  const owner = String(data.lastBy || data.createdBy || "").trim() || "--";
  let summary=[];
  try{
    summary = buildAbbrevList(data).map(part => String(part).trim()).filter(Boolean);
  }catch{
    summary = [];
  }
  if(!summary.length) return owner;
  return `${owner} | ${summary.join(" / ")}`;
}







})();



































