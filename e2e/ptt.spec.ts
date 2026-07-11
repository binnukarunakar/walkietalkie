import { expect, test, type BrowserContext, type Page } from "@playwright/test";

declare global {
  interface Window {
    __radio?: {
      inboundAudioBytes(): Promise<number>;
      micEnabled(): boolean;
      dropSocketForTest(): void;
    };
  }
}

async function tuneIn(page: Page, callsign: string, channel = 3, code = 7): Promise<void> {
  await page.goto("/");
  await page.getByTestId("channel-select").selectOption(String(channel));
  await page.getByTestId("code-select").selectOption(String(code));
  await page.getByTestId("callsign-input").fill(callsign);
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("radio-screen")).toBeVisible({ timeout: 10_000 });
}

// Event-driven press instead of positional mouse.down: immune to layout
// shifts between locating the button and pressing it.
async function holdPtt(page: Page, pointerId = 1): Promise<void> {
  await page
    .getByTestId("ptt-button")
    .dispatchEvent("pointerdown", { pointerId, isPrimary: pointerId === 1, pointerType: "touch" });
}

async function releasePtt(page: Page, pointerId = 1): Promise<void> {
  await page
    .getByTestId("ptt-button")
    .dispatchEvent("pointerup", { pointerId, isPrimary: pointerId === 1, pointerType: "touch" });
}

function micEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__radio?.micEnabled() ?? false);
}

async function twoRadios(
  browser: { newContext(): Promise<BrowserContext> },
  channel: number,
  code: number,
): Promise<{ a: Page; b: Page; close: () => Promise<void> }> {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  await tuneIn(a, "Alpha", channel, code);
  await tuneIn(b, "Bravo", channel, code);
  return {
    a,
    b,
    close: async () => {
      await contextA.close();
      await contextB.close();
    },
  };
}

test("two radios: roster, floor cycle, busy deny, audio bytes, mic gating", async ({
  browser,
}) => {
  const { a, b, close } = await twoRadios(browser, 3, 7);

  // Roster: each sees the other. Mic starts cold on both.
  await expect(a.getByTestId("peer-Bravo")).toBeVisible();
  await expect(b.getByTestId("peer-Alpha")).toBeVisible();
  expect(await micEnabled(a)).toBe(false);
  expect(await micEnabled(b)).toBe(false);

  // Alpha keys up.
  await holdPtt(a);
  await expect(a.getByTestId("on-air")).toBeVisible();
  await expect(b.getByTestId("receiving")).toHaveText(/Alpha/);
  expect(await micEnabled(a)).toBe(true);

  // Bravo keys over — busy deny, no floor steal, and CRITICALLY no hot mic.
  await holdPtt(b);
  await expect(b.getByTestId("floor-denied")).toBeVisible();
  await expect(a.getByTestId("on-air")).toBeVisible();
  expect(await micEnabled(b)).toBe(false);
  await releasePtt(b);

  // The deny banner clears on its own.
  await expect(b.getByTestId("floor-denied")).toHaveCount(0, { timeout: 3_000 });

  // Media plane: Bravo's mesh is actually receiving RTP from Alpha.
  await b.waitForFunction(
    async () => {
      const radio = window.__radio;
      if (radio === undefined) return false;
      return (await radio.inboundAudioBytes()) > 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  // Alpha releases; channel goes clear on both; mics cold everywhere.
  await releasePtt(a);
  await expect(a.getByTestId("on-air")).toHaveCount(0);
  await expect(b.getByTestId("receiving")).toHaveCount(0);
  expect(await micEnabled(a)).toBe(false);

  // Zello-style instant replay: Alpha's take landed in Bravo's log.
  await expect(b.getByTestId("replay-Alpha").first()).toBeVisible({ timeout: 10_000 });

  // Bravo can now take the floor.
  await holdPtt(b);
  await expect(b.getByTestId("on-air")).toBeVisible();
  await expect(a.getByTestId("receiving")).toHaveText(/Bravo/);
  await releasePtt(b);

  await close();
});

test("spacebar PTT: key down transmits, key up releases, blur force-releases", async ({
  browser,
}) => {
  const { a, b, close } = await twoRadios(browser, 8, 11);

  await a.keyboard.down("Space");
  await expect(a.getByTestId("on-air")).toBeVisible();
  await expect(b.getByTestId("receiving")).toHaveText(/Alpha/);
  await a.keyboard.up("Space");
  await expect(a.getByTestId("on-air")).toHaveCount(0);
  await expect(b.getByTestId("receiving")).toHaveCount(0);

  // Window blur while keyed must release the floor (no stuck transmit).
  await a.waitForTimeout(400); // sit out the 250ms release cooldown
  await a.keyboard.down("Space");
  await expect(a.getByTestId("on-air")).toBeVisible();
  await a.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(a.getByTestId("on-air")).toHaveCount(0);
  expect(await micEnabled(a)).toBe(false);

  await close();
});

test("multi-touch: a second finger lifting does not cut the transmission", async ({
  browser,
}) => {
  const { a, close } = await twoRadios(browser, 12, 2);

  await holdPtt(a, 1);
  await expect(a.getByTestId("on-air")).toBeVisible();
  await holdPtt(a, 2); // second finger grazes the button
  await releasePtt(a, 2);
  // Finger one is still down — must still be transmitting.
  await expect(a.getByTestId("on-air")).toBeVisible();
  await releasePtt(a, 1);
  await expect(a.getByTestId("on-air")).toHaveCount(0);

  await close();
});

test("max-hold force-release cuts the mic while the button is still held", async ({
  browser,
}) => {
  // Server runs with MAX_HOLD_MS=10000 (playwright.config webServer env).
  const { a, b, close } = await twoRadios(browser, 4, 9);

  await holdPtt(a);
  await expect(a.getByTestId("on-air")).toBeVisible();

  // Never release: the server must force-release at the max hold.
  await expect(a.getByTestId("on-air")).toHaveCount(0, { timeout: 15_000 });
  expect(await micEnabled(a)).toBe(false);
  await expect(b.getByTestId("receiving")).toHaveCount(0);

  // The channel is usable again.
  await releasePtt(a);
  await holdPtt(b);
  await expect(b.getByTestId("on-air")).toBeVisible();
  await releasePtt(b);

  await close();
});

test("reconnect: dropped socket resumes the session and resyncs the roster", async ({
  browser,
}) => {
  const { a, b, close } = await twoRadios(browser, 14, 6);

  await a.evaluate(() => window.__radio?.dropSocketForTest());

  // Backoff starts at 1s; the session must come back with the roster intact.
  await expect(a.getByTestId("radio-screen")).toBeVisible({ timeout: 15_000 });
  await expect(a.getByTestId("peer-Bravo")).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId("peer-Alpha")).toBeVisible();

  // And the media plane is rebuilt: Bravo transmits, Alpha hears.
  await holdPtt(b);
  await expect(a.getByTestId("receiving")).toHaveText(/Bravo/);
  await a.waitForFunction(
    async () => {
      const radio = window.__radio;
      if (radio === undefined) return false;
      return (await radio.inboundAudioBytes()) > 0;
    },
    undefined,
    { timeout: 15_000 },
  );
  await releasePtt(b);

  await close();
});

test("duplicate callsign is rejected with a visible error", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();

  await tuneIn(a, "Duplicate", 5, 3);

  await b.goto("/");
  await b.getByTestId("channel-select").selectOption("5");
  await b.getByTestId("code-select").selectOption("3");
  await b.getByTestId("callsign-input").fill("Duplicate");
  await b.getByTestId("join-button").click();
  await expect(b.getByTestId("join-error")).toHaveText(/already on this channel/);

  await contextA.close();
  await contextB.close();
});

