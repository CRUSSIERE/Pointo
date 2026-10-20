import {
  LS_KEY, pad, todayISO, timeToMinutes, minutesToTime, minutesToHM, parseHM,
  defaultState, migrate, allTypes, findType, breakMinutes, earliestDeparture, dayDelta,
  balance, setBalanceTo, writeDay, weekdaysBetween, monthStats, resnapshotFrom, workDayISO
} from "./calc.js?v=6"; // ?v= : voir sw.js

const $ = (id) => document.getElementById(id);
const TIME_IDS = { arrival: "arrivalTime", breakStart: "breakStart", breakEnd: "breakEnd", departure: "departureTime" };
const SHEET_IDS = { arrival: "sheetArrival", breakStart: "sheetBreakStart", breakEnd: "sheetBreakEnd", departure: "sheetDeparture" };
const PART_LABELS = { day: "Journée", am: "Matin", pm: "Après-midi", hours: "Heures" };
const MONTHS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const DOW = ["L","M","M","J","V","S","D"];

// ---------- State ----------
let state = migrate(readStorage());
let saveWarned = false;

function readStorage(){
  try{ return localStorage.getItem(LS_KEY); }catch(e){ return null; }
}
function save(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch(e){
    if(!saveWarned){ saveWarned = true; alert("Impossible d'enregistrer sur cet appareil (stockage plein ou navigation privée). Tes saisies seront perdues à la fermeture."); }
  }
}

const readInputs = (ids) => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, $(id).value]));
const fillInputs = (ids, day) => { for(const [k, id] of Object.entries(ids)) $(id).value = (day && day[k]) || ""; };
const dateLabel = (iso, opts = {weekday:"long", day:"numeric", month:"long"}) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString("fr-FR", opts);
};
function absenceText(a){
  const t = findType(state, a.type);
  return `${t ? t.label : "Absence"} · ${a.part === "hours" ? minutesToHM(a.minutes || 0) : PART_LABELS[a.part]}`;
}
const typeColor = (id) => { const t = findType(state, id); return t ? t.color : "var(--text-dim)"; };

function renderAll(){ renderToday(); renderCalendar(); renderBalance(); }

// ---------- Theme ----------
function applyTheme(){
  document.documentElement.setAttribute("data-theme", state.theme);
  $("themeToggle").classList.toggle("on", state.theme === "dark");
}
$("themeToggle").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme(); save();
});

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + btn.dataset.view));
    if(btn.dataset.view === "settings") renderSettings();
    renderAll();
  });
});

// ---------- Journée ----------
let formDay = null; // jour affiché dans le formulaire (change à minuit / au retour dans l'app)

function loadToday(){
  formDay = workDayISO(state);
  const day = state.days[formDay];
  fillInputs(TIME_IDS, day);
  if(!(day && day.arrival) && !(day && day.absence && day.absence.part === "day")) $("arrivalTime").value = state.settings.defaultArrival || "";
}

function saveToday(){
  writeDay(state, formDay, readInputs(TIME_IDS));
  save(); renderAll();
}

function renderToday(){
  $("headerSub").textContent = dateLabel(formDay);
  const existing = state.days[formDay];
  // aperçu sur une copie : rien n'est écrit tant que l'utilisateur ne saisit rien
  const day = writeDay({settings: state.settings, days: existing ? {[formDay]: {...existing}} : {}}, formDay, readInputs(TIME_IDS));

  const a = day.absence;
  $("todayAbsText").textContent = a ? absenceText(a) : "Aucune";
  $("todayAbsSw").hidden = !a;
  if(a) $("todayAbsSw").style.background = typeColor(a.type);
  $("todayAbsBtn").textContent = a ? "Modifier" : "Déclarer";

  const br = breakMinutes(day);
  const alertEl = $("breakAlert");
  alertEl.style.display = br.explicit && br.minutes < state.settings.minBreak ? "block" : "none";
  alertEl.textContent = `Ta pause (${minutesToHM(br.minutes)}) est sous le minimum de ${minutesToHM(state.settings.minBreak)}.`;

  const dep = earliestDeparture(day);
  const deltaEl = $("departDelta");
  if(dep == null){
    $("departTime").textContent = "--:--";
    deltaEl.textContent = a && a.part === "day" ? "Absent toute la journée" : "Renseigne ton arrivée";
    deltaEl.className = "delta neutral";
    return;
  }
  $("departTime").textContent = minutesToTime(dep);
  const now = new Date();
  const diff = dep - (now.getHours()*60 + now.getMinutes() + (formDay !== todayISO(now) ? 1440 : 0)); // poste de la veille
  deltaEl.textContent = diff > 0 ? `Dans ${minutesToHM(diff)}` : `Dépassé de ${minutesToHM(-diff)}`;
  deltaEl.className = diff > 0 ? "delta neutral" : "delta pos";
}

