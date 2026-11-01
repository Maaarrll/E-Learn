// src/updates.js
// Version stamps that open pages poll (GET /api/version) to know when to refresh.
// app changes on every deploy/restart; data changes when students should see
// something new (content published, announcement, teacher quiz).
const BOOT = Date.now();
let data = BOOT;

module.exports = {
  markUpdated: () => { data = Date.now(); },
  versions: () => ({ app: BOOT, data }),
};
