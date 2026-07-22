export interface FitsHeaderCard {
  key: string;
  value: string;
  comment: string;
  raw: string;
}

export interface FitsParsedData {
  headers: FitsHeaderCard[];
  width: number;
  height: number;
  bitpix: number;
  bzero: number;
  bscale: number;
  floatData: Float32Array;
  rawBuffer: ArrayBuffer;
}

// 1. Helper to parse FITS headers
export function parseFits(buffer: ArrayBuffer): FitsParsedData {
  const view = new DataView(buffer);
  const cards: FitsHeaderCard[] = [];
  let offset = 0;
  let endFound = false;

  while (offset < buffer.byteLength && !endFound) {
    const blockText = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset, 2880));
    for (let i = 0; i < 36; i++) {
      const cardText = blockText.slice(i * 80, (i + 1) * 80);
      const key = cardText.slice(0, 8).trim();
      if (key === 'END') {
        endFound = true;
        cards.push({ key: 'END', value: '', comment: '', raw: cardText });
        break;
      }
      if (!key) continue;

      let value = '';
      let comment = '';
      if (cardText[8] === '=') {
        const valueCommentPart = cardText.slice(9);
        let slashIndex = -1;
        let inQuotes = false;
        for (let j = 0; j < valueCommentPart.length; j++) {
          const char = valueCommentPart[j];
          if (char === "'") {
            inQuotes = !inQuotes;
          } else if (char === '/' && !inQuotes) {
            slashIndex = j;
            break;
          }
        }
        if (slashIndex !== -1) {
          value = valueCommentPart.slice(0, slashIndex).trim();
          comment = valueCommentPart.slice(slashIndex + 1).trim();
        } else {
          value = valueCommentPart.trim();
        }
        if (value.startsWith("'") && value.endsWith("'")) {
          value = value.slice(1, -1).trim();
        }
      } else {
        comment = cardText.slice(8).trim();
      }

      cards.push({ key, value, comment, raw: cardText });
    }
    offset += 2880;
  }

  const getValue = (key: string, def = 0): number => {
    const card = cards.find(c => c.key === key);
    return card ? parseFloat(card.value) : def;
  };

  const bitpix = getValue('BITPIX');
  const naxis = getValue('NAXIS');
  const width = getValue('NAXIS1', 0);
  const height = getValue('NAXIS2', 0);
  const bzero = getValue('BZERO', 0);
  const bscale = getValue('BSCALE', 1);

  if (naxis < 2 || width === 0 || height === 0) {
    throw new Error('Unsupported FITS structure. Requires at least 2 axes (2D image).');
  }

  const naxis3 = naxis >= 3 ? getValue('NAXIS3', 1) : 1;
  const channels = naxis >= 3 ? Math.max(1, naxis3) : 1;
  const pixelCount = width * height * channels;
  const floatData = new Float32Array(pixelCount);
  let dataOffset = offset;

  if (bitpix === 8) {
    for (let i = 0; i < pixelCount; i++) {
      if (dataOffset >= buffer.byteLength) break;
      const val = view.getUint8(dataOffset);
      floatData[i] = val * bscale + bzero;
      dataOffset += 1;
    }
  } else if (bitpix === 16) {
    for (let i = 0; i < pixelCount; i++) {
      if (dataOffset + 2 > buffer.byteLength) break;
      const val = view.getInt16(dataOffset, false);
      floatData[i] = val * bscale + bzero;
      dataOffset += 2;
    }
  } else if (bitpix === 32) {
    for (let i = 0; i < pixelCount; i++) {
      if (dataOffset + 4 > buffer.byteLength) break;
      const val = view.getInt32(dataOffset, false);
      floatData[i] = val * bscale + bzero;
      dataOffset += 4;
    }
  } else if (bitpix === -32) {
    for (let i = 0; i < pixelCount; i++) {
      if (dataOffset + 4 > buffer.byteLength) break;
      const val = view.getFloat32(dataOffset, false);
      floatData[i] = val * bscale + bzero;
      dataOffset += 4;
    }
  } else if (bitpix === -64) {
    for (let i = 0; i < pixelCount; i++) {
      if (dataOffset + 8 > buffer.byteLength) break;
      const val = view.getFloat64(dataOffset, false);
      floatData[i] = val * bscale + bzero;
      dataOffset += 8;
    }
  } else {
    throw new Error(`Unsupported BITPIX value: ${bitpix}`);
  }

  return { headers: cards, width, height, bitpix, bzero, bscale, floatData, rawBuffer: buffer };
}