Object.values(TIME_IDS).forEach(id => $(id).addEventListener("input", saveToday));
document.querySelectorAll(".btn-now[data-target]").forEach(btn => {
  btn.addEventListener("click", () => {
    const now = new Date();
    $(btn.dataset.target).value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    saveToday();
  });
});
$("saveDayBtn").addEventListener("click", () => {
  saveToday();
  $("saveDayBtn").textContent = "Enregistré ✓";
  setTimeout(() => { $("saveDayBtn").textContent = "Enregistrer la journée"; }, 1400);
});
$("todayAbsBtn").addEventListener("click", () => openSheet({isos: [formDay], title: "Absence aujourd'hui", fromToday: true}));

// ---------- Calendrier ----------
const calCursor = new Date(); calCursor.setDate(1);
let range = null; // null | {start: iso|null, isos?: [iso]}

function renderCalendar(){
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $("calMonthLabel").textContent = `${MONTHS[m]} ${y}`;
  const grid = $("calGrid");
  grid.replaceChildren();
  DOW.forEach(d => {
    const el = document.createElement("div"); el.className = "dow"; el.textContent = d; grid.appendChild(el);
  });
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // lundi = 0
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const daysInPrev = new Date(y, m, 0).getDate();
  const today = todayISO();
  const edges = new Set(range && range.start ? [range.start] : []);
  const inRange = new Set(range && range.isos || []);

  for(let i = 0; i < firstDow; i++){
    const cell = document.createElement("div"); cell.className = "cal-day other"; cell.textContent = daysInPrev - firstDow + 1 + i;
    grid.appendChild(cell);
  }
  for(let d = 1; d <= daysInMonth; d++){
    const iso = `${y}-${pad(m+1)}-${pad(d)}`;
    const day = state.days[iso];
    const cell = document.createElement("button");
    cell.className = "cal-day";
    cell.setAttribute("aria-label", dateLabel(iso));
    if(iso === today) cell.classList.add("today");
    if(edges.has(iso)) cell.classList.add("range-edge");
    if(inRange.has(iso)) cell.classList.add("in-range");
    const num = document.createElement("span"); num.textContent = d;
    const dots = document.createElement("div"); dots.className = "dots";
    const addDot = (color) => { const dot = document.createElement("span"); dot.className = "dot"; dot.style.background = color; dots.appendChild(dot); };
    if(day && day.absence){
      cell.classList.add("abs-" + day.absence.part);
      cell.style.setProperty("--c", typeColor(day.absence.type));
      addDot(typeColor(day.absence.type));
    }
    if(day && day.arrival && !(day.absence && day.absence.part === "day")){
      const delta = dayDelta(day, state);
      if(!day.absence) cell.classList.add(delta >= 0 ? "worked-pos" : "worked-neg");
      addDot(delta >= 0 ? "var(--green)" : "var(--red)");
    }
    cell.append(num, dots);
    cell.addEventListener("click", () => onDayTap(iso));
    grid.appendChild(cell);
  }

  $("rangeBtn").textContent = range ? "Annuler la sélection" : "Sélectionner une période";
  $("rangeHint").hidden = !range;
  $("rangeHint").textContent = range && range.start ? "Touche le dernier jour de la période" : "Touche le premier jour de la période";

  const legend = $("calLegend");
  legend.replaceChildren();
  [{color: "var(--green)", label: "Jour travaillé"}, ...allTypes(state)].forEach(it => {
    const chip = document.createElement("div"); chip.className = "chip";
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = it.color;
    chip.append(sw, it.label); // append(string) = nœud texte, jamais de HTML
    legend.appendChild(chip);
  });

  const st = monthStats(state, y, m);
  const summary = $("calSummary");
  summary.replaceChildren();
  [[String(st.worked), "Jours travaillés"], [minutesToHM(st.delta, true), "Écart cumulé"],
   [`${st.absences.toLocaleString("fr-FR", {maximumFractionDigits: 1})} j`, "Absences"]].forEach(([n, l]) => {
    const box = document.createElement("div"); box.className = "box";
    const nEl = document.createElement("div"); nEl.className = "n"; nEl.textContent = n;
    const lEl = document.createElement("div"); lEl.className = "l"; lEl.textContent = l;
    box.append(nEl, lEl); summary.appendChild(box);
  });
}

