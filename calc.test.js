// Fuseau fixé pour que le test du changement d'heure soit significatif quel que soit l'environnement.
process.env.TZ = "Europe/Paris";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHM, migrate, defaultState, dayDelta, balance, setBalanceTo, writeDay,
  weekdaysBetween, earliestDeparture, monthStats, timeToMinutes, minutesToHM, LS_KEY, resnapshotFrom
} from "./calc.js";

const mkDay = (o) => Object.assign({arrival:"", breakStart:"", breakEnd:"", departure:"", absence:null, dailyMinutes:432, defaultBreak:40}, o);
const S = defaultState();

test("LS_KEY inchangée", () => assert.equal(LS_KEY, "pointo.v3"));

test("dayDelta : exemples du contrat", () => {
  assert.equal(dayDelta(mkDay({absence:{type:"conge", part:"day"}}), S), 0);
  assert.equal(dayDelta(mkDay({absence:{type:"recup", part:"day"}}), S), -432);
  const base = {arrival:"08:30", breakStart:"12:00", breakEnd:"12:40"};
  assert.equal(dayDelta(mkDay({...base, departure:"16:22"}), S), 0);
  assert.equal(dayDelta(mkDay({...base, departure:"17:22"}), S), 60);
  assert.equal(dayDelta(mkDay({arrival:"08:30", departure:"12:06", absence:{type:"rtt", part:"pm"}}), S), 0);
  assert.equal(dayDelta(mkDay({arrival:"08:30", departure:"14:22", absence:{type:"recup", part:"hours", minutes:120}}), S), -120);
  assert.equal(dayDelta(mkDay({arrival:"08:30", breakStart:"12:00", breakEnd:"12:30"}), S), 10);
  assert.equal(dayDelta(mkDay({}), S), null);
});

test("parseHM", () => {
  assert.equal(parseHM("3h30"), 210);
  assert.equal(parseHM(" +1H05 "), 65);
  assert.equal(parseHM("2h"), 120);
  assert.equal(parseHM("-0h30"), -30);
  assert.equal(parseHM("1h75"), null);
  for(const bad of ["", "abc", "1:30", "h30", "1h300", null, undefined]) assert.equal(parseHM(bad), null);
  assert.equal(minutesToHM(parseHM("-0h30"), true), "-0h30");
});

test("migrate : null et JSON invalide", () => {
  assert.deepEqual(migrate(null), defaultState());
  assert.deepEqual(migrate("{pas du json"), defaultState());
  assert.deepEqual(migrate("42"), defaultState());
});

const oldV3 = () => ({
  theme:"dark",
  settings:{ dailyMinutes:420, defaultBreak:45, defaultArrival:"08:00" }, // minBreak absent
  balanceBaseMinutes:90,
  customTypes:[{id:"custom_1", label:"Formation", color:"var(--accent)"}],
  days:{
    "2026-09-01":{arrival:"08:00", breakStart:"12:00", breakEnd:"12:45", departure:"15:45", type:null},
    "2026-09-02":{arrival:"08:10", breakStart:"12:00", breakEnd:"12:30", departure:"16:40", type:null},
    "2026-09-03":{arrival:"08:00", breakStart:"12:00", breakEnd:"12:20", type:null},           // sans départ (ancienne journée)
    "2026-09-04":{arrival:"08:00", breakStart:"", breakEnd:"", type:null},                      // sans départ ni pause
    "2026-09-07":{arrival:"", breakStart:"", breakEnd:"", type:"conge"},
    "2026-09-08":{arrival:"", breakStart:"", breakEnd:"", type:"custom_1"},
    "2026-09-09":{arrival:"08:30", breakStart:"12:00", breakEnd:"13:00", departure:"17:00", type:"rtt"}, // heures + type : ignorées
    "2026-09-10":{arrival:"09:00", breakStart:"13:00", breakEnd:"12:00", departure:"08:00", type:null},  // saisie incohérente
    "2026-09-11":{arrival:"", breakStart:"", breakEnd:"", type:null},
    "2026-10-01":{arrival:"07:45", breakStart:"12:00", breakEnd:"12:35", departure:"16:30", type:null}
  },
  draft:{}
});

