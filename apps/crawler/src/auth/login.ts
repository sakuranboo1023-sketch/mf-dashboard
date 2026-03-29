import { mfUrls } from "@mf-dashboard/meta/urls";
import type { BrowserContext, Page } from "playwright";
import { log, debug } from "../logger.js";
import { getCredentials, getOTP } from "./credentials.js";
import { hasAuthState, saveAuthState } from "./state.js";

const TIMEOUTS = {
  redirect: 2000,
  short: 5000,
  medium: 10000,
  long: 15000,
  login: 30000,
};

const SELECTORS = {
  mfidEmail: 'input[name="mfid_user[email]"]',
  mfidPassword: 'input[name="mfid_user[password]"]',
  mfidSubmit: '#submitto, button:text-is("ログインする"), button[type="submit"]',
  mfidOtpInput:
    'input[autocomplete="one-time-code"], input[name*="otp"], input[name*="code"], input[type="tel"], input[inputmode="numeric"]',
  mfidOtpSubmit:
    '#submitto, button:text-is("認証する"), button:text-is("Verify"), button:text-is("確認する"), button[type="submit"]',
  mePassword: 'input[type="password"]',
  meSignIn: 'button:has-text("Sign in")',
};

function isLoggedInUrl(url: string): boolean {
  return (
    url.includes("moneyforward.com") &&
    !url.includes("id.moneyforward.com") &&
    !url.includes("/sign_in") &&
    url !== "https://moneyforward.com/" &&
    !url.endsWith("moneyforward.com")
  );
}

function buildAccountSelector(username: string): string {
  return `button:has-text("${username}"), button:has-text("メールアドレスでログイン"), button:has-text("Sign in with email")`;
}

async function waitForUrlChange(page: Page, timeout: number = TIMEOUTS.redirect): Promise<void> {
  const initialUrl = page.url();
  try {
    await page.waitForURL((url) => url.toString() !== initialUrl, { timeout });
  } catch {
    // Ignore timeout: no redirect happened
  }
}

async function maybeHandleOtp(
  page: Page,
  {
    inputSelector,
    submitSelector,
    label,
    timeout = TIMEOUTS.short,
  }: {
    inputSelector: string;
    submitSelector: string;
    label: string;
    timeout?: number;
  },
): Promise<void> {
  try {
    debug(`Checking for ${label} OTP...`);
    const otpInput = page.locator(inputSelector).first();
    await otpInput.waitFor({ state: "visible", timeout });

    debug(`${label} OTP required, getting from 1Password...`);
    const otp = await getOTP();
    await otpInput.fill(otp);
    debug("Clicking verify button...");
    await page.locator(submitSelector).first().click();
  } catch {
    debug(`${label} OTP not required`);
  }
}

/**
 * Check if the current session is valid by navigating to Money Forward
 * and checking if we're redirected to login page
 */
async function isSessionValid(page: Page): Promise<boolean> {
  debug("Checking if session is valid...");

  try {
    // Navigate to Money Forward home
    await page.goto(mfUrls.home, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.long,
    });

    // Wait a bit for potential redirects
    await waitForUrlChange(page);

    const currentUrl = page.url();
    debug("Current URL after navigation:", currentUrl);

    // If we're on the main site (not login/id page), session is valid
    if (isLoggedInUrl(currentUrl)) {
      log("Session is valid!");
      return true;
    }

    debug("Session is invalid, need to login");
    return false;
  } catch (err) {
    debug("Error checking session:", err);
    return false;
  }
}

/**
 * Login with auth state if available, otherwise perform full login
 */
export async function loginWithAuthState(page: Page, context: BrowserContext): Promise<void> {
  // If auth state exists, check if session is valid
  if (hasAuthState()) {
    debug("Auth state found, checking session validity...");

    const valid = await isSessionValid(page);
    if (valid) {
      debug("Using existing session from auth state");
      return;
    }

    debug("Session expired, performing full login...");
  } else {
    debug("No auth state found, performing full login...");
  }

  // Perform full login
  await login(page);

  // Save auth state after successful login
  await saveAuthState(context);
}

