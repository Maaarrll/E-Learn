// scripts/photo-type-check.js — node scripts/photo-type-check.js
// Self-check: local photo uploads only accept files that really are JPG/PNG/GIF/WEBP.
const assert = require('assert');
const { imageType, isPhotoUrl } = require('../src/utils/photos');

const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(20)]);
assert.strictEqual(imageType(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
assert.strictEqual(imageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
assert.strictEqual(imageType(pad([...Buffer.from('GIF89a')])), 'gif');
assert.strictEqual(imageType(pad([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])), 'webp');
// A script or SVG renamed to .png must be refused
assert.strictEqual(imageType(pad([...Buffer.from('<script>alert(1)</script>')])), null);
assert.strictEqual(imageType(pad([...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')])), null);
assert.strictEqual(imageType(Buffer.from([0xff, 0xd8])), null);

assert.ok(isPhotoUrl('/photos/photos-user3.png?v=1'));
assert.ok(isPhotoUrl('https://res.cloudinary.com/x.jpg'));
assert.ok(!isPhotoUrl('javascript:alert(1)'));
assert.ok(!isPhotoUrl('http://evil.example/x.png'));
assert.ok(!isPhotoUrl(null));
console.log('photo-type-check: all passed');
