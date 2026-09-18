const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name); }
function load(name, fallback) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`Failed to read ${name}:`, err.message);
    return fallback;
  }
}
function save(name, value) {
  const p = file(name);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

const db = {
  users: load('users.json', {}),
  withdrawals: load('withdrawals.json', {}),
  audit: load('audit.json', []),
  proofHashes: load('proof-hashes.json', {}) ,
  promos: load('promos.json', {}),
  system: load('system.json', {withdrawalsFrozen:false}),
};

function saveUsers() { save('users.json', db.users); }
function saveWithdrawals() { save('withdrawals.json', db.withdrawals); }
function saveAudit() { save('audit.json', db.audit); }
function saveProofHashes() { save('proof-hashes.json', db.proofHashes); }
function savePromos() { save('promos.json', db.promos); }
function saveSystem() { save('system.json', db.system); }

module.exports = { db, saveUsers, saveWithdrawals, saveAudit, saveProofHashes, savePromos, saveSystem };
