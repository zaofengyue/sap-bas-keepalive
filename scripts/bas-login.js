const { chromium } = require('playwright');

const CONFIG = {
  basUrl: process.env.BAS_URL,
  btpUser: process.env.BTP_USER,
  btpPassword: process.env.BTP_PASSWORD,
  // 登录后在 Dev Space 内停留时间（毫秒），让平台记录活跃状态
  stayDurationMs: 60 * 1000,
};

async function main() {
  log('=== SAP BAS Auto Login ===');

  if (!CONFIG.basUrl || !CONFIG.btpUser || !CONFIG.btpPassword) {
    log('❌ Missing env vars: BAS_URL, BTP_USER, BTP_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    // ── Step 1: 访问 BAS URL，触发 SSO 跳转 ──
    log('🌐 Navigating to BAS...');
    await page.goto(CONFIG.basUrl, { waitUntil: 'networkidle', timeout: 60000 });
    log(`   Current URL: ${page.url()}`);

    // ── Step 2: 填写邮箱 ──
    log('📧 Entering email...');
    await page.waitForSelector('input[type="email"], input[name="logonuidfield"], #j_username', {
      timeout: 30000,
    });

    await page.fill(
      'input[type="email"], input[name="logonuidfield"], #j_username',
      CONFIG.btpUser
    );

    // 点击 Continue / Next（不同区域按钮文字可能不同）
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), #continue, input[type="submit"]');
    if (await continueBtn.count() > 0) {
      await continueBtn.first().click();
      await page.waitForTimeout(2000);
    }

    // ── Step 3: 填写密码 ──
    log('🔑 Entering password...');
    await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
    await page.fill('input[type="password"], #j_password', CONFIG.btpPassword);

    // 点击登录按钮
    await page.click('button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")');
    log('   Login submitted, waiting for redirect...');

    // ── Step 4: 等待跳转回 BAS ──
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(`✅ Logged in! URL: ${page.url()}`);

    // ── Step 5: 检查是否已在 Dev Space 内 ──
    const currentUrl = page.url();

    if (currentUrl.includes('/index.html') || currentUrl.endsWith('.sap/')) {
      // 已经进入 Dev Space 编辑器
      log('🎉 Already inside Dev Space editor!');
    } else {
      // 在 Dev Spaces 列表页，需要点击进入
      log('📋 On Dev Spaces list page, looking for space...');

      // 等待列表加载
      await page.waitForSelector('.dev-space-item, [class*="devSpace"], .sapMListItem', {
        timeout: 30000,
      });

      // 找到 RUNNING 状态的空间并点击 Open
      const openBtn = page.locator('button:has-text("Open"), a:has-text("Open")').first();

      if (await openBtn.count() > 0) {
        log('🖱️  Clicking Open button...');
        await openBtn.click();
      } else {
        // 尝试点击 Dev Space 名称
        log('🖱️  Clicking Dev Space name...');
        await page.locator('.dev-space-item, [class*="devSpace"]').first().click();
      }

      // 等待进入编辑器（URL 变化或出现编辑器元素）
      await page.waitForURL(/index\.html|\.sap\/#/, { timeout: 120000 });
      log(`🎉 Entered Dev Space! URL: ${page.url()}`);
    }

    // ── Step 6: 在空间内停留一段时间，确保平台记录活跃 ──
    log(`⏳ Staying in Dev Space for ${CONFIG.stayDurationMs / 1000}s...`);
    await page.waitForTimeout(CONFIG.stayDurationMs);

    log('✅ Done! Dev Space activity recorded successfully.');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    // 截图保存，方便排查
    await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
    log('📸 Screenshot saved to /tmp/bas-error.png');
    throw err;
  } finally {
    await browser.close();
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
