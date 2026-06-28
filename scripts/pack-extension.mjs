import { readFileSync, statSync, writeFileSync } from "node:fs";

const files = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "README.md"
];

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const output = `SuperShort-extension-${manifest.version}.zip`;
const localParts = [];
const centralParts = [];
let offset = 0;

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (year - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
  return { time, day };
}

for (const file of files) {
  const data = readFileSync(file);
  const name = Buffer.from(file);
  const { time, day } = dosDateTime(statSync(file).mtime);
  const checksum = crc32(data);
  const size = data.length;

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(time),
    u16(day),
    u32(checksum),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    name
  ]);

  const centralHeader = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(time),
    u16(day),
    u32(checksum),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    name
  ]);

  localParts.push(localHeader, data);
  centralParts.push(centralHeader);
  offset += localHeader.length + data.length;
}

const centralDirectory = Buffer.concat(centralParts);
const endOfCentralDirectory = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(files.length),
  u16(files.length),
  u32(centralDirectory.length),
  u32(offset),
  u16(0)
]);

writeFileSync(output, Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]));
console.log(output);
