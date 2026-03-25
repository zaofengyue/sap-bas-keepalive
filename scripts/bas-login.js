const { chromium } = require('playwright');

// 从环境变量解析多账号配置，以 ; 分隔
function parseAccounts() {
  const urls      = (process.env.BAS_URL       || '').split(';').map(s => s.trim()).filter(Boolean);
  const users     = (process.env.BTP_USER      || '').split(';').map(s => s.trim()).filter(Boolean);
  const passwords = (process.env.BTP_PASSWORD  || '').split(';').map(s => s.trim()).filter(Boolean);
  const spaces    = (process.env.BAS_SPACE_NAME|| '').split(';').map(s => s.trim()).filter(Boolean);

  if (urls.length === 0) {
    console.error('❌ BAS_URL is not set.');
    process.exit(1);
  }

  return urls.map((basUrl, i) => ({
    basUrl,
    user:      users[i]     || users[0],
    password:  passwords[i] || passwords[0],
    spaceName: spaces[i]    || spaces[0] || '',
  }));
}

const ACCOUNTS = parseAccounts();
const STAY_MS = 60 * 1000;

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function isEditorUrl(url) {
  return (
    url.includes('#ws-') ||
    /-[a-z0-9]+\.[a-z0-9]+\.applicationstudio\.cloud\.sap/.test(url)
  );
}

async function dismissDialog(page, timeoutMs = 8000) {
  try {
    await page.waitForSelector('button:has-text("OK")', { timeout: timeoutMs });
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count() > 0 && !(await cb.isChecked())) {
      await cb.click();
      await page.waitForTimeout(500);
    }
    await page.locator('button:has-text("OK")').first().click();
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

async function keepAliveOne(account, index) {
  const { basUrl, user, password, spaceName } = account;
  const tag = `Account${index + 1}`;

  log(tag, `=== Starting keepalive (${spaceName || user}) ===`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  let newTabPage = null;
  context.on('page', async (newPage) => { newTabPage = newPage; });

  const page = await context.newPage();

  try {
    // ── 登录 ──
    log(tag, '🌐 Navigating...');
    await page.goto(basUrl, { waitUntil: 'networkidle', timeout: 60000 });

    log(tag, '📧 Entering email...');
    await page.waitForSelector('input[type="email"], input[name="logonuidfield"], #j_username', { timeout: 30000 });
    await page.fill('input[type="email"], input[name="logonuidfield"], #j_username', user);
    const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), #continue');
    if (await continueBtn.count() > 0) { await continueBtn.first().click(); await page.waitForTimeout(2000); }

    log(tag, '🔑 Entering password...');
    await page.waitForSelector('input[type="password"], #j_password', { timeout: 20000 });
    await page.fill('input[type="password"], #j_password', password);
    await page.click('button[type="submit"], #logOnFormSubmit, button:has-text("Sign In"), button:has-text("Log On")');
    await page.waitForURL(/applicationstudio\.cloud\.sap/, { timeout: 60000 });
    log(tag, '✅ Logged in');

    // ── 处理弹窗 ──
    await dismissDialog(page, 10000);

    // ── 等待列表页 iframe ──
    await page.waitForSelector('iframe#ws-manager', { timeout: 30000 });
    await page.waitForTimeout(3000);

    const frame = page.frameLocator('iframe#ws-manager');
    const isStopped = await frame.locator('a.stoppedStatus').count() > 0;
    const isRunning = await frame.locator('a.hyperlink:not(.disabled)').count() > 0;
    log(tag, `📊 Status: ${isRunning ? 'RUNNING' : isStopped ? 'STOPPED' : 'UNKNOWN'}`);

    if (isStopped) {
      // ── 启动空间 ──
      log(tag, '▶️  Starting Dev Space...');
      await frame.locator('#startButton0').click();
      log(tag, '✅ Start clicked');
      await page.waitForTimeout(3000);
      await dismissDialog(page, 5000);

      // ── 等待 RUNNING（最多4分钟）──
      log(tag, '⏳ Waiting for RUNNING...');
      const deadline = Date.now() + 240000;
      let running = false;

      while (Date.now() < deadline) {
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await dismissDialog(page, 3000);
        await page.waitForTimeout(2000);
        const f = page.frameLocator('iframe#ws-manager');
        if (await f.locator('a.hyperlink:not(.disabled)').count() > 0) {
          running = true;
          log(tag, '✅ RUNNING!');
          break;
        }
        log(tag, `   Waiting... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
        await page.waitForTimeout(10000);
      }

      if (!running) throw new Error('Space did not reach RUNNING within 4 minutes.');
      await page.waitForTimeout(2000);
    }

    // ── 进入编辑器 ──
    log(tag, '🖱️  Entering Dev Space...');
    const f = page.frameLocator('iframe#ws-manager');
    const link = f.locator('a.hyperlink:not(.disabled)[href*="#ws-"]').first();

    if (await link.count() > 0) {
      await link.click();
    } else if (spaceName) {
      const nameLink = f.locator(`a.hyperlink:not(.disabled):has-text("${spaceName}")`).first();
      if (await nameLink.count() > 0) {
        await nameLink.click();
      } else {
        throw new Error('Could not find clickable space link.');
      }
    } else {
      throw new Error('Could not find clickable space link.');
    }

    await page.waitForTimeout(3000);

    // ── 等待编辑器加载（最多3分钟）──
    log(tag, '⏳ Waiting for editor...');
    const editorDeadline = Date.now() + 180000;
    let editorLoaded = false;
    let editorPage = null;

    while (Date.now() < editorDeadline) {
      if (isEditorUrl(page.url())) { editorPage = page; editorLoaded = true; break; }
      if (newTabPage) {
        try {
          await newTabPage.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
          if (isEditorUrl(newTabPage.url())) { editorPage = newTabPage; editorLoaded = true; break; }
        } catch {}
      }
      await dismissDialog(page, 2000);
      log(tag, `   Waiting... (${Math.round((editorDeadline - Date.now()) / 1000)}s left)`);
      await page.waitForTimeout(8000);
    }

    if (!editorLoaded) throw new Error('Editor did not load within 3 minutes.');
    log(tag, '✅ Editor loaded');

    // ── 处理编辑器内弹窗 ──
    try {
      await editorPage.waitForSelector('button:has-text("OK")', { timeout: 8000 });
      const dontShow = editorPage.locator('input[type="checkbox"]').first();
      if (await dontShow.count() > 0 && !(await dontShow.isChecked())) {
        await dontShow.click();
        await editorPage.waitForTimeout(500);
      }
      await editorPage.locator('button:has-text("OK")').first().click();
    } catch {}

    // ── 停留60秒 ──
    log(tag, `⏳ Staying ${STAY_MS / 1000}s...`);
    await editorPage.waitForTimeout(STAY_MS);
    log(tag, '✅ Done! Activity recorded.');

  } catch (err) {
    log(tag, `❌ ${err.message}`);
    // 单个账号失败不影响其他账号继续执行
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`\n🚀 Starting keepalive for ${ACCOUNTS.length} account(s)...\n`);

  for (let i = 0; i < ACCOUNTS.length; i++) {
    await keepAliveOne(ACCOUNTS[i], i);
    if (i < ACCOUNTS.length - 1) await new Promise(r => setTimeout(r, 5000));
  }

  console.log('\n✅ All accounts processed.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
