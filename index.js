const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");

const { sendMail } = require("./mailer");

const APP_CONFIG_PATH = path.join(__dirname, "config.json");


// 配置信息
const userInfo = {}

// 保存原始数据到raw_data文件夹 == start
const fsSync = require('fs');
const DATA_DIR = './raw_data';
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}
// 保存格式为txt
async function saveRawData(data, route) {
  const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '');
  const filename = `raw_data_${timestamp}.txt`;
  const filePath = path.join(DATA_DIR, filename);

  const content = `=== 航线: ${route.depCityName} → ${route.arrCityName} (${route.depDate}) ===\n${JSON.stringify(data, null, 2)}`;

  await fs.writeFile(filePath, content, 'utf8');
  console.log(`✅ 原始数据已保存到: ${filePath}`);
}
// ===============end



/** 获取北京时间（Asia/Shanghai）的日期字符串 YYYY-MM-DD。 */
function getBeijingDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isDepartureDateExpired(depDate, beijingDate) {
  return depDate < beijingDate;
}



async function loadJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

function mergeConfig(baseConfig, overrideConfig) {
  if (!isPlainObject(baseConfig)) {
    return overrideConfig;
  }

  if (!isPlainObject(overrideConfig)) {
    return baseConfig;
  }

  const mergedConfig = { ...baseConfig };

  for (const [key, overrideValue] of Object.entries(overrideConfig)) {
    const baseValue = mergedConfig[key];

    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      mergedConfig[key] = mergeConfig(baseValue, overrideValue);
      continue;
    }

    mergedConfig[key] = overrideValue;
  }

  return mergedConfig;
}

function parseConfigFromEnv() {
  const rawConfig = process.env.CONFIG || JSON.stringify(userInfo);
  if (!rawConfig || rawConfig == '{}') {
    throw new Error("没有获取到航班相关配置项");
  }

  try {
    const parsedConfig = JSON.parse(rawConfig);
    if (!isPlainObject(parsedConfig)) {
      throw new Error("CONFIG配置解析失败");
    }
    return parsedConfig;
  } catch (error) {
    throw new Error(`解析环境变量 CONFIG 失败: ${error.message}`);
  }
}

async function loadAppConfig() {
  const fileConfig = await loadJson(APP_CONFIG_PATH);
  const envConfig = parseConfigFromEnv();
  return mergeConfig(fileConfig, envConfig);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[^\d.]/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getNestedValue(source, pathExpression) {
  if (!source || !pathExpression) {
    return undefined;
  }

  const segments = pathExpression
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current = source;
  for (const segment of segments) {
    if (
      current == null ||
      (typeof current !== "object" && !Array.isArray(current)) ||
      !(segment in current)
    ) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findValueDeep(source, keys) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const candidate = source[key];
      if (candidate == null) {
        continue;
      }
      if (typeof candidate === "string" && candidate.trim() === "") {
        continue;
      }
      return candidate;
    }
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      const value = findValueDeep(item, keys);
      if (value != null) {
        return value;
      }
    }
    return undefined;
  }

  for (const value of Object.values(source)) {
    const nestedValue = findValueDeep(value, keys);
    if (nestedValue != null) {
      return nestedValue;
    }
  }

  return undefined;
}

function unwrapResponsePayload(rawData, callbackName) {
  if (isPlainObject(rawData) || Array.isArray(rawData)) {
    return rawData;
  }

  if (typeof rawData !== "string") {
    throw new Error("接口返回内容不是可解析的 JSON 或 JSONP。");
  }

  const trimmed = rawData.trim();

  if (trimmed.startsWith("<script>") || trimmed.startsWith("<!DOCTYPE html")) {
    throw new Error("接口返回的是风控或跳转页面，不是正常的 JSONP 航班数据。");
  }

  // Brace-counting: find the outermost {...} block, then try JSON.parse,
  // falling back to Function eval for non-standard JSON (unquoted numeric keys, etc.)
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    let depth = 0;
    for (let i = firstBrace; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = trimmed.substring(firstBrace, i + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            return new Function("return (" + jsonStr + ")")();
          }
        }
      }
    }
  }

  throw new Error("接口没有返回合法的 JSONP 数据。");
}

