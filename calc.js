// Logique pure de Pointo : pas de DOM, pas de localStorage (testable avec node --test).

export const LS_KEY = "pointo.v3"; // clé historique conservée pour ne pas perdre les données existantes

export const DEFAULT_TYPES = [
  {id:"conge", label:"Congé", color:"var(--purple)"},
  {id:"rtt", label:"RTT", color:"var(--orange)"},
  {id:"recup", label:"Récup", color:"var(--teal)", consumesBalance:true},
  {id:"alternance", label:"Alternance", color:"var(--indigo)"},
  {id:"ferie", label:"Férié", color:"var(--red)"}
];

const TIME_FIELDS = ["arrival", "breakStart", "breakEnd", "departure"];

export function pad(n){ return String(n).padStart(2,"0"); }
export function todayISO(d = new Date()){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
export function timeToMinutes(t){
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  return m ? Number(m[1])*60 + Number(m[2]) : null;
}
export function minutesToTime(m){ m = ((m%1440)+1440)%1440; return `${pad(Math.floor(m/60))}:${pad(m%60)}`; }
export function minutesToHM(m, signed = false){
  const sign = m<0 ? "-" : (signed ? "+" : "");
  const abs = Math.abs(Math.round(m));
  return `${sign}${Math.floor(abs/60)}h${pad(abs%60)}`;
}

export function parseHM(str){
  const match = /^([+-]?)(\d+)h(\d{0,2})$/i.exec(String(str ?? "").trim());
  if(!match) return null;
  const mn = Number(match[3] || 0);
  if(mn > 59) return null;
  return (match[1]==="-" ? -1 : 1) * (Number(match[2])*60 + mn);
}

export function defaultState(){
  return {
    schema:4,
    theme:"light",
    settings:{ dailyMinutes:432, defaultBreak:40, minBreak:35, defaultArrival:"08:30" },
    balanceBaseMinutes:0,
    customTypes:[],
    days:{}
  };
}

export function migrate(raw){
  let parsed;
  try{ parsed = JSON.parse(raw); }catch(e){ return defaultState(); }
  if(!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultState();

  const def = defaultState();
  const { draft, ...rest } = parsed;
  const state = Object.assign(def, rest, {
    schema:4,
    settings: Object.assign(def.settings, parsed.settings),
    customTypes: Array.isArray(parsed.customTypes) ? parsed.customTypes : [],
    days: parsed.days && typeof parsed.days === "object" && !Array.isArray(parsed.days) ? parsed.days : {}
  });

  for(const iso of Object.keys(state.days)){
    const day = state.days[iso];
    if(!day || typeof day !== "object"){ delete state.days[iso]; continue; }
    for(const k of TIME_FIELDS) if(typeof day[k] !== "string") day[k] = "";
    if(!("absence" in day)) day.absence = day.type ? {type:day.type, part:"day"} : null;
    delete day.type;
    // snapshot = réglages actuels : le solde affiché reste identique après la mise à jour
    day.dailyMinutes ??= state.settings.dailyMinutes;
    day.defaultBreak ??= state.settings.defaultBreak;
  }

  // l'ancien brouillon est toujours plus récent que la journée enregistrée (l'enregistrement le vidait)
  if(draft && draft.date && draft.arrival){
    const patch = {};
    for(const k of TIME_FIELDS) patch[k] = draft[k] || "";
    writeDay(state, draft.date, patch);
  }
  return state;
}

export const allTypes = (state) => DEFAULT_TYPES.concat(state.customTypes);
export const findType = (state, id) => allTypes(state).find(t => t.id === id);

export function breakMinutes(day){
  const bs = timeToMinutes(day.breakStart), be = timeToMinutes(day.breakEnd);
  if(bs!=null && be!=null && be>=bs) return {minutes: be-bs, explicit:true}; // 12:00-12:00 = journée sans pause
  const part = day.absence && day.absence.part;
  if(part==="day" || part==="am" || part==="pm") return {minutes:0, explicit:false};
  return {minutes: day.defaultBreak, explicit:false};
}

export function absenceMinutes(day){
  const a = day.absence;
  if(!a) return 0;
  const m = a.part==="day" ? day.dailyMinutes
    : a.part==="am" || a.part==="pm" ? Math.round(day.dailyMinutes/2)
    : a.part==="hours" ? (a.minutes || 0) : 0;
  return Math.min(Math.max(m, 0), day.dailyMinutes);
}

export function earliestDeparture(day){
  const arrival = timeToMinutes(day.arrival);
  if(arrival==null) return null;
  return arrival + (day.dailyMinutes - absenceMinutes(day)) + breakMinutes(day).minutes;
}

export function dayDelta(day, state){
  const arrival = timeToMinutes(day.arrival), departure = timeToMinutes(day.departure);
  if(arrival==null && !day.absence) return null;
  const target = day.dailyMinutes;
  const abs = absenceMinutes(day);
  const type = day.absence && findType(state, day.absence.type);
  const credit = type && type.consumesBalance ? 0 : abs;
  const br = breakMinutes(day);
  let worked;
  // absence sur la journée entière : les heures éventuellement saisies sont ignorées, comme dans l'ancienne version
  if(day.absence && day.absence.part==="day") worked = 0;
  else if(arrival!=null && departure!=null && departure>arrival) worked = departure - arrival - br.minutes;
  // approximation historique : départ supposé à l'heure de départ au plus tôt
  else worked = (target - abs) + (br.explicit ? day.defaultBreak - br.minutes : 0);
  return worked + credit - target;
}

export function balance(state, now = new Date()){
  let total = state.balanceBaseMinutes, month = 0;
  const prefix = `${now.getFullYear()}-${pad(now.getMonth()+1)}-`;
  for(const [iso, day] of Object.entries(state.days)){
    const d = dayDelta(day, state);
    if(d==null) continue;
    total += d;
    if(iso.startsWith(prefix)) month += d;
  }
  return {total, month};
}

export function setBalanceTo(state, minutes){
  state.balanceBaseMinutes = minutes - (balance(state).total - state.balanceBaseMinutes);
}

export function writeDay(state, iso, patch){
  const day = state.days[iso] ??= {arrival:"", breakStart:"", breakEnd:"", departure:"", absence:null};
  day.dailyMinutes ??= state.settings.dailyMinutes;
  day.defaultBreak ??= state.settings.defaultBreak;
  return Object.assign(day, patch);
}

// Nouveaux réglages : ils s'appliquent à aujourd'hui et aux jours futurs, jamais au passé.
export function resnapshotFrom(state, fromIso){
  for(const [iso, day] of Object.entries(state.days)){
    if(iso >= fromIso) Object.assign(day, {dailyMinutes: state.settings.dailyMinutes, defaultBreak: state.settings.defaultBreak});
  }
}

const parseISO = (iso) => { const [y,m,d] = iso.split("-").map(Number); return new Date(y, m-1, d); };

export function weekdaysBetween(isoA, isoB){
  let a = parseISO(isoA), b = parseISO(isoB);
  if(a > b) [a, b] = [b, a];
  const out = [];
  for(const d = a; d <= b; d.setDate(d.getDate()+1)){
    if(d.getDay()!==0 && d.getDay()!==6) out.push(todayISO(d));
  }
  return out;
}

export function monthStats(state, year, monthIndex0){
  const prefix = `${year}-${pad(monthIndex0+1)}-`;
  let worked = 0, absences = 0, delta = 0;
  for(const [iso, day] of Object.entries(state.days)){
    if(!iso.startsWith(prefix)) continue;
    const a = day.absence;
    if(day.arrival && !(a && a.part==="day")) worked++;
    if(a) absences += a.part==="day" ? 1 : a.part==="hours" ? absenceMinutes(day)/day.dailyMinutes : 0.5;
    const d = dayDelta(day, state);
    if(d!=null) delta += d;
  }
  return {worked, absences, delta};
}