test("migrate : ancienne donnée v3", () => {
  const raw = oldV3();
  raw.days["2026-10-02"] = {arrival:"08:00", breakStart:"", breakEnd:"", type:null};
  raw.days["2026-10-05"] = {arrival:"", breakStart:"", breakEnd:"", type:"rtt"};
  raw.draft = {date:"2026-10-02", arrival:"09:59", breakStart:"", breakEnd:"", departure:""};
  const s = migrate(JSON.stringify(raw));
  assert.equal(s.schema, 4);
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.settings, {dailyMinutes:420, defaultBreak:45, minBreak:35, defaultArrival:"08:00"});
  assert.equal("draft" in s, false);
  assert.deepEqual(s.days["2026-09-08"], {arrival:"", breakStart:"", breakEnd:"", departure:"", absence:{type:"custom_1", part:"day"}, dailyMinutes:420, defaultBreak:45});
  assert.deepEqual(s.days["2026-09-07"].absence, {type:"conge", part:"day"});
  assert.equal(s.days["2026-09-01"].absence, null);
  assert.equal("type" in s.days["2026-09-01"], false);
  assert.equal(s.days["2026-09-03"].departure, "");
  assert.equal(s.days["2026-10-02"].arrival, "09:59", "le brouillon, plus récent, remplace la journée enregistrée");

  // brouillon d'un jour passé non enregistré : il devient une journée
  const raw2 = oldV3();
  raw2.days["2026-10-05"] = {arrival:"", breakStart:"", breakEnd:"", type:"rtt"};
  raw2.draft = {date:"2026-10-06", arrival:"08:20", breakStart:"12:00", breakEnd:"12:40", departure:"16:00"};
  const s2 = migrate(JSON.stringify(raw2));
  assert.deepEqual(s2.days["2026-10-06"], {arrival:"08:20", breakStart:"12:00", breakEnd:"12:40", departure:"16:00", absence:null, dailyMinutes:420, defaultBreak:45});
  // brouillon sur un jour typé sans heures : on garde l'absence
  raw2.draft.date = "2026-10-05";
  const s3 = migrate(JSON.stringify(raw2));
  assert.equal(s3.days["2026-10-05"].arrival, "08:20");
  assert.deepEqual(s3.days["2026-10-05"].absence, {type:"rtt", part:"day"});

  // idempotent
  assert.deepEqual(migrate(JSON.stringify(s)), s);
  assert.deepEqual(migrate(JSON.stringify(s2)), s2);
});

// Copie de l'ancien calcul (index.html avant refonte), pour vérifier la non-régression du solde.
function oldTotal(state){
  const timeToMin = (t) => { if(!t) return null; const [h,m]=t.split(":").map(Number); return h*60+m; };
  function dayDeltaMinutes(rec){
    if(!rec || !rec.arrival || rec.type) return null;
    const arrival = timeToMin(rec.arrival);
    const bs = timeToMin(rec.breakStart), be = timeToMin(rec.breakEnd);
    let breakMin = state.settings.defaultBreak;
    if(bs!=null && be!=null && be>bs) breakMin = be-bs;
    const departure = timeToMin(rec.departure);
    if(departure!=null && departure>arrival){
      return (departure - arrival) - breakMin - state.settings.dailyMinutes;
    }
    return state.settings.defaultBreak - breakMin;
  }
  let total = state.balanceBaseMinutes;
  Object.keys(state.days).forEach(iso => { const d = dayDeltaMinutes(state.days[iso]); if(d!=null) total += d; });
  return total;
}

test("non-régression : le solde total est identique après migration", () => {
  const raw = oldV3();
  const expected = oldTotal(raw);
  assert.notEqual(expected, raw.balanceBaseMinutes, "jeu de données significatif");
  assert.equal(balance(migrate(JSON.stringify(raw))).total, expected);
});

test("setBalanceTo : aller-retour", () => {
  const s = migrate(JSON.stringify(oldV3()));
  for(const target of [parseHM("+3h30"), parseHM("-1h15"), 0]){
    setBalanceTo(s, target);
    assert.equal(balance(s).total, target);
  }
});

test("writeDay : snapshot jamais écrasé, réglages ultérieurs sans effet", () => {
  const s = defaultState();
  const day = writeDay(s, "2026-10-20", {arrival:"08:30", breakStart:"12:00", breakEnd:"12:40", departure:"17:22"});
  assert.equal(day, s.days["2026-10-20"]);
  assert.equal(day.dailyMinutes, 432);
  assert.equal(day.absence, null);
  assert.equal(dayDelta(day, s), 60);
  s.settings.dailyMinutes = 480; s.settings.defaultBreak = 60;
  writeDay(s, "2026-10-20", {departure:"17:30"});
  assert.equal(day.dailyMinutes, 432);
  assert.equal(day.defaultBreak, 40);
  assert.equal(dayDelta(day, s), 68);
  assert.equal(writeDay(s, "2026-10-21", {}).dailyMinutes, 480);
});

