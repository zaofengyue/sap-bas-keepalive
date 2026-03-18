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

// 编辑器 URL 子域名格式: {trialId}-{devSpaceId}.{region}.applicationstudio.cloud.sap
// 列表页 URL 子域名格式: {trialId}.{region}.applicationstudio.cloud.sap
function isEditorUrl(url) {
  return /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url);
}

// 处理 Trial 隐私声明弹窗
async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });

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

  let newTabPage = null;
  context.on('page', async (newPage) => {
    log(`📄 New tab opened: ${newPage.url()}`);
    newTabPage = newPage;
  });

  const page = await context.newPage();

  try {
    // ── Step 1: 访问 BAS URL ──
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
    const continueBtn = page.locator(
      'button:has-text("Continue"), button:has-text("Next"), #continue'
    );
    if (await continueBtn.count() > 0) {
      await continueBtn.first().click();
      await page.waitForTimeout(2000);
    }

    // ── Step 3: 填写密码并提交 ──
    log('🔑 Entering password...');
    await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
    await page.fill('input[type="password"], #j_password', CONFIG.btpPassword);
    await page.click(
      'button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")'
    );
    log('   Waiting for redirect to BAS...');
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(`✅ Logged in! URL: ${page.url()}`);

    // ── Step 4: 处理登录后弹窗 ──
    log('🔍 Checking for Privacy Statement dialog (post-login)...');
    const dismissedAfterLogin = await dismissDialog(page, 10000);
    if (!dismissedAfterLogin) log('   ℹ️  No dialog after login');

    // ── Step 5: 截图保存列表页 ──
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/bas-list-page.png', fullPage: true });
    log(`📸 List page screenshot saved. URL: ${page.url()}`);

    // ── Step 6: 找到目标 Dev Space 并点击启动 ──
    log('📋 Looking for Dev Space...');

    // 先找到包含空间名的行，再在那一行里找操作按钮
    let spaceRow = null;

    if (CONFIG.devSpaceName) {
      log(`🎯 Looking for space: "${CONFIG.devSpaceName}"`);
      // 找包含空间名的容器行
      const candidates = [
        page.locator(`.sapMListItem:has-text("${CONFIG.devSpaceName}")`).first(),
        page.locator(`[class*="devSpace"]:has-text("${CONFIG.devSpaceName}")`).first(),
        page.locator(`tr:has-text("${CONFIG.devSpaceName}")`).first(),
        page.locator(`div:has-text("${CONFIG.devSpaceName}")`).nth(1),
      ];
      for (const candidate of candidates) {
        if (await candidate.count() > 0) {
          spaceRow = candidate;
          log(`   Found space row`);
          break;
        }
      }
    }

    // 点击逻辑：优先点击行内的启动/编辑图标，其次点击空间名
    let clicked = false;

    if (spaceRow) {
      // 尝试点击行内的最后一个图标按钮（通常是启动/打开按钮）
      const iconBtns = spaceRow.locator('button, [role="button"], .sapUiIcon, svg');
      const btnCount = await iconBtns.count();
      log(`   Found ${btnCount} buttons/icons in space row`);

      if (btnCount > 0) {
        // 点击最后一个图标（截图中右边的铅笔/编辑图标）
        await iconBtns.last().click();
        clicked = true;
        log('🖱️  Clicked action icon in space row');
      }
    }

    // 备用：直接点击空间名文字
    if (!clicked && CONFIG.devSpaceName) {
      const nameEl = page.locator(`text="${CONFIG.devSpaceName}"`).first();
      if (await nameEl.count() > 0) {
        await nameEl.click();
        clicked = true;
        log(`🖱️  Clicked space name: "${CONFIG.devSpaceName}"`);
      }
    }

    // 再备用：点击第一个可见的空间名（任何文字元素）
    if (!clicked) {
      const selectors = [
        '.ws-name', '[class*="spaceName"]', '[class*="wsName"]',
        '.sapMSLITitle', '.sapMListItem .sapMText',
      ];
      for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const text = await el.textContent().catch(() => '');
          log(`   Fallback click (${sel}): "${text?.trim()}"`);
          await el.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      throw new Error('Could not find Dev Space element. Check bas-list-page.png.');
    }

    await page.waitForTimeout(3000);

    // ── Step 7: 处理点击后弹出的隐私声明弹窗 ──
    log('🔍 Checking for Privacy Statement dialog (post-click)...');
    const dismissedAfterClick = await dismissDialog(page, 10000);
    if (!dismissedAfterClick) log('   ℹ️  No dialog after click');

    // ── Step 8: 等待 Dev Space 启动并进入编辑器（最多5分钟，STOPPED状态启动需要时间）──
    log('⏳ Waiting for Dev Space to start and editor to load (up to 5 minutes)...');
    log('   (Space may need time to start from STOPPED state)');

    const deadline = Date.now() + 300000; // 5分钟
    let editorLoaded = false;
    let activeEditorPage = null;

    while (Date.now() < deadline) {
      const remaining = Math.round((deadline - Date.now()) / 1000);

      // 检查当前页 URL 是否变成编辑器格式
      if (isEditorUrl(page.url())) {
        activeEditorPage = page;
        editorLoaded = true;
        log(`✅ Editor loaded in current tab! URL: ${page.url()}`);
        break;
      }

      // 检查新 Tab
      if (newTabPage) {
        try {
          await newTabPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          if (isEditorUrl(newTabPage.url())) {
            activeEditorPage = newTabPage;
            editorLoaded = true;
            log(`✅ Editor loaded in new tab! URL: ${newTabPage.url()}`);
            break;
          }
        } catch { /* ignore */ }
      }

      // 处理等待过程中可能出现的弹窗
      await dismissDialog(page, 2000);

      log(`   Waiting... URL: ${page.url()} (${remaining}s left)`);
      await page.waitForTimeout(8000);
    }

    if (!editorLoaded) {
      await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
      throw new Error('Editor did not load within 5 minutes. Check bas-error.png.');
    }

    // ── Step 9: 在编辑器内停留60秒 ──
    log(`⏳ Staying in editor for ${CONFIG.stayDurationMs / 1000}s...`);
    await activeEditorPage.waitForTimeout(CONFIG.stayDurationMs);
    await activeEditorPage.screenshot({ path: '/tmp/bas-editor.png' });
    log('📸 Editor screenshot saved');

    log('✅ All done! Dev Space activity recorded successfully.');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true }).catch(() => {});
    log('📸 Error screenshot saved');
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