test("channel full: join past the mesh cap fails with a clear error", async ({ browser }) => {
  // Server runs with MAX_CHANNEL_SIZE=3 (playwright.config webServer env).
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext()),
  );
  const pages = await Promise.all(contexts.map((c) => c.newPage()));

  await tuneIn(pages[0]!, "Crew1", 6, 4);
  await tuneIn(pages[1]!, "Crew2", 6, 4);
  await tuneIn(pages[2]!, "Crew3", 6, 4);

  const late = pages[3]!;
  await late.goto("/");
  await late.getByTestId("channel-select").selectOption("6");
  await late.getByTestId("code-select").selectOption("4");
  await late.getByTestId("callsign-input").fill("Crew4");
  await late.getByTestId("join-button").click();
  await expect(late.getByTestId("join-error")).toHaveText(/full/i);
  await expect(late.getByTestId("radio-screen")).toHaveCount(0);

  await Promise.all(contexts.map((c) => c.close()));
});

test("microphone permission denied shows an error and does not retry-loop", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException("denied", "NotAllowedError"));
  });
  const page = await context.newPage();

  await page.goto("/");
  await page.getByTestId("callsign-input").fill("NoMic");
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("join-error")).toHaveText(/microphone permission denied/i);
  // Fatal: back on the join screen, no reconnect loop spinning.
  await page.waitForTimeout(2_500);
  await expect(page.getByTestId("radio-screen")).toHaveCount(0);
  await expect(page.getByTestId("join-screen")).toBeVisible();

  await context.close();
});

test("privacy codes isolate crews on the same channel", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();

  await tuneIn(a, "CrewOne", 9, 1);
  await tuneIn(b, "CrewTwo", 9, 2);

  // Positive sync first: CrewTwo transmits on 9/2 and must NOT leak to 9/1.
  await holdPtt(b);
  await expect(b.getByTestId("on-air")).toBeVisible();
  await a.waitForTimeout(800);
  await expect(a.getByTestId("receiving")).toHaveCount(0);
  await releasePtt(b);

  // Same channel number, different privacy code: neither sees the other.
  await expect(a.getByTestId("peer-CrewTwo")).toHaveCount(0);
  await expect(b.getByTestId("peer-CrewOne")).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});
