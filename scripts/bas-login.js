const { chromium } = require('playwright');

const CONFIG = {
  basUrl: process.env.BAS_URL,
  btpUser: process.env.BTP_USER,
  btpPassword: process.env.BTP_PASSWORD,
  devSpaceName: process.env.BAS_SPACE_NAME || '',  // 空间名，如 cmliu
  stayDurationMs: 60 * 1000,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// 编辑器 URL: {trialId}-{devSpaceId}.{region}.applicationstudio.cloud.sap
function isEditorUrl(url) {
  return /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url);
}

// 处理 Trial 隐私声明弹窗
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
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), #continue');
    if (await continueBtn.count() > 0) {
      await continueBtn.first().click();
      await page.waitForTimeout(2000);
    }

    // ── Step 3: 填写密码并提交 ──
    log('🔑 Entering password...');
    await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
    await page.fill('input[type="password"], #j_password', CONFIG.btpPassword);
    await page.click('button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")');
    log('   Waiting for redirect...');
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(`✅ Logged in! URL: ${page.url()}`);

    // ── Step 4: 处理登录后弹窗 ──
    log('🔍 Checking for Privacy Statement dialog...');
    await dismissDialog(page, 10000);

    // ── Step 5: 等待列表页完全加载 ──
    log('⏳ Waiting for Dev Spaces list to load...');
    try {
      await page.waitForSelector('text=Loading...', { timeout: 5000 });
      await page.waitForSelector('text=Loading...', { state: 'hidden', timeout: 30000 });
      log('   Loading complete');
    } catch {
      log('   List appears ready');
    }
    await page.waitForTimeout(2000);

    // 截图：列表页
    await page.screenshot({ path: '/tmp/bas-list-page.png', fullPage: true });
    log('📸 List page screenshot saved');

    // ── Step 6: 检查空间当前状态 ──
    log('🔍 Checking Dev Space status...');

    const isRunning = await page.locator('text=RUNNING').count() > 0;
    const isStopped = await page.locator('text=STOPPED').count() > 0;
    log(`   Status: ${isRunning ? 'RUNNING' : isStopped ? 'STOPPED' : 'UNKNOWN'}`);

    if (isStopped) {
      // ── Step 7a: 空间是 STOPPED，点击 ▶ 启动按钮 ──
      log('▶️  Space is STOPPED, clicking Start button...');

      // 启动按钮是行右侧的第一个圆形图标按钮（▶）
      // 根据截图，按钮选择器尝试顺序：
      let startClicked = false;

      // 方法1：找 title 或 aria-label 含 Start 的按钮
      const startBtnByLabel = page.locator(
        'button[title*="Start"], button[aria-label*="Start"], [title*="Start"], [aria-label*="Start"]'
      ).first();
      if (await startBtnByLabel.count() > 0) {
        await startBtnByLabel.click();
        startClicked = true;
        log('   ✅ Clicked Start button (by aria-label)');
      }

      // 方法2：找包含 ▶ 的 SVG 图标按钮（播放图标）
      if (!startClicked) {
        const svgBtns = page.locator('button svg, [role="button"] svg');
        const count = await svgBtns.count();
        log(`   Found ${count} SVG icon buttons`);
        // 遍历找到播放图标（circle + polygon/path 组合）
        for (let i = 0; i < count; i++) {
          const btn = svgBtns.nth(i);
          const parent = btn.locator('..');
          const html = await parent.innerHTML().catch(() => '');
          if (html.includes('circle') || html.includes('play') || html.includes('start')) {
            await parent.click();
            startClicked = true;
            log(`   ✅ Clicked Start button (SVG index ${i})`);
            break;
          }
        }
      }

      // 方法3：找行内所有按钮，点击第一个（截图显示▶是最左边的操作按钮）
      if (!startClicked) {
        // 先找包含 STOPPED 文字的行
        const stoppedRow = page.locator(':has-text("STOPPED")').last();
        if (await stoppedRow.count() > 0) {
          const btnsInRow = stoppedRow.locator('button, [role="button"]');
          const btnCount = await btnsInRow.count();
          log(`   Found ${btnCount} buttons in STOPPED row`);
          if (btnCount > 0) {
            await btnsInRow.first().click();
            startClicked = true;
            log('   ✅ Clicked first button in STOPPED row');
          }
        }
      }

      if (!startClicked) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Could not find Start button. Check bas-list-page.png.');
      }

      // ── Step 8: 等待状态从 STOPPED 变为 RUNNING ──
      log('⏳ Waiting for space to start (STOPPED → RUNNING)...');
      await page.waitForTimeout(3000);

      // 处理可能出现的弹窗
      await dismissDialog(page, 5000);

      // 轮询等待 RUNNING 状态出现（最多4分钟）
      const startDeadline = Date.now() + 240000;
      let isNowRunning = false;

      while (Date.now() < startDeadline) {
        const remaining = Math.round((startDeadline - Date.now()) / 1000);
        const runningCount = await page.locator('text=RUNNING').count();
        const stoppingCount = await page.locator('text=STARTING').count();

        if (runningCount > 0) {
          isNowRunning = true;
          log('✅ Space is now RUNNING!');
          break;
        }

        log(`   Still starting... (${remaining}s left, STARTING indicators: ${stoppingCount})`);
        await dismissDialog(page, 2000);
        await page.waitForTimeout(8000);
      }

      if (!isNowRunning) {
        await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
        throw new Error('Space did not reach RUNNING state within 4 minutes.');
      }

      await page.waitForTimeout(2000);

      // ── Step 9: 空间变为 RUNNING，点击空间名进入编辑器 ──
      log('🖱️  Space is RUNNING, clicking space name to enter editor...');

    } else if (isRunning) {
      log('✅ Space is already RUNNING, clicking to enter editor...');
    } else {
      log('⚠️  Unknown status, attempting to click space name...');
    }

    // ── Step 10: 点击空间名（已变成蓝色可点击状态）──
    let enterClicked = false;

    if (CONFIG.devSpaceName) {
      const nameEl = page.locator(`text="${CONFIG.devSpaceName}"`).first();
      if (await nameEl.count() > 0) {
        await nameEl.click();
        enterClicked = true;
        log(`🖱️  Clicked space name: "${CONFIG.devSpaceName}"`);
      }
    }

    if (!enterClicked) {
      // 备用：找蓝色链接或可点击的空间名
      const selectors = [
        'a[class*="spaceName"]', 'a[class*="wsName"]',
        '.ws-name a', '[class*="devSpaceName"] a',
        '.sapMLnk', 'a.sapMText',
      ];
      for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const text = await el.textContent().catch(() => '');
          log(`   Clicking (${sel}): "${text?.trim()}"`);
          await el.click();
          enterClicked = true;
          break;
        }
      }
    }

    if (!enterClicked) {
      await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
      throw new Error('Could not click space name to enter editor.');
    }

    await page.waitForTimeout(3000);

    // ── Step 11: 处理进入时的弹窗 ──
    await dismissDialog(page, 10000);

    // ── Step 12: 等待编辑器加载（最多3分钟）──
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
            log(`✅ Editor loaded in new tab! URL: ${newTabPage.url()}`);
            break;
          }
        } catch { /* ignore */ }
      }

      await dismissDialog(page, 2000);
      log(`   Waiting for editor URL... (${remaining}s left)`);
      await page.waitForTimeout(8000);
    }

    if (!editorLoaded) {
      await page.screenshot({ path: '/tmp/bas-error.png', fullPage: true });
      throw new Error('Editor did not load within 3 minutes.');
    }

    // ── Step 13: 在编辑器内停留60秒 ──
    log(`⏳ Staying in editor for ${CONFIG.stayDurationMs / 1000}s...`);
    await activeEditorPage.waitForTimeout(CONFIG.stayDurationMs);
    await activeEditorPage.screenshot({ path: '/tmp/bas-editor.png' });
    log('📸 Editor screenshot saved');
    log('✅ All done! Dev Space is running and activity recorded.');

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