// 2. Construct a new FITS file from modified headers and modified float data
export function writeFits(parsed: FitsParsedData, newHeaders: FitsHeaderCard[]): ArrayBuffer {
  let headerText = '';
  newHeaders.forEach(card => {
    if (card.key === 'END') return;
    let line = '';
    if (card.value !== '') {
      const paddedKey = card.key.padEnd(8, ' ');
      let valStr = card.value;
      if (isNaN(Number(valStr)) && valStr !== 'T' && valStr !== 'F') {
        valStr = `'${valStr}'`;
      }
      line = `${paddedKey}= ${valStr.padEnd(20, ' ')}`;
      if (card.comment) {
        line += ` / ${card.comment}`;
      }
    } else {
      line = card.key.padEnd(80, ' ');
    }
    headerText += line.slice(0, 80).padEnd(80, ' ');
  });
  headerText += 'END'.padEnd(80, ' ');

  const headerBlockCount = Math.ceil(headerText.length / 2880);
  headerText = headerText.padEnd(headerBlockCount * 2880, ' ');

  const bytesPerPixel = Math.abs(parsed.bitpix) / 8;
  const dataLength = parsed.floatData.length * bytesPerPixel;
  const dataBlockCount = Math.ceil(dataLength / 2880);
  const dataPadding = (dataBlockCount * 2880) - dataLength;

  const outBuffer = new ArrayBuffer(headerText.length + dataLength + dataPadding);
  const outView = new DataView(outBuffer);
  const encoder = new TextEncoder();

  const headerBytes = encoder.encode(headerText);
  new Uint8Array(outBuffer, 0, headerBytes.length).set(headerBytes);

  let dataOffset = headerBytes.length;
  const bzero = parsed.bzero || 0;
  const bscale = parsed.bscale || 1.0;

  if (parsed.bitpix === 8) {
    for (let i = 0; i < parsed.floatData.length; i++) {
      const rawVal = Math.round((parsed.floatData[i] - bzero) / bscale);
      outView.setUint8(dataOffset + i, Math.max(0, Math.min(255, rawVal)));
    }
  } else if (parsed.bitpix === 16) {
    for (let i = 0; i < parsed.floatData.length; i++) {
      const rawVal = Math.round((parsed.floatData[i] - bzero) / bscale);
      outView.setInt16(dataOffset + i * 2, Math.max(-32768, Math.min(32767, rawVal)), false);
    }
  } else if (parsed.bitpix === 32) {
    for (let i = 0; i < parsed.floatData.length; i++) {
      const rawVal = Math.round((parsed.floatData[i] - bzero) / bscale);
      outView.setInt32(dataOffset + i * 4, rawVal, false);
    }
  } else if (parsed.bitpix === -32) {
    for (let i = 0; i < parsed.floatData.length; i++) {
      const rawVal = (parsed.floatData[i] - bzero) / bscale;
      outView.setFloat32(dataOffset + i * 4, rawVal, false);
    }
  } else if (parsed.bitpix === -64) {
    for (let i = 0; i < parsed.floatData.length; i++) {
      const rawVal = (parsed.floatData[i] - bzero) / bscale;
      outView.setFloat64(dataOffset + i * 8, rawVal, false);
    }
  }

  const totalWritten = headerBytes.length + dataLength;
  for (let i = 0; i < dataPadding; i++) {
    outView.setUint8(totalWritten + i, 0);
  }

  return outBuffer;
}

// 3. Lightweight SER Video Parser
export interface SerParsedData {
  width: number;
  height: number;
  frameCount: number;
  colorID: number;
  pixelDepth: number;
  littleEndian: boolean;
  framesOffset: number;
  rawBuffer: ArrayBuffer;
}

