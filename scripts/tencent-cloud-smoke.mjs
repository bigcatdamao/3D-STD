import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const API_HOST = "ai3d.tencentcloudapi.com";
const API_SERVICE = "ai3d";
const API_VERSION = "2025-05-13";

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    args[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function parseCredentials(text) {
  const values = {};
  const bare = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalSeparator = line.indexOf("=");
    const colonSeparator = line.indexOf(":");
    const separator = equalSeparator > 0 ? equalSeparator : colonSeparator;
    if (separator > 0) {
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    } else {
      bare.push(line);
    }
  }

  const secretId =
    values.TENCENTCLOUD_SECRET_ID ?? values.SECRET_ID ?? values.SecretId ?? bare[0];
  const secretKey =
    values.TENCENTCLOUD_SECRET_KEY ?? values.SECRET_KEY ?? values.SecretKey ?? bare[1];

  if (!secretId || !secretKey) {
    throw new Error("Credential file must contain a SecretId and SecretKey.");
  }
  return { secretId, secretKey };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function utcDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function signRequest({ action, body, region, secretId, secretKey, timestamp }) {
  const payload = JSON.stringify(body);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${API_HOST}`,
    `x-tc-action:${action.toLowerCase()}`,
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join("\n");

  const date = utcDate(timestamp);
  const credentialScope = `${date}/${API_SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, API_SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    payload,
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: API_HOST,
      "X-TC-Action": action,
      "X-TC-Region": region,
      "X-TC-Timestamp": String(timestamp),
      "X-TC-Version": API_VERSION,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.credentials || !args.action || (!args.body && !args["body-base64"])) {
    throw new Error(
      "Usage: node scripts/tencent-cloud-smoke.mjs --credentials <path> --action <Action> --body <json> [--region ap-guangzhou]",
    );
  }

  const credentialText = await readFile(args.credentials, "utf8");
  const credentials = parseCredentials(credentialText);
  const bodyText = args["body-base64"]
    ? Buffer.from(args["body-base64"], "base64").toString("utf8")
    : args.body;
  const body = JSON.parse(bodyText);
  const region = args.region ?? "ap-guangzhou";
  const timestamp = Math.floor(Date.now() / 1000);
  const signed = signRequest({
    action: args.action,
    body,
    region,
    ...credentials,
    timestamp,
  });

  const response = await fetch(`https://${API_HOST}`, {
    method: "POST",
    headers: signed.headers,
    body: signed.payload,
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { Response: { Error: { Code: "NonJsonResponse", Message: raw.slice(0, 300) } } };
  }

  const apiResponse = payload.Response ?? {};
  let savedResultUrl = false;
  if (args["result-url-type"] && args["result-url-file"]) {
    const resultFile = Array.isArray(apiResponse.ResultFile3Ds)
      ? apiResponse.ResultFile3Ds.find(
          (item) => item.Type?.toUpperCase() === args["result-url-type"].toUpperCase(),
        )
      : null;
    if (resultFile?.Url) {
      await writeFile(args["result-url-file"], resultFile.Url, "utf8");
      savedResultUrl = true;
    }
  }
  const downloads = [];
  if (args["download-dir"] && Array.isArray(apiResponse.ResultFile3Ds)) {
    await mkdir(args["download-dir"], { recursive: true });
    for (let index = 0; index < apiResponse.ResultFile3Ds.length; index += 1) {
      const item = apiResponse.ResultFile3Ds[index];
      if (!item?.Url) continue;
      const responseFile = await fetch(item.Url);
      if (!responseFile.ok) {
        downloads.push({ index: index + 1, type: item.Type, httpStatus: responseFile.status });
        continue;
      }
      const urlExtension = extname(new URL(item.Url).pathname);
      const extension = urlExtension || `.${String(item.Type ?? "bin").toLowerCase()}`;
      const filename = `result-${String(index + 1).padStart(2, "0")}${extension}`;
      const bytes = Buffer.from(await responseFile.arrayBuffer());
      await writeFile(join(args["download-dir"], filename), bytes);
      downloads.push({ index: index + 1, type: item.Type, filename, bytes: bytes.length });
    }
  }
  const result = {
    action: args.action,
    httpStatus: response.status,
    requestId: apiResponse.RequestId ?? null,
    errorCode: apiResponse.Error?.Code ?? apiResponse.ErrorCode ?? null,
    errorMessage: apiResponse.Error?.Message ?? apiResponse.ErrorMessage ?? null,
    status: apiResponse.Status ?? null,
    jobId: apiResponse.JobId ?? null,
    resultTypes: Array.isArray(apiResponse.ResultFile3Ds)
      ? apiResponse.ResultFile3Ds.map((item) => item.Type)
      : [],
    savedResultUrl,
    downloads,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
