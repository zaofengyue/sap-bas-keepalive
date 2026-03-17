const axios = require('axios');

const {
  BTP_USER,
  BTP_PASSWORD,
  BTP_SUBDOMAIN,
  BAS_URL,
} = process.env;

// BTP UAA Token 获取
async function getToken() {
  const tokenUrl = `https://${BTP_SUBDOMAIN}.authentication.eu10.hana.ondemand.com/oauth/token`;
  
  const params = new URLSearchParams({
    grant_type: 'password',
    username: BTP_USER,
    password: BTP_PASSWORD,
    client_id: 'sb-bas-ui!t3',
  });

  const res = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });

  return res.data.access_token;
}

// 访问 BAS 首页以触发唤醒（最简单有效的方式）
async function pingBAS(token) {
  console.log(`🔍 Pinging BAS: ${BAS_URL}`);
  
  const res = await axios.get(BAS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (BAS-Keepalive-Bot)',
    },
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
  });

  console.log(`✅ BAS responded with status: ${res.status}`);
  return res.status;
}

// 备用方案：直接 HTTP 访问（无需 token，适合公开订阅）
async function pingBASSimple() {
  console.log(`🔍 Simple ping to: ${BAS_URL}`);
  
  const res = await axios.get(BAS_URL, {
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
  });

  console.log(`✅ BAS responded with status: ${res.status}`);
  return res.status;
}

async function main() {
  console.log(`⏰ ${new Date().toISOString()} - Starting BAS keepalive`);
  
  try {
    let status;

    if (BTP_USER && BTP_PASSWORD) {
      // 有凭证：获取token后访问
      const token = await getToken();
      console.log('🔑 Token acquired');
      status = await pingBAS(token);
    } else {
      // 无凭证：直接 ping
      status = await pingBASSimple();
    }

    if (status >= 200 && status < 400) {
      console.log('🟢 BAS is alive!');
    } else {
      console.log(`🟡 BAS returned ${status}, may still be waking up`);
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    // 不以非零退出，避免 Actions 报错发邮件
    process.exit(0);
  }
}

main();
