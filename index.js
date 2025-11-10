// sms-bot.js
const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const countryEmoji = require("country-emoji");

// === CONFIG ===
const BOT1_TOKEN = process.env.BOT1_TOKEN || "8038496658:AAH56cp1BgeEmneJCOcDp72gtQ0iQ8lfvdA";
const BOT1_CHATID = process.env.BOT1_CHATID || "-1002391889544";
const BOT2_TOKEN = process.env.BOT2_TOKEN || "8430148380:AAF3yvkNPJYGoZwmwxoJh9qguMDpwIzHViw";
const BOT2_CHATID = process.env.BOT2_CHATID || "-1002789126504";

const BOT_LIST = [
  { token: BOT1_TOKEN, chatId: BOT1_CHATID },
  { token: BOT2_TOKEN, chatId: BOT2_CHATID },
];

// === TARGET SITE ===
const BASE_URL = process.env.BASE_URL || "https://d-group.stats.direct";
const LOGIN_PATH = "/user-management/auth/login";
const SMS_PATH = "/sms-records/index";

// === CREDENTIALS ===
const USERNAME = process.env.SMS_USER || "Smartmethod";
const PASSWORD = process.env.SMS_PASS || "Smartmethod904";

// === INIT ===
const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

// Telegram bots init
const bots = BOT_LIST.map(cfg => ({
  bot: new TelegramBot(cfg.token, { polling: false }),
  chatId: cfg.chatId
}));

let lastId = null;
let lastMsgText = "";

// === OTP Extract ===
function extractOtp(text) {
  if (!text) return null;

  // 1️⃣ Try 3-3 pattern like 123-456 or 123 456
  const dashPattern = text.match(/\b\d{3}[-\s]?\d{3}\b/);
  if (dashPattern) return dashPattern[0].replace(/\D/g, "");

  // 2️⃣ Try continuous 6–8 digits
  const continuous = text.match(/\b\d{6,8}\b/);
  if (continuous) return continuous[0];

  // 3️⃣ Try 4–5 digits (some local OTPs)
  const short = text.match(/\b\d{4,5}\b/);
  if (short) return short[0];

  return null;
}

// === COUNTRY DETECT ===
function getCountryInfo(number) {
  if (!number) return "Unknown 🌍";
  let s = String(number).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!s.startsWith("+")) s = "+" + s;

  try {
    const phone = parsePhoneNumberFromString(s);
    if (phone && phone.country) {
      const iso = phone.country;
      const name = countryEmoji.name(iso) || iso;
      const flag = countryEmoji.flag(iso) || "🌍";
      return `${name} ${flag}`;
    }
  } catch {
    return "Unknown 🌍";
  }
  return "Unknown 🌍";
}

// === ESCAPE HTML FOR TELEGRAM ===
function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === SEND TO TELEGRAM ===
async function sendTelegramSMS(sms) {
  const otp = extractOtp(sms.message) || "N/A";
  const safeMsg = escapeHTML(sms.message || "");
  const safeCli = escapeHTML(sms.cli || "");
  const safeNum = escapeHTML(sms.number || "");

  const final = `<b>${sms.country} ${safeCli} OTP Received...</b>

📞 <b>Number:</b> <code>${safeNum}</code>
🔑 <b>𝐘𝐨𝐮𝐫 𝐎𝐓𝐏:</b> <code>${otp}</code>
🌍 <b>𝐂𝐨𝐮𝐧𝐭𝐫𝐲:</b> ${sms.country}
📱 <b>𝐒𝐞𝐫𝐯𝐢𝐜𝐞:</b> ${safeCli}
📆 <b>Date:</b> ${sms.date}

💬 <b>𝐅𝐮𝐥𝐥 𝐒𝐌𝐒:</b>
<pre>${safeMsg}</pre>`;

  for (const { bot, chatId } of bots) {
    try {
      await bot.sendMessage(chatId, final, { parse_mode: "HTML" });
    } catch (err) {
      if (err.message.includes("Unauthorized")) {
        console.warn(`⚠️ Bot token invalid for chat ${chatId}. Skipping.`);
      } else {
        console.error("Telegram send error:", err.message);
      }
    }
  }
}

