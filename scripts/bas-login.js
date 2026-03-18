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

// 编辑器 URL 包含 #ws- 锚点
function isEditorUrl(url) {
  return (
    url.includes('#ws-') ||
    /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url)
  );
}

// 处理各种弹窗，勾选"不再显示"后点 OK
async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count() > 0 && !(await cb.isChecked())) {
      await cb.click();
      await page.waitForTimeout(500);
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
    log('❌ Missing env vars: BAS_URL, BTP_USER, BTP_PASSWORD');
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
    log(`📄 New tab: ${newPage.url()}`);
    newTabPage = newPage;
  });

  const page = await context.newPage();

  try {
    // ── 登录 ──
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
    log(`✅ Logged in`);

    // ── 处理登录后弹窗 ──
    await dismissDialog(page, 10000);

    // ── 等待列表页 iframe 加载 ──
    await page.waitForSelector('iframe#ws-manager', { timeout: 30000 });
    await page.waitForTimeout(3000);

    const frame = page.frameLocator('iframe#ws-manager');
    const isStopped = await frame.locator('a.stoppedStatus').count() > 0;
    const isRunning = await frame.locator('a.hyperlink:not(.disabled)').count() > 0;
    log(`📊 Status: ${isRunning ? 'RUNNING' : isStopped ? 'STOPPED' : 'UNKNOWN'}`);

    if (isStopped) {
      // ── 点击 ▶ 启动按钮 ──
      log('▶️  Starting Dev Space...');
      await frame.locator('#startButton0').click();
      log('✅ Start clicked');
      await page.waitForTimeout(3000);
      await dismissDialog(page, 5000);

      // ── 等待 RUNNING（最多4分钟）──
      log('⏳ Waiting for RUNNING (up to 4 min)...');
      const deadline = Date.now() + 240000;
      let running = false;

      while (Date.now() < deadline) {
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await dismissDialog(page, 3000);
        await page.waitForTimeout(2000);

        const f = page.frameLocator('iframe#ws-manager');
        if (await f.locator('a.hyperlink:not(.disabled)').count() > 0) {
          running = true;
          log('✅ RUNNING!');
          break;
        }
        log(`   Waiting... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
        await page.waitForTimeout(10000);
      }

      if (!running) throw new Error('Space did not reach RUNNING within 4 minutes.');
      await page.waitForTimeout(2000);
    }

    // ── 点击空间名进入编辑器 ──
    log('🖱️  Entering Dev Space...');
    const f = page.frameLocator('iframe#ws-manager');
    const link = f.locator('a.hyperlink:not(.disabled)[href*="#ws-"]').first();

    if (await link.count() > 0) {
      await link.click();
    } else {
      const nameLink = f.locator(`a.hyperlink:not(.disabled):has-text("${CONFIG.devSpaceName}")`).first();
      if (await nameLink.count() > 0) {
        await nameLink.click();
      } else {
        throw new Error('Could not find clickable space link.');
      }
    }

    await page.waitForTimeout(3000);

    // ── 等待编辑器加载（最多3分钟）──
    log('⏳ Waiting for editor...');
    const editorDeadline = Date.now() + 180000;
    let editorLoaded = false;
    let editorPage = null;

    while (Date.now() < editorDeadline) {
      if (isEditorUrl(page.url())) {
        editorPage = page;
        editorLoaded = true;
        break;
      }
      if (newTabPage) {
        try {
          await newTabPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          if (isEditorUrl(newTabPage.url())) {
            editorPage = newTabPage;
            editorLoaded = true;
            break;
          }
        } catch {}
      }
      await dismissDialog(page, 2000);
      log(`   Waiting... (${Math.round((editorDeadline - Date.now()) / 1000)}s left)`);
      await page.waitForTimeout(8000);
    }

    if (!editorLoaded) throw new Error('Editor did not load within 3 minutes.');
    log(`✅ Editor loaded: ${editorPage.url()}`);

    // ── 处理编辑器内弹窗 ──
    try {
      await editorPage.waitForSelector('button:has-text("OK")', { timeout: 8000 });
      const dontShow = editorPage.locator('input[type="checkbox"]').first();
      if (await dontShow.count() > 0 && !(await dontShow.isChecked())) {
        await dontShow.click();
        await editorPage.waitForTimeout(500);
      }
      await editorPage.locator('button:has-text("OK")').first().click();
      log('✅ Dismissed editor dialog');
    } catch {
      log('   ℹ️  No dialog in editor');
    }

    // ── 停留60秒记录活跃状态 ──
    log(`⏳ Staying ${CONFIG.stayDurationMs / 1000}s...`);
    await editorPage.waitForTimeout(CONFIG.stayDurationMs);
    log('✅ Done! Activity recorded.');

  } catch (err) {
    log(`❌ ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
