(() => {
  const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
  const WEBM_IDS = {
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TIMECODE_SCALE: 0x2ad7b1,
    DURATION: 0x4489
  };

  function readId(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let length = 1;
    let mask = 0x80;
    while (length <= 4 && (first & mask) === 0) {
      length += 1;
      mask >>= 1;
    }
    if (length > 4 || offset + length > bytes.length) return null;

    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value = value * 256 + bytes[offset + i];
    }
    return { value, length };
  }

  function readSize(bytes, offset) {
    if (offset >= bytes.length) return null;
    const first = bytes[offset];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && (first & mask) === 0) {
      length += 1;
      mask >>= 1;
    }
    if (length > 8 || offset + length > bytes.length) return null;

    let value = BigInt(first & (0xff >> length));
    for (let i = 1; i < length; i += 1) {
      value = (value << 8n) | BigInt(bytes[offset + i]);
    }

    const maxValue = (1n << BigInt(7 * length)) - 1n;
    return {
      value,
      length,
      unknown: value === maxValue
    };
  }

  function readElement(bytes, offset, limit = bytes.length) {
    const id = readId(bytes, offset);
    if (!id) return null;
    const sizeOffset = offset + id.length;
    const size = readSize(bytes, sizeOffset);
    if (!size) return null;

    const dataStart = sizeOffset + size.length;
    let dataEnd = limit;
    if (!size.unknown) {
      if (size.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      dataEnd = dataStart + Number(size.value);
      if (dataEnd > limit) return null;
    }

    return {
      id: id.value,
      start: offset,
      idLength: id.length,
      sizeOffset,
      sizeLength: size.length,
      sizeValue: size.value,
      sizeUnknown: size.unknown,
      dataStart,
      dataEnd,
      end: dataEnd
    };
  }

  function findChild(bytes, start, end, targetId) {
    let offset = start;
    while (offset < end) {
      const element = readElement(bytes, offset, end);
      if (!element) return null;
      if (element.id === targetId) return element;
      if (element.sizeUnknown || element.end <= offset) return null;
      offset = element.end;
    }
    return null;
  }

  function encodeSize(value, preferredLength = 0) {
    const numeric = BigInt(value);
    let length = preferredLength;

    function fits(len) {
      return numeric >= 0n && numeric < ((1n << BigInt(7 * len)) - 1n);
    }

    if (!length || !fits(length)) {
      length = 1;
      while (length <= 8 && !fits(length)) length += 1;
    }
    if (length > 8) throw new Error("EBML element size is too large.");

    let encoded = numeric | (1n << BigInt(7 * length));
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i -= 1) {
      out[i] = Number(encoded & 0xffn);
      encoded >>= 8n;
    }
    return out;
  }

  function parseUnsigned(bytes, start, end) {
    const length = end - start;
    if (length <= 0 || length > 8) return null;
    let value = 0n;
    for (let i = start; i < end; i += 1) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function durationElement(durationUnits) {
    const out = new Uint8Array(11);
    out[0] = 0x44;
    out[1] = 0x89;
    out[2] = 0x88;
    new DataView(out.buffer).setFloat64(3, durationUnits, false);
    return out;
  }

  function repairBytes(bytes, durationMs) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) return bytes;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return bytes;

    let rootOffset = 0;
    let segment = null;
    while (rootOffset < bytes.length) {
      const element = readElement(bytes, rootOffset, bytes.length);
      if (!element) return bytes;
      if (element.id === WEBM_IDS.SEGMENT) {
        segment = element;
        break;
      }
      if (element.sizeUnknown || element.end <= rootOffset) return bytes;
      rootOffset = element.end;
    }
    if (!segment) return bytes;

    const info = findChild(bytes, segment.dataStart, segment.dataEnd, WEBM_IDS.INFO);
    if (!info || info.sizeUnknown) return bytes;

    let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;
    const infoParts = [];
    let cursor = info.dataStart;

    while (cursor < info.dataEnd) {
      const child = readElement(bytes, cursor, info.dataEnd);
      if (!child || child.sizeUnknown || child.end <= cursor) return bytes;

      if (child.id === WEBM_IDS.TIMECODE_SCALE) {
        const parsed = parseUnsigned(bytes, child.dataStart, child.dataEnd);
        if (parsed && parsed > 0) timecodeScaleNs = parsed;
        infoParts.push(bytes.slice(child.start, child.end));
      } else if (child.id !== WEBM_IDS.DURATION) {
        infoParts.push(bytes.slice(child.start, child.end));
      }
      cursor = child.end;
    }

    const durationUnits = durationMs * 1_000_000 / timecodeScaleNs;
    if (!Number.isFinite(durationUnits) || durationUnits <= 0) return bytes;

    infoParts.push(durationElement(durationUnits));
    const newInfoData = concatBytes(infoParts);
    const newInfoSize = encodeSize(newInfoData.length, info.sizeLength);
    const newInfo = concatBytes([
      bytes.slice(info.start, info.sizeOffset),
      newInfoSize,
      newInfoData
    ]);

    const oldInfoLength = info.end - info.start;
    const infoDelta = newInfo.length - oldInfoLength;

    let newSegmentSize = bytes.slice(segment.sizeOffset, segment.dataStart);
    if (!segment.sizeUnknown) {
      const nextSegmentSize = segment.sizeValue + BigInt(infoDelta);
      if (nextSegmentSize < 0n) return bytes;
      newSegmentSize = encodeSize(nextSegmentSize, segment.sizeLength);
    }

    return concatBytes([
      bytes.slice(0, segment.sizeOffset),
      newSegmentSize,
      bytes.slice(segment.dataStart, info.start),
      newInfo,
      bytes.slice(info.end)
    ]);
  }

  async function repairWebmDuration(blob, durationMs) {
    try {
      if (!(blob instanceof Blob) || blob.size <= 0) return blob;
      if (!/webm/i.test(blob.type || "")) return blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const repaired = repairBytes(bytes, durationMs);
      if (repaired === bytes) return blob;
      return new Blob([repaired], { type: blob.type || "video/webm" });
    } catch (error) {
      console.warn("TabVault WebM duration repair skipped:", error);
      return blob;
    }
  }

  globalThis.TabVaultWebm = {
    repairWebmDuration,
    _repairBytesForTest: repairBytes
  };
})();
