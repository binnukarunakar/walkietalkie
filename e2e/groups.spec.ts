import { expect, test, type Page } from "@playwright/test";

async function holdPtt(page: Page): Promise<void> {
  await page
    .getByTestId("ptt-button")
    .dispatchEvent("pointerdown", { pointerId: 1, isPrimary: true, pointerType: "touch" });
}

async function releasePtt(page: Page): Promise<void> {
  await page
    .getByTestId("ptt-button")
    .dispatchEvent("pointerup", { pointerId: 1, isPrimary: true, pointerType: "touch" });
}

async function joinFromLobby(page: Page, url: string, callsign: string, label: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("group-lobby")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("callsign-input").fill(callsign);
  await page.getByTestId(`join-${label}`).click();
  await expect(page.getByTestId("radio-screen")).toBeVisible({ timeout: 10_000 });
}

test("groups: create via UI, two crews, admin announces to all channels", async ({ browser }) => {
  // ── Admin creates the "Stage" group through the UI.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto("/");
  await admin.getByTestId("create-group-link").click();
  await expect(admin.getByTestId("create-group-screen")).toBeVisible();
  await admin.getByTestId("group-name-input").fill("Stage");
  await admin.getByTestId("label-input-0").fill("musicians");
  await admin.getByTestId("label-input-1").fill("led-tech");
  await admin.getByTestId("create-group-button").click();

  // Creation drops the admin straight into the lobby with the admin URL.
  await expect(admin.getByTestId("group-lobby")).toBeVisible({ timeout: 10_000 });
  const adminUrl = admin.url();
  expect(adminUrl).toContain("group=");
  expect(adminUrl).toContain("#admin=");
  const memberUrl = adminUrl.replace(/#admin=.*$/, "");

  // ── Two crew members join DIFFERENT channels via the member link.
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const musician = await ctxA.newPage();
  const tech = await ctxB.newPage();
  await joinFromLobby(musician, memberUrl, "Guitar", "musicians");
  await joinFromLobby(tech, memberUrl, "Lights", "led-tech");

  // Channel isolation inside the group: different crews don't see each other.
  await expect(musician.getByTestId("peer-Lights")).toHaveCount(0);
  await expect(tech.getByTestId("peer-Guitar")).toHaveCount(0);
  // Labels are visible in each member's header.
  await expect(musician.locator(".code-label")).toContainText("musicians");
  await expect(tech.locator(".code-label")).toContainText("led-tech");

  // ── Admin goes on the PA.
  await admin.getByTestId("callsign-input").fill("Ops");
  await admin.getByTestId("announce-button").click();
  await expect(admin.getByTestId("radio-screen")).toBeVisible({ timeout: 10_000 });
  await expect(admin.getByTestId("channel-label")).toContainText("ALL CHANNELS");
  // Members of both channels see the announcer arrive.
  await expect(musician.getByTestId("peer-Ops")).toBeVisible();
  await expect(tech.getByTestId("peer-Ops")).toBeVisible();

  // Announce: BOTH channels hear it at once.
  await holdPtt(admin);
  await expect(admin.getByTestId("on-air")).toBeVisible();
  await expect(admin.getByTestId("ptt-button")).toHaveText("ANNOUNCING");
  await expect(musician.getByTestId("receiving")).toHaveText(/Ops/);
  await expect(tech.getByTestId("receiving")).toHaveText(/Ops/);

  // A member keying over the announcement gets the busy bonk.
  await holdPtt(musician);
  await expect(musician.getByTestId("floor-denied")).toBeVisible();
  await releasePtt(musician);

  // Release clears every channel.
  await releasePtt(admin);
  await expect(musician.getByTestId("receiving")).toHaveCount(0);
  await expect(tech.getByTestId("receiving")).toHaveCount(0);

  // ── Atomic deny: while a musician talks, the PA reports WHICH crew is busy.
  await musician.waitForTimeout(400); // sit out the release cooldown
  await holdPtt(musician);
  await expect(musician.getByTestId("on-air")).toBeVisible();
  await holdPtt(admin);
  await expect(admin.getByTestId("floor-denied")).toHaveText(/musicians/);
  await releasePtt(admin);
  await releasePtt(musician);

  await adminCtx.close();
  await ctxA.close();
  await ctxB.close();
});
