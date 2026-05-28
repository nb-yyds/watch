const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");

const { sendMail } = require("./mailer");

const APP_CONFIG_PATH = path.join(__dirname, "config.json");
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
  const rawConfig = process.env.CONFIG;
  if (!rawConfig) {
    return {};
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

  // Try callback-specific pattern first
  const explicitPattern = callbackName
    ? new RegExp(
        `^${callbackName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\((.*)\\);?$`,
        "s"
      )
    : null;

  if (explicitPattern) {
    const explicitMatch = trimmed.match(explicitPattern);
    if (explicitMatch) {
      return JSON.parse(explicitMatch[1]);
    }
  }

  // Fallback: brace-counting to extract JSON from JSONP wrapper
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
            // JSON contains non-standard syntax (e.g. unquoted numeric keys),
            // fall through to Function eval which handles JS object notation
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
    price: [
      "bestPrice",
      "price",
      "adultPrice",
      "ticketPrice",
      "salePrice",
      "lowestPrice",
      "lp",
    ],
    airline: [
      "carrierAirlineName",
      "airlineName",
      "airline",
      "airlineCompanyName",
      "carrierName",
      "companyName",
      "airways",
      "alc",
    ],
    airlineCode: [
      "carrierAirlineCode",
      "airlineCode",
      "carrierCode",
      "airlineShortCode",
      "alc",
    ],
    flightNumber: ["carrier", "flightNumber", "flightNo", "flightNum", "fn"],
    departureTime: [
      "depTime",
      "departureTime",
      "dptTime",
      "takeOffTime",
      "startTime",
      "dt",
    ],
    arrivalTime: ["arrTime", "arrivalTime", "dstTime", "landTime", "endTime", "at"],
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

  const airlineCode = directAirlineCode || findValueDeep(item, fieldMappings.airlineCode);
  const airline =
    directAirline || findValueDeep(item, fieldMappings.airline) ||
    airlineMap[airlineCode] ||
    airlineCode ||
    "未知航空公司";
  const flightNumber = findValueDeep(item, fieldMappings.flightNumber) || "未知航班编号";
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
  const fieldMappings = mergeFieldMappings(
    defaultFieldMappings(),
    responseConfig.fieldMappings || {}
  );

  const hintedPaths = Array.isArray(responseConfig.flightListPaths)
    ? responseConfig.flightListPaths
    : [];

  for (const pathExpression of hintedPaths) {
    const candidate = getNestedValue(payload, pathExpression);
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => normalizeFlight(item, airlineMap, fieldMappings))
        .filter(Boolean);
    }
  }

  const allArrays = collectArrays(payload);
  let bestMatch = [];

  for (const candidateArray of allArrays) {
    const normalized = candidateArray
      .map((item) => normalizeFlight(item, airlineMap, fieldMappings))
      .filter(Boolean);

    if (normalized.length > bestMatch.length) {
      bestMatch = normalized;
    }
  }

  return bestMatch;
}

function getAllowedAirlineCodes(route) {
  const routeAirlineCodes = normalizeAirlineCodes(route?.airlineCodes);
  if (routeAirlineCodes.length > 0) {
    return new Set(routeAirlineCodes);
  }

  return null;
}

function filterFlightsByPrice(flights, priceLimit, allowedAirlineCodes) {
  return flights.filter((flight) => {
    return (
      flight.stop === 0 &&
      (!allowedAirlineCodes || allowedAirlineCodes.has(flight.airlineCode)) &&
      flight.price < priceLimit
    );
  });
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

function renderHtmlTable(route, rows, priceLimit) {
  const caption = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
  const body = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.airline || "未知航空公司")}</td>
        <td>${escapeHtml(row.flightNumber || "未知航班编号")}</td>
        <td>${escapeHtml(row.departureTime || "未知")}</td>
        <td>${escapeHtml(row.arrivalTime || "未知")}</td>
        <td>${escapeHtml(row.duration || "未知")}</td>
        <td>${escapeHtml(row.price)}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>航班低价提醒</title>
    <style>
      body {
        font-family: "Microsoft YaHei", sans-serif;
        color: #222;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      caption {
        margin-bottom: 12px;
        font-size: 18px;
        font-weight: 700;
        text-align: left;
      }
      th,
      td {
        border: 1px solid #d9d9d9;
        padding: 8px 12px;
        text-align: left;
      }
      th {
        background: #f5f5f5;
      }
      .hint {
        margin-bottom: 16px;
        color: #666;
      }
    </style>
  </head>
  <body>
    <div class="hint">仅发送价格低于 ${escapeHtml(priceLimit)} 元的航班。</div>
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
      <tbody>${body}
      </tbody>
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
  const callback = `jsonp${Math.floor(Math.random() * 1000)}`;

  const params = {
    _ksTS: `${ts}_999`,
    callback,
    tripType: 0,
    depCity: route.depCity,
    depCityName: route.depCityName,
    arrCity: route.arrCity,
    arrCityName: route.arrCityName,
    depDate: route.depDate,
    searchSource: 99,
    needMemberPrice: true,
    '_input_charset': 'utf-8',
  };

  const baseUrl = appConfig.request.url.split('?')[0];
  const response = await axios.get(baseUrl, {
    params,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'Referer': 'https://sjipiao.fliggy.com/',
    },
    timeout: Number(appConfig.requestTimeoutMs ?? 20000),
    responseType: "text",
  });

  const payload = unwrapResponsePayload(
    response.data,
    callback
  );

  const flights = extractFlightList(payload, airlineMap, appConfig.response || {});
  if (flights.length === 0) {
    throw new Error("接口返回成功，但没有提取到航班列表，请检查字段映射配置。");
  }

  return flights;
}

async function sendErrorNotification(route, mailConfig, error) {
  const routeLabel = `${route.depCityName} -> ${route.arrCityName} (${route.depDate})`;
  const html = renderErrorHtml(route, error);

  await sendMail(html, mailConfig, {
    routeLabel: `${routeLabel} - 接口异常`,
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
      const matchedFlights = deduplicateFlights(filterFlightsByPrice(
        flights,
        routePriceLimit,
        allowedAirlineCodes
      ));

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
  await main(appConfig);
}

signIn().catch((error) => {
  console.error("[ERROR] 脚本执行失败：", error.message);
  process.exitCode = 1;
});