function defaultFieldMappings() {
  return {
    price: ["bestPrice", "price", "adultPrice", "ticketPrice", "salePrice", "lowestPrice", "lp", "cabinPrice"],
    airline: ["carrierAirlineName", "airlineName", "airline", "companyName", "carrierName", "airlines"],
    airlineCode: ["carrierAirlineCode", "airlineCode", "carrierCode", "alc"],
    flightNumber: ["carrier", "flightNo", "flightNumber", "fn", "flightNum"],
    departureTime: ["depTime", "departureTime", "dptTime", "startTime", "dt"],
    arrivalTime: ["arrTime", "arrivalTime", "dstTime", "landTime", "endTime", "at"],
    stop: ["stop", "stopover", "stopNum"]
  };
}


function mergeFieldMappings(defaultMappings, customMappings) {
  if (!isPlainObject(customMappings)) {
    return defaultMappings;
  }

  const mergedMappings = { ...defaultMappings };

  for (const [field, defaultKeys] of Object.entries(defaultMappings)) {
    const customKeys = Array.isArray(customMappings[field]) ? customMappings[field] : [];
    mergedMappings[field] = [...new Set([...customKeys, ...defaultKeys])];
  }

  for (const [field, customKeys] of Object.entries(customMappings)) {
    if (!(field in mergedMappings) && Array.isArray(customKeys)) {
      mergedMappings[field] = [...new Set(customKeys)];
    }
  }

  return mergedMappings;
}


function normalizeAirlineCodes(airlineCodes) {
  if (!Array.isArray(airlineCodes)) {
    return [];
  }

  return [
    ...new Set(
      airlineCodes
        .map((code) => (typeof code === "string" ? code.trim().toUpperCase() : ""))
        .filter(Boolean)
    ),
  ];
}

function calcDuration(depTime, arrTime) {
  const dep = new Date(depTime.replace(" ", "T"));
  const arr = new Date(arrTime.replace(" ", "T"));
  const diff = arr - dep;
  if (!Number.isFinite(diff) || diff <= 0) return "未知";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours === 0) return `${minutes}分钟`;
  if (minutes === 0) return `${hours}小时`;
  return `${hours}小时${minutes}分`;
}

function normalizeFlight(item, airlineMap, fieldMappings) {
  if (!item || typeof item !== "object") {
    return null;
  }

  // 过滤中转航班：isTransfer / transferFlight / transferCity 任一有值都不要
  if (
    item.isTransfer === true ||
    (Array.isArray(item.transferFlight) && item.transferFlight.length > 0) ||
    item.transferCity ||
    item?.transferFlight?.[0]?.totalInfo?.transferCity
  ) {
    return null;
  }

  const directPrice = parseNumber(item?.bestPrice ?? item?.cabin?.bestPrice);
  const price = directPrice ?? parseNumber(findValueDeep(item, fieldMappings.price));
  if (price == null) {
    return null;
  }

  const directAirline = item?.carrierAirlineName;
  const directAirlineCode = item?.carrierAirlineCode;
  const directFlightNumber = item?.carrier || item?.flightNo;
  const directDepartureTime = item?.depTime;
  const directArrivalTime = item?.arrTime;

  if (!directDepartureTime || !directArrivalTime) {
    return null;
  }

  // 到达机场必须是目标城市对应机场（避免中转段脏数据混入）
  // 如你只查 CAN->KMG，可再加 arrAirport 校验；这里先不强绑死

  const airlineCode = directAirlineCode || findValueDeep(item, fieldMappings.airlineCode);
  const airline =
    directAirline ||
    findValueDeep(item, fieldMappings.airline) ||
    airlineMap[airlineCode] ||
    airlineCode ||
    "未知航空公司";

  const flightNumber =
    findValueDeep(item, fieldMappings.flightNumber) || directFlightNumber || "未知航班编号";
  const departureTime = findValueDeep(item, fieldMappings.departureTime) || "未知";
  const arrivalTime = findValueDeep(item, fieldMappings.arrivalTime) || "未知";
  const stop = item?.stop ?? null;
  const duration = calcDuration(departureTime, arrivalTime);

  return {
    airline,
    airlineCode,
    flightNumber,
    departureTime,
    arrivalTime,
    price,
    stop,
    duration,
  };
}