export async function login(page: Page): Promise<void> {
  const { username, password } = await getCredentials();

  debug("Navigating to login page...");
  await page.goto(mfUrls.auth.signIn, {
    waitUntil: "domcontentloaded",
  });

  // Enter email
  debug("Entering email...");
  const emailInput = page.locator(SELECTORS.mfidEmail);
  await emailInput.waitFor({ state: "visible", timeout: TIMEOUTS.medium });
  await emailInput.fill(username);

  // Click sign in button
  debug("Clicking Sign in button...");
  await page.waitForTimeout(500);
  const submitBtn = page.locator(SELECTORS.mfidSubmit).first();
  await submitBtn.waitFor({ state: "visible", timeout: TIMEOUTS.short });
  await submitBtn.click();
  debug("Clicked, waiting for password page...");

  // Wait for password field (should appear on next page)
  const passwordInput = page.locator(SELECTORS.mfidPassword);
  await passwordInput.waitFor({ state: "visible", timeout: TIMEOUTS.long });
  debug("Password page loaded!");

  // Enter password
  debug("Entering password...");
  await passwordInput.fill(password);
  await page.waitForTimeout(500);
  debug("Clicking Sign in button...");
  const submitBtn2 = page.locator(SELECTORS.mfidSubmit).first();
  await submitBtn2.waitFor({ state: "visible", timeout: TIMEOUTS.short });
  await submitBtn2.click();
  debug("Clicked, waiting for next step...");

  // Wait for page to respond after password submit
  await page.waitForTimeout(3000);
  const afterPasswordUrl = page.url();
  debug("URL after password submit:", afterPasswordUrl);
  await page.screenshot({ path: "data/after-password.png" });
  debug("Screenshot saved to data/after-password.png");

  // Check if already logged in (no OTP needed)
  if (isLoggedInUrl(afterPasswordUrl)) {
    debug("Login completed without OTP!");
    return;
  }

  // Check if OTP is required (wait up to 15 seconds for OTP page)
  await maybeHandleOtp(page, {
    inputSelector: SELECTORS.mfidOtpInput,
    submitSelector: SELECTORS.mfidOtpSubmit,
    label: "MFID",
    timeout: TIMEOUTS.long,
  });

  // Wait for OTP verification to complete - should redirect away from /two_factor_auth
  debug("Waiting for OTP verification to complete...");
  try {
    await page.waitForURL((url) => !url.toString().includes("/two_factor_auth"), {
      timeout: TIMEOUTS.login,
    });
  } catch {
    debug("Timeout waiting for OTP redirect, continuing...");
  }

  let currentUrl = page.url();
  debug("URL after OTP:", currentUrl);

  // If already on ME, done
  if (isLoggedInUrl(currentUrl)) {
    debug("Already logged in to ME after OTP!");
    log("Login successful!");
    return;
  }

  // Navigate directly to Money Forward ME home
  debug("Navigating to Money Forward ME home...");
  await page.goto(mfUrls.home, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUTS.login,
  });

  // Wait for possible redirects (login flow)
  await page.waitForTimeout(3000);
  currentUrl = page.url();
  debug("URL after navigating to ME home:", currentUrl);

  // If we ended up on ME, we're done
  if (isLoggedInUrl(currentUrl)) {
    debug("Successfully navigated to ME!");
    log("Login successful!");
    return;
  }

  // If redirected to sign_in, try the sign_in flow
  debug("Not yet on ME, trying sign_in flow...");
  await page.goto(mfUrls.signIn, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUTS.login,
  });

  // Wait for redirect
  try {
    await page.waitForURL(
      (url) => {
        const u = url.toString();
        return (
          isLoggedInUrl(u) || u.includes("account_selector") || u.includes("/sign_in/password")
        );
      },
      { timeout: TIMEOUTS.login },
    );
  } catch {
    debug("Timeout waiting for redirect, continuing...");
  }
  currentUrl = page.url();
  debug("Current URL:", currentUrl);

  // Check if already on ME
  if (isLoggedInUrl(currentUrl)) {
    debug("Logged in to ME!");
    return;
  }

  // Check if we're on account selector or password page
  if (currentUrl.includes("account_selector")) {
    // Click account button (contains email address)
    debug("Account selector found, clicking account...");
    // Try multiple selectors: email address, or Japanese/English text
    const accountButton = page.locator(buildAccountSelector(username)).first();
    await accountButton.waitFor({ state: "visible", timeout: TIMEOUTS.short });

    // Click and wait for navigation (either to password page or directly to ME)
    debug("Clicking account and waiting for navigation...");
    await accountButton.click();

    // Wait for either password page or direct redirect to ME
    await page.waitForURL(/id\.moneyforward\.com\/sign_in\/password|moneyforward\.com\//, {
      timeout: TIMEOUTS.long,
    });
    currentUrl = page.url();
  }

  // Check if we need to enter password or already redirected to ME
  if (currentUrl.includes(mfUrls.auth.password)) {
    // Wait for password page
    debug("Waiting for ME password page...");
    const mePasswordInput = page.locator(SELECTORS.mePassword).first();
    await mePasswordInput.waitFor({ state: "visible", timeout: TIMEOUTS.medium });

    // Enter password
    debug("Entering ME password...");
    await mePasswordInput.fill(password);

    // Click Sign in button
    debug("Clicking Sign in button...");
    await page.locator(SELECTORS.meSignIn).click();

    // Wait for redirect to ME
    debug("Waiting for ME redirect...");
    await page.waitForURL(`${mfUrls.home}**`, { timeout: TIMEOUTS.login });
  } else {
    debug("Already redirected to ME (session exists)");
  }

  log("Login successful!");
}
