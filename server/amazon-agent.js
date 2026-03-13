// Amazon Browser Automation Agent
// Uses Playwright + Stealth to add items to cart and reach checkout
// Supports both local (headless: false) and remote/Railway (headless: true) modes
// Persists Amazon session cookies to skip login on subsequent orders

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Apply stealth plugin to avoid bot detection
chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, 'amazon-session.json');

// Active sessions keyed by sessionId
const sessions = new Map();

// Session timeout: 5 minutes of inactivity
const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

function log(sessionId, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${sessionId?.slice(0, 8) || 'system'}]`, ...args);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms + Math.random() * 500));
}

function touchSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    clearTimeout(session.timeout);
    session.timeout = setTimeout(() => {
      log(sessionId, 'Session timed out after 5 min inactivity — closing browser');
      closeSession(sessionId);
    }, SESSION_TIMEOUT_MS);
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
const HEADLESS = IS_PRODUCTION || process.env.HEADLESS === 'true';

const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--js-flags=--max-old-space-size=256',
  '--disable-canvas-aa',
  '--disable-2d-canvas-clip-aa',
  '--disable-accelerated-2d-canvas',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--disable-background-networking',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
];

const CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 768 },
  locale: 'en-US',
};

// ---- Cookie persistence ----

function loadSavedSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      // Check if session file is less than 24 hours old
      if (data.savedAt && Date.now() - data.savedAt < 24 * 60 * 60 * 1000) {
        log(null, `Loaded saved session (${Math.round((Date.now() - data.savedAt) / 60000)} min old)`);
        return data.storageState;
      }
      log(null, 'Saved session expired (>24h), will do fresh login');
    }
  } catch (e) {
    log(null, `Failed to load saved session: ${e.message}`);
  }
  return null;
}

async function saveSession(context) {
  try {
    const storageState = await context.storageState();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ storageState, savedAt: Date.now() }, null, 2));
    log(null, 'Saved session cookies to amazon-session.json');
  } catch (e) {
    log(null, `Failed to save session: ${e.message}`);
  }
}

// Check if we're actually logged in by navigating to Amazon homepage
async function isLoggedIn(page, sessionId) {
  try {
    log(sessionId, 'Checking if saved session is still valid...');
    await page.goto('https://www.amazon.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await delay(2000);

    const body = await page.content();
    // Look for signs of being logged in
    const signedIn = body.includes('nav-link-accountList') &&
                     !body.includes('Sign in') ||
                     body.includes('Hello, ') ||
                     body.includes('nav-item-signout');

    // Also check we're not on a login/verification page
    const url = page.url();
    const onLoginPage = url.includes('/ap/signin') || url.includes('/ap/cvf') || url.includes('/ap/mfa');

    if (signedIn && !onLoginPage) {
      log(sessionId, 'Saved session is valid — already logged in');
      return true;
    }

    log(sessionId, 'Saved session expired or invalid');
    return false;
  } catch (e) {
    log(sessionId, `Session check failed: ${e.message}`);
    return false;
  }
}

// Full login flow — returns true if signed in, or returns early result for 2FA/captcha
async function doFullLogin({ page, email, password, sessionId, onStatus, context }) {
  log(sessionId, 'Navigating to Amazon sign-in');
  onStatus({ phase: 'signing-in', message: 'Navigating to Amazon sign-in...' });
  await page.goto('https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await delay(1500);

  // Enter email
  onStatus({ phase: 'signing-in', message: 'Entering email...' });
  const emailField = await page.$('#ap_email');
  if (emailField) {
    await emailField.click();
    await page.keyboard.type(email, { delay: 80 });
    await delay(500);
    await page.click('#continue');
    await delay(2000);
  }

  // Check for CAPTCHA
  const pageContent = await page.content();
  if (pageContent.includes('captcha') || pageContent.includes('puzzle')) {
    log(sessionId, 'CAPTCHA detected');
    onStatus({ phase: 'captcha', message: 'CAPTCHA detected. Screenshot captured — please wait for manual resolution.' });
    const screenshot = await page.screenshot({ type: 'png' });
    sessions.get(sessionId).phase = 'captcha';
    touchSession(sessionId);
    return {
      status: 'needs-intervention',
      reason: 'captcha',
      screenshot: screenshot.toString('base64'),
      sessionId,
    };
  }

  // Enter password
  onStatus({ phase: 'signing-in', message: 'Entering password...' });
  const passwordField = await page.$('#ap_password');
  if (passwordField) {
    await passwordField.click();
    await page.keyboard.type(password, { delay: 60 });
    await delay(500);
    await page.click('#signInSubmit');
    await delay(3000);
  }

  // Check for 2FA / verification
  const currentUrl = page.url();
  const body = await page.content();
  const needs2FA = body.includes('verification') ||
                   body.includes('Two-Step') ||
                   body.includes('approve the notification') ||
                   body.includes('Enter the characters') ||
                   currentUrl.includes('/ap/cvf') ||
                   currentUrl.includes('/ap/mfa');

  if (needs2FA) {
    log(sessionId, '2FA required, pausing for user input');
    onStatus({
      phase: '2fa',
      message: 'Verification code required. Check your email and enter the code below.',
    });
    const screenshot = await page.screenshot({ type: 'png' });
    sessions.get(sessionId).phase = '2fa';
    touchSession(sessionId);
    return {
      status: 'needs-intervention',
      reason: '2fa',
      screenshot: screenshot.toString('base64'),
      sessionId,
    };
  }

  // Successfully signed in — save cookies
  log(sessionId, 'Signed in successfully');
  onStatus({ phase: 'signed-in', message: 'Signed in successfully.' });
  await saveSession(context);
  await delay(1000);

  return { status: 'signed-in' };
}

export async function startAmazonOrder({ items, email, password, sessionId, onStatus }) {
  let browser = null;
  let context = null;
  let page = null;

  try {
    log(sessionId, `Starting order: ${items.length} items, headless=${HEADLESS}`);
    onStatus({ phase: 'launching', message: 'Launching browser...' });

    browser = await chromium.launch({
      headless: HEADLESS,
      args: BROWSER_ARGS,
    });

    // Try loading saved session cookies
    const savedState = loadSavedSession();
    if (savedState) {
      onStatus({ phase: 'restoring-session', message: 'Restoring saved session...' });
      context = await browser.newContext({ ...CONTEXT_OPTIONS, storageState: savedState });
    } else {
      context = await browser.newContext(CONTEXT_OPTIONS);
    }

    page = await context.newPage();

    // Store session so we can resume after approval
    sessions.set(sessionId, { browser, context, page, phase: 'starting', timeout: null });
    touchSession(sessionId);

    // Auto-cleanup if browser crashes or disconnects
    browser.on('disconnected', () => {
      log(sessionId, 'Browser disconnected (crash or OOM) — cleaning up session');
      clearTimeout(sessions.get(sessionId)?.timeout);
      sessions.delete(sessionId);
    });

    // ---- STEP 1: Sign in (or verify saved session) ----
    let needsLogin = true;

    if (savedState) {
      const valid = await isLoggedIn(page, sessionId);
      if (valid) {
        needsLogin = false;
        onStatus({ phase: 'signed-in', message: 'Restored saved session — already signed in.' });
      } else {
        // Saved session invalid — create fresh context without cookies
        log(sessionId, 'Saved session invalid, starting fresh login');
        await context.close();
        context = await browser.newContext(CONTEXT_OPTIONS);
        page = await context.newPage();
        sessions.set(sessionId, { ...sessions.get(sessionId), context, page });
      }
    }

    if (needsLogin) {
      const loginResult = await doFullLogin({ page, email, password, sessionId, onStatus, context });
      if (loginResult.status !== 'signed-in') {
        // 2FA or captcha — return early, caller will resume later
        return loginResult;
      }
    }

    // ---- STEP 2: Add ALL items to cart ----
    return await addItemsAndCheckout({ items, page, sessionId, onStatus });

  } catch (error) {
    let screenshot = null;
    if (page) {
      try {
        const buf = await page.screenshot({ type: 'png' });
        screenshot = buf.toString('base64');
      } catch (_) {}
    }

    log(sessionId, 'Error during order:', error.message);
    onStatus({ phase: 'error', message: `Error: ${error.message}` });

    return {
      status: 'error',
      reason: error.message,
      screenshot,
      sessionId,
    };
  }
}

// Click an element via JavaScript to bypass Playwright's actionability checks
// (avoids timeouts from overlays, interstitials, and modals)
async function jsClick(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, selector);
}

// Try multiple selectors to add to cart, using JS clicks
async function tryAddToCart(page) {
  const selectors = [
    '#add-to-cart-button',
    '#add-to-cart-button-ubb',
    'input[name="submit.add-to-cart"]',
    '[data-feature-id="addToCart"] button',
    '#one-click-button',
    '#buy-now-button',
  ];

  for (const sel of selectors) {
    const clicked = await jsClick(page, sel);
    if (clicked) return sel;
  }

  // Last resort: find by text content
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('input[type="submit"], button, span.a-button-inner')];
    const addBtn = buttons.find(b =>
      (b.value || b.textContent || '').toLowerCase().includes('add to cart')
    );
    if (addBtn) { addBtn.click(); return true; }
    return false;
  });

  return clicked ? 'text-match' : null;
}

// Extracted so it can be called after 2FA resolution
async function addItemsAndCheckout({ items, page, sessionId, onStatus }) {
  const failedItems = [];

  // Block heavy resources during add-to-cart to save memory on Railway
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    log(sessionId, `Adding item ${i + 1}/${items.length}: ${item.asin} qty=${item.quantity}`);
    onStatus({
      phase: 'adding-item',
      message: `Adding item ${i + 1}/${items.length}: ${item.name} (ASIN: ${item.asin}, qty: ${item.quantity})...`,
    });

    try {
      await page.goto(`https://www.amazon.com/dp/${item.asin}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await delay(2000 + Math.random() * 1000);

      // Dismiss any overlays/modals that might block the button
      await page.evaluate(() => {
        // Close common Amazon popups
        document.querySelectorAll(
          '#sp-cc-accept, #attachSi498498_feature_div .a-button-close, ' +
          '.a-popover-footer .a-button-close, #nav-main .nav-a.nav-a-2, ' +
          '#abb-intl-popup .abb-intl-decline, .a-modal-close'
        ).forEach(el => el.click());
        // Remove overlay backdrops
        document.querySelectorAll('.a-popover-wrapper, .a-modal-scroller').forEach(el => el.remove());
      }).catch(() => {});

      // Set quantity if > 1
      if (item.quantity > 1) {
        try {
          await page.evaluate((qty) => {
            const sel = document.querySelector('#quantity');
            if (sel) { sel.value = String(qty); sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
            const inp = document.querySelector('input[name="quantity"]');
            if (inp) { inp.value = String(qty); inp.dispatchEvent(new Event('input', { bubbles: true })); }
          }, item.quantity);
          await delay(500);
        } catch (e) {
          log(sessionId, `Qty set failed for ${item.asin}: ${e.message}`);
          onStatus({
            phase: 'adding-item',
            message: `Could not set quantity to ${item.quantity} for ${item.name}, defaulting to 1.`,
          });
        }
      }

      // Try Add to Cart via JS click
      const matched = await tryAddToCart(page);

      if (matched) {
        log(sessionId, `Clicked via: ${matched}`);
        await delay(2000 + Math.random() * 1000);
        onStatus({
          phase: 'item-added',
          message: `Added ${i + 1}/${items.length}: ${item.name}`,
        });
      } else {
        // Capture screenshot of failed page for debugging
        let failScreenshot = null;
        try {
          const buf = await page.screenshot({ type: 'png' });
          failScreenshot = buf.toString('base64');
        } catch (_) {}

        const pageUrl = page.url();
        failedItems.push({ ...item, reason: 'no Add to Cart button found' });
        log(sessionId, `No add-to-cart button for ${item.asin}, url: ${pageUrl}`);
        onStatus({
          phase: 'item-skipped',
          message: `Skipped ${item.name} — no Add to Cart button found.`,
          screenshot: failScreenshot,
          url: pageUrl,
        });
      }
    } catch (err) {
      // Capture screenshot on error
      let failScreenshot = null;
      try {
        const buf = await page.screenshot({ type: 'png' });
        failScreenshot = buf.toString('base64');
      } catch (_) {}

      failedItems.push({ ...item, reason: err.message });
      log(sessionId, `Error adding ${item.asin}: ${err.message}`);
      onStatus({
        phase: 'item-skipped',
        message: `Skipped ${item.name} — ${err.message}`,
        screenshot: failScreenshot,
      });
    }

    // Flush page memory between items
    if (i < items.length - 1) {
      await page.goto('about:blank', { waitUntil: 'commit' }).catch(() => {});
      await delay(800 + Math.random() * 700);
    }

    touchSession(sessionId);
  }

  const addedCount = items.length - failedItems.length;
  log(sessionId, `Cart complete: ${addedCount}/${items.length} added, ${failedItems.length} failed`);
  onStatus({
    phase: 'cart-complete',
    message: `Added ${addedCount}/${items.length} items to cart.${failedItems.length > 0 ? ` ${failedItems.length} failed.` : ''}`,
  });

  // ---- Go to cart, then checkout ----
  // Unblock all resources for cart/checkout (need full page for screenshots)
  await page.unroute('**/*');

  onStatus({ phase: 'checkout', message: 'Navigating to checkout...' });
  await page.goto('https://www.amazon.com/gp/cart/view.html', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await delay(2000);

  // Click "Proceed to checkout"
  const checkoutBtn = await page.$('input[name="proceedToRetailCheckout"]') ||
                      await page.$('#sc-buy-box-ptc-button input') ||
                      await page.$('[data-feature-id="proceed-to-checkout-action"] a');
  if (checkoutBtn) {
    await checkoutBtn.click();
    await delay(5000);
  } else {
    const anyCheckoutBtn = await page.$('text=Proceed to checkout');
    if (anyCheckoutBtn) {
      await anyCheckoutBtn.click();
      await delay(5000);
    }
  }

  // Screenshot checkout page
  const failedMsg = failedItems.length > 0
    ? ` (${failedItems.length} item${failedItems.length > 1 ? 's' : ''} could not be added)`
    : '';
  log(sessionId, 'At checkout, awaiting approval');
  onStatus({ phase: 'awaiting-approval', message: `At checkout — ${addedCount} items in cart${failedMsg}. Review and confirm.` });
  const checkoutScreenshot = await page.screenshot({ type: 'png', fullPage: true });

  sessions.get(sessionId).phase = 'awaiting-approval';
  touchSession(sessionId);

  return {
    status: 'awaiting-approval',
    screenshot: checkoutScreenshot.toString('base64'),
    sessionId,
    currentUrl: page.url(),
    itemsAdded: addedCount,
    itemsFailed: failedItems,
  };
}