export function parseSer(buffer: ArrayBuffer): SerParsedData {
  const view = new DataView(buffer);
  const signature = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, 14));
  if (!signature.startsWith('LUCAM-RECORDER')) {
    throw new Error('Invalid SER file signature.');
  }

  // Header layout: FileID(14) + LuID(4) @14 + ColorID(4) @18 + LittleEndian(4) @22
  // + ImageWidth(4) @26 + ImageHeight(4) @30 + PixelDepth(4) @34 + FrameCount(4) @38
  const colorID = view.getInt32(18, true);
  const littleEndian = view.getInt32(22, true) === 1;
  const width = view.getInt32(26, true);
  const height = view.getInt32(30, true);
  const pixelDepth = view.getInt32(34, true);
  const frameCount = view.getInt32(38, true);

  return {
    width,
    height,
    frameCount,
    colorID,
    pixelDepth,
    littleEndian,
    framesOffset: 178,
    rawBuffer: buffer
  };
}

export function extractSerFrame(ser: SerParsedData, frameIndex: number): Float32Array {
  if (frameIndex < 0 || frameIndex >= ser.frameCount) {
    throw new Error('Frame index out of bounds');
  }

  const bytesPerPixel = ser.pixelDepth > 8 ? 2 : 1;
  const frameSize = ser.width * ser.height * bytesPerPixel;
  const offset = ser.framesOffset + (frameIndex * frameSize);

  const floatData = new Float32Array(ser.width * ser.height);
  const view = new DataView(ser.rawBuffer, offset, frameSize);

  for (let i = 0; i < ser.width * ser.height; i++) {
    if (bytesPerPixel === 1) {
      floatData[i] = view.getUint8(i);
    } else {
      floatData[i] = view.getUint16(i * 2, ser.littleEndian);
    }
  }

  return floatData;
}

// 4. TIFF/RAW/JPEG EXIF METADATA PARSER
const EXIF_TAG_MAP: Record<number, { name: string, desc: string }> = {
  0x010E: { name: 'IMAGEDESC', desc: 'Image title/description' },
  0x010F: { name: 'MAKE', desc: 'Camera manufacturer' },
  0x0110: { name: 'MODEL', desc: 'Camera model' },
  0x0112: { name: 'ORIENT', desc: 'Image orientation parameter' },
  0x011A: { name: 'XRESOL', desc: 'Horizontal resolution' },
  0x011B: { name: 'YRESOL', desc: 'Vertical resolution' },
  0x0131: { name: 'SOFTWARE', desc: 'Software / firmware version' },
  0x0132: { name: 'DATETIME', desc: 'File modification date' },
  0x829A: { name: 'EXPTIME', desc: 'Exposure time in seconds' },
  0x829D: { name: 'FNUMBER', desc: 'F-stop focal aperture value' },
  0x8827: { name: 'ISOSPEED', desc: 'ISO sensor sensitivity rating' },
  0x9003: { name: 'DATE-OBS', desc: 'Original date/time of capture' },
  0x920A: { name: 'FOCALLEN', desc: 'Physical focal length (mm)' },
  0x9208: { name: 'LIGHTSRC', desc: 'Sensor light source conditions' },
  0x9209: { name: 'FLASH', desc: 'Strobe flash status' },
};

