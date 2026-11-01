// src/utils/photos.js
// Profile photo uploads (students and instructors) go to Cloudinary.
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');

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

// Uploads to folder/publicId (replacing the old photo) and resolves with the https URL
function uploadPhoto(buffer, folder, publicId) {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        const err = new Error('Photo uploads are not set up on this server yet.');
        err.status = 503;
        return Promise.reject(err);
    }
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

// Best effort: a removed account's photo shouldn't stay on Cloudinary
function deletePhoto(folder, publicId) {
    if (!process.env.CLOUDINARY_CLOUD_NAME) return;
    cloudinary.uploader.destroy(`${folder}/${publicId}`, { resource_type: 'image' })
        .catch(err => console.error('Could not delete profile photo:', err.message));
}

module.exports = { photoUpload, uploadPhoto, deletePhoto };