// 有效航班判断函数
function isValidFlight(flight) {
  if (!flight || typeof flight !== 'object') return false;

  const { stop, isTransfer, bestPrice, price, cabin, transferFlight } = flight;

  // 1. 必须是直飞
  const isDirect = stop === 0 || !isTransfer;

  // 2. 有价格信息（最重要）
  const hasPrice = bestPrice != null && bestPrice > 0 ||
    price != null && price > 0 ||
    (cabin?.bestPrice != null && cabin.bestPrice > 0);

  // 3. 不是中转航班
  const notTransfer = transferFlight === undefined || transferFlight.length === 0;

  return isDirect && hasPrice && notTransfer;
}


// 过滤直飞航班（去除中转）
function isDirectFlight(flight) {
  if (!flight || typeof flight !== 'object') return false;

  const { isTransfer, transferFlight } = flight;
  return isTransfer !== true && !transferFlight;
}


// 按时间升序排序，并标记前5条最低价航班
function sortFlightsWithMarking(flights) {
  // 先找出最低价
  const sortedByPrice = [...flights].sort((a, b) => a.price - b.price);
  const minPrice = sortedByPrice[0].price;
  const cheapest5 = sortedByPrice.filter(flight => flight.price === minPrice);

  // 再按出发时间升序排序
  return flights.sort((a, b) => {
    const getMinutes = (timeStr) => {
      let time = timeStr.trim();
      if (time.includes(' ')) time = time.split(' ')[1];
      const [hours, minutes] = time.split(':').map(Number);
      return hours * 60 + minutes;
    };
    return getMinutes(a.departureTime) - getMinutes(b.departureTime);
  });
}



// ==================== 按价格 + 出发时间排序后只取前5条 ====================
function sortFlightsByPriceAndTime(flights) {
  // 先按价格升序，再按出发时间升序
  const sorted = [...flights].sort((a, b) => {
    // 价格升序（小到大）
    if (a.price !== b.price) return a.price - b.price;
    // 价格相同则按出发时间升序
    const getMinutes = (timeStr) => {
      let time = timeStr.trim();
      if (time.includes(' ')) time = time.split(' ')[1];
      const [hours, minutes] = time.split(':').map(Number);
      return hours * 60 + minutes;
    };
    return getMinutes(a.departureTime) - getMinutes(b.departureTime);
  });

  // 只取前5条（最低价的前五条）
  return sorted.slice(0, 5);
}



function collectArrays(source, results = []) {
  if (Array.isArray(source)) {
    results.push(source);
    for (const item of source) {
      collectArrays(item, results);
    }
    return results;
  }

  if (isPlainObject(source)) {
    for (const value of Object.values(source)) {
      collectArrays(value, results);
    }
  }

  return results;
}

