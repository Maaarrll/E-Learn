// src/utils/videos.js
// Lesson videos are MP4 files the teacher uploads from her laptop. They are kept on
// this computer (not YouTube), so students can watch with no internet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, '..', '..', 'uploads', 'videos');
fs.mkdirSync(VIDEO_DIR, { recursive: true });

// A video's permanent content key is also its file name: v + 12 hex characters
const isVideoId = (id) => typeof id === 'string' && /^v[0-9a-f]{12}$/.test(id);
const videoPath = (id) => path.join(VIDEO_DIR, `${id}.mp4`);

const upload = multer({
  storage: multer.diskStorage({
    destination: VIDEO_DIR,
    filename: (req, file, cb) => cb(null, `v${crypto.randomBytes(6).toString('hex')}.mp4`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.mp4$/i.test(file.originalname)),
}).single('video');

// POST handler: saves one "video" file and replies { fileId }
function uploadVideo(req, res) {
  upload(req, res, (err) => {
    if (err) {
      const big = err.code === 'LIMIT_FILE_SIZE';
      if (!big) console.error('Video upload failed:', err);
      return res.status(400).json({ error: big ? 'That video is over 2 GB. Please use a smaller file.' : 'Upload failed. Please try again.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Please choose an MP4 video file.' });
    res.json({ fileId: path.basename(req.file.filename, '.mp4') });
  });
}

module.exports = { VIDEO_DIR, isVideoId, videoPath, uploadVideo };
