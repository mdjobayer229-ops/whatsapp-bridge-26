/**
 * Railway Volume Migration Script
 * Run ONCE after attaching a Railway volume at /data:
 *   node setup-volume.js
 *
 * This moves the existing auth from ephemeral storage
 * to the persistent Railway volume.
 */
const fs = require('fs');
const path = require('path');

const SRC = process.env.AUTH_DIR || 'auth_info';
const DEST = '/data/auth_info';

if (!fs.existsSync(SRC)) {
  console.log('Source auth directory not found:', SRC);
  console.log('Nothing to migrate. Set AUTH_DIR=/data/auth_info in Railway env vars.');
  process.exit(0);
}

if (fs.existsSync(DEST)) {
  console.log('Destination already exists:', DEST);
  console.log('Skipping migration. Delete it first if you want to re-migrate.');
  process.exit(0);
}

try {
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true });
  console.log('Auth migrated successfully:');
  console.log(`  From: ${SRC}`);
  console.log(`  To:   ${DEST}`);
  console.log('');
  console.log('Now set AUTH_DIR=/data/auth_info in Railway env vars and redeploy.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
}
