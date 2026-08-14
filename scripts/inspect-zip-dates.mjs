import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const EOCD_SEARCH_BYTES = 65_557;

function safeNumber(value, label) {
  assert.ok(
    value <= BigInt(Number.MAX_SAFE_INTEGER),
    `${label} exceeds JavaScript's safe integer range`,
  );
  return Number(value);
}

async function readRange(url, range, timeoutMs) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${range}`, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 206, `${url} did not honor ZIP range ${range}`);
  return Buffer.from(await response.arrayBuffer());
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function readZip64Values(extra, entry) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    const value = extra.subarray(offset + 4, offset + 4 + length);
    if (id === ZIP64_EXTRA_ID) {
      let cursor = 0;
      const take = (label) => {
        assert.ok(cursor + 8 <= value.length, `Truncated ZIP64 ${label}`);
        const result = safeNumber(value.readBigUInt64LE(cursor), label);
        cursor += 8;
        return result;
      };
      if (entry.uncompressedSize === 0xffffffff) {
        entry.uncompressedSize = take("uncompressed size");
      }
      if (entry.compressedSize === 0xffffffff) {
        entry.compressedSize = take("compressed size");
      }
      if (entry.localHeaderOffset === 0xffffffff) {
        entry.localHeaderOffset = take("local header offset");
      }
      return;
    }
    offset += 4 + length;
  }
}

async function readZipEntries(url, advertisedSize, timeoutMs) {
  const suffixLength = Math.min(advertisedSize, EOCD_SEARCH_BYTES);
  const suffix = await readRange(url, `-${suffixLength}`, timeoutMs);
  const eocdOffset = findEndOfCentralDirectory(suffix);
  let entryCount = suffix.readUInt16LE(eocdOffset + 10);
  let centralSize = suffix.readUInt32LE(eocdOffset + 12);
  let centralOffset = suffix.readUInt32LE(eocdOffset + 16);
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    const locatorOffset = eocdOffset - 20;
    assert.ok(
      locatorOffset >= 0,
      "ZIP64 end-of-central-directory locator is missing",
    );
    assert.equal(
      suffix.readUInt32LE(locatorOffset),
      ZIP64_EOCD_LOCATOR_SIGNATURE,
      "ZIP64 end-of-central-directory locator is invalid",
    );
    assert.equal(
      suffix.readUInt32LE(locatorOffset + 4),
      0,
      "Multi-disk ZIP64 archives are unsupported",
    );
    const zip64Offset = safeNumber(
      suffix.readBigUInt64LE(locatorOffset + 8),
      "ZIP64 end-of-central-directory offset",
    );
    const zip64 = await readRange(
      url,
      `${zip64Offset}-${zip64Offset + 55}`,
      timeoutMs,
    );
    assert.equal(
      zip64.readUInt32LE(0),
      ZIP64_EOCD_SIGNATURE,
      "ZIP64 end-of-central-directory record is invalid",
    );
    assert.equal(
      zip64.readUInt32LE(16),
      0,
      "Multi-disk ZIP64 archives are unsupported",
    );
    assert.equal(
      zip64.readUInt32LE(20),
      0,
      "Multi-disk ZIP64 archives are unsupported",
    );
    entryCount = safeNumber(zip64.readBigUInt64LE(32), "ZIP64 entry count");
    centralSize = safeNumber(
      zip64.readBigUInt64LE(40),
      "ZIP64 central-directory size",
    );
    centralOffset = safeNumber(
      zip64.readBigUInt64LE(48),
      "ZIP64 central-directory offset",
    );
  }
  assert.ok(entryCount > 0, "The ZIP archive has no entries");
  assert.ok(centralSize > 0, "The ZIP central directory is empty");

  const central = await readRange(
    url,
    `${centralOffset}-${centralOffset + centralSize - 1}`,
    timeoutMs,
  );
  const entries = [];
  let offset = 0;
  while (offset < central.length && entries.length < entryCount) {
    assert.equal(
      central.readUInt32LE(offset),
      CENTRAL_SIGNATURE,
      "Invalid ZIP central-directory entry",
    );
    const nameLength = central.readUInt16LE(offset + 28);
    const extraLength = central.readUInt16LE(offset + 30);
    const commentLength = central.readUInt16LE(offset + 32);
    const entry = {
      flags: central.readUInt16LE(offset + 8),
      method: central.readUInt16LE(offset + 10),
      compressedSize: central.readUInt32LE(offset + 20),
      uncompressedSize: central.readUInt32LE(offset + 24),
      localHeaderOffset: central.readUInt32LE(offset + 42),
      name: central
        .subarray(offset + 46, offset + 46 + nameLength)
        .toString("utf8"),
    };
    const extra = central.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    readZip64Values(extra, entry);
    assert.ok(entry.compressedSize >= 0, "Invalid ZIP compressed size");
    assert.ok(entry.uncompressedSize >= 0, "Invalid ZIP uncompressed size");
    assert.ok(entry.localHeaderOffset >= 0, "Invalid ZIP local header offset");
    entries.push(entry);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(
    entries.length,
    entryCount,
    "The ZIP central directory is truncated",
  );
  return entries;
}

export async function inspectZipEntries({
  url,
  advertisedSize,
  timeoutMs = 180_000,
}) {
  assert.ok(Number.isInteger(advertisedSize) && advertisedSize > 22);
  return readZipEntries(url, advertisedSize, timeoutMs);
}

function validCivilDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10) === value;
}

async function scanEntryDates({
  url,
  entry,
  expectedDate,
  scanBytes,
  timeoutMs,
}) {
  assert.equal(entry.flags & 1, 0, "Encrypted ZIP entries are unsupported");
  assert.ok(
    [0, 8].includes(entry.method),
    `Unsupported ZIP method ${entry.method}`,
  );
  const localHeader = await readRange(
    url,
    `${entry.localHeaderOffset}-${entry.localHeaderOffset + 29}`,
    timeoutMs,
  );
  assert.equal(
    localHeader.readUInt32LE(0),
    LOCAL_SIGNATURE,
    "Invalid ZIP local-file header",
  );
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, {
    headers: {
      Range: `bytes=${dataOffset}-${dataOffset + entry.compressedSize - 1}`,
      "Cache-Control": "no-cache",
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 206, "The ZIP member range was not honored");
  assert.ok(response.body, "The ZIP member has no response body");

  const source = Readable.fromWeb(response.body);
  const output = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
  const decoder = new StringDecoder("utf8");
  const datePattern =
    /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;
  const targetBytes = Math.min(entry.uncompressedSize, scanBytes);
  let bytesRead = 0;
  let dateCount = 0;
  let minimumDate = null;
  let maximumDate = null;
  let firstCharacter = null;
  let lastCharacters = "";
  let overlap = "";
  let intentionallyStopped = false;

  const inspectText = (text) => {
    if (!firstCharacter) firstCharacter = text.match(/\S/)?.[0] || null;
    lastCharacters = `${lastCharacters}${text}`.slice(-128);
    const searchable = overlap + text;
    for (const match of searchable.matchAll(datePattern)) {
      if ((match.index || 0) + match[0].length <= overlap.length) continue;
      const date = match[0];
      if (!validCivilDate(date)) continue;
      dateCount++;
      minimumDate =
        minimumDate === null || date < minimumDate ? date : minimumDate;
      maximumDate =
        maximumDate === null || date > maximumDate ? date : maximumDate;
    }
    overlap = searchable.slice(-32);
  };

  try {
    for await (const chunk of output) {
      const remaining = targetBytes - bytesRead;
      if (remaining <= 0) break;
      const selected =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      bytesRead += selected.length;
      inspectText(decoder.write(selected));
      if (bytesRead >= targetBytes && targetBytes < entry.uncompressedSize) {
        intentionallyStopped = true;
        controller.abort();
        source.destroy();
        output.destroy();
        break;
      }
    }
    if (!intentionallyStopped) inspectText(decoder.end());
  } catch (error) {
    if (!intentionallyStopped) throw error;
  } finally {
    clearTimeout(timeout);
    source.destroy();
    output.destroy();
  }

  assert.ok(bytesRead >= targetBytes, "The ZIP member is truncated");
  assert.ok(
    ["[", "{"].includes(firstCharacter),
    "The ZIP member is not JSON data",
  );
  assert.ok(dateCount > 0, "The ZIP member contains no civil date");
  assert.equal(
    maximumDate,
    expectedDate,
    `The ZIP member maximum inspected date is ${maximumDate}, expected ${expectedDate}`,
  );
  const complete = targetBytes === entry.uncompressedSize;
  if (complete) {
    assert.equal(
      lastCharacters.trimEnd().slice(-1),
      firstCharacter === "[" ? "]" : "}",
      "The JSON member has no closing delimiter",
    );
  }
  return {
    name: entry.name,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    inspectedBytes: bytesRead,
    inspection: complete ? "full" : "prefix",
    dateCount,
    minimumDate,
    maximumDate,
  };
}

export async function inspectZipDates({
  url,
  advertisedSize,
  expectedDate,
  expectedFileName,
  scanBytes = Number.MAX_SAFE_INTEGER,
  timeoutMs = 180_000,
}) {
  assert.ok(Number.isInteger(advertisedSize) && advertisedSize > 22);
  assert.match(expectedDate, /^\d{4}-\d{2}-\d{2}$/);
  const entries = await readZipEntries(url, advertisedSize, timeoutMs);
  const dataEntries = entries.filter(
    ({ name }) => !name.endsWith("/") && /\.(?:json|csv)$/i.test(name),
  );
  assert.equal(
    dataEntries.length,
    1,
    "The ZIP must contain exactly one data file",
  );
  const [entry] = dataEntries;
  if (expectedFileName) {
    assert.equal(entry.name, expectedFileName, "Unexpected ZIP member name");
  }
  return scanEntryDates({ url, entry, expectedDate, scanBytes, timeoutMs });
}