export async function confirmPurchase(sessionId, onStatus) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: 'error', reason: 'Session not found — browser may have been closed.' };
  }

  const { page, context } = session;
  touchSession(sessionId);

  try {
    log(sessionId, 'Confirming purchase — clicking Place Order');
    onStatus({ phase: 'placing-order', message: 'Placing order...' });

    const placeOrderBtn = await page.$('input[name="placeYourOrder1"]') ||
                          await page.$('#submitOrderButtonId input') ||
                          await page.$('#placeYourOrder input') ||
                          await page.$('text=Place your order');

    if (placeOrderBtn) {
      await placeOrderBtn.click();
      await delay(5000);

      const confirmScreenshot = await page.screenshot({ type: 'png', fullPage: true });
      log(sessionId, 'Order placed successfully');
      onStatus({ phase: 'order-placed', message: 'Order placed successfully!' });

      // Save cookies after successful order
      await saveSession(context);

      await session.browser.close();
      clearTimeout(session.timeout);
      sessions.delete(sessionId);

      return {
        status: 'order-placed',
        screenshot: confirmScreenshot.toString('base64'),
      };
    } else {
      const screenshot = await page.screenshot({ type: 'png', fullPage: true });
      log(sessionId, 'No Place Order button found');
      onStatus({ phase: 'error', message: 'Could not find Place Order button. Check the screenshot.' });
      return {
        status: 'error',
        reason: 'no-place-order-button',
        screenshot: screenshot.toString('base64'),
      };
    }
  } catch (error) {
    let screenshot = null;
    try {
      const buf = await page.screenshot({ type: 'png' });
      screenshot = buf.toString('base64');
    } catch (_) {}

    log(sessionId, 'Error confirming purchase:', error.message);
    onStatus({ phase: 'error', message: `Error: ${error.message}` });
    return { status: 'error', reason: error.message, screenshot };
  }
}

