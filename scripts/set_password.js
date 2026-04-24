const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const password = process.argv[2];
const username = process.argv[3] || 'bwsz';

if (!password || password.length < 8) {
  console.error('Usage: node scripts/set_password.js <new-password-at-least-8-chars> [username]');
  process.exit(1);
}

const usersPath = path.join(__dirname, '..', 'data', 'users.json');
if (!fs.existsSync(usersPath)) {
  console.error('data/users.json does not exist. Start the app once first.');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
const user = data.users.find((item) => item.username === username) || data.users[0];
if (!user) {
  console.error('No user found in data/users.json.');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('base64url');
const iterations = 120000;
const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64url');
user.password = `pbkdf2$sha256$${iterations}$${salt}$${key}`;
user.updatedAt = new Date().toISOString();
fs.writeFileSync(usersPath, JSON.stringify(data, null, 2));
console.log(`Password updated for user: ${user.username}`);