function extractFlightList(payload, airlineMap, responseConfig) {
  if (!payload || (!isPlainObject(payload) && !Array.isArray(payload))) {
    console.log(`[DEBUG] 解析后的数据格式不正常: ${typeof payload}`);
    return [];
  }

  const fieldMappings = mergeFieldMappings(defaultFieldMappings(), responseConfig.fieldMappings || {});
  const hintedPaths = Array.isArray(responseConfig.flightListPaths) ? responseConfig.flightListPaths : [];

  // 严格模式：只允许 hintedPaths，不允许兜底收集所有数组
  if (hintedPaths.length > 0) {
    for (const pathExpression of hintedPaths) {
      const candidate = getNestedValue(payload, pathExpression);
      if (Array.isArray(candidate) && candidate.length > 0) {
        const flights = candidate
          .map(item => normalizeFlight(item, airlineMap, fieldMappings))
          .filter(flight => isValidFlight(flight));

        console.log(`[DEBUG] 成功通过 hintedPath 提取到 ${flights.length} 个航班`);
        return flights;
      }
    }
    console.log(`[DEBUG] hintedPaths 配置有，但没有匹配到有效航班`);
    return [];
  }

  // 2. 尝试收集所有数组（兜底方案）
  const allArrays = collectArrays(payload);
  let bestMatch = [];

  for (const candidateArray of allArrays) {
    if (!Array.isArray(candidateArray) || candidateArray.length === 0) continue;

    const normalized = candidateArray
      .map(item => normalizeFlight(item, airlineMap, fieldMappings))
      .filter(Boolean);

    if (normalized.length > bestMatch.length) {
      bestMatch = normalized;
    }
  }

  console.log(`[DEBUG] 通过兜底方案提取到 ${bestMatch.length} 个航班`);

  return bestMatch;
}



function getAllowedAirlineCodes(route) {
  const routeAirlineCodes = normalizeAirlineCodes(route?.airlineCodes);
  if (routeAirlineCodes.length > 0) {
    return new Set(routeAirlineCodes);
  }

  return null;
}

// ==================== 核心修复函数 - 2 ====================
function filterFlightsByPrice(flights, priceLimit, allowedAirlineCodes) {
  let uniqueFlights = deduplicateFlights(flights);
  let directFlights = uniqueFlights.filter(isDirectFlight).filter(isValidFlight);

  let priceFiltered = directFlights.filter(flight => flight.price < priceLimit);

  const sortedFlights = sortFlightsWithMarking(priceFiltered);

  console.log(`[DEBUG] 直飞 + 去重 + 排序后共 ${sortedFlights.length} 个航班（已标记价格最低的5条）`);
  return sortedFlights;
}



function deduplicateFlights(flights) {
  const map = new Map();
  for (const flight of flights) {
    const key = `${flight.flightNumber}|${flight.departureTime}|${flight.arrivalTime}`;
    const existing = map.get(key);
    if (!existing || flight.price < existing.price) {
      map.set(key, flight);
    }
  }
  return [...map.values()];
}
// 新增 filterDirectFlights（直飞过滤）
function filterDirectFlights(flights) {
  return flights.filter(flight => {
    return flight.stop === 0 || flight.stop === null || flight.stop === undefined;
  });
}
function sortFlightsByDeparture(flights) {
  return flights.sort((a, b) => {
    const getMinutes = (timeStr) => {
      let time = timeStr.trim();
      if (time.includes(' ')) {
        time = time.split(' ')[1];
      }
      const [hours, minutes] = time.split(':').map(Number);
      return hours * 60 + minutes;
    };

    const minutesA = getMinutes(a.departureTime);
    const minutesB = getMinutes(b.departureTime);

    return minutesA - minutesB;
  });
}