// === LOGIN (CSRF SAFE + CLOUDFLARE COMPATIBLE) ===
async function performLogin() {
  console.log("🔐 Logging in to d-group.stats.direct...");

  try {
    // Step 1: GET login page to collect cookies + CSRF
    const getRes = await client.get(`${BASE_URL}${LOGIN_PATH}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL,
        "Connection": "keep-alive",
      },
      validateStatus: s => s >= 200 && s < 400,
    });

    const $ = cheerio.load(String(getRes.data || ""));
    const csrfToken = $('input[name="_csrf-frontend"]').val() || $('meta[name="csrf-token"]').attr("content");

    if (!csrfToken) {
      console.error("❌ Couldn't find CSRF token on login page!");
      return false;
    }

    console.log("✅ CSRF token found:", csrfToken.slice(0, 10) + "...");

    await new Promise(r => setTimeout(r, 1000)); // mimic human delay

    // Step 2: POST login form
    const params = new URLSearchParams();
    params.append("_csrf-frontend", csrfToken);
    params.append("LoginForm[username]", USERNAME);
    params.append("LoginForm[password]", PASSWORD);
    params.append("LoginForm[rememberMe]", "0");

    const postRes = await client.post(`${BASE_URL}${LOGIN_PATH}`, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": BASE_URL,
        "Referer": `${BASE_URL}${LOGIN_PATH}`,
        "Connection": "keep-alive",
      },
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
    });

    console.log("Login POST status:", postRes.status);

    if (postRes.status === 302 || postRes.status === 303) {
      console.log("✅ Login successful (redirect).");
      return true;
    }

    const body = String(postRes.data || "");
    if (postRes.status === 200 && !/LoginForm|login/i.test(body)) {
      console.log("✅ Login successful (no login form found).");
      return true;
    }

    console.warn("❌ Login seems to have failed (still login page).");
    return false;
  } catch (err) {
    console.error("❌ Login failed:", err.message);
    if (err.response && err.response.status === 403) {
      console.log("🚫 Server blocked the request (403). Try slower intervals or proxy.");
    }
    return false;
  }
}

// === FETCH SMS PAGE ===
async function fetchSmsPageHtml() {
  try {
    const res = await client.get(`${BASE_URL}${SMS_PATH}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Referer": `${BASE_URL}${SMS_PATH}`,
      },
      validateStatus: s => s >= 200 && s < 400,
    });
    return String(res.data || "");
  } catch (err) {
    console.error("Fetch SMS page error:", err.message);
    return null;
  }
}

// === PARSE LATEST SMS ===
function parseLatestSmsFromHtml(html) {
  const $ = cheerio.load(html);
  const table = $("table").first();
  if (!table.length) return null;

  const headers = [];
  table.find("thead tr th").each((i, th) => headers.push($(th).text().trim().toLowerCase()));

  function idx(name) {
    return headers.findIndex(h => h.includes(name));
  }

  const idxDate = idx("date");
  const idxSource = idx("source");
  const idxDest = idx("destination");
  const idxMsg = idx("message");
  const idxRef = idx("ref");

  const row = table.find("tbody tr").first();
  if (!row.length) return null;

  const cols = row.find("td").map((i, el) => $(el).text().trim()).get();
  return {
    id: cols[idxRef] || cols[idxDest] || Date.now(),
    date: cols[idxDate] || "",
    number: cols[idxDest] || "",
    cli: cols[idxSource] || "",
    message: cols[idxMsg] || "",
    country: getCountryInfo(cols[idxDest]),
  };
}

// === WORKER LOOP (auto retry + rate limit safe) ===
async function startWorker() {
  const ok = await performLogin();
  if (!ok) return console.error("Login failed — aborting.");

  console.log("✅ Login success. Fetching initial SMS...");

  const initialHtml = await fetchSmsPageHtml();
  if (initialHtml) {
    const latest = parseLatestSmsFromHtml(initialHtml);
    if (latest) {
      lastId = latest.id;
      lastMsgText = latest.message;
      console.log("📨 Sending initial SMS to Telegram...");
      await sendTelegramSMS(latest);
    } else {
      console.log("⚠️ No SMS found initially.");
    }
  }

  console.log("🔁 Starting loop...");

  async function loopWorker() {
    try {
      const html = await fetchSmsPageHtml();
      if (!html) {
        console.warn("⚠️ No HTML received. Retry in 30s...");
        return setTimeout(loopWorker, 30000);
      }

      const latest = parseLatestSmsFromHtml(html);
      if (!latest) {
        console.warn("⚠️ No SMS found. Retry in 30s...");
        return setTimeout(loopWorker, 30000);
      }

      if ((latest.id && latest.id !== lastId) || (latest.message && latest.message !== lastMsgText)) {
        lastId = latest.id;
        lastMsgText = latest.message;
        await sendTelegramSMS(latest);
      }

      setTimeout(loopWorker, 20000); // 20s normal delay
    } catch (err) {
      if (err.message.includes("429")) {
        console.warn("⏳ Got 429 Too Many Requests — waiting 60s...");
        return setTimeout(loopWorker, 60000);
      } else {
        console.error("Worker error:", err.message);
        setTimeout(loopWorker, 30000);
      }
    }
  }

  loopWorker();
}

// === RUN ===
startWorker();
console.log("📱 d-group panel bot is Running...");