test("weekdaysBetween : changement de mois, changement d'heure, ordre indifférent", () => {
  assert.deepEqual(weekdaysBetween("2026-09-28", "2026-10-05"), ["2026-09-28","2026-09-29","2026-09-30","2026-10-01","2026-10-02","2026-10-05"]);
  const dst = ["2026-10-23","2026-10-26","2026-10-27"]; // passage à l'heure d'hiver le 25/10
  assert.deepEqual(weekdaysBetween("2026-10-23", "2026-10-27"), dst);
  assert.deepEqual(weekdaysBetween("2026-10-27", "2026-10-23"), dst);
  assert.deepEqual(weekdaysBetween("2026-03-27", "2026-03-30"), ["2026-03-27","2026-03-30"]); // heure d'été
  assert.deepEqual(weekdaysBetween("2026-10-24", "2026-10-25"), []);
});

test("earliestDeparture : demi-journée et heures", () => {
  assert.equal(earliestDeparture(mkDay({})), null);
  assert.equal(earliestDeparture(mkDay({arrival:"08:30"})), timeToMinutes("16:22"));
  assert.equal(earliestDeparture(mkDay({arrival:"08:30", absence:{type:"rtt", part:"pm"}})), timeToMinutes("12:06"));
  assert.equal(earliestDeparture(mkDay({arrival:"08:30", absence:{type:"recup", part:"hours", minutes:120}})), timeToMinutes("14:22"));
  assert.equal(earliestDeparture(mkDay({arrival:"08:30", breakStart:"12:00", breakEnd:"12:30", absence:{type:"conge", part:"am"}})), timeToMinutes("12:36"));
});

test("monthStats : cas simple", () => {
  const s = defaultState();
  writeDay(s, "2026-10-01", {arrival:"08:30", breakStart:"12:00", breakEnd:"12:40", departure:"17:22"}); // +60
  writeDay(s, "2026-10-02", {absence:{type:"conge", part:"day"}});                                        // 0
  writeDay(s, "2026-10-05", {arrival:"08:30", departure:"12:06", absence:{type:"rtt", part:"pm"}});       // 0
  writeDay(s, "2026-10-06", {arrival:"08:30", departure:"14:22", absence:{type:"recup", part:"hours", minutes:108}}); // -108+...
  writeDay(s, "2026-11-02", {arrival:"08:30", departure:"18:00"});                                        // autre mois
  const st = monthStats(s, 2026, 9);
  assert.equal(st.worked, 3);
  assert.equal(st.absences, 1 + 0.5 + 0.25);
  assert.equal(st.delta, 60 + 0 + 0 - 120);
  assert.equal(balance(s, new Date(2026, 9, 20)).month, st.delta);
});

test("resnapshotFrom : nouveaux réglages pour aujourd'hui et le futur, pas le passé", () => {
  const s = defaultState();
  writeDay(s, "2026-10-19", {arrival:"08:30"});
  writeDay(s, "2026-10-20", {arrival:"08:30"});
  writeDay(s, "2027-01-15", {absence:{type:"recup", part:"am"}});
  s.settings.dailyMinutes = 420;
  resnapshotFrom(s, "2026-10-20");
  assert.equal(s.days["2026-10-19"].dailyMinutes, 432);
  assert.equal(s.days["2026-10-20"].dailyMinutes, 420);
  assert.equal(s.days["2027-01-15"].dailyMinutes, 420);
  assert.equal(earliestDeparture(s.days["2026-10-20"]), timeToMinutes("08:30") + 420 + 40);
});

test("journée sans pause : 12:00-12:00 compte 0 de pause", () => {
  assert.equal(dayDelta(mkDay({arrival:"08:00", breakStart:"12:00", breakEnd:"12:00", departure:"15:12"}), S), 0);
});

test("migrate : days corrompu (tableau) ignoré", () => {
  assert.deepEqual(migrate(JSON.stringify({settings:{}, days:[1, 2]})).days, {});
});
