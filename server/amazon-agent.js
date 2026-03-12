// Amazon Browser Automation Agent
// Uses Playwright + Stealth to add items to cart and reach checkout
// Supports both local (headless: false) and remote/Railway (headless: true) modes

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Apply stealth plugin to avoid bot detection
chromium.use(StealthPlugin());

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

export async function startAmazonOrder({ items, email, password, sessionId, onStatus }) {
  let browser = null;
  let context = null;
  let page = null;

  try {
    log(sessionId, `Starting order: ${items.length} items, headless=${HEADLESS}`);
    onStatus({ phase: 'launching', message: 'Launching browser...' });

    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
      ],
    });

    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });

    page = await context.newPage();

    // Store session so we can resume after approval
    sessions.set(sessionId, { browser, context, page, phase: 'starting', timeout: null });
    touchSession(sessionId);

    // ---- STEP 1: Sign in ----
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

    // Verify we're signed in
    log(sessionId, 'Signed in successfully');
    onStatus({ phase: 'signed-in', message: 'Signed in successfully.' });
    await delay(1000);

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

// Extracted so it can be called after 2FA resolution
async function addItemsAndCheckout({ items, page, sessionId, onStatus }) {
  const failedItems = [];

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
      await delay(1500 + Math.random() * 1000);

      // Set quantity if > 1
      if (item.quantity > 1) {
        try {
          const qtySelect = await page.$('#quantity');
          if (qtySelect) {
            await qtySelect.selectOption(String(item.quantity));
            await delay(500);
          } else {
            const qtyInput = await page.$('input[name="quantity"]');
            if (qtyInput) {
              await qtyInput.fill(String(item.quantity));
              await delay(500);
            }
          }
        } catch (e) {
          log(sessionId, `Qty set failed for ${item.asin}: ${e.message}`);
          onStatus({
            phase: 'adding-item',
            message: `Could not set quantity to ${item.quantity} for ${item.name}, defaulting to 1.`,
          });
        }
      }

      // Click "Add to Cart" — try multiple selectors
      const addBtn = await page.$('#add-to-cart-button') ||
                     await page.$('#add-to-cart-button-ubb') ||
                     await page.$('input[name="submit.add-to-cart"]') ||
                     await page.$('[data-feature-id="addToCart"] button');

      if (addBtn) {
        await addBtn.click();
        await delay(2000 + Math.random() * 1000);
        onStatus({
          phase: 'item-added',
          message: `Added ${i + 1}/${items.length}: ${item.name}`,
        });
      } else {
        failedItems.push({ ...item, reason: 'no Add to Cart button' });
        log(sessionId, `No add-to-cart button for ${item.asin}`);
        onStatus({
          phase: 'item-skipped',
          message: `Skipped ${item.name} — no Add to Cart button found.`,
        });
      }
    } catch (err) {
      failedItems.push({ ...item, reason: err.message });
      log(sessionId, `Error adding ${item.asin}: ${err.message}`);
      onStatus({
        phase: 'item-skipped',
        message: `Skipped ${item.name} — ${err.message}`,
      });
    }

    // Human-like delay between items
    if (i < items.length - 1) {
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

  const { page } = session;
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

  const { page } = session;
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

  const { page } = session;
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
