const { chromium } = require('playwright');

const CONFIG = {
  basUrl: process.env.BAS_URL,
  btpUser: process.env.BTP_USER,
  btpPassword: process.env.BTP_PASSWORD,
  devSpaceName: process.env.BAS_SPACE_NAME || '',
  stayDurationMs: 60 * 1000,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// 处理 Trial 隐私声明弹窗
// 会先勾选"Do not show this message again"，再点 OK
async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });

    // 勾选"不再显示"，下次就不弹了
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.count() > 0) {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) {
        await checkbox.click();
        log('   ☑️  Checked "Do not show this message again"');
        await page.waitForTimeout(500);
      }
    }

    await page.locator('button:has-text("OK")').first().click();
    log('✅ Dismissed Privacy Statement dialog');
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

// 判断当前 URL 是否已进入编辑器
function isEditorUrl(url) {
  return (
    url.includes('/index.html') ||
    url.includes('/#') ||
    url.includes('/editor/') ||
    (/applicationstudio\.cloud\.sap\/.+/.test(url) && !url.endsWith('.sap/'))
  );
}

async function main() {
  log('=== SAP BAS Auto Login & Keepalive ===');

  if (!CONFIG.basUrl || !CONFIG.btpUser || !CONFIG.btpPassword) {
    log('❌ Missing required env vars: BAS_URL, BTP_USER, BTP_PASSWORD');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  let editorPage = null;

  // 监听新 Tab（点击空间名可能在新窗口打开编辑器）
  context.on('page', async (newPage) => {
    log(`📄 New tab opened: ${newPage.url()}`);
    editorPage = newPage;
  });

  const page = await context.newPage();

  try {
    // ── Step 1: 访问 BAS URL，触发 SSO 跳转 ──
    log('🌐 Navigating to BAS...');
    await page.goto(CONFIG.basUrl, { waitUntil: 'networkidle', timeout: 60000 });
    log(`   URL: ${page.url()}`);

    // ── Step 2: 填写邮箱 ──
    log('📧 Entering email...');
    await page.waitForSelector(
      'input[type="email"], input[name="logonuidfield"], #j_username',
      { timeout: 30000 }
    );
    await page.fill(
      'input[type="email"], input[name="logonuidfield"], #j_username',
      CONFIG.btpUser
    );

    // 部分区域登录页分两步，先输邮箱点 Continue，再输密码
    const continueBtn = page.locator(
      'button:has-text("Continue"), button:has-text("Next"), #continue'
    );
    if (await continueBtn.count() > 0) {
      await continueBtn.first().click();
      await page.waitForTimeout(2000);
    }

    // ── Step 3: 填写密码并提交 ──
    log('🔑 Entering password...');
    await page.waitForSelector(
      'input[type="password"], #j_password',
      { timeout: 20000 }
    );
    await page.fill('input[type="password"], #j_password', CONFIG.btpPassword);
    await page.click(
      'button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")'
    );

    log('   Waiting for redirect to BAS...');
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(`✅ Logged in! URL: ${page.url()}`);

    // ── Step 4: 检查弹窗（空间已运行时，登录后直接弹出）──
    log('🔍 Checking for Privacy Statement dialog (post-login)...');
    const dismissedAfterLogin = await dismissDialog(page, 10000);
    if (!dismissedAfterLogin) log('   ℹ️  No dialog after login, continuing...');

    // ── Step 5: 截图保存列表页状态 ──
    await page.screenshot({ path: '/tmp/bas-list-page.png', fullPage: true });
    log('📸 List page screenshot saved');

    // ── Step 6: 判断是否已直接进入编辑器 ──
    if (isEditorUrl(page.url())) {
      log('🎉 Already inside Dev Space editor (space was running)!');
      // 跳到 Step 9 停留
    } else {
      // ── Step 7: 在列表页点击 Dev Space 名字 ──
      log('📋 On Dev Spaces list, looking for space to click...');
      await page.waitForTimeout(2000);

      let spaceClicked = false;

      // 优先按指定名字精确点击
      if (CONFIG.devSpaceName) {
        log(`🎯 Looking for space: "${CONFIG.devSpaceName}"`);
        const byName = page.locator(`text="${CONFIG.devSpaceName}"`).first();
        if (await byName.count() > 0) {
          await byName.click();
          spaceClicked = true;
          log(`🖱️  Clicked space by name: "${CONFIG.devSpaceName}"`);
        }
      }

      // 备用：按常见选择器找第一个空间
      if (!spaceClicked) {
        const selectors = [
          '.ws-name',
          '[class*="spaceName"]',
          '[class*="devSpaceName"]',
          '[class*="wsName"]',
          '.sapMSLITitle',
          '.sapMListItem .sapMText',
          '[role="row"] [role="gridcell"]:first-child',
        ];

        for (const sel of selectors) {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            const text = await el.textContent().catch(() => '');
            log(`   Found element (${sel}): "${text?.trim()}"`);
            await el.click();
            spaceClicked = true;
            log('🖱️  Clicked Dev Space');
            break;
          }
        }
      }

      if (!spaceClicked) {
        throw new Error(
          'Could not find Dev Space element. Check /tmp/bas-list-page.png screenshot.'
        );
      }

      await page.waitForTimeout(3000);

      // ── Step 8: 检查弹窗（空间停止状态时，点击空间名后弹出）──
      log('🔍 Checking for Privacy Statement dialog (post-click)...');
      const dismissedAfterClick = await dismissDialog(page, 10000);
      if (!dismissedAfterClick) log('   ℹ️  No dialog after click, continuing...');

      // ── Step 9: 等待编辑器加载 ──
      log('⏳ Waiting for editor to load (up to 3 minutes)...');

      const deadline = Date.now() + 180000;
      let editorLoaded = false;
      let activeEditorPage = null;

      while (Date.now() < deadline) {
        // 情况A：当前页跳转到编辑器
        if (isEditorUrl(page.url())) {
          activeEditorPage = page;
          editorLoaded = true;
          log('✅ Editor loaded in current tab');
          break;
        }

        // 情况B：新 Tab 打开了编辑器
        if (editorPage && isEditorUrl(editorPage.url())) {
          activeEditorPage = editorPage;
          editorLoaded = true;
          log('✅ Editor loaded in new tab');
          break;
        }

        // 处理等待过程中可能出现的弹窗
        await dismissDialog(page, 2000);

        log(`   Still waiting... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
        await page.waitForTimeout(5000);
      }

      if (!editorLoaded) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Editor did not load within 3 minutes. Check bas-error.png.');
      }

      log(`🎉 Inside Dev Space! URL: ${activeEditorPage.url()}`);

      // ── Step 10: 停留60秒，确保平台记录活跃状态 ──
      log(`⏳ Staying for ${CONFIG.stayDurationMs / 1000}s to record activity...`);
      await activeEditorPage.waitForTimeout(CONFIG.stayDurationMs);
    }

    log('✅ All done! Dev Space activity recorded successfully.');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true }).catch(() => {});
    log('📸 Error screenshot saved to /tmp/bas-error.png');
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