function onDayTap(iso){
  if(!range) return openSheet({isos: [iso], title: dateLabel(iso), withTimes: true});
  if(!range.start){ range.start = iso; return renderCalendar(); }
  const isos = weekdaysBetween(range.start, iso);
  if(!isos.length){ alert("Aucun jour ouvré dans cette période."); range = null; return renderCalendar(); }
  range.isos = isos; renderCalendar();
  const [first, last] = [isos[0], isos[isos.length-1]];
  const short = {day: "numeric", month: "short"};
  openSheet({isos, title: `Du ${dateLabel(first, short)} au ${dateLabel(last, short)} · ${isos.length} j ouvrés`, range: true});
}

$("rangeBtn").addEventListener("click", () => { range = range ? null : {start: null}; renderCalendar(); });
$("calPrev").addEventListener("click", () => { calCursor.setMonth(calCursor.getMonth()-1); renderCalendar(); });
$("calNext").addEventListener("click", () => { calCursor.setMonth(calCursor.getMonth()+1); renderCalendar(); });

// ---------- Feuille jour / absence ----------
// sheet = {isos, title, withTimes?, fromToday?, range?, type, part}
let sheet = null;

function openSheet(opts){
  const first = state.days[opts.isos[0]];
  const a = !opts.range && first ? first.absence : null;
  sheet = {...opts, type: a ? a.type : null, part: a ? a.part : "day"};
  $("sheetTitle").textContent = opts.title;
  $("sheetTimes").hidden = !opts.withTimes;
  if(opts.withTimes) fillInputs(SHEET_IDS, first);
  $("absHours").value = a && a.part === "hours" ? minutesToHM(a.minutes || 0) : "";
  renderSheet();
  $("sheetBackdrop").classList.add("show");
  $("daySheet").classList.add("show");
}

function renderSheet(){
  const grid = $("typeGrid");
  grid.replaceChildren();
  allTypes(state).forEach(t => {
    const btn = document.createElement("button");
    btn.className = "type-btn" + (sheet.type === t.id ? " selected" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => { sheet.type = sheet.type === t.id ? null : t.id; renderSheet(); });
    grid.appendChild(btn);
  });
  const add = document.createElement("button");
  add.className = "type-btn custom-add";
  add.textContent = "＋ Autre…";
  add.addEventListener("click", () => {
    const name = (prompt("Nom du type d'absence :") || "").trim();
    if(!name) return;
    const id = "custom_" + Date.now();
    state.customTypes.push({id, label: name, color: "var(--accent)"});
    save();
    sheet.type = id; renderSheet();
  });
  grid.appendChild(add);
  $("partSeg").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.part === sheet.part));
  $("hoursRow").hidden = sheet.part !== "hours";
}

function closeSheet(){
  sheet = null;
  if(range){ range = null; renderCalendar(); }
  $("sheetBackdrop").classList.remove("show");
  $("daySheet").classList.remove("show");
}

function afterSheetWrite(){
  save(); closeSheet(); loadToday(); renderAll();
}