export function parseExif(buffer: ArrayBuffer): FitsHeaderCard[] {
  const view = new DataView(buffer);
  let isLittleEndian = true;
  let tiffHeaderOffset = 0;

  const marker = view.getUint16(0);
  if (marker === 0xFFD8) {
    let offset = 2;
    while (offset < buffer.byteLength) {
      if (offset + 4 > buffer.byteLength) break;
      const nextMarker = view.getUint16(offset);
      const size = view.getUint16(offset + 2);
      if (nextMarker === 0xFFE1) {
        const signature = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset + 4, 4));
        if (signature === 'Exif') {
          tiffHeaderOffset = offset + 10;
          break;
        }
      }
      offset += size + 2;
    }
  }

  if (tiffHeaderOffset === 0 && marker !== 0x4949 && marker !== 0x4D4D) return [];
  if (tiffHeaderOffset + 8 > buffer.byteLength) return [];
  
  const byteOrder = view.getUint16(tiffHeaderOffset);
  if (byteOrder === 0x4949) {
    isLittleEndian = true;
  } else if (byteOrder === 0x4D4D) {
    isLittleEndian = false;
  } else {
    return [];
  }

  const magic = view.getUint16(tiffHeaderOffset + 2, isLittleEndian);
  if (magic !== 0x002A) return [];

  const firstIFDOffset = view.getUint32(tiffHeaderOffset + 4, isLittleEndian);
  const cards: FitsHeaderCard[] = [];

  const parseIFD = (ifdOffset: number) => {
    if (ifdOffset === 0 || tiffHeaderOffset + ifdOffset + 2 > buffer.byteLength) return;
    const entriesCount = view.getUint16(tiffHeaderOffset + ifdOffset, isLittleEndian);
    
    for (let i = 0; i < entriesCount; i++) {
      const entryPos = tiffHeaderOffset + ifdOffset + 2 + (i * 12);
      if (entryPos + 12 > buffer.byteLength) break;

      const tag = view.getUint16(entryPos, isLittleEndian);
      const type = view.getUint16(entryPos + 2, isLittleEndian);
      const count = view.getUint32(entryPos + 4, isLittleEndian);
      let valueOffset = view.getUint32(entryPos + 8, isLittleEndian);

      if (tag === 0x8769) {
        parseIFD(valueOffset);
        continue;
      }

      const tagMeta = EXIF_TAG_MAP[tag];
      if (!tagMeta) continue;

      let extractedValue = '';

      try {
        if (type === 2) {
          const strOffset = count <= 4 ? entryPos + 8 : tiffHeaderOffset + valueOffset;
          const bytes = new Uint8Array(buffer, strOffset, count);
          extractedValue = new TextDecoder('ascii').decode(bytes).replace(/\0+$/, '').trim();
        } else if (type === 3) {
          extractedValue = view.getUint16(entryPos + 8, isLittleEndian).toString();
        } else if (type === 4) {
          extractedValue = valueOffset.toString();
        } else if (type === 5 || type === 10) {
          const numOffset = tiffHeaderOffset + valueOffset;
          if (numOffset + 8 <= buffer.byteLength) {
            const num = view.getUint32(numOffset, isLittleEndian);
            const den = view.getUint32(numOffset + 4, isLittleEndian);
            extractedValue = den !== 0 ? (num / den).toFixed(3) : '0';
          }
        }
      } catch (e) {
        extractedValue = 'Parse Error';
      }

      if (extractedValue) {
        cards.push({
          key: tagMeta.name,
          value: extractedValue,
          comment: tagMeta.desc,
          raw: `${tagMeta.name.padEnd(8, ' ')}= ${extractedValue}`
        });
      }
    }
  };

  parseIFD(firstIFDOffset);
  return cards;
}

// 5. JPEG-specific markers parser (JFIF & SOF markers for resolution and dimension properties)
export function parseJpeg(buffer: ArrayBuffer): FitsHeaderCard[] {
  const view = new DataView(buffer);
  if (view.getUint16(0) !== 0xFFD8) return []; // Not a JPEG

  const cards: FitsHeaderCard[] = [
    { key: 'FILETYPE', value: 'JPEG', comment: 'File type format descriptor', raw: '' },
    { key: 'MIMETYPE', value: 'image/jpeg', comment: 'MIME media type identification', raw: '' }
  ];

  let offset = 2;
  while (offset < buffer.byteLength) {
    if (offset + 4 > buffer.byteLength) break;
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);

    // APP0 (JFIF marker segment)
    if (marker === 0xFFE0) {
      const signature = new TextDecoder('ascii').decode(new Uint8Array(buffer, offset + 4, 4));
      if (signature === 'JFIF') {
        const major = view.getUint8(offset + 9);
        const minor = view.getUint8(offset + 10);
        const unit = view.getUint8(offset + 11);
        const xRes = view.getUint16(offset + 12);
        const yRes = view.getUint16(offset + 14);

        cards.push(
          { key: 'JFIFVER', value: `${major}.${minor.toString().padStart(2, '0')}`, comment: 'JFIF layout version specification', raw: '' },
          { key: 'RESUNIT', value: unit === 1 ? 'inch' : unit === 2 ? 'cm' : 'None', comment: 'Density resolution unit', raw: '' },
          { key: 'XRESOL', value: xRes.toString(), comment: 'Horizontal pixel resolution', raw: '' },
          { key: 'YRESOL', value: yRes.toString(), comment: 'Vertical pixel resolution', raw: '' }
        );
      }
    }
    // SOF markers (Start of Frame segments: 0xFFC0 baseline, 0xFFC2 progressive, etc.)
    else if (marker >= 0xFFC0 && marker <= 0xFFCF && marker !== 0xFFC4 && marker !== 0xFFC8 && marker !== 0xFFCC) {
      const bits = view.getUint8(offset + 4);
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      const components = view.getUint8(offset + 9);

      let encoding = 'Unknown DCT';
      if (marker === 0xFFC0) encoding = 'Baseline DCT, Huffman coding';
      else if (marker === 0xFFC1) encoding = 'Extended sequential DCT, Huffman coding';
      else if (marker === 0xFFC2) encoding = 'Progressive DCT, Huffman coding';
      else if (marker === 0xFFC3) encoding = 'Lossless DCT, Huffman coding';

      const megapixels = ((width * height) / 1000000).toFixed(3);

      cards.push(
        { key: 'WIDTH', value: width.toString(), comment: 'Image width in pixels', raw: '' },
        { key: 'HEIGHT', value: height.toString(), comment: 'Image height in pixels', raw: '' },
        { key: 'IMAGESZE', value: `${width}x${height}`, comment: 'Pixel dimension boundaries', raw: '' },
        { key: 'MEGAPIX', value: megapixels, comment: 'Megapixels value of image', raw: '' },
        { key: 'ENCODING', value: encoding, comment: 'JPEG compression encoding process', raw: '' },
        { key: 'BITSPER', value: bits.toString(), comment: 'Sample bit depth depth size', raw: '' },
        { key: 'COLORCMP', value: components.toString(), comment: 'Number of color planes', raw: '' }
      );
    }
    offset += size + 2;
  }

  return cards;
}

