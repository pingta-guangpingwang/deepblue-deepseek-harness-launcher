const DEFAULT_DOWNLOADS = [
  'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-online.exe',
  'https://ailishishu-deepseek-harness.oss-cn-beijing.aliyuncs.com/download/deepblue-deepseek-harness-launcher-win-x64-offline.exe'
];

const urls = process.argv.slice(2);
const targets = urls.length ? urls : DEFAULT_DOWNLOADS;

async function verifyPublicDownload(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error(`${rawUrl}: public downloads must use HTTPS`);

  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: { 'user-agent': 'deepseek-harness-release-public-check/1.0' },
    signal: AbortSignal.timeout(30_000)
  });
  if (response.status !== 200) throw new Error(`${rawUrl}: anonymous HEAD returned HTTP ${response.status}`);

  const length = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`${rawUrl}: missing or invalid Content-Length`);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('xml')) throw new Error(`${rawUrl}: OSS returned an XML response instead of the download`);

  return { url: response.url, bytes: length, contentType: contentType || 'unknown' };
}

const results = [];
for (const target of targets) results.push(await verifyPublicDownload(target));
for (const result of results) console.log(`PUBLIC ${result.bytes} ${result.contentType} ${result.url}`);