// Submit a 2FA verification code remotely (type it into the page)
export async function submit2FACode(sessionId, code, onStatus) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: 'error', reason: 'Session not found.' };
  }

  const { page, context } = session;
  touchSession(sessionId);

  try {
    log(sessionId, `Submitting 2FA code: ${code.slice(0, 2)}***`);
    onStatus({ phase: '2fa-submitting', message: 'Entering verification code...' });

    // Try known OTP / verification input selectors
    const codeInput = await page.$('input[name="otpCode"]') ||
                      await page.$('input[name="code"]') ||
                      await page.$('#auth-mfa-otpcode') ||
                      await page.$('input[type="tel"]') ||
                      await page.$('input[type="text"][autocomplete="one-time-code"]') ||
                      await page.$('.cvf-widget-input-code input') ||
                      await page.$('input.a-input-text');

    if (!codeInput) {
      const screenshot = await page.screenshot({ type: 'png' });
      log(sessionId, '2FA code input not found');
      return {
        status: 'error',
        reason: 'Could not find verification code input field.',
        screenshot: screenshot.toString('base64'),
        sessionId,
      };
    }

    await codeInput.click();
    await codeInput.fill('');
    await page.keyboard.type(code, { delay: 80 });
    await delay(500);

    // Try to find and click the submit/verify button
    const submitBtn = await page.$('#auth-signin-button') ||
                      await page.$('input[type="submit"]') ||
                      await page.$('#cvf-submit-otp-button') ||
                      await page.$('button[type="submit"]') ||
                      await page.$('text=Verify') ||
                      await page.$('text=Submit');

    if (submitBtn) {
      await submitBtn.click();
      await delay(4000);
    } else {
      // Try pressing Enter
      await page.keyboard.press('Enter');
      await delay(4000);
    }

    // Check if we're past verification
    const currentUrl = page.url();
    const screenshot = await page.screenshot({ type: 'png' });

    if (!currentUrl.includes('/ap/') && !currentUrl.includes('cvf')) {
      log(sessionId, '2FA resolved, signed in');
      onStatus({ phase: 'signed-in', message: 'Verification complete. Signed in.' });
      sessions.get(sessionId).phase = 'signed-in';

      // Save cookies after successful 2FA
      await saveSession(context);

      return {
        status: '2fa-resolved',
        screenshot: screenshot.toString('base64'),
        sessionId,
        currentUrl,
      };
    } else {
      log(sessionId, 'Still on verification page after code submit');
      onStatus({ phase: '2fa', message: 'Code submitted but still on verification page. Check screenshot and try again.' });
      return {
        status: 'needs-intervention',
        reason: '2fa',
        screenshot: screenshot.toString('base64'),
        sessionId,
      };
    }
  } catch (error) {
    log(sessionId, '2FA code submit error:', error.message);
    return { status: 'error', reason: error.message, sessionId };
  }
}

