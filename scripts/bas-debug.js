const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // 登录
  await page.goto(process.env.BAS_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('input[type="email"], input[name="logonuidfield"], #j_username', { timeout: 30000 });
  await page.fill('input[type="email"], input[name="logonuidfield"], #j_username', process.env.BTP_USER);
  const btn = page.locator('button:has-text("Continue"), button:has-text("Next"), #continue');
  if (await btn.count() > 0) { await btn.first().click(); await page.waitForTimeout(2000); }
  await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
  await page.fill('input[type="password"], #j_password', process.env.BTP_PASSWORD);
  await page.click('button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")');
  await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
  console.log('Logged in:', page.url());

  // 处理弹窗
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: 8000 });
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count() > 0 && !(await cb.isChecked())) await cb.click();
    await page.locator('button:has-text("OK")').first().click();
    await page.waitForTimeout(1500);
  } catch {}

  // 等 iframe 加载
  await page.waitForSelector('iframe#ws-manager', { timeout: 30000 });
  await page.waitForTimeout(5000);

  // 取 iframe 内完整 HTML
  const frame = page.frameLocator('iframe#ws-manager');
  const html = await frame.locator('body').innerHTML().catch(() => 'failed');

  console.log('\n=== IFRAME INNER HTML ===');
  console.log(html);
  console.log('=== END IFRAME HTML ===');

  await page.screenshot({ path: '/tmp/bas-debug-list.png', fullPage: true });
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
