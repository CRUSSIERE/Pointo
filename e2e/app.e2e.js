// Test de bout en bout dans Chromium : migration des anciennes données + parcours principaux.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Données au format de l'ancienne version (avant la refonte), telles que les utilisateurs les ont.
const OLD = {"theme":"dark","settings":{"dailyMinutes":432,"defaultBreak":40,"minBreak":35,"defaultArrival":"08:30"},"balanceBaseMinutes":60,"customTypes":[{"id":"custom_1","label":"<b>Maladie</b>","color":"var(--accent)"}],"days":{"2026-10-01":{"arrival":"08:30","breakStart":"12:00","breakEnd":"12:30","departure":"17:00","type":null},"2026-10-02":{"arrival":"","breakStart":"","breakEnd":"","type":"rtt"},"2026-10-05":{"arrival":"08:00","breakStart":"","breakEnd":"","type":"custom_1"}},"draft":{}};

let server, browser;
before(async () => {
  server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await sleep(100); } }
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.kill(); });

describe("Pointo", () => {
  let page, errors = [], dialogs = [];
  const txt = s => page.locator(s).innerText();
  const tab = v => page.click(`.tab-btn[data-view="${v}"]`);
  const dayCell = d => page.locator("#calGrid button.cal-day").nth(d - 1);
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem("pointo.v3")));

  before(async () => {
    page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", e => errors.push(String(e)));
    page.on("dialog", d => { dialogs.push(d.message()); d.type() === "prompt" ? d.accept("Télétravail <i>x</i>") : d.accept(); });
    await page.clock.install({ time: new Date(2026, 9, 20, 10, 0) });
    await page.addInitScript(o => { if (!sessionStorage.seeded) { sessionStorage.seeded = 1; localStorage.setItem("pointo.v3", o); } }, JSON.stringify(OLD));
    await page.goto(BASE);
  });
  after(() => page.close());

  it("reprend les anciennes données sans changer le solde", async () => {
    assert.equal(await page.getAttribute("html", "data-theme"), "dark");
    await tab("cal");
    assert.equal(await txt("#calMonthLabel"), "Octobre 2026");
    assert.ok((await txt("#calLegend")).includes("<b>Maladie</b>"), "libellé affiché tel quel");
    assert.equal(await page.locator("#calLegend b").count(), 0, "pas de HTML injecté");
    assert.ok(await dayCell(2).evaluate(e => e.classList.contains("abs-day")));
    await tab("supp");
    assert.equal(await txt("#balanceValue"), "+1h48");
  });

  it("calcule le départ au plus tôt, avec une demi-journée d'absence", async () => {
    await tab("jour");
    assert.equal(await page.inputValue("#arrivalTime"), "08:30");
    assert.equal(await txt("#departTime"), "16:22");
    await page.click("#todayAbsBtn");
    await page.click("#typeGrid .type-btn:has-text('RTT')");
    await page.click("#partSeg [data-part=pm]");
    await page.click("#sheetSave");
    assert.equal(await txt("#departTime"), "12:06");
    const s = await store(); // première écriture : données enregistrées au nouveau format
    assert.deepEqual(s.days["2026-10-20"].absence, { type: "rtt", part: "pm" });
    assert.equal(s.schema, 4);
    assert.ok(!("draft" in s));
  });

  it("enregistre automatiquement la journée", async () => {
    await page.fill("#breakStart", "12:00");
    await page.fill("#breakEnd", "12:20");
    assert.ok(await page.isVisible("#breakAlert"), "alerte pause trop courte");
    assert.equal((await store()).days["2026-10-20"].breakEnd, "12:20");
  });

  it("marque une période (jours ouvrés seulement) puis la retire en partie", async () => {
    await tab("cal");
    await page.click("#rangeBtn");
    await dayCell(12).click();
    await dayCell(18).click(); // dimanche : le week-end est ignoré
    assert.ok((await txt("#sheetTitle")).includes("5 j ouvrés"));
    await page.click("#typeGrid .type-btn:has-text('Alternance')");
    await page.click("#sheetSave");
    let s = await store();
    for (const d of [12, 13, 14, 15, 16]) assert.deepEqual(s.days[`2026-10-${d}`].absence, { type: "alternance", part: "day" });
    assert.ok(!s.days["2026-10-17"] && !s.days["2026-10-18"]);
    await page.click("#rangeBtn");
    await dayCell(14).click(); await dayCell(15).click();
    await page.click("#sheetClear");
    s = await store();
    assert.equal(s.days["2026-10-14"].absence, null);
    assert.ok(s.days["2026-10-16"].absence);
  });

  it("modifie un jour passé et ajoute une récup en heures", async () => {
    await dayCell(1).click();
    assert.equal(await page.inputValue("#sheetDeparture"), "17:00");
    await page.fill("#sheetDeparture", "18:00");
    await page.click("#sheetSave");
    assert.equal((await store()).days["2026-10-01"].departure, "18:00");

    await dayCell(6).click();
    await page.click("#typeGrid .type-btn:has-text('Récup')");
    await page.click("#partSeg [data-part=hours]");
    await page.fill("#absHours", "2h70");
    await page.click("#sheetSave");
    assert.ok(dialogs.at(-1).includes("2h30"), "2h70 refusé");
    await page.fill("#absHours", "2h30");
    await page.click("#sheetSave");
    assert.deepEqual((await store()).days["2026-10-06"].absence, { type: "recup", part: "hours", minutes: 150 });
  });

  it("crée un type d'absence perso sans injecter de HTML", async () => {
    await dayCell(7).click();
    await page.click("#typeGrid .custom-add");
    assert.equal(await page.locator("#typeGrid .type-btn.selected").innerText(), "Télétravail <i>x</i>");
    await page.click("#partSeg [data-part=am]");
    await page.click("#sheetSave");
    assert.ok(await dayCell(7).evaluate(e => e.classList.contains("abs-am")));
  });

  it("fixe le solde actuel et ne réécrit pas l'historique quand on change les réglages", async () => {
    // 60 + 108 (1er oct.) - 150 (récup) + 20 (aujourd'hui, pause de 20 min) = +0h38
    await tab("supp");
    assert.equal(await txt("#balanceValue"), "+0h38");
    await page.fill("#balanceAdjust", "+5h00");
    await page.click("#applyBalanceBtn");
    assert.equal(await txt("#balanceValue"), "+5h00");

    await tab("settings");
    await page.fill("#dailyDurH", "");
    await page.dispatchEvent("#dailyDurH", "change");
    assert.equal(await page.inputValue("#dailyDurH"), "7", "valeur vide ignorée");
    await page.fill("#defaultBreak", "45");
    await page.dispatchEvent("#defaultBreak", "change");
    await page.fill("#dailyDurM", "0");
    await page.dispatchEvent("#dailyDurM", "change");
    const st = await store();
    assert.equal(st.settings.dailyMinutes, 420);
    assert.equal(st.days["2026-10-01"].dailyMinutes, 432, "jour passé figé");
    assert.equal(st.days["2026-10-20"].dailyMinutes, 420, "aujourd'hui suit les nouveaux réglages");
    await tab("jour");
    assert.equal(await txt("#departTime"), "12:20"); // 08:30 + 3h30 (demi-journée de 7h00) + 20 min de pause
    // seul aujourd'hui bouge : écart = pause par défaut (45) - pause prise (20) au lieu de 40 - 20
    await tab("supp");
    assert.equal(await txt("#balanceValue"), "+5h05");
  });

  it("passe au jour suivant au retour dans l'app, sans garder la pause de la veille", async () => {
    await page.clock.setSystemTime(new Date(2026, 9, 21, 8, 0));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await tab("jour");
    assert.equal(await page.inputValue("#arrivalTime"), "08:30");
    assert.equal(await page.inputValue("#breakStart"), "");
    assert.ok((await txt("#headerSub")).includes("21"));
  });

  it("n'a ni erreur console ni scroll horizontal", async () => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  });
});

describe("Hors-ligne", () => {
  it("s'affiche sans réseau une fois installée", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); // la page est maintenant contrôlée par le service worker
    await ctx.setOffline(true);
    await page.reload();
    assert.equal(await page.locator("#departTime").innerText(), "16:22");
    await ctx.close();
  });
});

describe("Poste de nuit", () => {
  it("garde la journée de la veille après minuit et y enregistre le départ", async () => {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date(2026, 9, 22, 22, 0) });
    await page.goto(BASE);
    await page.click('.btn-now[data-target="arrivalTime"]');
    await page.clock.setSystemTime(new Date(2026, 9, 23, 2, 0));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal(await page.inputValue("#arrivalTime"), "22:00", "toujours sur la journée du 22");
    assert.equal(await page.locator("#departDelta").innerText(), "Dans 3h52"); // départ au plus tôt 05:52
    await page.click('.btn-now[data-target="departureTime"]');
    const s = await page.evaluate(() => JSON.parse(localStorage.getItem("pointo.v3")));
    assert.equal(s.days["2026-10-22"].departure, "02:00");
    assert.ok(!s.days["2026-10-23"], "rien d'enregistré sur le 23");
    await page.close();
  });
});