$("partSeg").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { sheet.part = b.dataset.part; renderSheet(); }));
$("sheetBackdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if(e.key === "Escape" && sheet) closeSheet(); });

$("sheetSave").addEventListener("click", () => {
  if(sheet.range && !sheet.type) return alert("Choisis un type d'absence.");
  let absence = null;
  if(sheet.type){
    absence = {type: sheet.type, part: sheet.part};
    if(sheet.part === "hours"){
      const min = parseHM($("absHours").value);
      if(min == null || min <= 0) return alert("Durée attendue : par exemple 2h30");
      absence.minutes = min;
    }
  }
  const patch = {absence};
  if(sheet.withTimes) Object.assign(patch, readInputs(SHEET_IDS));
  // journée pas encore enregistrée : on garde l'arrivée pré-remplie, sauf absence toute la journée
  if(sheet.fromToday && !state.days[formDay] && !(absence && absence.part === "day")) Object.assign(patch, readInputs(TIME_IDS));
  sheet.isos.forEach(iso => writeDay(state, iso, patch));
  afterSheetWrite();
});

$("sheetClear").addEventListener("click", () => {
  sheet.isos.forEach(iso => { if(state.days[iso]) writeDay(state, iso, {absence: null}); });
  afterSheetWrite();
});

// ---------- Heures supp ----------
function renderBalance(){
  const {total, month} = balance(state);
  $("balanceValue").textContent = minutesToHM(total, true);
  $("balanceValue").style.color = total >= 0 ? "var(--green)" : "var(--red)";
  $("monthDelta").textContent = minutesToHM(month, true);
  $("monthDelta").style.color = month >= 0 ? "var(--green)" : "var(--red)";
}

$("applyBalanceBtn").addEventListener("click", () => {
  const m = parseHM($("balanceAdjust").value);
  if(m == null) return alert("Format attendu : +3h30 ou -1h15");
  setBalanceTo(state, m);
  save(); renderBalance();
  $("balanceAdjust").value = "";
});

// ---------- Réglages ----------
function renderSettings(){
  const s = state.settings;
  $("dailyDurH").value = Math.floor(s.dailyMinutes/60);
  $("dailyDurM").value = s.dailyMinutes % 60;
  $("defaultBreak").value = s.defaultBreak;
  $("minBreak").value = s.minBreak;
  $("defaultArrival").value = s.defaultArrival;
}

const intIn = (id, max) => { const v = $(id).value.trim(); const n = Number(v); return v !== "" && Number.isInteger(n) && n >= 0 && n <= max ? n : null; };
const SETTING_READERS = {
  dailyDurH: () => { const h = intIn("dailyDurH", 23), m = intIn("dailyDurM", 59); return h != null && m != null && h*60+m > 0 ? {dailyMinutes: h*60+m} : null; },
  defaultBreak: () => { const n = intIn("defaultBreak", 600); return n == null ? null : {defaultBreak: n}; },
  minBreak: () => { const n = intIn("minBreak", 600); return n == null ? null : {minBreak: n}; },
  defaultArrival: () => timeToMinutes($("defaultArrival").value) == null ? null : {defaultArrival: $("defaultArrival").value}
};
SETTING_READERS.dailyDurM = SETTING_READERS.dailyDurH;
Object.keys(SETTING_READERS).forEach(id => {
  $(id).addEventListener("change", () => {
    const patch = SETTING_READERS[id]();
    if(patch){ Object.assign(state.settings, patch); resnapshotFrom(state, todayISO()); save(); }
    renderSettings(); renderAll(); // valeur invalide : on réaffiche l'ancienne
  });
});

$("resetBtn").addEventListener("click", () => {
  if(!confirm("Supprimer toutes tes données Pointo ? Cette action est irréversible.")) return;
  state = defaultState();
  save(); applyTheme(); loadToday(); renderSettings(); renderAll();
});

// ---------- Rafraîchissement ----------
function refresh(){
  if(workDayISO(state) !== formDay && !sheet) loadToday(); // nouveau jour : le formulaire passe au jour courant
  renderAll();
}
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") refresh(); });
setInterval(refresh, 30000);
// autre onglet : on reprend ses données au lieu de les écraser à la prochaine saisie
window.addEventListener("storage", e => { if(e.key === LS_KEY){ state = migrate(e.newValue); loadToday(); renderAll(); } });

// ---------- Init ----------
applyTheme();
loadToday();
renderSettings();
renderAll();

if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
