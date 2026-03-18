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

function isEditorUrl(url) {
  return /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url);
}

async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.count() > 0 && !(await checkbox.isChecked())) {
      await checkbox.click();
      log('   ☑️  Checked "Do not show this message again"');
      await page.waitForTimeout(500);
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

    // ── Step 2: 处理主页面弹窗（Privacy Statement）──
    log('🔍 Checking for Privacy Statement dialog on main page...');
    await dismissDialog(page, 10000);

    // ── Step 3: 等待 iframe#ws-manager 加载完成 ──
    log('⏳ Waiting for ws-manager iframe to load...');
    await page.waitForSelector('iframe#ws-manager', { timeout: 30000 });
    const wsManagerFrame = page.frameLocator('iframe#ws-manager');

    // 等待 iframe 内部内容加载（等待空间列表出现）
    log('⏳ Waiting for Dev Spaces list inside iframe...');
    try {
      // 等待 Loading 消失
      await wsManagerFrame.locator('text=Loading...').waitFor({ timeout: 5000 });
      await wsManagerFrame.locator('text=Loading...').waitFor({ state: 'hidden', timeout: 30000 });
      log('   Loading complete');
    } catch {
      log('   No loading spinner, list may be ready');
    }
    await page.waitForTimeout(2000);

    // 截图确认列表页状态
    await page.screenshot({ path: '/tmp/bas-list-page.png', fullPage: true });
    log('📸 List page screenshot saved');

    // ── Step 4: 在 iframe 内检查空间状态 ──
    const isStopped = await wsManagerFrame.locator('text=STOPPED').count() > 0;
    const isRunning = await wsManagerFrame.locator('text=RUNNING').count() > 0;
    log(`📊 Space status: ${isRunning ? 'RUNNING' : isStopped ? 'STOPPED' : 'UNKNOWN'}`);

    // 打印 iframe 内所有按钮（调试用）
    const iframeButtons = await wsManagerFrame.locator('button, [role="button"]').all();
    log(`   Found ${iframeButtons.length} buttons inside iframe`);
    for (let i = 0; i < iframeButtons.length; i++) {
      const btn = iframeButtons[i];
      const id = await btn.getAttribute('id').catch(() => '');
      const cls = await btn.getAttribute('class').catch(() => '');
      const title = await btn.getAttribute('title').catch(() => '');
      const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
      const text = await btn.innerText().catch(() => '');
      log(`   btn[${i}] id="${id}" title="${title}" aria="${ariaLabel}" class="${(cls||'').substring(0,60)}" text="${text.trim().substring(0,30)}"`);
    }

    if (isStopped) {
      // ── Step 5: 点击 ▶ 启动按钮（在 iframe 内）──
      log('▶️  Space is STOPPED, clicking Start button inside iframe...');
      let startClicked = false;

      // 尝试各种选择器
      const startSelectors = [
        'button[title="Start"]',
        'button[title="Run"]',
        'button[aria-label="Start"]',
        'button[aria-label="Run"]',
        '[title="Start"]',
        '[title="Run"]',
        'button.start-btn',
        'button.run-btn',
        '[class*="start"]',
        '[class*="run-btn"]',
        '[class*="play"]',
      ];

      for (const sel of startSelectors) {
        const el = wsManagerFrame.locator(sel).first();
        if (await el.count() > 0) {
          await el.click();
          startClicked = true;
          log(`✅ Clicked Start button: ${sel}`);
          break;
        }
      }

      // 备用：找 iframe 内右侧区域的第一个按钮
      if (!startClicked) {
        log('   Trying first action button in iframe...');
        // 空间行内的按钮（排除顶部的 Create Dev Space 按钮）
        const allBtns = wsManagerFrame.locator('button');
        const count = await allBtns.count();
        log(`   Total buttons in iframe: ${count}`);

        for (let i = 0; i < count; i++) {
          const btn = allBtns.nth(i);
          const text = await btn.innerText().catch(() => '');
          const cls = await btn.getAttribute('class').catch(() => '');
          // 跳过 "Create Dev Space" 按钮
          if (text.includes('Create') || text.includes('create')) continue;
          // 点击第一个非 Create 的按钮
          await btn.click();
          startClicked = true;
          log(`✅ Clicked button[${i}] class="${cls}" text="${text.trim()}"`);
          break;
        }
      }

      if (!startClicked) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Could not find Start button inside iframe.');
      }

      await page.waitForTimeout(3000);

      // 处理点击后弹窗（在主页面检查）
      await dismissDialog(page, 8000);

      // 截图确认点击效果
      await page.screenshot({ path: '/tmp/bas-after-start.png', fullPage: true });
      log('📸 After-start screenshot saved');

      // ── Step 6: 等待 RUNNING 状态（最多4分钟，轮询刷新页面）──
      log('⏳ Waiting for RUNNING status (up to 4 minutes)...');
      const startDeadline = Date.now() + 240000;
      let isNowRunning = false;

      while (Date.now() < startDeadline) {
        const remaining = Math.round((startDeadline - Date.now()) / 1000);

        // 刷新页面重新检查状态
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await dismissDialog(page, 3000);
        await page.waitForTimeout(2000);

        const frame = page.frameLocator('iframe#ws-manager');
        const runningNow = await frame.locator('text=RUNNING').count() > 0;

        if (runningNow) {
          isNowRunning = true;
          log('✅ Space is now RUNNING!');
          break;
        }

        const starting = await frame.locator('text=STARTING').count() > 0;
        log(`   ${starting ? 'STARTING...' : 'Still waiting...'} (${remaining}s left)`);
        await page.waitForTimeout(10000);
      }

      if (!isNowRunning) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Space did not reach RUNNING within 4 minutes.');
      }

      await page.waitForTimeout(2000);
    }

    // ── Step 7: 点击空间名进入编辑器（在 iframe 内）──
    log('🖱️  Clicking space name to enter editor...');
    const frame = page.frameLocator('iframe#ws-manager');
    let enterClicked = false;

    if (CONFIG.devSpaceName) {
      const nameEl = frame.locator(`text="${CONFIG.devSpaceName}"`).first();
      if (await nameEl.count() > 0) {
        await nameEl.click();
        enterClicked = true;
        log(`✅ Clicked space name: "${CONFIG.devSpaceName}"`);
      }
    }

    if (!enterClicked) {
      const linkSelectors = ['a[class*="name"]', 'a[class*="space"]', 'a', '.space-name', '[class*="wsName"]'];
      for (const sel of linkSelectors) {
        const el = frame.locator(sel).first();
        if (await el.count() > 0) {
          const text = await el.innerText().catch(() => '');
          if (text.includes('Create') || text.includes('documentation') || text.includes('restrictions')) continue;
          await el.click();
          enterClicked = true;
          log(`✅ Clicked: ${sel} ("${text.trim()}")`);
          break;
        }
      }
    }

    if (!enterClicked) {
      await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
      throw new Error('Could not click space name.');
    }

    await page.waitForTimeout(3000);
    await dismissDialog(page, 10000);

    // ── Step 8: 等待编辑器加载（最多3分钟）──
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

    // ── Step 9: 停留60秒记录活跃状态 ──
    log(`⏳ Staying in editor for ${CONFIG.stayDurationMs / 1000}s...`);
    await activeEditorPage.waitForTimeout(CONFIG.stayDurationMs);
    await activeEditorPage.screenshot({ path: '/tmp/bas-editor.png' });
    log('✅ All done! Dev Space activity recorded.');

  } catch (err) {
    log(`❌ Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