// Continue order after 2FA is resolved — add items and go to checkout
export async function continueAfter2FA(sessionId, items, onStatus) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: 'error', reason: 'Session not found.' };
  }

  touchSession(sessionId);
  log(sessionId, `Continuing order after 2FA: ${items.length} items`);

  try {
    return await addItemsAndCheckout({ items, page: session.page, sessionId, onStatus });
  } catch (error) {
    let screenshot = null;
    try {
      const buf = await session.page.screenshot({ type: 'png' });
      screenshot = buf.toString('base64');
    } catch (_) {}

    log(sessionId, 'Error continuing after 2FA:', error.message);
    onStatus({ phase: 'error', message: `Error: ${error.message}` });
    return { status: 'error', reason: error.message, screenshot, sessionId };
  }
}

export async function resumeAfterIntervention(sessionId, onStatus) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: 'error', reason: 'Session not found.' };
  }

  const { page, context } = session;
  touchSession(sessionId);

  try {
    onStatus({ phase: 'resuming', message: 'Checking browser state after intervention...' });
    await delay(2000);

    const screenshot = await page.screenshot({ type: 'png' });
    const currentUrl = page.url();

    if (currentUrl.includes('amazon.com') &&
        !currentUrl.includes('/ap/') &&
        !currentUrl.includes('cvf')) {
      log(sessionId, 'Intervention resolved, signed in');
      onStatus({ phase: 'signed-in', message: 'Verification complete. Signed in.' });

      // Save cookies after intervention resolved
      await saveSession(context);

      return {
        status: 'intervention-resolved',
        screenshot: screenshot.toString('base64'),
        sessionId,
        currentUrl,
      };
    } else {
      onStatus({ phase: '2fa', message: 'Still on verification page.' });
      return {
        status: 'needs-intervention',
        reason: '2fa',
        screenshot: screenshot.toString('base64'),
        sessionId,
      };
    }
  } catch (error) {
    return { status: 'error', reason: error.message };
  }
}

export async function takeScreenshot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  touchSession(sessionId);
  try {
    const buf = await session.page.screenshot({ type: 'png' });
    return buf.toString('base64');
  } catch (_) {
    return null;
  }
}

export async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  log(sessionId, 'Closing session');
  try {
    clearTimeout(session.timeout);
    await session.browser.close();
  } catch (_) {}
  sessions.delete(sessionId);
}

export function getActiveSessions() {
  return Array.from(sessions.keys()).map(id => ({
    id,
    phase: sessions.get(id)?.phase || 'unknown',
  }));
}