// 6. PNG-specific IHDR chunk parser
export function parsePng(buffer: ArrayBuffer): FitsHeaderCard[] {
  const view = new DataView(buffer);
  const signature = new Uint8Array(buffer, 0, 8);
  const expectedSig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const isPng = expectedSig.every((b, i) => signature[i] === b);
  if (!isPng) return [];

  const cards: FitsHeaderCard[] = [
    { key: 'FILETYPE', value: 'PNG', comment: 'File type format descriptor', raw: '' },
    { key: 'MIMETYPE', value: 'image/png', comment: 'MIME media type identification', raw: '' }
  ];

  // Search IHDR chunk (always starts at offset 8)
  if (buffer.byteLength > 29) {
    const chunkLength = view.getUint32(8, false);
    const chunkType = new TextDecoder('ascii').decode(new Uint8Array(buffer, 12, 4));

    if (chunkType === 'IHDR' && chunkLength === 13) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      const bitDepth = view.getUint8(24);
      const colorType = view.getUint8(25);
      const compression = view.getUint8(26);
      const filter = view.getUint8(27);
      const interlace = view.getUint8(28);

      let colorDesc = 'Unknown';
      if (colorType === 0) colorDesc = 'Grayscale';
      else if (colorType === 2) colorDesc = 'Truecolor RGB';
      else if (colorType === 3) colorDesc = 'Indexed Color';
      else if (colorType === 4) colorDesc = 'Grayscale + Alpha';
      else if (colorType === 6) colorDesc = 'Truecolor RGB + Alpha';

      cards.push(
        { key: 'WIDTH', value: width.toString(), comment: 'Image width in pixels', raw: '' },
        { key: 'HEIGHT', value: height.toString(), comment: 'Image height in pixels', raw: '' },
        { key: 'IMAGESZE', value: `${width}x${height}`, comment: 'Pixel dimension boundaries', raw: '' },
        { key: 'BITDEPTH', value: bitDepth.toString(), comment: 'Bit depth size per pixel', raw: '' },
        { key: 'COLORTYPE', value: colorDesc, comment: 'PNG color composition descriptor', raw: '' },
        { key: 'COMPRESS', value: compression === 0 ? 'Deflate/Inflate' : 'Unknown', comment: 'PNG compression format', raw: '' },
        { key: 'FILTER', value: filter === 0 ? 'Adaptive filtering' : 'Unknown', comment: 'PNG scanline filter method', raw: '' },
        { key: 'INTERLAC', value: interlace === 0 ? 'None' : 'Adam7 interlace', comment: 'PNG interlacing method', raw: '' }
      );
    }
  }
  return cards;
}
