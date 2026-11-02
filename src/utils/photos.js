// src/utils/photos.js
// Profile photo uploads (students and instructors) go to Cloudinary, or, when
// Cloudinary isn't set up (the offline classroom laptop), to a folder on this computer.
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');

const PHOTO_DIR = process.env.PHOTO_DIR || path.join(__dirname, '..', '..', 'uploads', 'photos');
const useCloudinary = () => !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

// The real image type from the file's first bytes (the browser's claimed type can lie)
function imageType(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
    if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
    return null;
}

// Saves name.<ext> (removing an older photo with another extension) and returns its /photos/ address
function savePhotoLocally(buffer, name) {
    const ext = imageType(buffer);
    if (!ext) {
        const err = new Error('Only JPG, PNG, WEBP or GIF images are allowed.');
        err.status = 400;
        return Promise.reject(err);
    }
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    removeLocalPhoto(name);
    fs.writeFileSync(path.join(PHOTO_DIR, `${name}.${ext}`), buffer);
    return Promise.resolve(`/photos/${name}.${ext}?v=${Date.now()}`); // ?v= so browsers show the new photo
}

function removeLocalPhoto(name) {
    for (const ext of ['jpg', 'png', 'gif', 'webp']) fs.rmSync(path.join(PHOTO_DIR, `${name}.${ext}`), { force: true });
}

// "hcilearn/instructor_photos" + "instructor3" -> "instructor_photos-instructor3"
const localName = (folder, publicId) => `${path.basename(folder)}-${publicId}`.replace(/[^A-Za-z0-9_-]/g, '');

// Photo addresses pages may show: Cloudinary (https) or this computer's /photos/
const isPhotoUrl = (url) => /^(https:\/\/|\/photos\/)/.test(url || '');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Only common photo formats (no SVG/other files that could carry scripts)
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// One "photo" file, up to 3 MB, kept in memory until it goes to Cloudinary
const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
            const err = new Error('Only JPG, PNG, WEBP or GIF images are allowed.');
            err.status = 400;
            return cb(err);
        }
        cb(null, true);
    },
}).single('photo');

// Uploads to folder/publicId (replacing the old photo) and resolves with the photo's address
function uploadPhoto(buffer, folder, publicId) {
    if (!useCloudinary()) return savePhotoLocally(buffer, localName(folder, publicId));
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({
            folder,
            public_id: publicId,
            overwrite: true,
            // Cloudinary checks the real file contents, not just the type the browser claims
            resource_type: 'image',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        }, (err, result) => (err ? reject(err) : resolve(result.secure_url)));
        streamifier.createReadStream(buffer).pipe(stream);
    });
}

// Best effort: a removed account's photo shouldn't stay on Cloudinary (or this computer)
function deletePhoto(folder, publicId) {
    if (!useCloudinary()) return removeLocalPhoto(localName(folder, publicId));
    cloudinary.uploader.destroy(`${folder}/${publicId}`, { resource_type: 'image' })
        .catch(err => console.error('Could not delete profile photo:', err.message));
}

module.exports = { photoUpload, uploadPhoto, deletePhoto, isPhotoUrl, imageType, PHOTO_DIR };