// 最终的 filterAndSortFlights 函数
function filterAndSortFlights(flights, routePriceLimit, allowedAirlineCodes) {
  // 1. 去重
  let uniqueFlights = deduplicateFlights(flights);

  // 2. 直飞（stop === 0 或空）
  let directFlights = uniqueFlights.filter((flight) => {
    return flight.stop === 0 || flight.stop === null || flight.stop === undefined;
  });

  // 3. 航司过滤（可选）
  if (allowedAirlineCodes && allowedAirlineCodes.size > 0) {
    directFlights = directFlights.filter((flight) => {
      const code = String(flight.airlineCode || "").toUpperCase();
      const no = String(flight.flightNumber || "").toUpperCase();
      // 兼容 flightNumber 带航司前缀的情况
      return (
        allowedAirlineCodes.has(code) ||
        [...allowedAirlineCodes].some((c) => no.startsWith(c))
      );
    });
  }

  // 4. 价格过滤
  const priceFiltered = directFlights.filter((flight) => flight.price < routePriceLimit);

  // 5. 按起飞时间早 -> 晚 升序
  const sortedFlights = priceFiltered.sort((a, b) => {
    const getMinutes = (timeStr) => {
      let time = String(timeStr || "").trim();
      if (time.includes(" ")) time = time.split(" ")[1];
      const [hours, minutes] = time.split(":").map(Number);
      return (hours || 0) * 60 + (minutes || 0);
    };
    return getMinutes(a.departureTime) - getMinutes(b.departureTime);
  });

  console.log(
    `[DEBUG] 直飞 + 去重 + 排序后共 ${sortedFlights.length} 个航班（邮件按时间排序，最低价5条标红）`
  );

  return sortedFlights;
}


