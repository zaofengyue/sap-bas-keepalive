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

// 编辑器 URL 包含 #ws- 锚点，如 index.html#ws-pt9rm
// 或子域名带 devSpaceId: {trialId}-{devSpaceId}.{region}.applicationstudio.cloud.sap
function isEditorUrl(url) {
  return (
    url.includes('#ws-') ||
    /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url)
  );
}

async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });
    const checkbox = page.locator('input[type="checkbox"], input[type="checkbox"] + label').first();
    if (await checkbox.count() > 0) {
      const cb = page.locator('input[type="checkbox"]').first();
      if (!(await cb.isChecked())) {
        await cb.click();
        log('   ☑️  Checked checkbox');
        await page.waitForTimeout(500);
      }
    }
    await page.locator('button:has-text("OK")').first().click();
    log('✅ Dismissed dialog');
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
    // ── Step 1: 登录 ──
    log('🌐 Navigating to BAS...');
    await page.goto(CONFIG.basUrl, { waitUntil: 'networkidle', timeout: 60000 });

    log('📧 Entering email...');
    await page.waitForSelector('input[type="email"], input[name="logonuidfield"], #j_username', { timeout: 30000 });
    await page.fill('input[type="email"], input[name="logonuidfield"], #j_username', CONFIG.btpUser);
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), #continue');
    if (await continueBtn.count() > 0) { await continueBtn.first().click(); await page.waitForTimeout(2000); }

    log('🔑 Entering password...');
    await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
    await page.fill('input[type="password"], #j_password', CONFIG.btpPassword);
    await page.click('button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")');
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(`✅ Logged in! URL: ${page.url()}`);

    // ── Step 2: 处理主页面弹窗 ──
    await dismissDialog(page, 10000);

    // ── Step 3: 等待 iframe 加载 ──
    log('⏳ Waiting for ws-manager iframe...');
    await page.waitForSelector('iframe#ws-manager', { timeout: 30000 });
    await page.waitForTimeout(3000);

    const frame = page.frameLocator('iframe#ws-manager');

    // ── Step 4: 检查空间状态 ──
    const isStopped = await frame.locator('a.stoppedStatus, .stoppedStatus').count() > 0;
    const isRunning = await frame.locator('a.hyperlink:not(.disabled)').count() > 0;
    log(`📊 Space status: ${isRunning ? 'RUNNING' : isStopped ? 'STOPPED' : 'UNKNOWN'}`);
    await page.screenshot({ path: '/tmp/bas-list-page.png', fullPage: true });

    if (isStopped) {
      // ── Step 5: 点击 ▶ 启动按钮 ──
      log('▶️  Clicking Start button (#startButton0)...');
      await frame.locator('#startButton0').click();
      log('✅ Start button clicked!');
      await page.waitForTimeout(3000);
      await dismissDialog(page, 5000);
      await page.screenshot({ path: '/tmp/bas-after-start.png', fullPage: true });

      // ── Step 6: 等待 RUNNING（最多4分钟）──
      log('⏳ Waiting for RUNNING status (up to 4 minutes)...');
      const startDeadline = Date.now() + 240000;
      let isNowRunning = false;

      while (Date.now() < startDeadline) {
        const remaining = Math.round((startDeadline - Date.now()) / 1000);
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await dismissDialog(page, 3000);
        await page.waitForTimeout(2000);

        const f = page.frameLocator('iframe#ws-manager');
        if (await f.locator('a.hyperlink:not(.disabled)').count() > 0) {
          isNowRunning = true;
          log('✅ Space is now RUNNING!');
          break;
        }
        const starting = await f.locator('text=STARTING').count() > 0;
        log(`   ${starting ? 'STARTING...' : 'Still STOPPED...'} (${remaining}s left)`);
        await page.waitForTimeout(10000);
      }

      if (!isNowRunning) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Space did not reach RUNNING within 4 minutes.');
      }
      await page.waitForTimeout(2000);
    }

    // ── Step 7: 点击空间名进入编辑器 ──
    log('🖱️  Clicking space name to enter editor...');
    const f = page.frameLocator('iframe#ws-manager');
    const spaceLink = f.locator('a.hyperlink:not(.disabled)[href*="#ws-"]').first();

    if (await spaceLink.count() > 0) {
      await spaceLink.click();
      log('✅ Clicked space link');
    } else {
      const nameLink = f.locator(`a.hyperlink:not(.disabled):has-text("${CONFIG.devSpaceName}")`).first();
      if (await nameLink.count() > 0) {
        await nameLink.click();
        log(`✅ Clicked space name: "${CONFIG.devSpaceName}"`);
      } else {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Could not find clickable space link.');
      }
    }

    await page.waitForTimeout(3000);

    // ── Step 8: 等待编辑器加载（最多3分钟）──
    // URL 格式: index.html#ws-pt9rm 或 {trialId}-{devSpaceId}.xxx.applicationstudio.cloud.sap
    log('⏳ Waiting for editor to load...');
    const editorDeadline = Date.now() + 180000;
    let editorLoaded = false;
    let activeEditorPage = null;

    while (Date.now() < editorDeadline) {
      const remaining = Math.round((editorDeadline - Date.now()) / 1000);

      if (isEditorUrl(page.url())) {
        activeEditorPage = page;
        editorLoaded = true;
        log(`✅ Editor loaded! URL: ${page.url()}`);
        break;
      }

      if (newTabPage) {
        try {
          await newTabPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          if (isEditorUrl(newTabPage.url())) {
            activeEditorPage = newTabPage;
            editorLoaded = true;
            log(`✅ Editor in new tab! URL: ${newTabPage.url()}`);
            break;
          }
        } catch {}
      }

      await dismissDialog(page, 2000);
      log(`   Waiting... (${remaining}s left) URL: ${page.url()}`);
      await page.waitForTimeout(8000);
    }

    if (!editorLoaded) {
      await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
      throw new Error('Editor did not load within 3 minutes.');
    }

    // ── Step 9: 处理编辑器内弹窗（tracking 提示等）──
    log('🔍 Handling any dialogs inside editor...');
    // 编辑器内的 OK 按钮（tracking 弹窗）
    try {
      await activeEditorPage.waitForSelector('button:has-text("OK")', { timeout: 8000 });
      // 勾选 "Don't show this page again"
      const dontShow = activeEditorPage.locator('input[type="checkbox"]').first();
      if (await dontShow.count() > 0 && !(await dontShow.isChecked())) {
        await dontShow.click();
        log('   ☑️  Checked "Don\'t show this page again"');
        await activeEditorPage.waitForTimeout(500);
      }
      await activeEditorPage.locator('button:has-text("OK")').first().click();
      log('✅ Dismissed editor dialog');
      await activeEditorPage.waitForTimeout(1000);
    } catch {
      log('   ℹ️  No dialog in editor');
    }

    // ── Step 10: 停留60秒记录活跃状态 ──
    log(`⏳ Staying in editor for ${CONFIG.stayDurationMs / 1000}s...`);
    await activeEditorPage.waitForTimeout(CONFIG.stayDurationMs);
    await activeEditorPage.screenshot({ path: '/tmp/bas-editor.png' });
    log('✅ All done! Dev Space is running and activity recorded.');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
