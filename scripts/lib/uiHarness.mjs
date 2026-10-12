/**
 * Make every browser context a UI suite opens behave like a signed-in person
 * on a device that has already dismissed the install prompt.
 *
 *   - `/api/sso/verify-mis` is stubbed to 200: AuthContext polls it and signs
 *     out on 401, and a minted test user has no MIS session — without this
 *     every page after the first bounces to the sign-in screen.
 *   - The NGA "install the app" prompt is marked as dismissed: otherwise it
 *     covers screenshots and intercepts clicks.
 *
 * Call once, right after `chromium.launch()`.
 */
export function prepareBrowser(browser) {
  const original = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const ctx = await original(...args);
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem('nga.installDismissedThisSession', '1');
        localStorage.setItem('nga.appInstalled', '1');
      } catch { /* storage unavailable */ }
    });
    await ctx.route('**/api/sso/verify-mis**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '{"success":true,"data":{"valid":true}}',
    }));
    // LOG_HTTP_ERRORS=1: print every failed request by URL — the console only
    // says "Failed to load resource", never which one.
    if (process.env.LOG_HTTP_ERRORS) {
      ctx.on('response', (r) => {
        if (r.status() >= 400) console.log(`  [http ${r.status()}] ${r.request().method()} ${r.url()}`);
      });
    }
    return ctx;
  };
  return browser;
}
