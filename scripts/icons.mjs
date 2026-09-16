import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
fs.mkdirSync(target, { recursive: true });
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const kind = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, crc]);
}
function makeIcon(alert, size = 256) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const squares = [[43, 43], [136, 43], [43, 136], [136, 136]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sampleX = (x + .5) * 256 / size, sampleY = (y + .5) * 256 / size;
    let color = [22, 27, 35, 255];
    for (let i = 0; i < squares.length; i++) {
      const [sx, sy] = squares[i];
      if (sampleX >= sx && sampleX < sx + 77 && sampleY >= sy && sampleY < sy + 77) color = i === 3 || (alert && i === 1) ? [239, 118, 129, 255] : [190, 207, 224, 255];
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    color.forEach((c, index) => { raw[offset + index] = c; });
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const png = makeIcon(false);
fs.writeFileSync(path.join(target, 'icon.png'), png);
fs.writeFileSync(path.join(target, 'icon-alert.png'), makeIcon(true));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(size => makeIcon(false, size));
const ico = Buffer.alloc(6 + sizes.length * 16); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(sizes.length, 4);
let offset = ico.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16; ico[entry] = ico[entry + 1] = size === 256 ? 0 : size;
  ico.writeUInt16LE(1, entry + 4); ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(images[index].length, entry + 8); ico.writeUInt32LE(offset, entry + 12); offset += images[index].length;
}
fs.writeFileSync(path.join(target, 'icon.ico'), Buffer.concat([ico, ...images]));