// （按「全表最低价的 5 条」标记，不是按时间前 5 行）
function renderHtmlTable(route, rows, priceLimit) {
  const caption = `${route.depCityName} → ${route.arrCityName} (${route.depDate}) - 直飞低价航班（早到晚排序）`;

  // 少于 5 条：不标红；≥ 5 条：在全表中找出价格最低的 5 条再标记
  const shouldMark = rows.length >= 5;
  const cheapestKeys = new Set(
    shouldMark
      ? [...rows]
        .sort((a, b) => a.price - b.price)
        .slice(0, 5)
        .map((f) => `${f.flightNumber}|${f.departureTime}|${f.arrivalTime}|${f.price}`)
      : []
  );

  const body = rows
    .map((row) => {
      const key = `${row.flightNumber}|${row.departureTime}|${row.arrivalTime}|${row.price}`;
      const isCheapest = shouldMark && cheapestKeys.has(key);

      const rowStyle = isCheapest
        ? "background-color: #ff4444; color: #fff; font-weight: bold; border: 2px solid #ff6666;"
        : "background-color: white; color: black;";

      const fontStyle = isCheapest ? "color: #ff0; font-weight: bold;" : "";

      return `
        <tr style="${rowStyle}">
          <td style="${fontStyle}">${escapeHtml(row.airline || "")}</td>
          <td style="${fontStyle}">${escapeHtml(row.flightNumber || "")}</td>
          <td style="${fontStyle}">${escapeHtml(row.departureTime || "")}</td>
          <td style="${fontStyle}">${escapeHtml(row.arrivalTime || "")}</td>
          <td style="${fontStyle}">${escapeHtml(row.duration || "")}</td>
          <td style="${fontStyle}">¥${escapeHtml(row.price)}</td>
        </tr>`;
    })
    .join("");

  const hint = shouldMark
    ? `所有直飞航班（已按出发时间升序排序）。表格中价格最低的 5 条用红底黄字标记。仅发送价格低于 ${escapeHtml(priceLimit)} 元的航班。`
    : `所有直飞航班（已按出发时间升序排序）。当前仅 ${rows.length} 条，不足 5 条不标红。仅发送价格低于 ${escapeHtml(priceLimit)} 元的航班。`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>航班低价提醒</title>
    <style>
      body { font-family: "Microsoft YaHei", sans-serif; }
      table { width: 100%; border-collapse: collapse; }
      caption { margin-bottom: 15px; font-size: 18px; font-weight: 700; text-align: left; color: #ff4444; }
      th, td { border: 1px solid #d9d9d9; padding: 10px 12px; text-align: left; }
      th { background: #f5f5f5; }
      .hint { margin-bottom: 16px; font-size: 14px; color: #666; }
    </style>
  </head>
  <body>
    <div class="hint">${hint}</div>
    <table>
      <caption>${escapeHtml(caption)}</caption>
      <thead>
        <tr>
          <th>航空公司</th>
          <th>航班编号</th>
          <th>出发时间</th>
          <th>到达时间</th>
          <th>飞行时长</th>
          <th>价格</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
 </body>
</html>`;
}



function renderErrorHtml(route, error) {
  const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>机票接口异常提醒</title>
    <style>
      body {
        font-family: "Microsoft YaHei", sans-serif;
        color: #222;
        line-height: 1.6;
      }
      .card {
        border: 1px solid #f0d3d3;
        background: #fff7f7;
        padding: 16px;
        border-radius: 8px;
      }
      .title {
        font-size: 18px;
        font-weight: 700;
        margin-bottom: 12px;
        color: #b42318;
      }
      .label {
        font-weight: 700;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: #fff;
        border: 1px solid #ead1d1;
        padding: 12px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">机票接口异常提醒</div>
      <div><span class="label">监测航线：</span>${escapeHtml(routeLabel)}</div>
      <div><span class="label">异常信息：</span></div>
      <pre>${escapeHtml(error.message || String(error))}</pre>
    </div>
  </body>
</html>`;
}

function renderExpiredRouteHtml(route, beijingDate) {
  const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>航班监控已过期</title>
    <style>
      body {
        font-family: "Microsoft YaHei", sans-serif;
        color: #222;
        line-height: 1.6;
      }
      .card {
        border: 1px solid #f0d3d3;
        background: #fff7f7;
        padding: 16px;
        border-radius: 8px;
      }
      .title {
        font-size: 18px;
        font-weight: 700;
        margin-bottom: 12px;
        color: #b42318;
      }
      .label {
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">航班监控已过期</div>
      <div><span class="label">监测航线：</span>${escapeHtml(routeLabel)}</div>
      <div><span class="label">当前北京时间：</span>${escapeHtml(beijingDate)}</div>
      <p>所有配置航线的出发日期均已过期，本次及后续运行不会再向飞猪发送查询请求。</p>
      <p><strong>请及时关闭 GitHub Actions 工作流，避免工作流继续定时运行。</strong></p>
    </div>
  </body>
</html>`;
}

function buildRouteMailConfig(defaultMailConfig, route) {
  const routeMail = isPlainObject(route?.mail) ? route.mail : {};

  return {
    ...defaultMailConfig,
    ...routeMail,
    to:
      Array.isArray(routeMail.to) && routeMail.to.length > 0
        ? routeMail.to
        : defaultMailConfig.to,
    cc: Array.isArray(routeMail.cc) ? routeMail.cc : defaultMailConfig.cc,
  };
}

function getRoutePriceLimit(route, appConfig) {
  const rawPriceLimit = route?.priceLimit ?? appConfig.priceLimit ?? 1000;
  const priceLimit = Number(rawPriceLimit);

  if (!Number.isFinite(priceLimit)) {
    throw new Error(`航线 ${route.depCity || ""} -> ${route.arrCity || ""} 的 priceLimit 配置无效`);
  }

  return priceLimit;
}

function validateAppConfig(config) {
  if (!config || !isPlainObject(config)) {
    throw new Error("node-axios/config.json 配置格式不正确。");
  }

  if (!config.request || !config.request.url) {
    throw new Error("缺少 request.url 配置。");
  }

  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error("缺少 routes 配置，至少需要一条航线。");
  }

  for (const route of config.routes) {
    if (!isValidDateString(route?.depDate)) {
      throw new Error(
        `航线 ${route?.depCity || ""} -> ${route?.arrCity || ""} 的 depDate 配置无效，应为 YYYY-MM-DD 格式`
      );
    }

    if (route?.airlineCodes != null && !Array.isArray(route.airlineCodes)) {
      throw new Error(
        `Route ${route.depCity || ""} -> ${route.arrCity || ""} airlineCodes must be an array`
      );
    }
  }

  if (!config.mail || !isPlainObject(config.mail)) {
    throw new Error("缺少 mail 配置。");
  }
}

async function queryFlights(route, appConfig, airlineMap) {
  const ts = Date.now();
  const callback = `jsonp${Math.floor(Math.random() * 10000)}`;

  const params = {
    _ksTS: `${ts}_999`,
    callback,
    tripType: 0,
    depCity: route.depCity,
    depCityName: route.depCityName || "",
    arrCity: route.arrCity,
    arrCityName: route.arrCityName || "",
    depDate: route.depDate,
    searchSource: 99,
    needMemberPrice: true,
    '_input_charset': 'utf-8',
  };

  const baseUrl = appConfig.request.url.split('?')[0];

  const axiosConfig = {
    params,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Referer': 'https://sjipiao.fliggy.com/flight_search_result.htm',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    timeout: 25000,
    maxRedirects: 30,
    responseType: "text",
  };

  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    axiosConfig.proxy = {
      host: url.hostname,
      port: Number(url.port),
      protocol: url.protocol.slice(0, -1)
    };
  }

  try {
    console.log(`\n[DEBUG] 正在请求：${route.depCityName} → ${route.arrCityName} | ${route.depDate}`);

    const response = await axios.get(baseUrl, axiosConfig);

    const payload = unwrapResponsePayload(response.data, callback);

    
    // 保存原始数据到本地
    // console.log(`[DEBUG] 原始数据解析成功，保存到 raw_data 文件夹`);
    // await saveRawData(payload, route);

    // 提取航班
    const flights = extractFlightList(payload, airlineMap, appConfig.response || {});

    console.log(`[DEBUG] 提取到 ${flights.length} 个航班`);


    return flights;

  } catch (error) {
    console.error(`[ERROR] 请求失败：${error.message}`);
    throw error;
  }
}


async function queryFlightss(route, appConfig, airlineMap) {
  const ts = Date.now();
  const callback = `jsonp${Math.floor(Math.random() * 10000)}`;

  const params = {
    _ksTS: `${ts}_999`,
    callback,
    tripType: 0,
    depCity: route.depCity,
    depCityName: route.depCityName || "",
    arrCity: route.arrCity,
    arrCityName: route.arrCityName || "",
    depDate: route.depDate,
    searchSource: 99,
    needMemberPrice: true,
    '_input_charset': 'utf-8',
  };

  const baseUrl = appConfig.request.url.split('?')[0];

  const axiosConfig = {
    params,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      'Referer': 'https://sjipiao.fliggy.com/flight_search_result.htm',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
    },
    timeout: 25000,
    maxRedirects: 30,           // ← 关键修复：提高重定向次数
    maxBodyLength: 10 * 1024 * 1024,
    maxContentLength: 10 * 1024 * 1024,
    responseType: "text",
    validateStatus: status => status >= 200 && status < 400, // 允许重定向
  };

  // 代理支持
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    axiosConfig.proxy = {
      host: url.hostname,
      port: Number(url.port),
      protocol: url.protocol.slice(0, -1)
    };
  }

  try {
    console.log(`\n[DEBUG] 正在请求：${route.depCity} → ${route.arrCity} | ${route.depDate}`);

    const response = await axios.get(baseUrl, axiosConfig);

    console.log(`[DEBUG] 状态码：${response.status} | 重定向次数：${response.request.res?.res?.responseUrl ? '已处理' : '未处理'}`);

    const payload = unwrapResponsePayload(response.data, callback);

    console.log(`[DEBUG] 解析后数据类型：${typeof payload}`);
    console.log(`[DEBUG] 提取到航班数量：${Array.isArray(payload) ? payload.length : (payload?.data ? payload.data.length : 0)}`);

    const flights = extractFlightList(payload, airlineMap, appConfig.response || {});

    return flights;

  } catch (error) {
    console.error(`[ERROR] 请求失败：${error.message}`);
    if (error.response) {
      console.error(`[ERROR] 状态码：${error.response.status}`);
      console.error(`[ERROR] 响应头：`, error.response.headers);
    }
    throw error;
  }
}



async function sendErrorNotification(route, mailConfig, error) {
  const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
  const html = renderErrorHtml(route, error);

  await sendMail(html, mailConfig, {
    routeLabel: `${routeLabel} - 接口异常`,
  });
}

async function sendExpiredRouteNotification(route, mailConfig, beijingDate) {
  const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
  const html = renderExpiredRouteHtml(route, beijingDate);

  await sendMail(html, mailConfig, {
    routeLabel: `${routeLabel} - 监控已过期，请关闭 GitHub Actions 工作流`,
  });
}

async function main(appConfig) {
  validateAppConfig(appConfig);

  const airlineMapPath = path.resolve(__dirname, appConfig.airlineMapPath || "hkgs.json");
  const airlineMap = await loadJson(airlineMapPath);

  for (const route of appConfig.routes) {
    const routeMailConfig = buildRouteMailConfig(appConfig.mail, route);
    const routePriceLimit = getRoutePriceLimit(route, appConfig);
    const allowedAirlineCodes = getAllowedAirlineCodes(route);
    const priceLimit = routePriceLimit;

    try {
      const flights = await queryFlights(route, appConfig, airlineMap);
      const matchedFlights = filterAndSortFlights(
        flights,
        routePriceLimit,
        allowedAirlineCodes
      );


      if (matchedFlights.length === 0) {
        console.log(
          `[SKIP] ${route.depCityName} -> ${route.arrCityName} ${route.depDate}，没有低于 ${priceLimit} 元的航班`
        );
        continue;
      }

      const html = renderHtmlTable(route, matchedFlights, routePriceLimit);
      await sendMail(html, routeMailConfig, {
        routeLabel: `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`,
        matchedCount: matchedFlights.length,
      });

      console.log(
        `[OK] ${route.depCityName} -> ${route.arrCityName} ${route.depDate}，已发送 ${matchedFlights.length} 条低价航班`
      );
    } catch (error) {
      const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
      console.error(`[ERROR] ${routeLabel} 接口异常：${error.message}`);

      try {
        await sendErrorNotification(route, routeMailConfig, error);
        console.log(`[WARN] ${routeLabel} 已发送接口异常提醒邮件`);
      } catch (mailError) {
        console.error(
          `[ERROR] ${routeLabel} 接口异常提醒邮件发送失败：${mailError.message}`
        );
      }
    }
  }
}

async function signIn() {
  const appConfig = await loadAppConfig();
  validateAppConfig(appConfig);

  const beijingDate = getBeijingDateString();
  const activeRoutes = [];

  console.log(`[INFO] 当前北京时间日期：${beijingDate}`);

  for (const route of appConfig.routes) {
    if (!isDepartureDateExpired(route.depDate, beijingDate)) {
      activeRoutes.push(route);
      continue;
    }

    const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
    console.warn(`[EXPIRED] ${routeLabel} 已过期，跳过飞猪请求`);
  }

  if (activeRoutes.length === 0) {
    for (const route of appConfig.routes) {
      const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
      const routeMailConfig = buildRouteMailConfig(appConfig.mail, route);

      try {
        await sendExpiredRouteNotification(route, routeMailConfig, beijingDate);
        console.log(`[WARN] ${routeLabel} 已发送关闭 GitHub Actions 工作流提醒邮件`);
      } catch (mailError) {
        console.error(`[ERROR] ${routeLabel} 过期提醒邮件发送失败：${mailError.message}`);
      }
    }

    console.log("[STOP] 所有航线均已过期，本次运行结束，未向飞猪发送请求");
    return;
  }

  await main({ ...appConfig, routes: activeRoutes });
}

signIn().catch((error) => {
  console.error("[ERROR] 脚本执行失败：", error.message);
  process.exitCode = 1;
});
